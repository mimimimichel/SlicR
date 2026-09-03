/**
 * Prismatic — from flat faces to the shapes they came from.
 *
 * The rebuild hands back planes, and for a part made of planes that is the
 * answer. For the bore through it, it is not: a hole arrives as thirty-two
 * little planes and, left alone, leaves as thirty-two little planes. Somebody
 * opening that in Fusion gets thirty-two faces they cannot fillet, cannot
 * measure the diameter of, and cannot pull with a push-pull. What they wanted,
 * and what it was drawn as, is one cylinder.
 *
 * So the faces are looked at again in groups. Neighbours are added to a group
 * one at a time while a single cylinder, cone or sphere still passes through
 * all of them, and a group that ends up with one is replaced by the one face
 * that surface makes. Nothing is taken on trust: every fit is measured against
 * every corner of the group and dropped if it is worse than the tolerance the
 * conversion was given, so a square post — whose four side planes are, as it
 * happens, all tangent to the same cylinder — keeps its four flat faces,
 * because its corners are nowhere near that cylinder.
 *
 * Then the edges. Thirty-two straight segments around the top of a bore are a
 * circle; written as thirty-two edges they are thirty-two edges forever. They
 * are found the same way and for the same reason, and they are found once for
 * the whole body rather than once per face — an edge belongs to the two faces
 * that meet along it, and the two have to agree about what it is or the solid
 * comes apart along it.
 *
 * What comes out is a proper boundary representation: a list of points, a list
 * of edges each knowing its two ends and its geometry, and faces bounded by
 * loops of those edges. Which is what the STEP writer needs, and what a solid
 * modeller means by a solid.
 */
