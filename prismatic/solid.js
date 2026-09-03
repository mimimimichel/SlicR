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
      if (n) out.push([mid[0] / n, mid[1] / n, mid[2] / n]);
      return out;
    });
    var weight = faces.map(function (face) { return Math.abs(planeArea(brep, face)); });

    function bend(x, y) {
      return faces[x].x * faces[y].x + faces[x].y * faces[y].y + faces[x].z * faces[y].z;
    }

    /**
     * A patch of faces that only ever fold gently into one another. Two flat
     * faces cannot be neighbours — they would be one face — so every fold here
     * is real; the question is whether it is a corner of the part or one step
     * around something round. A gentle fold is the second often enough to be
     * worth asking about, and asking is what the fit is for.
     *
     * The angle only decides what to ask about. Whether the answer is yes is
     * decided by the tolerance, which is why it can be generous without turning
     * a twelve-sided hole into a cylinder: the corners of a coarse polygon sit
     * nowhere near the circle through its faces, and the fit says so.
     */
    var patch = new Int32Array(faces.length).fill(-1);
    var patches = [];
    for (var f = 0; f < faces.length; f++) {
      if (patch[f] >= 0) continue;
      var id = patches.length;
      var members = [f];
      patch[f] = id;
      for (var head = 0; head < members.length; head++) {
        var here = members[head];
        for (var k = 0; k < neighbours[here].length; k++) {
          var next = neighbours[here][k];
          if (patch[next] >= 0 || bend(here, next) < cosSmooth) continue;
          patch[next] = id;
          members.push(next);
        }
      }
      patches.push(members);
    }

    var taken = new Int32Array(faces.length).fill(-1);
    var groups = [];

    // The biggest patches first: a surface that has already claimed its faces
    // cannot have them taken back by a smaller one that also nearly fits.
    patches.sort(function (a, b) { return b.length - a.length; });

    for (var p = 0; p < patches.length; p++) {
      var members = patches[p].filter(function (m) { return taken[m] < 0; });
      if (members.length < o.minFaces) continue;

      var group = new P.Group();
      var points = [];
      var seats = [];
      var inGroup = new Set();
      // Pushed rather than concatenated: a patch of nine thousand faces
      // concatenated one at a time copies the whole list nine thousand times,
      // which is most of a second spent on nothing.
      members.forEach(function (m) {
        group.add([faces[m].x, faces[m].y, faces[m].z], faces[m].d, weight[m], m);
        Array.prototype.push.apply(points, samples[m]);
        Array.prototype.push.apply(seats, corners[m]);
        inGroup.add(m);
      });

      var surface = fit(thin(points), group, tolerance, thin(seats));
      if (!surface) continue;

      // Now that there is a surface, the faces just outside the patch can be
      // asked directly: a band of the same cylinder cut coarsely enough to fold
      // sharply belongs to it too, and only the surface itself can say so.
      var frontier = [];
      members.forEach(function (m) {
        neighbours[m].forEach(function (n) { if (!inGroup.has(n) && taken[n] < 0) frontier.push(n); });
      });
      while (frontier.length) {
        var candidate = frontier.shift();
        if (inGroup.has(candidate) || taken[candidate] >= 0) continue;
        var trial = group.copy();
        trial.add([faces[candidate].x, faces[candidate].y, faces[candidate].z],
          faces[candidate].d, weight[candidate], candidate);
        // Added to the lists in place and taken back off again if the surface
        // will not have it, rather than copying both lists per candidate.
        var wasPoints = points.length, wasSeats = seats.length;
        Array.prototype.push.apply(points, samples[candidate]);
        Array.prototype.push.apply(seats, corners[candidate]);
        var grown = fit(thin(points), trial, tolerance, thin(seats));
        if (!grown) { points.length = wasPoints; seats.length = wasSeats; continue; }
        // Touching the surface is not lying along it. Without this a cylinder
        // swallows the cap on the end of it, every corner of which is on the
        // cylinder because the rim is where the two meet.
        if (!P.tangent(grown, [faces[candidate].x, faces[candidate].y, faces[candidate].z],
              samples[candidate], cosTangent)) {
          points.length = wasPoints;
          seats.length = wasSeats;
          continue;
        }
        group = trial;
        surface = grown;
        members.push(candidate);
        inGroup.add(candidate);
        neighbours[candidate].forEach(function (n) {
          if (!inGroup.has(n) && taken[n] < 0) frontier.push(n);
        });
      }

      // Everything, now, and exactly: a group that grew a face at a time can
      // drift away from where it started, and the thinned fits above were only
      // ever good enough to decide with.
      surface = fit(points, group, tolerance, seats);
      if (!surface) continue;

      var along = true;
      for (var c = 0; c < members.length && along; c++) {
        var mm = members[c];
        along = P.tangent(surface, [faces[mm].x, faces[mm].y, faces[mm].z], samples[mm], cosTangent);
      }
      if (!along) continue;

      for (var m2 = 0; m2 < members.length; m2++) taken[members[m2]] = groups.length;
      groups.push({
        surface: surface, members: members.slice(),
        group: group, points: points, seats: seats
      });
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
   * So neighbouring groups are offered to each other. The accumulated moments
   * of two groups add, so the joint fit costs nothing to try, and it is only
   * accepted if the one surface holds over everything both of them had.
   */
  function coalesce(groups, taken, neighbours, tolerance) {
    var P = root.PrismaticPrimitives;
    var merged = true;
    var rounds = 0;
    while (merged && rounds++ < 8) {
      merged = false;
      var touching = new Map();
      for (var f = 0; f < taken.length; f++) {
        var mine = taken[f];
        if (mine < 0) continue;
        for (var k = 0; k < neighbours[f].length; k++) {
          var theirs = taken[neighbours[f][k]];
          if (theirs < 0 || theirs === mine) continue;
          var key = mine < theirs ? mine + ':' + theirs : theirs + ':' + mine;
          touching.set(key, [Math.min(mine, theirs), Math.max(mine, theirs)]);
        }
      }

      var pairs = [];
      touching.forEach(function (pair) { pairs.push(pair); });
      // Biggest first, so a large surface gathers the scraps rather than a
      // scrap deciding what the large one is.
      pairs.sort(function (a, b) {
        return (groups[b[0]].members.length + groups[b[1]].members.length) -
               (groups[a[0]].members.length + groups[a[1]].members.length);
      });

      for (var p = 0; p < pairs.length && !merged; p++) {
        var a = groups[pairs[p][0]], b = groups[pairs[p][1]];
        if (!a || !b || a === b) continue;
        var joint = a.group.copy();
        joint.weight += b.group.weight;
        joint.sd += b.group.sd;
        for (var i = 0; i < 3; i++) {
          joint.sn[i] += b.group.sn[i];
          joint.dn[i] += b.group.dn[i];
          for (var j = 0; j < 3; j++) joint.nn[i * 3 + j] += b.group.nn[i * 3 + j];
        }
        for (var x = 0; x < 16; x++) joint.m4[x] += b.group.m4[x];
        for (var y = 0; y < 4; y++) joint.b4[y] += b.group.b4[y];

        var points = a.points.concat(b.points);
        var seats = a.seats.concat(b.seats);
        if (points.length > 200000) continue;      // past this the pair is not worth the pass
        var surface = P.fit(joint, thin(points), tolerance, thin(seats));
        if (!surface) continue;
        surface = P.fit(joint, points, tolerance, seats);      // thinned to decide, whole to accept
        if (!surface) continue;

        var members = a.members.concat(b.members);

        a.surface = surface;
        a.members = members;
        a.group = joint;
        a.points = points;
        a.seats = seats;
        var index = groups.indexOf(a);
        for (var t = 0; t < taken.length; t++) if (taken[t] === pairs[p][1]) taken[t] = index;
        groups[pairs[p][1]] = null;
        merged = true;
      }

      if (merged) {
        // Close the gaps the removals left, and point everyone at where their
        // group ended up.
        var kept = [];
        var moved = new Int32Array(groups.length).fill(-1);
        for (var g = 0; g < groups.length; g++) {
          if (!groups[g]) continue;
          moved[g] = kept.length;
          kept.push(groups[g]);
        }
        for (var v = 0; v < taken.length; v++) if (taken[v] >= 0) taken[v] = moved[taken[v]];
        groups.length = 0;
        Array.prototype.push.apply(groups, kept);
      }
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
        if (arc) geometry = { type: 'circle', centre: arc.centre, axis: arc.axis, radius: arc.radius };
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

  /** Walk a loop of vertices as a sequence of the edges it is made of. */
  function loopEdges(loop, lookup) {
    var out = [];
    var i = 0;
    while (i < loop.length) {
      var step = lookup.get(loop[i] + '>' + loop[(i + 1) % loop.length]);
      if (!step) return null;
      out.push(step);
      var edge = step;
      // Skip the rest of whatever edge this segment belongs to.
      var span = 1;
      while (span < loop.length) {
        var nextStep = lookup.get(loop[(i + span) % loop.length] + '>' + loop[(i + span + 1) % loop.length]);
        if (!nextStep || nextStep.edge !== edge.edge) break;
        span++;
      }
      i += span;
    }
    return out;
  }

  // ---------------------------------------------------------------------------

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
    var counts = { plane: 0, cylinder: 0, cone: 0, sphere: 0 };
    var found = o.recognise && brep.faces.length > 1
      ? recognise(brep, o)
      : { groups: [], taken: new Int32Array(brep.faces.length).fill(-1) };

    var vertices = brep.vertices;
    var seams = [];

    found.groups.forEach(function (group) {
      var loops = outlineOf(brep, brep.faces, group.members);

      // A surface with no boundary at all. A whole ball is the case: nothing
      // bounds it, and a face has to be bounded by something.
      //
      // The way round it is the way a modeller does it — cut the ball in half
      // and let the two halves share the cut. One new point on the equator, one
      // circular edge through it, and two faces: the one whose loop runs
      // anticlockwise about the axis is the top half, the one that runs the
      // other way is the bottom. Nothing else in the body has to know.
      if (!loops) {
        if (group.surface.type !== 'sphere') {
          group.members.forEach(function (f) { found.taken[f] = -1; });
          return;
        }
        counts.sphere++;
        var enclosedBall = 0;
        group.members.forEach(function (f) {
          enclosedBall += brep.faces[f].d * planeArea(brep, brep.faces[f]) / 3;
        });
        if (vertices === brep.vertices) vertices = Array.prototype.slice.call(brep.vertices);
        var axis = [0, 0, 1];
        var start = [
          group.surface.centre[0] + group.surface.radius,
          group.surface.centre[1],
          group.surface.centre[2]
        ];
        var at = vertices.length / 3;
        vertices.push(start[0], start[1], start[2]);
        seams.push({
          vertex: at,
          circle: { centre: group.surface.centre.slice(), axis: axis, radius: group.surface.radius },
          north: faces.length,
          south: faces.length + 1
        });
        faces.push({ surface: group.surface, loops: null, from: group.members.length, volume: enclosedBall });
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
      var index = built.edges.length;
      built.edges.push({
        a: seam.vertex, b: seam.vertex, via: [],
        curve: { type: 'circle', centre: seam.circle.centre, axis: seam.circle.axis, radius: seam.circle.radius },
        closed: true
      });
      faces[seam.north].loops = [[{ edge: index, forward: true }]];
      faces[seam.south].loops = [[{ edge: index, forward: false }]];
      faces[seam.north].points = [[seam.vertex]];
      faces[seam.south].points = [[seam.vertex]];
      faces[seam.north].seam = true;
      faces[seam.south].seam = true;
    });

    var out = [];
    for (var i = 0; i < faces.length; i++) {
      if (faces[i].seam) {
        out.push({
          surface: faces[i].surface, loops: faces[i].loops, points: faces[i].points,
          from: faces[i].from, volume: faces[i].volume
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