(function (root) {
  'use strict';

  var DEFAULTS = {
    recognise: true,     // look for cylinders, cones and spheres at all
    minFaces: 4,         // planes it takes before a curve is worth believing
    smoothAngle: 45,     // deg; a fold gentler than this is worth asking about
    tangentAngle: 25,    // deg; how far a face may lean and still lie along a surface
    tolerance: 0         // mm; 0 means "whatever the conversion was told"
  };

  var SAMPLE_CAP = 600;   // points enough to pin a surface down
  var REFIT_EVERY = 16;   // faces taken before the surface is fitted again

  function fit(points, group, tolerance, corners) {
    return root.PrismaticPrimitives.fit(group, points, tolerance, corners);
  }

  /**
   * Every nth of a long list. A surface fitted to six hundred points spread
   * over a patch is the same surface as one fitted to thirty thousand, and
   * doing it in full at every step of the growth is what turns a ball of nine
   * thousand faces from a moment into a minute. The whole of it is measured
   * once, at the end, where being exact is worth the pass.
   */
  function thin(list) {
    if (list.length <= SAMPLE_CAP) return list;
    var step = Math.ceil(list.length / SAMPLE_CAP);
    var out = [];
    for (var i = 0; i < list.length; i += step) out.push(list[i]);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Reading the planar body
  // ---------------------------------------------------------------------------

  function vertexAt(brep, id) {
    return [brep.vertices[id * 3], brep.vertices[id * 3 + 1], brep.vertices[id * 3 + 2]];
  }

  /** Signed area of a planar face, in its own plane: the outline less its holes. */
  function planeArea(brep, face) {
    var n = [face.x, face.y, face.z];
    var u = across(n), v = cross(n, u);
    var total = 0;
    for (var l = 0; l < face.loops.length; l++) {
      var loop = face.loops[l], sum = 0;
      for (var i = 0; i < loop.length; i++) {
        var a = vertexAt(brep, loop[i]), b = vertexAt(brep, loop[(i + 1) % loop.length]);
        sum += dot(a, u) * dot(b, v) - dot(b, u) * dot(a, v);
      }
      total += sum / 2;
    }
    return total;
  }

  function across(a) {
    var pick = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    return unit(cross(a, pick));
  }
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function unit(v) {
    var len = Math.sqrt(dot(v, v));
    return len > 0 ? [v[0] / len, v[1] / len, v[2] / len] : [1, 0, 0];
  }

  /** Which faces meet along which edge. Every edge has exactly two, or the mesh had a hole. */
  function edgeMap(brep) {
    var V = brep.vertices.length / 3;
    var edges = new Map();
    brep.faces.forEach(function (face, f) {
      face.loops.forEach(function (loop) {
        for (var i = 0; i < loop.length; i++) {
          var a = loop[i], b = loop[(i + 1) % loop.length];
          if (a === b) continue;
          var key = a < b ? a * V + b : b * V + a;
          var seen = edges.get(key);
          if (!seen) { seen = { a: a < b ? a : b, b: a < b ? b : a, faces: [] }; edges.set(key, seen); }
          if (seen.faces.indexOf(f) < 0) seen.faces.push(f);
        }
      });
    });
    return edges;
  }

  // ---------------------------------------------------------------------------
  // Growing a group until it stops being a cylinder
  // ---------------------------------------------------------------------------

  function recognise(brep, o) {
    var P = root.PrismaticPrimitives;
    var faces = brep.faces;
    var tolerance = o.tolerance;
    var cosSmooth = Math.cos(o.smoothAngle * Math.PI / 180);
    var cosTangent = Math.cos(o.tangentAngle * Math.PI / 180);

    // Who touches whom.
    var neighbours = faces.map(function () { return []; });
    edgeMap(brep).forEach(function (edge) {
      if (edge.faces.length !== 2) return;
      var x = edge.faces[0], y = edge.faces[1];
      if (neighbours[x].indexOf(y) < 0) neighbours[x].push(y);
      if (neighbours[y].indexOf(x) < 0) neighbours[y].push(x);
    });

    /**
     * Where to check a face against a candidate surface: its corners, the
     * middle of each of its edges, and its own middle.
     *
     * The corners alone are not enough, and the way they are not enough is
     * instructive. Every vertex of a plain cylinder — the rim at each end —
     * lies on one sphere, the one through both rims. Ask only about corners and
     * a cylinder with two flat ends comes back a perfect sphere, tangent at
     * every face centre, deviation zero. It is the middle of the end cap, four
     * millimetres off that sphere, that says otherwise.
     */
    var corners = faces.map(function (face) {
      var out = [];
      face.loops.forEach(function (loop) {
        for (var i = 0; i < loop.length; i++) out.push(vertexAt(brep, loop[i]));
      });
      return out;
    });
    var middles = new Array(faces.length);
    var samples = faces.map(function (face, f) {
      var out = corners[f].slice();
      var mid = [0, 0, 0], n = 0;
      face.loops.forEach(function (loop) {
        for (var i = 0; i < loop.length; i++) {
          var a = vertexAt(brep, loop[i]), b = vertexAt(brep, loop[(i + 1) % loop.length]);
          out.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
          mid[0] += a[0]; mid[1] += a[1]; mid[2] += a[2];
          n++;
        }
      });
      if (n) {
        middles[f] = [mid[0] / n, mid[1] / n, mid[2] / n];
        out.push(middles[f]);
      }
      return out;
    });
    var weight = faces.map(function (face) { return Math.abs(planeArea(brep, face)); });

    function bend(x, y) {
      return faces[x].x * faces[y].x + faces[x].y * faces[y].y + faces[x].z * faces[y].z;
    }

    /**
     * Seeds, not patches.
     *
     * The first try at this grouped faces into "patches" that only ever fold
     * gently into one another and asked one question of each. It works on a
     * part whose features meet at sharp edges and falls apart on one whose
     * features blend, which is most real parts: on a fillet-and-bore bracket,
     * ninety-nine folds in a hundred are gentle, so the whole part is one patch,
     * one question, and the answer is no. Nothing is recognised at all.
     *
     * So the question is asked locally instead. Take a face and enough of its
     * neighbours to pin a surface down — a dozen is plenty and three is not,
     * which is the whole reason this is not simply grown from one face — fit
     * that, and then grow it for as far as the fit keeps holding. Where a
     * cylinder ends and a fillet begins, the fit stops holding, and that is
     * exactly where the face should end.
     */
    var SEED_FACES = 14;

    function seedAround(start, taken) {
      var seed = [start];
      var seen = new Set([start]);
      for (var head = 0; head < seed.length && seed.length < SEED_FACES; head++) {
        var here = seed[head];
        for (var k = 0; k < neighbours[here].length && seed.length < SEED_FACES; k++) {
          var next = neighbours[here][k];
          if (seen.has(next) || taken[next] >= 0) continue;
          if (bend(here, next) < cosSmooth) continue;
          seen.add(next);
          seed.push(next);
        }
      }
      return seed;
    }

    var taken = new Int32Array(faces.length).fill(-1);
    var groups = [];
    var order = faces.map(function (_, i) { return i; })
      .sort(function (a, b) { return weight[b] - weight[a]; });

    // Simplest first, so that when two kinds of surface hold over the same faces
    // the answer is the one with fewer things to say. A cylinder written as a
    // torus with a major radius of ten thousand is not wrong; it is just not
    // what anybody drew.
    var SIMPLICITY = { plane: 0, cylinder: 1, cone: 2, sphere: 3, torus: 4 };
    var KINDS = ['plane', 'cylinder', 'cone', 'sphere', 'torus'];
    var ROUNDS = 3;

    function startFrom(members) {
      var group = new P.Group();
      var points = [];
      var seats = [];
      members.forEach(function (m) {
        group.add([faces[m].x, faces[m].y, faces[m].z], faces[m].d, weight[m], m, middles[m]);
        Array.prototype.push.apply(points, samples[m]);
        Array.prototype.push.apply(seats, corners[m]);
      });
      return { group: group, points: points, seats: seats, members: members.slice() };
    }

    /**
     * Take what is already grouped, call it this kind of surface, and carry it
     * as far as that will go.
     */
    function grow(from, kind, taken) {
      var state = startFrom(from.members);
      var surface = P.refit(kind, state.group, thin(state.points), tolerance, thin(state.seats));
      if (!surface) return null;

      var inGroup = new Set(state.members);
      var frontier = [];
      state.members.forEach(function (m) {
        neighbours[m].forEach(function (n) { if (!inGroup.has(n) && taken[n] < 0) frontier.push(n); });
      });

      var since = 0;
      while (frontier.length) {
        var candidate = frontier.shift();
        if (inGroup.has(candidate) || taken[candidate] >= 0) continue;
        if (P.deviation(surface, samples[candidate]) > tolerance) continue;
        // Touching a surface is not lying along it: without this a cylinder
        // swallows the cap on the end of it, every corner of which is on the
        // cylinder because the rim is where the two meet.
        if (!P.tangent(surface, [faces[candidate].x, faces[candidate].y, faces[candidate].z],
              samples[candidate], cosTangent)) continue;

        state.group.add([faces[candidate].x, faces[candidate].y, faces[candidate].z],
          faces[candidate].d, weight[candidate], candidate, middles[candidate]);
        Array.prototype.push.apply(state.points, samples[candidate]);
        Array.prototype.push.apply(state.seats, corners[candidate]);
        state.members.push(candidate);
        inGroup.add(candidate);
        neighbours[candidate].forEach(function (n) {
          if (!inGroup.has(n) && taken[n] < 0) frontier.push(n);
        });
        if (++since >= REFIT_EVERY) {
          since = 0;
          var moved = P.refit(kind, state.group, thin(state.points), tolerance, thin(state.seats));
          if (moved) surface = moved;
        }
      }
      state.surface = surface;
      return state;
    }

    function preferred(a, b) {
      if (!b) return true;
      if (a.members.length > b.members.length * 1.1) return true;
      if (a.members.length < b.members.length * 0.9) return false;
      return SIMPLICITY[a.surface.type] < SIMPLICITY[b.surface.type];
    }

    /**
     * What this seed is part of.
     *
     * The kind cannot be settled where the seed is, and not only because a
     * dozen facets off anything smooth fit a sphere. A torus is worse than
     * that: its axis is found by asking where every normal meets, and on a
     * small patch every line very nearly meets every other, so the answer is
     * noise. The seed cannot know it is looking at a doughnut.
     *
     * So it grows as whatever it can be, and then — with a few hundred faces
     * to ask of instead of a dozen — the question is put again. That is when
     * the doughnut appears, and the sphere that had been creeping along it
     * hands over. Two or three rounds of that and it stops changing its mind.
     */
    function reach(seed, taken) {
      var best = null;
      for (var k = 0; k < KINDS.length; k++) {
        var tried = grow({ members: seed }, KINDS[k], taken);
        if (tried && preferred(tried, best)) best = tried;
      }
      if (!best) return null;

      for (var round = 1; round < ROUNDS; round++) {
        var again = null;
        for (var j = 0; j < KINDS.length; j++) {
          if (KINDS[j] === best.surface.type) continue;
          var other = grow(best, KINDS[j], taken);
          if (other && preferred(other, again)) again = other;
        }
        if (!again || !preferred(again, best)) break;
        best = again;
      }
      return best;
    }

    for (var s = 0; s < order.length; s++) {
      var start = order[s];
      if (taken[start] >= 0) continue;
      var seed = seedAround(start, taken);
      if (seed.length < o.minFaces) continue;

      var best = reach(seed, taken);
      if (!best || best.members.length < o.minFaces) continue;

      // Everything, now, and exactly: a group that grew a face at a time can
      // drift away from where it started, and the fits above were only ever
      // good enough to decide with — they were made against a sample of the
      // group's points, not all of them.
      //
      // Where the exact answer no longer holds over every face, the faces it
      // does not hold over are handed back and the rest is asked again. That
      // is not fussiness: throwing the whole group away instead is what made
      // the tolerance work backwards, a looser one giving *more* faces than a
      // tighter one, because the looser the tolerance the further a group grows
      // and the more likely one face at the far end of it is to spoil the lot.
      // A doughnut that grew one facet too far is still a doughnut.
      var kind = best.surface.type;
      var members = best.members;
      var settled = null, held = best;
      for (var pass = 0; pass < 4 && members.length >= o.minFaces; pass++) {
        var state = startFrom(members);
        var tried = P.refit(kind, state.group, thin(state.points), tolerance, thin(state.seats));
        if (!tried) break;
        var keep = [];
        for (var c = 0; c < members.length; c++) {
          var mm = members[c];
          if (P.deviation(tried, samples[mm]) > tolerance) continue;
          if (!P.tangent(tried, [faces[mm].x, faces[mm].y, faces[mm].z], samples[mm], cosTangent)) continue;
          keep.push(mm);
        }
        if (keep.length === members.length) { settled = tried; held = state; break; }
        members = keep;
      }
      if (!settled || members.length < o.minFaces) continue;

      for (var m2 = 0; m2 < members.length; m2++) taken[members[m2]] = groups.length;
      groups.push({
        surface: settled, members: members.slice(),
        group: held.group, points: held.points, seats: held.seats
      });
    }

    // Stragglers. A face left over next to a surface that would have it is
    // usually one the growth walked past — the frontier is breadth first and a
    // face can be reached and refused before the surface it belonged to had
    // settled. Offering them again afterwards costs one pass and tidies the
    // seam of a mesh's own parameterisation, which is where they collect.
    //
    // The sign of the fold is not asked about here, only its size. Where a
    // surface turns over — the crest of a doughnut's tube, the pole of a ball —
    // the tangent plane barely moves from one facet to the next, and putting
    // the corners back where those nearly parallel planes cross can leave a
    // sliver facing backwards. It is a fold in the rebuild a few hundredths of
    // a millimetre deep, not a wall of the part: it is on the surface, it is
    // along the surface, and the surface should have it. Growth still asks for
    // the sign, which is what keeps a cylinder from swallowing its end cap.
    var adopted = true, sweeps = 0;
    while (adopted && sweeps++ < 4) {
      adopted = false;
      for (var f2 = 0; f2 < faces.length; f2++) {
        if (taken[f2] >= 0) continue;
        for (var nb = 0; nb < neighbours[f2].length; nb++) {
          var into = taken[neighbours[f2][nb]];
          if (into < 0) continue;
          var host = groups[into];
          if (P.deviation(host.surface, samples[f2]) > tolerance) continue;
          if (!P.alongside(host.surface, [faces[f2].x, faces[f2].y, faces[f2].z],
                samples[f2], cosTangent)) continue;
          host.group.add([faces[f2].x, faces[f2].y, faces[f2].z], faces[f2].d,
            weight[f2], f2, middles[f2]);
          Array.prototype.push.apply(host.points, samples[f2]);
          Array.prototype.push.apply(host.seats, corners[f2]);
          host.members.push(f2);
          taken[f2] = into;
          adopted = true;
          break;
        }
      }
    }

    coalesce(groups, taken, neighbours, tolerance);
    return { groups: groups, taken: taken };
  }

  /**
   * Two halves of one sphere, put back together.
   *
   * A surface is grown from a patch outwards and stops where the fit stops
   * holding. On a mesh whose facets sit right at the edge of the tolerance that
   * can happen halfway round a ball: the first group takes what it can, the
   * rest starts again on its own, and what should have been one sphere comes
   * out in four pieces — which is worse than not recognising it at all, because
   * four spheres of slightly different radius is not a thing anyone drew.
   *
   * So neighbouring groups are offered to each other, over and over until
   * nobody moves. The accumulated moments of two groups add, so the joint fit
   * costs almost nothing to try, and it is only accepted if the one surface
   * holds over everything both of them had.
   *
   * It matters more than it sounds, because the order surfaces are found in is
   * close to arbitrary: a sphere that happened to be seeded first can creep
   * along a doughnut and cut it in two before the doughnut is ever asked
   * about. This is where that is put right.
   */
  function coalesce(groups, taken, neighbours, tolerance) {
    var P = root.PrismaticPrimitives;
    var rounds = 0;
    while (rounds++ < 12) {
      // Who is next to whom, now.
      var touching = new Map();
      for (var f = 0; f < taken.length; f++) {
        var mine = taken[f];
        if (mine < 0) continue;
        for (var k = 0; k < neighbours[f].length; k++) {
          var theirs = taken[neighbours[f][k]];
          if (theirs < 0 || theirs === mine) continue;
          var lo = Math.min(mine, theirs), hi = Math.max(mine, theirs);
          touching.set(lo + ':' + hi, [lo, hi]);
        }
      }
      var pairs = [];
      touching.forEach(function (pair) { pairs.push(pair); });
      if (!pairs.length) return;
      // Biggest first, so a large surface gathers the scraps rather than a
      // scrap deciding what the large one is.
      pairs.sort(function (a, b) {
        return (groups[b[0]].members.length + groups[b[1]].members.length) -
               (groups[a[0]].members.length + groups[a[1]].members.length);
      });

      // Where each group has ended up this round, since a group merged into
      // another is then offered on as that one.
      var moved = new Int32Array(groups.length);
      for (var i = 0; i < groups.length; i++) moved[i] = i;
      function settled(x) { while (moved[x] !== x) { moved[x] = moved[moved[x]]; x = moved[x]; } return x; }

      var merges = 0;
      for (var p = 0; p < pairs.length; p++) {
        var ai = settled(pairs[p][0]), bi = settled(pairs[p][1]);
        if (ai === bi) continue;
        var a = groups[ai], b = groups[bi];
        if (!a || !b) continue;
        if (a.members.length + b.members.length > 60000) continue;

        var joint = a.group.copy();
        joint.weight += b.group.weight;
        joint.sd += b.group.sd;
        for (var x = 0; x < 3; x++) {
          joint.sn[x] += b.group.sn[x];
          joint.dn[x] += b.group.dn[x];
          for (var y = 0; y < 3; y++) joint.nn[x * 3 + y] += b.group.nn[x * 3 + y];
        }
        for (var m4 = 0; m4 < 16; m4++) joint.m4[m4] += b.group.m4[m4];
        for (var b4 = 0; b4 < 4; b4++) joint.b4[b4] += b.group.b4[b4];
        for (var m6 = 0; m6 < 36; m6++) joint.m6[m6] += b.group.m6[m6];
        if (b.group.seen && (!joint.seen || b.group.seen.w > joint.seen.w)) joint.seen = b.group.seen;

        var points = a.points.concat(b.points);
        var seats = a.seats.concat(b.seats);
        var surface = P.fit(joint, thin(points), tolerance, thin(seats));
        if (!surface) continue;
        surface = P.fit(joint, points, tolerance, seats);      // thinned to decide, whole to accept
        if (!surface) continue;

        a.surface = surface;
        a.members = a.members.concat(b.members);
        a.group = joint;
        a.points = points;
        a.seats = seats;
        groups[bi] = null;
        moved[bi] = ai;
        merges++;
      }
      if (!merges) return;

      // Close the gaps the removals left, and point everyone at where their
      // group ended up.
      var kept = [];
      var placed = new Int32Array(groups.length).fill(-1);
      for (var g = 0; g < groups.length; g++) {
        if (!groups[g]) continue;
        placed[g] = kept.length;
        kept.push(groups[g]);
      }
      for (var v = 0; v < taken.length; v++) {
        if (taken[v] >= 0) taken[v] = placed[settled(taken[v])];
      }
      groups.length = 0;
      Array.prototype.push.apply(groups, kept);
    }
  }

  // ---------------------------------------------------------------------------
  // The boundary of a group of faces
  // ---------------------------------------------------------------------------

  /**
   * Where a group of faces stops. Its own edges cancel — each is walked one way
   * by one face and the other way by its neighbour — and what is left is the
   * outline, already turning the way the faces did.
   */
  function outlineOf(brep, faces, members) {
    var V = brep.vertices.length / 3;
    var directed = new Set();
    var listed = [];
    members.forEach(function (f) {
      faces[f].loops.forEach(function (loop) {
        for (var i = 0; i < loop.length; i++) {
          var a = loop[i], b = loop[(i + 1) % loop.length];
          if (a === b) continue;
          directed.add(a * V + b);
          listed.push(a, b);
        }
      });
    });

    var outgoing = new Map();
    var edges = [];
    for (var i = 0; i < listed.length; i += 2) {
      var a = listed[i], b = listed[i + 1];
      if (directed.has(b * V + a)) continue;          // another face of the group has it
      var slot = outgoing.get(a);
      if (!slot) { slot = []; outgoing.set(a, slot); }
      slot.push(edges.length / 2);
      edges.push(a, b);
    }
    if (!edges.length) return null;

    var spent = new Uint8Array(edges.length / 2);
    var loops = [];
    for (var e = 0; e < spent.length; e++) {
      if (spent[e]) continue;
      var head = edges[e * 2];
      var loop = [head];
      var at = edges[e * 2 + 1];
      spent[e] = 1;
      var guard = spent.length + 1;
      var closed = false;
      while (guard-- > 0) {
        if (at === head) { closed = true; break; }
        var pick = -1, slots = outgoing.get(at) || [];
        for (var g = 0; g < slots.length; g++) if (!spent[slots[g]]) { pick = slots[g]; break; }
        if (pick < 0) break;
        spent[pick] = 1;
        loop.push(at);
        at = edges[pick * 2 + 1];
      }
      if (!closed || loop.length < 3) return null;
      loops.push(loop);
    }
    return loops.length ? loops : null;
  }

  // ---------------------------------------------------------------------------
  // Edges: found once, for both the faces that share them
  // ---------------------------------------------------------------------------

  /**
   * Cut the outlines into edges. An edge runs between two junctions — a corner
   * where more than two faces meet, or where the pair of faces sharing the
   * boundary changes — and everything between is one edge whether it arrived as
   * one segment or as thirty-two.
   *
   * Doing it on the body rather than face by face is the point: the two faces
   * either side of an edge are handed the same edge, so they cannot disagree
   * about where it runs.
   */
  function buildEdges(vertices, faces, tolerance) {
    var P = root.PrismaticPrimitives;
    var V = vertices.length / 3;
    var at = function (id) { return [vertices[id * 3], vertices[id * 3 + 1], vertices[id * 3 + 2]]; };

    var segments = new Map();
    faces.forEach(function (face, f) {
      face.loops.forEach(function (loop) {
        for (var i = 0; i < loop.length; i++) {
          var a = loop[i], b = loop[(i + 1) % loop.length];
          if (a === b) continue;
          var key = a < b ? a * V + b : b * V + a;
          var seen = segments.get(key);
          if (!seen) {
            seen = { a: a < b ? a : b, b: a < b ? b : a, faces: [], key: key };
            segments.set(key, seen);
          }
          if (seen.faces.indexOf(f) < 0) seen.faces.push(f);
        }
      });
    });

    var incident = new Map();
    segments.forEach(function (seg) {
      [seg.a, seg.b].forEach(function (v) {
        var list = incident.get(v);
        if (!list) { list = []; incident.set(v, list); }
        list.push(seg);
      });
    });

    function pairOf(seg) {
      var f = seg.faces.slice().sort(function (x, y) { return x - y; });
      return f.join(':');
    }
    function isJunction(v) {
      var list = incident.get(v) || [];
      if (list.length !== 2) return true;
      return pairOf(list[0]) !== pairOf(list[1]);
    }

    var used = new Set();
    var chains = [];

    function walk(from, seg) {
      var chain = [from];
      var here = from, edge = seg;
      while (true) {
        used.add(edge.key);
        var other = edge.a === here ? edge.b : edge.a;
        chain.push(other);
        here = other;
        if (isJunction(here)) break;
        var list = incident.get(here) || [];
        var onward = null;
        for (var i = 0; i < list.length; i++) if (!used.has(list[i].key)) onward = list[i];
        if (!onward) break;
        edge = onward;
      }
      return chain;
    }

    // From every junction outwards, then whatever cycles are left over — a ring
    // where one face meets another all the way round has no junction on it at
    // all, and is one closed edge.
    incident.forEach(function (list, v) {
      if (!isJunction(v)) return;
      list.forEach(function (seg) {
        if (used.has(seg.key)) return;
        chains.push({ points: walk(v, seg), faces: seg.faces });
      });
    });
    segments.forEach(function (seg) {
      if (used.has(seg.key)) return;
      var chain = walk(seg.a, seg);
      chains.push({ points: chain, faces: seg.faces, ring: chain[0] === chain[chain.length - 1] });
    });

    // What each chain is.
    var edges = [];
    var lookup = new Map();     // "a>b" of every segment -> {edge, forward}
    chains.forEach(function (chain) {
      var ids = chain.points;
      var pts = ids.map(at);
      var geometry = null;

      if (ids.length === 2) {
        geometry = { type: 'line' };
      } else if (!chain.ring && straight(pts, tolerance)) {
        geometry = { type: 'line' };
      } else {
        var arc = P.fitArc(pts, tolerance);
        if (arc && onBoth(arc, pts, chain.faces, faces, tolerance)) {
          geometry = { type: 'circle', centre: arc.centre, axis: arc.axis, radius: arc.radius };
        }
      }

      if (!geometry) {
        // Neither straight nor round: it stays as the segments it arrived as.
        for (var i = 0; i < ids.length - 1; i++) add([ids[i], ids[i + 1]], { type: 'line' });
        return;
      }
      add(ids, geometry);
    });

    function add(ids, geometry) {
      var index = edges.length;
      edges.push({
        a: ids[0],
        b: ids[ids.length - 1],
        via: ids.slice(1, ids.length - 1),
        curve: geometry,
        closed: ids[0] === ids[ids.length - 1]
      });
      for (var i = 0; i < ids.length - 1; i++) {
        lookup.set(ids[i] + '>' + ids[i + 1], { edge: index, forward: true });
        lookup.set(ids[i + 1] + '>' + ids[i], { edge: index, forward: false });
      }
    }

    return { edges: edges, lookup: lookup };
  }

  /**
   * Does this arc lie on both the faces it divides, all the way along?
   *
   * A circle through a chain of corners can be through them and still not be on
   * the surface between them — a ring of corners round a cylinder is a circle
   * whichever plane it is read in, and read in the wrong one it leaves the
   * cylinder between every pair. The corners are where it is fitted; the file
   * has to be right everywhere, so it is checked everywhere.
   */
  function onBoth(arc, points, owners, faces, tolerance) {
    var P = root.PrismaticPrimitives;
    var n = points.length;
    var last = points[n - 1];
    var u = unit([points[0][0] - arc.centre[0], points[0][1] - arc.centre[1], points[0][2] - arc.centre[2]]);
    if (!u) return false;
    var v = cross(arc.axis, u);
    var end = [last[0] - arc.centre[0], last[1] - arc.centre[1], last[2] - arc.centre[2]];
    var sweep = Math.atan2(dot(end, v), dot(end, u));
    if (sweep <= 1e-9) sweep += 2 * Math.PI;

    var steps = Math.max(8, Math.min(180, n * 4));
    for (var i = 0; i <= steps; i++) {
      var t = sweep * i / steps;
      var c = Math.cos(t) * arc.radius, s = Math.sin(t) * arc.radius;
      var p = [
        arc.centre[0] + u[0] * c + v[0] * s,
        arc.centre[1] + u[1] * c + v[1] * s,
        arc.centre[2] + u[2] * c + v[2] * s
      ];
      for (var f = 0; f < owners.length; f++) {
        if (P.distance(faces[owners[f]].surface, p) > tolerance) return false;
      }
    }
    return true;
  }

  function straight(points, tolerance) {
    var a = points[0], b = points[points.length - 1];
    var dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(len > 0)) return false;
    for (var i = 1; i < points.length - 1; i++) {
      var wx = points[i][0] - a[0], wy = points[i][1] - a[1], wz = points[i][2] - a[2];
      var cx = wy * dz - wz * dy, cy = wz * dx - wx * dz, cz = wx * dy - wy * dx;
      if (Math.sqrt(cx * cx + cy * cy + cz * cz) / len > tolerance) return false;
    }
    return true;
  }

  /**
   * Walk a loop of vertices as a sequence of the edges it is made of.
   *
   * Where the walk starts matters. An edge is a run of segments, and a loop
   * that happens to start in the middle of one would take the tail of that edge
   * first and the head of it again at the end — the same edge named twice by
   * one loop, which is not an edge any more. So the walk begins where one edge
   * hands over to the next. A loop with no such place is a single closed edge
   * all the way round, and may start anywhere.
   */
  function loopEdges(loop, lookup) {
    var n = loop.length;
    var begin = 0;
    for (var s = 0; s < n; s++) {
      var here = lookup.get(loop[s] + '>' + loop[(s + 1) % n]);
      var back = lookup.get(loop[(s + n - 1) % n] + '>' + loop[s]);
      if (!here || !back) return null;
      if (here.edge !== back.edge || here.forward !== back.forward) { begin = s; break; }
    }

    var out = [];
    var i = 0;
    while (i < n) {
      var at = (begin + i) % n;
      var step = lookup.get(loop[at] + '>' + loop[(at + 1) % n]);
      if (!step) return null;
      out.push(step);
      // Skip the rest of whatever edge this segment belongs to.
      var span = 1;
      while (i + span < n) {
        var k = (begin + i + span) % n;
        var onward = lookup.get(loop[k] + '>' + loop[(k + 1) % n]);
        if (!onward || onward.edge !== step.edge || onward.forward !== step.forward) break;
        span++;
      }
      i += span;
    }
    return out;
  }

  // ---------------------------------------------------------------------------

  /**
   * Where to cut a surface that closes on itself, and which way each half then
   * runs round the cut.
   *
   * A ball is cut at its equator: one circle, the top half going round it one
   * way and the bottom half the other. The axis is arbitrary — every great
   * circle of a sphere is its equator — so it may as well be z.
   *
   * A doughnut is cut at both of its equators, the wide one and the one round
   * the hole, which leaves the top half and the bottom half each bounded by two
   * circles. Reading it in the parameters a torus is written in: the surface
   * runs u round the axis and v round the tube, and the outer equator is v = 0
   * while the inner one is v = pi. The upper half is 0 < v < pi, and a boundary
   * that keeps the surface on its left goes forward along the outer circle and
   * back along the inner one. The lower half is the same the other way about.
   */
  function halved(s) {
    if (s.type === 'sphere') {
      return {
        rings: [{ centre: s.centre.slice(), axis: [0, 0, 1], radius: s.radius }],
        senses: [[true], [false]]
      };
    }
    if (s.type === 'torus' && s.major > s.minor) {
      var a = unit(s.axis);
      if (!a) return null;
      return {
        rings: [
          { centre: s.centre.slice(), axis: a, radius: s.major + s.minor },
          { centre: s.centre.slice(), axis: a, radius: s.major - s.minor }
        ],
        senses: [[true, false], [false, true]]
      };
    }
    return null;
  }

  /**
   * The whole of it: recognise what the planes came from, keep whatever they
   * did not, and hand back a body of faces bounded by shared edges.
   */
  function build(brep, options) {
    var o = {};
    for (var k in DEFAULTS) o[k] = DEFAULTS[k];
    if (options) for (var j in options) if (options[j] != null) o[j] = options[j];
    if (!(o.tolerance > 0)) o.tolerance = 0.05;

    var faces = [];
    var counts = { plane: 0, cylinder: 0, cone: 0, sphere: 0, torus: 0 };
    var found = o.recognise && brep.faces.length > 1
      ? recognise(brep, o)
      : { groups: [], taken: new Int32Array(brep.faces.length).fill(-1) };

    var vertices = brep.vertices;
    var seams = [];

    found.groups.forEach(function (group) {
      var loops = outlineOf(brep, brep.faces, group.members);

      // A surface with no boundary at all. A whole ball is one case and a whole
      // doughnut is the other: nothing bounds either, and a face has to be
      // bounded by something.
      //
      // The way round it is the way a modeller does it — cut it in half and let
      // the two halves share the cut. Nothing else in the body has to know.
      if (!loops) {
        var whole = halved(group.surface);
        if (!whole) {
          group.members.forEach(function (f) { found.taken[f] = -1; });
          return;
        }
        counts[group.surface.type]++;
        var enclosedWhole = 0;
        group.members.forEach(function (f) {
          enclosedWhole += brep.faces[f].d * planeArea(brep, brep.faces[f]) / 3;
        });
        if (vertices === brep.vertices) vertices = Array.prototype.slice.call(brep.vertices);
        var rings = whole.rings.map(function (circle) {
          var u = across(circle.axis);
          var at = vertices.length / 3;
          vertices.push(circle.centre[0] + u[0] * circle.radius,
                        circle.centre[1] + u[1] * circle.radius,
                        circle.centre[2] + u[2] * circle.radius);
          return { vertex: at, circle: circle };
        });
        seams.push({
          rings: rings, senses: whole.senses,
          north: faces.length, south: faces.length + 1
        });
        faces.push({ surface: group.surface, loops: null, from: group.members.length, volume: enclosedWhole });
        faces.push({ surface: group.surface, loops: null, from: 0, volume: 0 });
        return;
      }
      counts[group.surface.type]++;
      var enclosed = 0;
      group.members.forEach(function (f) { enclosed += brep.faces[f].d * planeArea(brep, brep.faces[f]) / 3; });
      faces.push({
        surface: group.surface, loops: loops, from: group.members.length, volume: enclosed
      });
    });

    brep.faces.forEach(function (face, f) {
      if (found.taken[f] >= 0) return;
      counts.plane++;
      faces.push({
        surface: { type: 'plane', x: face.x, y: face.y, z: face.z, d: face.d },
        loops: face.loops,
        from: 1,
        // What this face contributes to the volume the body encloses, kept from
        // when it was still flat: a third of its area times its distance from
        // the origin. A curved face has no such formula, and the writer still
        // has to tell a body from a cavity.
        volume: face.d * planeArea(brep, face) / 3
      });
    });

    var coordinates = vertices === brep.vertices ? brep.vertices : Float64Array.from(vertices);
    var bounded = faces.filter(function (f) { return f.loops; });
    var built = buildEdges(coordinates, bounded, o.tolerance);

    // The seams are not edges of the mesh, so they are added rather than found.
    seams.forEach(function (seam) {
      var made = seam.rings.map(function (ring) {
        var index = built.edges.length;
        built.edges.push({
          a: ring.vertex, b: ring.vertex, via: [],
          curve: {
            type: 'circle', centre: ring.circle.centre,
            axis: ring.circle.axis, radius: ring.circle.radius
          },
          closed: true
        });
        return index;
      });
      [seam.north, seam.south].forEach(function (which, half) {
        faces[which].loops = made.map(function (index, r) {
          return [{ edge: index, forward: seam.senses[half][r] }];
        });
        faces[which].points = seam.rings.map(function (ring) { return [ring.vertex]; });
        faces[which].seam = true;
      });
    });

    var out = [];
    for (var i = 0; i < faces.length; i++) {
      if (faces[i].seam) {
        out.push({
          surface: faces[i].surface, loops: faces[i].loops, points: faces[i].points,
          from: faces[i].from, volume: faces[i].volume, seam: true
        });
        continue;
      }
      var loops = [];
      var lost = false;
      for (var l = 0; l < faces[i].loops.length; l++) {
        var walk = loopEdges(faces[i].loops[l], built.lookup);
        if (!walk) { lost = true; break; }
        loops.push(walk);
      }
      if (lost) return null;
      out.push({
        surface: faces[i].surface, loops: loops, points: faces[i].loops,
        from: faces[i].from, volume: faces[i].volume
      });
    }

    return {
      vertices: coordinates,
      edges: built.edges,
      faces: out,
      flatness: brep.flatness,
      // How far the body strays from what it says it is: the furthest any
      // corner sits off the surface of its own face, or off the curve of its
      // own edge. A file has to declare an accuracy and then be that accurate,
      // and a fitted cylinder is not exact the way a fitted plane is.
      slack: slackOf({ vertices: coordinates, edges: built.edges, faces: out }),
      counts: counts
    };
  }

  function slackOf(body) {
    var P = root.PrismaticPrimitives;
    var worst = 0;
    var at = function (id) {
      return [body.vertices[id * 3], body.vertices[id * 3 + 1], body.vertices[id * 3 + 2]];
    };

    body.faces.forEach(function (face) {
      face.points.forEach(function (loop) {
        loop.forEach(function (v) {
          var gap = P.distance(face.surface, at(v));
          if (isFinite(gap) && gap > worst) worst = gap;
        });
      });
    });

    body.edges.forEach(function (edge) {
      if (edge.curve.type !== 'circle') return;
      var c = edge.curve;
      [edge.a, edge.b].concat(edge.via).forEach(function (v) {
        var p = at(v);
        var w = [p[0] - c.centre[0], p[1] - c.centre[1], p[2] - c.centre[2]];
        var along = dot(w, c.axis);
        var radial = Math.sqrt(Math.max(0, dot(w, w) - along * along));
        var gap = Math.sqrt(along * along + (radial - c.radius) * (radial - c.radius));
        if (gap > worst) worst = gap;
      });
    });

    return worst;
  }

  root.PrismaticSolid = { build: build, DEFAULTS: DEFAULTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.PrismaticSolid;
})(typeof globalThis !== 'undefined' ? globalThis : window);
