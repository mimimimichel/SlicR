/**
 * Orca Web Slicer — a prismatic solid, rebuilt from a mesh.
 *
 * A mesh that came out of CAD is a solid that was chopped up: every flat face
 * arrives as a fan of facets, and every corner is only as sharp as the
 * exporter's tolerance left it. This puts it back together the way Fusion's
 * "Convert Mesh > Prismatic" does — group the facets back into the flat faces
 * they were cut from, fit one exact plane to each, move every vertex onto the
 * intersection of the planes meeting there, and re-triangulate each face from
 * its outline instead of keeping the fan.
 *
 * What comes back is still a triangle soup — there is no B-rep kernel in a web
 * page — but it is one whose flat faces are flat to the last decimal, whose
 * edges are straight, and which usually holds a fraction of the triangles it
 * started with. For a slicer that is the half that matters: a top surface
 * planar to the micron lands in one layer instead of two, a wall that is
 * exactly vertical stops reading as a shallow overhang, and the facet noise
 * that turns one perimeter into forty little segments is gone.
 *
 * It is deliberately timid. Each rebuilt face is measured against the facets it
 * replaces and keeps them if the two disagree; the finished body is measured
 * against the volume it came from, and the conversion is handed back undone
 * rather than quietly reshaping the part. Nothing here flatters a mesh that was
 * never prismatic — `analyze` says so first, and a scan or a sculpt is better
 * left alone.
 *
 * earcut triangulates the faces. Without it the faces keep their facets and
 * only the plane fitting and vertex snapping happen, which is still worth
 * having; `rebuilt` in the report says which of the two ran.
 */
(function (root) {
  'use strict';

  var DEFAULTS = {
    angle: 1.5,           // deg — how far a facet's normal may sit off its face
    deviation: 0.05,      // mm  — how far a facet's corner may sit off the plane
    snapAxes: true,       // pull a face onto X/Y/Z when it is nearly there
    mergeFaces: true,     // faces that share a plane are given the same plane
    weld: 1e-4,           // mm  — grid on which two vertices are one point
    minDihedral: 3,       // deg — below this, two planes are one direction
    maxMove: 0,           // mm  — how far a vertex may travel; 0 means 20x deviation
    maxVolumeError: 0.01, // past 1% off the original volume, reject the rebuild
    maxFaceError: 0.05,   // past 5% off a face's area, that face keeps its facets
    passes: 4             // rounds of growing faces and refitting them
  };

  // mm — a point this close to the line through its neighbours is on it, and so
  // is not a corner of anything. Kept tight on purpose: once the vertices are
  // snapped, the points along an edge are exactly collinear, so nothing has to
  // be guessed at here and nothing that was a feature is rounded away.
  var COLLINEAR = 1e-6;

  function settings(options) {
    var o = {};
    for (var k in DEFAULTS) o[k] = DEFAULTS[k];
    if (options) for (var j in options) if (options[j] != null) o[j] = options[j];
    if (!(o.maxMove > 0)) o.maxMove = o.deviation * 20;
    return o;
  }

  // ---------------------------------------------------------------------------
  // The mesh: welded vertices, a plane per facet, and who touches whom
  // ---------------------------------------------------------------------------

  /**
   * Weld the soup into a vertex list with facet normals, areas and centroids.
   * Facets with two corners in the same place are left out: they cover no
   * surface, have no normal to speak of, and would otherwise seed a face of
   * their own and poison every measurement taken afterwards.
   */
  function buildMesh(positions, o) {
    var source = (positions.length / 9) | 0;
    var grid = 1 / o.weld;
    var lookup = new Map();
    var vx = [], vy = [], vz = [];
    var tri = [];
    var dropped = 0;

    for (var t = 0; t < source; t++) {
      var corner = [-1, -1, -1];
      var bad = false;
      for (var v = 0; v < 3 && !bad; v++) {
        var off = t * 9 + v * 3;
        var x = positions[off], y = positions[off + 1], z = positions[off + 2];
        if (!isFinite(x) || !isFinite(y) || !isFinite(z)) { bad = true; break; }
        var key = Math.round(x * grid) + '_' + Math.round(y * grid) + '_' + Math.round(z * grid);
        var id = lookup.get(key);
        if (id === undefined) {
          id = vx.length;
          lookup.set(key, id);
          vx.push(x); vy.push(y); vz.push(z);
        }
        corner[v] = id;
      }
      if (bad || corner[0] === corner[1] || corner[1] === corner[2] || corner[0] === corner[2]) {
        dropped++;
        continue;
      }
      tri.push(corner[0], corner[1], corner[2]);
    }

    var count = tri.length / 3;
    var mesh = {
      count: count,
      dropped: dropped,
      sourceCount: source,
      ids: Int32Array.from(tri),
      vx: Float64Array.from(vx), vy: Float64Array.from(vy), vz: Float64Array.from(vz),
      vertices: vx.length,
      nx: new Float64Array(count), ny: new Float64Array(count), nz: new Float64Array(count),
      area: new Float64Array(count),
      cx: new Float64Array(count), cy: new Float64Array(count), cz: new Float64Array(count)
    };

    for (var i = 0; i < count; i++) {
      var a = mesh.ids[i * 3], b = mesh.ids[i * 3 + 1], c = mesh.ids[i * 3 + 2];
      var ux = mesh.vx[b] - mesh.vx[a], uy = mesh.vy[b] - mesh.vy[a], uz = mesh.vz[b] - mesh.vz[a];
      var wx = mesh.vx[c] - mesh.vx[a], wy = mesh.vy[c] - mesh.vy[a], wz = mesh.vz[c] - mesh.vz[a];
      var px = uy * wz - uz * wy, py = uz * wx - ux * wz, pz = ux * wy - uy * wx;
      var len = Math.sqrt(px * px + py * py + pz * pz);
      if (len > 0) { mesh.nx[i] = px / len; mesh.ny[i] = py / len; mesh.nz[i] = pz / len; }
      mesh.area[i] = len / 2;
      mesh.cx[i] = (mesh.vx[a] + mesh.vx[b] + mesh.vx[c]) / 3;
      mesh.cy[i] = (mesh.vy[a] + mesh.vy[b] + mesh.vy[c]) / 3;
      mesh.cz[i] = (mesh.vz[a] + mesh.vz[b] + mesh.vz[c]) / 3;
    }

    buildAdjacency(mesh);
    return mesh;
  }

  /**
   * Facet neighbours across shared edges, as a compressed adjacency list. An
   * edge used by more than two facets — a mesh that is not a surface — links
   * the first two and leaves the rest alone rather than guessing.
   */
  function buildAdjacency(mesh) {
    var count = mesh.count, V = mesh.vertices;
    var edge = new Map();
    var pairA = [], pairB = [], pairLen = [];
    var nonManifold = 0;

    for (var t = 0; t < count; t++) {
      for (var k = 0; k < 3; k++) {
        var a = mesh.ids[t * 3 + k], b = mesh.ids[t * 3 + (k + 1) % 3];
        var key = a < b ? a * V + b : b * V + a;
        var seen = edge.get(key);
        if (seen === undefined) edge.set(key, t);
        else if (seen >= 0) {
          pairA.push(seen); pairB.push(t);
          var ex = mesh.vx[b] - mesh.vx[a], ey = mesh.vy[b] - mesh.vy[a], ez = mesh.vz[b] - mesh.vz[a];
          pairLen.push(Math.sqrt(ex * ex + ey * ey + ez * ez));
          edge.set(key, -1);
        } else nonManifold++;
      }
    }

    var start = new Int32Array(count + 1);
    for (var p = 0; p < pairA.length; p++) { start[pairA[p] + 1]++; start[pairB[p] + 1]++; }
    for (var i = 0; i < count; i++) start[i + 1] += start[i];
    var list = new Int32Array(pairA.length * 2);
    var cursor = start.slice(0, count);
    for (var q = 0; q < pairA.length; q++) {
      list[cursor[pairA[q]]++] = pairB[q];
      list[cursor[pairB[q]]++] = pairA[q];
    }

    mesh.adjStart = start;
    mesh.adjList = list;
    mesh.pairA = pairA;
    mesh.pairB = pairB;
    mesh.pairLen = pairLen;
    mesh.nonManifold = nonManifold;
    mesh.openEdges = 0;
    edge.forEach(function (value) { if (value >= 0) mesh.openEdges++; });
    return mesh;
  }

  // ---------------------------------------------------------------------------
  // Finding the faces
  // ---------------------------------------------------------------------------

  /**
   * Grow each flat face out from the largest facet that has not been claimed,
   * testing every candidate against the plane the face started with rather than
   * against a plane that drifts as the face grows. That distinction is the
   * whole game: a 512-facet cylinder turns each of its neighbours by 0.7°, so a
   * drifting plane would swallow the entire cylinder one harmless step at a
   * time, while a fixed one stops after a few facets — which is what "flat to
   * within a tolerance" was supposed to mean.
   *
   * The seed plane is only a first guess, so each round refits every face to
   * the facets it collected, throws out the ones the refit left outside
   * tolerance, and offers them to their neighbours' refitted planes before
   * seeding anything new. Three or four rounds of that settle down.
   */
  function segment(mesh, o) {
    var count = mesh.count;
    var cosA = Math.cos(o.angle * Math.PI / 180);
    var face = new Int32Array(count).fill(-1);
    var planes = [];

    var order = new Int32Array(count);
    for (var i = 0; i < count; i++) order[i] = i;
    order.sort(function (a, b) { return mesh.area[b] - mesh.area[a]; });

    function fits(t, p) {
      if (mesh.nx[t] * p.x + mesh.ny[t] * p.y + mesh.nz[t] * p.z < cosA) return false;
      for (var k = 0; k < 3; k++) {
        var id = mesh.ids[t * 3 + k];
        var gap = mesh.vx[id] * p.x + mesh.vy[id] * p.y + mesh.vz[id] * p.z - p.d;
        if (gap > o.deviation || gap < -o.deviation) return false;
      }
      return true;
    }

    function grow() {
      var stack = [];
      for (var s = 0; s < order.length; s++) {
        var seed = order[s];
        if (face[seed] >= 0) continue;
        var p = {
          x: mesh.nx[seed], y: mesh.ny[seed], z: mesh.nz[seed], d: 0, area: 0
        };
        p.d = p.x * mesh.cx[seed] + p.y * mesh.cy[seed] + p.z * mesh.cz[seed];
        var f = planes.length;
        planes.push(p);
        face[seed] = f;
        stack.length = 0;
        stack.push(seed);
        while (stack.length) {
          var t = stack.pop();
          for (var e = mesh.adjStart[t]; e < mesh.adjStart[t + 1]; e++) {
            var u = mesh.adjList[e];
            if (face[u] >= 0 || !fits(u, p)) continue;
            face[u] = f;
            stack.push(u);
          }
        }
      }
    }

    /**
     * Let a facet move to a neighbouring face whose plane fits it, so long as
     * that face is the bigger of the two. Growth starts from one facet's own
     * plane, which on a large face can be a fraction of a degree out of true —
     * enough that the far end of the face falls outside the tolerance and
     * starts a face of its own. Once every face has been refitted to what it
     * collected, those splinters fit the real plane and come home. Only ever
     * moving towards the larger face is what stops two of them trading facets
     * back and forth forever.
     */
    function absorb() {
      var total = 0, moved = true, rounds = 0;
      while (moved && rounds++ < 8) {
        moved = false;
        for (var t = 0; t < count; t++) {
          var mine = face[t];
          if (mine < 0) continue;
          for (var e = mesh.adjStart[t]; e < mesh.adjStart[t + 1]; e++) {
            var theirs = face[mesh.adjList[e]];
            if (theirs < 0 || theirs === mine) continue;
            if (planes[theirs].area <= planes[mine].area) continue;
            if (!fits(t, planes[theirs])) continue;
            face[t] = mine = theirs;
            moved = true;
            total++;
          }
        }
      }
      return total;
    }

    /** Offer the homeless facets to the settled planes around them. */
    function attach() {
      var loose = [];
      for (var t = 0; t < count; t++) if (face[t] < 0) loose.push(t);
      var moved = true;
      while (moved && loose.length) {
        moved = false;
        var still = [];
        for (var i = 0; i < loose.length; i++) {
          var u = loose[i], taken = false;
          for (var e = mesh.adjStart[u]; e < mesh.adjStart[u + 1]; e++) {
            var n = face[mesh.adjList[e]];
            if (n >= 0 && fits(u, planes[n])) { face[u] = n; taken = moved = true; break; }
          }
          if (!taken) still.push(u);
        }
        loose = still;
      }
    }

    /**
     * One least-squares plane per face, through the area-weighted centroid, and
     * then — if the face is within tolerance of an axis and staying on it does
     * not push any of its facets further off than the tolerance allows — that
     * axis exactly. The second half of that condition is what keeps the option
     * safe: a 20 mm face half a degree out of square is 0.09 mm off at its far
     * corner, and squaring it up is a change to the part, not a cleanup.
     */
    function refit() {
      var n = planes.length;
      var sx = new Float64Array(n), sy = new Float64Array(n), sz = new Float64Array(n);
      var mx = new Float64Array(n), my = new Float64Array(n), mz = new Float64Array(n);
      var wsum = new Float64Array(n);
      var t, f;
      for (t = 0; t < count; t++) {
        f = face[t];
        if (f < 0) continue;
        var w = mesh.area[t];
        sx[f] += mesh.nx[t] * w; sy[f] += mesh.ny[t] * w; sz[f] += mesh.nz[t] * w;
        mx[f] += mesh.cx[t] * w; my[f] += mesh.cy[t] * w; mz[f] += mesh.cz[t] * w;
        wsum[f] += w;
      }

      var candidate = new Array(n);
      for (var f2 = 0; f2 < n; f2++) {
        var p = planes[f2];
        p.area = wsum[f2];
        if (!(wsum[f2] > 0)) continue;
        var len = Math.sqrt(sx[f2] * sx[f2] + sy[f2] * sy[f2] + sz[f2] * sz[f2]);
        if (len > 0) { p.x = sx[f2] / len; p.y = sy[f2] / len; p.z = sz[f2] / len; }
        var cx = mx[f2] / wsum[f2], cy = my[f2] / wsum[f2], cz = mz[f2] / wsum[f2];
        p.d = p.x * cx + p.y * cy + p.z * cz;
        if (!o.snapAxes) continue;
        var axis = nearestAxis(p, cosA);
        if (axis) candidate[f2] = { x: axis[0], y: axis[1], z: axis[2], off: 0,
          d: axis[0] * cx + axis[1] * cy + axis[2] * cz };
      }

      for (t = 0; t < count; t++) {
        f = face[t];
        var c = f >= 0 ? candidate[f] : null;
        if (!c) continue;
        for (var k = 0; k < 3; k++) {
          var id = mesh.ids[t * 3 + k];
          var gap = Math.abs(mesh.vx[id] * c.x + mesh.vy[id] * c.y + mesh.vz[id] * c.z - c.d);
          if (gap > c.off) c.off = gap;
        }
      }
      for (var f3 = 0; f3 < n; f3++) {
        var pick = candidate[f3];
        if (!pick || pick.off > o.deviation) continue;
        planes[f3].x = pick.x; planes[f3].y = pick.y; planes[f3].z = pick.z; planes[f3].d = pick.d;
      }
    }

    function evict() {
      var out = 0;
      for (var t = 0; t < count; t++) {
        var f = face[t];
        if (f >= 0 && !fits(t, planes[f])) { face[t] = -1; out++; }
      }
      return out;
    }

    // Grow from seed planes, refit each face to what it collected, and then
    // keep going while the refit is still changing anyone's mind: facets that
    // no longer fit are put back out, their neighbours take the ones they can,
    // splinters are pulled into the bigger face they belong to, and whatever is
    // still homeless seeds a face of its own.
    grow();
    refit();
    for (var pass = 1; pass < o.passes; pass++) {
      var churn = evict();
      attach();
      churn += absorb();
      grow();
      refit();
      if (!churn) break;
    }

    return compact(mesh, face, planes, o);
  }

  /** The axis a face is nearly on, if it is nearly on one; CAD meant it to be. */
  function nearestAxis(p, cosA) {
    var axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (var i = 0; i < 3; i++) {
      var dot = p.x * axes[i][0] + p.y * axes[i][1] + p.z * axes[i][2];
      if (dot >= cosA) return axes[i];
      if (-dot >= cosA) return [-axes[i][0], -axes[i][1], -axes[i][2]];
    }
    return null;
  }

  /**
   * Drop the faces that ended up empty, renumber, and — when asked — give every
   * face that landed on the same plane one shared plane. Two bosses on the same
   * top surface then slice as one flat top instead of two that miss each other
   * by a micron. Prismatic parts have few distinct planes, which is the point,
   * so the list of representatives stays short enough to search head-on.
   */
  function compact(mesh, face, planes, o) {
    var used = new Int32Array(planes.length).fill(-1);
    var kept = [];
    for (var t = 0; t < mesh.count; t++) {
      var f = face[t];
      if (f < 0) continue;
      if (used[f] < 0) { used[f] = kept.length; kept.push(planes[f]); }
      face[t] = used[f];
    }

    if (o.mergeFaces && kept.length > 1) mergePlanes(kept, o);

    var n = kept.length;
    var start = new Int32Array(n + 1);
    for (var i = 0; i < mesh.count; i++) if (face[i] >= 0) start[face[i] + 1]++;
    for (var f2 = 0; f2 < n; f2++) start[f2 + 1] += start[f2];
    var list = new Int32Array(mesh.count);
    var cursor = start.slice(0, n);
    for (var k = 0; k < mesh.count; k++) if (face[k] >= 0) list[cursor[face[k]]++] = k;

    return { face: face, planes: kept, start: start, list: list, count: n };
  }

  var MERGE_LIMIT = 4000;   // faces past which pairing them all off costs more
                            // than it can possibly return: a mesh with this
                            // many faces is not a prismatic part anyway.

  function mergePlanes(planes, o) {
    if (planes.length > MERGE_LIMIT) return;
    var cosA = Math.cos(o.angle * Math.PI / 180);
    var reps = [];
    var of = new Int32Array(planes.length);
    for (var i = 0; i < planes.length; i++) {
      var p = planes[i], hit = -1;
      for (var r = 0; r < reps.length; r++) {
        var q = reps[r];
        if (p.x * q.x + p.y * q.y + p.z * q.z < cosA) continue;
        if (Math.abs(p.d - q.d) > o.deviation) continue;
        hit = r;
        break;
      }
      if (hit < 0) {
        hit = reps.length;
        reps.push({ x: p.x, y: p.y, z: p.z, d: p.d, area: 0, sx: 0, sy: 0, sz: 0, sd: 0 });
      }
      var rep = reps[hit];
      rep.sx += p.x * p.area; rep.sy += p.y * p.area; rep.sz += p.z * p.area;
      rep.sd += p.d * p.area; rep.area += p.area;
      of[i] = hit;
    }
    for (var m = 0; m < reps.length; m++) {
      var rp = reps[m];
      if (!(rp.area > 0)) continue;
      var len = Math.sqrt(rp.sx * rp.sx + rp.sy * rp.sy + rp.sz * rp.sz);
      if (len > 0) { rp.x = rp.sx / len; rp.y = rp.sy / len; rp.z = rp.sz / len; }
      rp.d = rp.sd / rp.area;
    }
    for (var j = 0; j < planes.length; j++) {
      var target = reps[of[j]];
      planes[j].x = target.x; planes[j].y = target.y; planes[j].z = target.z;
      planes[j].d = target.d;
    }
  }

  // ---------------------------------------------------------------------------
  // Putting the vertices back on the corners
  // ---------------------------------------------------------------------------

  /**
   * Every vertex belongs to the faces that meet there, and in the solid it came
   * from it sat exactly where those planes cross. Solve for that point: three
   * independent planes give a corner, two give a point on the edge between
   * them, one gives the foot on the face. More than three and the planes rarely
   * meet at one point at all, so the answer is the least-squares one — the spot
   * that misses all of them by as little as possible.
   *
   * Directions closer together than `minDihedral` count once, which is what
   * keeps the solve honest: two nearly parallel planes cross in a line whose
   * position is mostly noise, and treating them as one direction leaves the
   * vertex where it was instead of flinging it down that line.
   */
  function snapVertices(mesh, seg, o) {
    var V = mesh.vertices;
    var start = new Int32Array(V + 1);
    for (var t = 0; t < mesh.count; t++) {
      if (seg.face[t] < 0) continue;
      for (var k = 0; k < 3; k++) start[mesh.ids[t * 3 + k] + 1]++;
    }
    for (var i = 0; i < V; i++) start[i + 1] += start[i];
    var list = new Int32Array(start[V]);
    var cursor = start.slice(0, V);
    for (var t2 = 0; t2 < mesh.count; t2++) {
      var f = seg.face[t2];
      if (f < 0) continue;
      for (var k2 = 0; k2 < 3; k2++) list[cursor[mesh.ids[t2 * 3 + k2]]++] = f;
    }

    var sinMin = Math.sin(o.minDihedral * Math.PI / 180);
    var moved = 0, worst = 0;
    var here = [];

    for (var v = 0; v < V; v++) {
      here.length = 0;
      for (var e = start[v]; e < start[v + 1]; e++) {
        var p = seg.planes[list[e]], dup = false;
        for (var d = 0; d < here.length; d++) {
          var q = here[d];
          if (p.x * q.x + p.y * q.y + p.z * q.z > 0.9999 && Math.abs(p.d - q.d) < 1e-9) { dup = true; break; }
        }
        if (!dup) here.push(p);
      }
      if (!here.length) continue;

      var solved = solveVertex(here, mesh.vx[v], mesh.vy[v], mesh.vz[v], sinMin);
      if (!solved) continue;
      var dx = solved[0] - mesh.vx[v], dy = solved[1] - mesh.vy[v], dz = solved[2] - mesh.vz[v];
      var travel = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (travel > o.maxMove) {
        // The planes here cross somewhere improbable. Settle for the foot on
        // the biggest face rather than moving the vertex halfway across the part.
        var big = here[0];
        for (var b = 1; b < here.length; b++) if (here[b].area > big.area) big = here[b];
        var gap = big.x * mesh.vx[v] + big.y * mesh.vy[v] + big.z * mesh.vz[v] - big.d;
        solved = [mesh.vx[v] - big.x * gap, mesh.vy[v] - big.y * gap, mesh.vz[v] - big.z * gap];
        travel = Math.abs(gap);
      }
      mesh.vx[v] = solved[0]; mesh.vy[v] = solved[1]; mesh.vz[v] = solved[2];
      if (travel > 0) moved++;
      if (travel > worst) worst = travel;
    }

    return { moved: moved, worst: worst };
  }

  /**
   * Least squares against the planes at one vertex, solved in the subspace the
   * planes actually pin down: build an orthonormal basis from their normals,
   * skipping any that adds no new direction, and solve there. What the planes
   * leave free — along a face, along an edge — stays where it was.
   */
  function solveVertex(planes, x0, y0, z0, sinMin) {
    var basis = [];
    for (var i = 0; i < planes.length && basis.length < 3; i++) {
      var rx = planes[i].x, ry = planes[i].y, rz = planes[i].z;
      for (var b = 0; b < basis.length; b++) {
        var dot = rx * basis[b][0] + ry * basis[b][1] + rz * basis[b][2];
        rx -= dot * basis[b][0]; ry -= dot * basis[b][1]; rz -= dot * basis[b][2];
      }
      var len = Math.sqrt(rx * rx + ry * ry + rz * rz);
      if (len > sinMin) basis.push([rx / len, ry / len, rz / len]);
    }
    var k = basis.length;
    if (!k) return null;

    var M = new Float64Array(k * k), r = new Float64Array(k);
    var g = new Float64Array(k);
    for (var p = 0; p < planes.length; p++) {
      var pl = planes[p];
      for (var c = 0; c < k; c++) g[c] = pl.x * basis[c][0] + pl.y * basis[c][1] + pl.z * basis[c][2];
      var miss = pl.d - (pl.x * x0 + pl.y * y0 + pl.z * z0);
      for (var a = 0; a < k; a++) {
        r[a] += g[a] * miss;
        for (var j = 0; j < k; j++) M[a * k + j] += g[a] * g[j];
      }
    }

    var y = solveSmall(M, r, k);
    if (!y) return null;
    var out = [x0, y0, z0];
    for (var m = 0; m < k; m++) {
      out[0] += y[m] * basis[m][0];
      out[1] += y[m] * basis[m][1];
      out[2] += y[m] * basis[m][2];
    }
    return isFinite(out[0]) && isFinite(out[1]) && isFinite(out[2]) ? out : null;
  }

  /** Gaussian elimination with partial pivoting, for k of 1, 2 or 3. */
  function solveSmall(M, r, k) {
    var A = new Float64Array(k * (k + 1));
    for (var i = 0; i < k; i++) {
      for (var j = 0; j < k; j++) A[i * (k + 1) + j] = M[i * k + j];
      A[i * (k + 1) + k] = r[i];
    }
    for (var c = 0; c < k; c++) {
      var pivot = c;
      for (var p = c + 1; p < k; p++) {
        if (Math.abs(A[p * (k + 1) + c]) > Math.abs(A[pivot * (k + 1) + c])) pivot = p;
      }
      var best = A[pivot * (k + 1) + c];
      if (!(Math.abs(best) > 1e-12)) return null;
      if (pivot !== c) {
        for (var s = c; s <= k; s++) {
          var tmp = A[c * (k + 1) + s];
          A[c * (k + 1) + s] = A[pivot * (k + 1) + s];
          A[pivot * (k + 1) + s] = tmp;
        }
      }
      for (var row = c + 1; row < k; row++) {
        var factor = A[row * (k + 1) + c] / A[c * (k + 1) + c];
        if (!factor) continue;
        for (var col = c; col <= k; col++) A[row * (k + 1) + col] -= factor * A[c * (k + 1) + col];
      }
    }
    var out = new Float64Array(k);
    for (var b = k - 1; b >= 0; b--) {
      var sum = A[b * (k + 1) + k];
      for (var q = b + 1; q < k; q++) sum -= A[b * (k + 1) + q] * out[q];
      out[b] = sum / A[b * (k + 1) + b];
      if (!isFinite(out[b])) return null;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Rebuilding each face from its outline
  // ---------------------------------------------------------------------------

  /**
   * A face's outline is the edges its facets do not share with each other.
   * Walk those into closed loops, and hand them back projected onto the face's
   * plane. Nothing is thrown away yet: which points along the outline are real
   * corners cannot be decided one face at a time.
   */
  function faceLoops(mesh, seg, f) {
    var from = seg.start[f], to = seg.start[f + 1];
    var V = mesh.vertices;
    var directed = new Set();
    var i, t, k;

    for (i = from; i < to; i++) {
      t = seg.list[i];
      for (k = 0; k < 3; k++) {
        directed.add(mesh.ids[t * 3 + k] * V + mesh.ids[t * 3 + (k + 1) % 3]);
      }
    }

    var outgoing = new Map();
    var edges = [];
    for (i = from; i < to; i++) {
      t = seg.list[i];
      for (k = 0; k < 3; k++) {
        var a = mesh.ids[t * 3 + k], b = mesh.ids[t * 3 + (k + 1) % 3];
        if (directed.has(b * V + a)) continue;      // the facet next door has it
        var slot = outgoing.get(a);
        if (!slot) { slot = []; outgoing.set(a, slot); }
        slot.push(edges.length / 2);
        edges.push(a, b);
      }
    }
    if (!edges.length) return null;

    var spent = new Uint8Array(edges.length / 2);
    var basis = planeBasis(seg.planes[f]);
    var rings = [];
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
        var next = -1, slots = outgoing.get(at) || [];
        for (var g = 0; g < slots.length; g++) if (!spent[slots[g]]) { next = slots[g]; break; }
        if (next < 0) break;
        spent[next] = 1;
        loop.push(at);
        at = edges[next * 2 + 1];
      }
      // An outline that does not close means the facets here are not a surface.
      // Give up on this face rather than invent a boundary for it.
      if (!closed || loop.length < 3) return null;
      rings.push(project(mesh, loop, basis));
    }
    return rings.length ? rings : null;
  }

  /**
   * A point on an outline is a corner if any one of the faces meeting there
   * turns at it. Deciding that across the whole body rather than face by face
   * is what keeps the rebuild watertight: if a long flat face drops a point as
   * lying on a straight run while the little face on the other side of that
   * edge keeps it, the two no longer meet along the same line and a crack opens
   * that the slicer would go on to fill with air.
   */
  function markCorners(rings, corner) {
    for (var r = 0; r < rings.length; r++) {
      var xy = rings[r].xy, ids = rings[r].ids, n = ids.length;
      var seen = new Set();
      for (var i = 0; i < n; i++) {
        if (seen.has(ids[i])) corner[ids[i]] = 1;   // the outline pinches here
        seen.add(ids[i]);
        var p = (i + n - 1) % n, q = (i + 1) % n;
        var ex = xy[q * 2] - xy[p * 2], ey = xy[q * 2 + 1] - xy[p * 2 + 1];
        var len = Math.sqrt(ex * ex + ey * ey);
        var off = len > 0
          ? Math.abs((xy[i * 2] - xy[p * 2]) * ey - (xy[i * 2 + 1] - xy[p * 2 + 1]) * ex) / len
          : Infinity;
        if (off > COLLINEAR) corner[ids[i]] = 1;
      }
    }
  }

  /** Everything the corners left out was on a straight run. */
  function reduceRing(ring, corner) {
    var keep = [];
    for (var i = 0; i < ring.ids.length; i++) if (corner[ring.ids[i]]) keep.push(i);
    if (keep.length < 3) return null;
    if (keep.length === ring.ids.length) return ring;
    var xy = new Array(keep.length * 2), ids = new Array(keep.length);
    for (var k = 0; k < keep.length; k++) {
      xy[k * 2] = ring.xy[keep[k] * 2];
      xy[k * 2 + 1] = ring.xy[keep[k] * 2 + 1];
      ids[k] = ring.ids[keep[k]];
    }
    return { xy: xy, ids: ids, area: ringArea(xy) };
  }

  /**
   * One outer loop and whatever loops sit directly inside it, triangulated as a
   * face with holes. The triangles come back as vertex indices, not as fresh
   * coordinates: the vertices have already been solved onto their corners, and
   * a face that re-derived them from its own projection would land a hair away
   * from what the face next door derived, which is a crack. Sharing the indices
   * means the two sides cannot disagree.
   */
  function triangulateFace(rings, was, o, earcut, V) {
    // Facets wind outward, so the plane normal came out of them and an outer
    // loop turns the same way: positive area. Anything negative is a hole.
    var outers = [], holes = [];
    var i, j;
    for (i = 0; i < rings.length; i++) (rings[i].area > 0 ? outers : holes).push(rings[i]);
    if (!outers.length) return null;

    for (i = 0; i < holes.length; i++) {
      var owner = -1;
      for (j = 0; j < outers.length; j++) {
        if (!inside(holes[i].xy[0], holes[i].xy[1], outers[j].xy)) continue;
        if (owner < 0 || Math.abs(outers[j].area) < Math.abs(outers[owner].area)) owner = j;
      }
      if (owner < 0) return null;
      (outers[owner].holes || (outers[owner].holes = [])).push(holes[i]);
    }

    var out = [];
    var built = 0;
    for (i = 0; i < outers.length; i++) {
      var ring = outers[i];
      var xy = ring.xy.slice(), ids = ring.ids.slice(), starts = [];
      var kids = ring.holes || [];
      ring.holes = null;
      for (var h = 0; h < kids.length; h++) {
        starts.push(xy.length / 2);
        for (var c = 0; c < kids[h].xy.length; c++) xy.push(kids[h].xy[c]);
        for (var d = 0; d < kids[h].ids.length; d++) ids.push(kids[h].ids[d]);
      }
      var index = earcut(xy, starts.length ? starts : null, 2);
      if (!index.length) return null;
      for (var m = 0; m < index.length; m += 3) {
        var i0 = index[m], i1 = index[m + 1], i2 = index[m + 2];
        var ax = xy[i0 * 2], ay = xy[i0 * 2 + 1];
        var bx = xy[i1 * 2], by = xy[i1 * 2 + 1];
        var cx = xy[i2 * 2], cy = xy[i2 * 2 + 1];
        var twice = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        if (twice === 0) continue;
        built += Math.abs(twice) / 2;
        // Wind every triangle the way the face faces, whichever way earcut
        // handed it back.
        if (twice > 0) out.push(ids[i0], ids[i1], ids[i2]);
        else out.push(ids[i0], ids[i2], ids[i1]);
      }
    }
    if (!out.length) return null;

    // The rebuilt face has to cover what the facets covered, and it has to end
    // where they ended. If it does not, the facets are the safer answer.
    if (was > 0 && Math.abs(built - was) / was > o.maxFaceError) return null;
    if (!outlineIntact(rings, out, V)) return null;
    return out;
  }

  /**
   * Does the rebuilt face end exactly where its outline said it would? A face
   * whose facets are a hair off flat can project onto its own plane as a
   * polygon that crosses itself, and what comes back from triangulating that is
   * a patch with a different edge to the one the face next door is expecting.
   * The test is direct: every edge of the outline is used once by the new
   * triangles, and every edge used once by them is an edge of the outline.
   */
  function outlineIntact(rings, out, V) {
    var used = new Map();
    var i, key;
    for (i = 0; i < out.length; i += 3) {
      for (var k = 0; k < 3; k++) {
        key = out[i + k] * V + out[i + (k + 1) % 3];
        used.set(key, (used.get(key) || 0) + 1);
      }
    }
    var wanted = new Set();
    for (var r = 0; r < rings.length; r++) {
      var ids = rings[r].ids;
      for (i = 0; i < ids.length; i++) {
        key = ids[i] * V + ids[(i + 1) % ids.length];
        if (used.get(key) !== 1 || used.get(ids[(i + 1) % ids.length] * V + ids[i])) return false;
        wanted.add(key);
      }
    }
    var sound = true;
    used.forEach(function (n, k2) {
      if (n === 1 && !used.get(reverseKey(k2, V)) && !wanted.has(k2)) sound = false;
      if (n > 1) sound = false;
    });
    return sound;
  }

  function reverseKey(key, V) {
    var a = Math.floor(key / V);
    return (key - a * V) * V + a;
  }

  /**
   * Every face, rebuilt where it can be and left as facets where it cannot.
   *
   * Two things can push a face back onto its facets, and both of them are
   * catching. A face that falls back keeps every one of its vertices, which
   * puts them beyond the reach of the straight-run pruning and can push the
   * face next door back in turn. And a face whose outline was fine on its own
   * can still lay an edge that some other face has already laid — a seam
   * stitched twice rather than a hole, but not a surface either. So the pass
   * repeats: rebuild, audit the seams of the whole body, hand back whichever
   * faces are quarrelling, and go round again until nobody moves.
   */
  function rebuild(mesh, seg, o) {
    var earcut = root.earcut;
    var corner = new Uint8Array(mesh.vertices);
    var outlines = new Array(seg.count);
    var facets = new Uint8Array(seg.count);
    var built = new Array(seg.count);
    var V = mesh.vertices;
    var f, i;

    function fallback(g) {
      facets[g] = 1;
      built[g] = null;
      keepEveryVertex(mesh, seg, g, corner);
    }

    for (f = 0; f < seg.count; f++) {
      var rings = earcut ? faceLoops(mesh, seg, f) : null;
      outlines[f] = rings;
      if (rings) markCorners(rings, corner);
      else fallback(f);
    }

    for (var round = 0; round < 8; round++) {
      var changed = false;
      for (f = 0; f < seg.count; f++) {
        if (facets[f]) { built[f] = null; continue; }
        var reduced = [];
        var lost = false;
        for (i = 0; i < outlines[f].length; i++) {
          var ring = reduceRing(outlines[f][i], corner);
          if (!ring) { lost = true; break; }
          reduced.push(ring);
        }
        var area = 0;
        for (i = seg.start[f]; i < seg.start[f + 1]; i++) area += mesh.area[seg.list[i]];
        var tris = lost ? null : triangulateFace(reduced, area, o, earcut, V);
        built[f] = tris || null;
        if (!tris) { fallback(f); changed = true; }
      }
      if (changed) continue;
      if (!repairSeams(mesh, seg, built, facets, fallback, V)) break;
    }

    var out = [];
    var rebuilt = 0, kept = 0;
    for (f = 0; f < seg.count; f++) {
      if (built[f]) {
        rebuilt++;
        for (i = 0; i < built[f].length; i++) out.push(built[f][i]);
      } else {
        kept++;
        for (i = seg.start[f]; i < seg.start[f + 1]; i++) {
          var t = seg.list[i];
          out.push(mesh.ids[t * 3], mesh.ids[t * 3 + 1], mesh.ids[t * 3 + 2]);
        }
      }
    }
    return { indices: out, rebuilt: rebuilt, keptFacets: kept };
  }

  /**
   * Hand back every face that shares an edge with the wrong number of others.
   * A face's own facets are a piece of the mesh that came in, so giving one
   * back cannot make the seams worse — and when every face along a bad edge has
   * already been given back, the fault was in the mesh to begin with and there
   * is nothing here to fix.
   */
  function repairSeams(mesh, seg, built, facets, fallback, V) {
    var edges = new Map();
    var f, i, k, a, b, key, list;

    function note(x, y, face) {
      key = x < y ? x * V + y : y * V + x;
      list = edges.get(key);
      if (!list) { list = []; edges.set(key, list); }
      list.push(face);
    }

    for (f = 0; f < seg.count; f++) {
      if (built[f]) {
        for (i = 0; i < built[f].length; i += 3) {
          for (k = 0; k < 3; k++) {
            a = built[f][i + k]; b = built[f][i + (k + 1) % 3];
            if (a !== b) note(a, b, f);
          }
        }
      } else {
        for (i = seg.start[f]; i < seg.start[f + 1]; i++) {
          var t = seg.list[i];
          for (k = 0; k < 3; k++) note(mesh.ids[t * 3 + k], mesh.ids[t * 3 + (k + 1) % 3], f);
        }
      }
    }

    var guilty = [];
    edges.forEach(function (faces) {
      if (faces.length === 2) return;
      for (var j = 0; j < faces.length; j++) if (!facets[faces[j]]) guilty.push(faces[j]);
    });
    if (!guilty.length) return false;
    for (var g = 0; g < guilty.length; g++) if (!facets[guilty[g]]) fallback(guilty[g]);
    return true;
  }

  function keepEveryVertex(mesh, seg, f, corner) {
    for (var i = seg.start[f]; i < seg.start[f + 1]; i++) {
      var t = seg.list[i];
      corner[mesh.ids[t * 3]] = 1;
      corner[mesh.ids[t * 3 + 1]] = 1;
      corner[mesh.ids[t * 3 + 2]] = 1;
    }
  }

  /** Two axes in the plane, turning the way the plane faces. */
  function planeBasis(p) {
    // Cross the normal with whichever world axis it leans on least.
    var ax = Math.abs(p.x) < 0.9 ? 1 : 0, ay = 1 - ax;
    var ux = p.y * 0 - p.z * ay;
    var uy = p.z * ax - p.x * 0;
    var uz = p.x * ay - p.y * ax;
    var len = Math.sqrt(ux * ux + uy * uy + uz * uz);
    if (!(len > 0)) { ux = 1; uy = 0; uz = 0; len = 1; }
    ux /= len; uy /= len; uz /= len;
    // v = n x u, which makes u x v the normal again: a loop that turns
    // anticlockwise in (u, v) is one that faces the way the plane does.
    return {
      ux: ux, uy: uy, uz: uz,
      vx: p.y * uz - p.z * uy, vy: p.z * ux - p.x * uz, vz: p.x * uy - p.y * ux,
      ox: p.x * p.d, oy: p.y * p.d, oz: p.z * p.d
    };
  }

  function project(mesh, loop, b) {
    var xy = new Array(loop.length * 2);
    for (var i = 0; i < loop.length; i++) {
      var id = loop[i];
      var dx = mesh.vx[id] - b.ox, dy = mesh.vy[id] - b.oy, dz = mesh.vz[id] - b.oz;
      xy[i * 2] = dx * b.ux + dy * b.uy + dz * b.uz;
      xy[i * 2 + 1] = dx * b.vx + dy * b.vy + dz * b.vz;
    }
    return { xy: xy, ids: loop.slice(), area: ringArea(xy) };
  }

  function ringArea(xy) {
    var sum = 0, n = xy.length / 2;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      sum += (xy[j * 2] - xy[i * 2]) * (xy[j * 2 + 1] + xy[i * 2 + 1]);
    }
    return sum / 2;
  }

  /** Straight runs need two points, not forty. */
  function dropCollinear(ring) {
    var xy = ring.xy, ids = ring.ids, keep = [];
    var n = xy.length / 2;
    if (n < 3) return null;
    var px = xy[(n - 1) * 2], py = xy[(n - 1) * 2 + 1];
    for (var i = 0; i < n; i++) {
      var cx = xy[i * 2], cy = xy[i * 2 + 1];
      var nx = xy[((i + 1) % n) * 2], ny = xy[((i + 1) % n) * 2 + 1];
      var ex = nx - px, ey = ny - py;
      var len = Math.sqrt(ex * ex + ey * ey);
      var off = len > 0 ? Math.abs((cx - px) * ey - (cy - py) * ex) / len : 0;
      if (off > COLLINEAR || len === 0) { keep.push(i); px = cx; py = cy; }
    }
    if (keep.length < 3) return null;
    if (keep.length === n) return ring;
    var outXY = new Array(keep.length * 2), outIds = new Array(keep.length);
    for (var k = 0; k < keep.length; k++) {
      outXY[k * 2] = xy[keep[k] * 2];
      outXY[k * 2 + 1] = xy[keep[k] * 2 + 1];
      outIds[k] = ids[keep[k]];
    }
    return { xy: outXY, ids: outIds, area: ringArea(outXY) };
  }

  function inside(x, y, xy) {
    var n = xy.length / 2, hit = false;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      var yi = xy[i * 2 + 1], yj = xy[j * 2 + 1];
      if ((yi > y) === (yj > y)) continue;
      var xi = xy[i * 2], xj = xy[j * 2];
      if (x < xi + (y - yi) / (yj - yi) * (xj - xi)) hit = !hit;
    }
    return hit;
  }

  // ---------------------------------------------------------------------------
  // Measurements
  // ---------------------------------------------------------------------------

  function volumeOf(positions) {
    var sum = 0;
    for (var i = 0; i < positions.length; i += 9) {
      sum += positions[i] * (positions[i + 4] * positions[i + 8] - positions[i + 5] * positions[i + 7]) -
             positions[i + 1] * (positions[i + 3] * positions[i + 8] - positions[i + 5] * positions[i + 6]) +
             positions[i + 2] * (positions[i + 3] * positions[i + 7] - positions[i + 4] * positions[i + 6]);
    }
    return sum / 6;
  }

  /** Every edge used twice and no more: the body holds water. */
  function watertight(positions, weld) {
    var grid = 1 / weld;
    var lookup = new Map();
    var ids = [];
    for (var i = 0; i < positions.length; i += 3) {
      var key = Math.round(positions[i] * grid) + '_' +
                Math.round(positions[i + 1] * grid) + '_' +
                Math.round(positions[i + 2] * grid);
      var id = lookup.get(key);
      if (id === undefined) { id = lookup.size; lookup.set(key, id); }
      ids.push(id);
    }
    var edges = new Map();
    for (var t = 0; t < ids.length; t += 3) {
      // A triangle flattened onto a single point covers nothing and seals
      // nothing; counted, its doubled edge would read as a tear that is not
      // there. It is left out of the accounting entirely.
      if (ids[t] === ids[t + 1] || ids[t + 1] === ids[t + 2] || ids[t] === ids[t + 2]) continue;
      for (var k = 0; k < 3; k++) {
        var a = ids[t + k], b = ids[t + (k + 1) % 3];
        var ek = a < b ? a + ':' + b : b + ':' + a;
        edges.set(ek, (edges.get(ek) || 0) + 1);
      }
    }
    var sound = true;
    edges.forEach(function (n) { if (n !== 2) sound = false; });
    return sound;
  }

  var SHARP = 20;   // deg — a fold this deep is an edge of the part, not the
                    // tessellation of something curved

  /**
   * How flat the mesh is, how far its facets sit from the faces they were put
   * in, and — the measurement that tells a machined part from a scan — how much
   * of the length where two faces meet is a real edge rather than the seam
   * between two facets approximating a curve. A box folds at 90 degrees
   * wherever its faces meet; a sphere folds by a couple of degrees everywhere,
   * however many faces it is carved into.
   */
  function faceStats(mesh, seg) {
    var planar = 0, total = 0, worst = 0;
    for (var f = 0; f < seg.count; f++) {
      var members = seg.start[f + 1] - seg.start[f];
      for (var i = seg.start[f]; i < seg.start[f + 1]; i++) {
        var t = seg.list[i];
        total += mesh.area[t];
        if (members > 1) planar += mesh.area[t];
        var p = seg.planes[f];
        for (var k = 0; k < 3; k++) {
          var id = mesh.ids[t * 3 + k];
          var gap = Math.abs(mesh.vx[id] * p.x + mesh.vy[id] * p.y + mesh.vz[id] * p.z - p.d);
          if (gap > worst) worst = gap;
        }
      }
    }

    var cosSharp = Math.cos(SHARP * Math.PI / 180);
    var between = 0, sharp = 0;
    for (var e = 0; e < mesh.pairA.length; e++) {
      var fa = seg.face[mesh.pairA[e]], fb = seg.face[mesh.pairB[e]];
      if (fa < 0 || fb < 0 || fa === fb) continue;
      var a = seg.planes[fa], b = seg.planes[fb];
      between += mesh.pairLen[e];
      if (a.x * b.x + a.y * b.y + a.z * b.z < cosSharp) sharp += mesh.pairLen[e];
    }

    return {
      faces: seg.count,
      planarArea: total > 0 ? planar / total : 0,
      sharpness: between > 0 ? sharp / between : 0,
      deviation: worst
    };
  }

  /** Is this the mesh of a prismatic part at all, or a scan pretending to be one? */
  function verdictOf(stats, triangles) {
    if (!triangles) return 'empty';
    if (stats.sharpness >= 0.6 && stats.planarArea >= 0.5) return 'prismatic';
    if (stats.sharpness < 0.25) return 'organic';
    return 'mixed';
  }

  // ---------------------------------------------------------------------------
  // The two things worth calling
  // ---------------------------------------------------------------------------

  /**
   * What the mesh looks like without touching it: how many flat faces are in
   * there, how much of the surface they cover, and whether prismatic is the
   * right idea. Cheap enough to run when a panel opens.
   */
  function analyze(positions, options) {
    var o = settings(options);
    var mesh = buildMesh(positions, o);
    if (!mesh.count) {
      return {
        triangles: 0, faces: 0, planarArea: 0, sharpness: 0, deviation: 0,
        verdict: 'empty', watertight: false, openEdges: 0
      };
    }
    var seg = segment(mesh, o);
    var stats = faceStats(mesh, seg);
    return {
      triangles: mesh.count,
      faces: stats.faces,
      planarArea: stats.planarArea,
      sharpness: stats.sharpness,
      deviation: stats.deviation,
      openEdges: mesh.openEdges,
      watertight: mesh.openEdges === 0 && mesh.nonManifold === 0,
      verdict: verdictOf(stats, mesh.count)
    };
  }

  /**
   * The conversion. Returns the rebuilt soup along with everything needed to
   * decide whether to trust it — and `ok: false` with the original geometry
   * when the rebuild did not survive its own checks.
   */
  function toSolid(positions, options) {
    var o = settings(options);
    var before = volumeOf(positions);
    var mesh = buildMesh(positions, o);
    if (mesh.count < 4) {
      return reject(positions, 'There is not enough geometry here to rebuild.', before);
    }

    var seg = segment(mesh, o);
    var stats = faceStats(mesh, seg);
    var verdict = verdictOf(stats, mesh.count);
    var snap = snapVertices(mesh, seg, o);

    var faces = rebuild(mesh, seg, o);
    var out = faces.indices;

    var result = new Float32Array(out.length * 3);
    var written = 0;
    for (var k = 0; k < out.length; k += 3) {
      var a = out[k], b = out[k + 1], c = out[k + 2];
      // A triangle naming the same vertex twice is not a triangle. A merely
      // thin one is left alone: it carries no surface either, but dropping it
      // would take an edge out of the body with it and open a gap where the
      // slicer would then find air.
      if (a === b || b === c || a === c) continue;
      var o3 = written * 9;
      result[o3] = mesh.vx[a]; result[o3 + 1] = mesh.vy[a]; result[o3 + 2] = mesh.vz[a];
      result[o3 + 3] = mesh.vx[b]; result[o3 + 4] = mesh.vy[b]; result[o3 + 5] = mesh.vz[b];
      result[o3 + 6] = mesh.vx[c]; result[o3 + 7] = mesh.vy[c]; result[o3 + 8] = mesh.vz[c];
      written++;
    }
    result = result.subarray(0, written * 9);

    var after = volumeOf(result);
    var error = Math.abs(before) > 1e-9 ? Math.abs(after - before) / Math.abs(before) : 0;
    var sealedBefore = mesh.openEdges === 0 && mesh.nonManifold === 0;
    var sealed = watertight(result, o.weld);

    var report = {
      positions: result,
      ok: true,
      reason: null,
      verdict: verdict,
      faces: seg.count,
      rebuilt: faces.rebuilt,
      keptFacets: faces.keptFacets,
      triangles: written,
      trianglesBefore: mesh.sourceCount,
      planarArea: stats.planarArea,
      sharpness: stats.sharpness,
      deviation: stats.deviation,
      moved: snap.worst,
      volume: after,
      volumeBefore: before,
      volumeError: error,
      watertight: sealed,
      watertightBefore: sealedBefore
    };

    if (!written) return reject(positions, 'The rebuild came back empty.', before, report);
    if (error > o.maxVolumeError) {
      return reject(positions, 'The rebuilt body is ' + (error * 100).toFixed(1) +
        '% off the volume of the original, past the ' + (o.maxVolumeError * 100).toFixed(1) +
        '% allowed. Tighten the tolerances, or leave this mesh as it is.', before, report);
    }
    if (sealedBefore && !sealed) {
      return reject(positions, 'The rebuilt body has gaps the original did not.', before, report);
    }
    return report;
  }

  function reject(positions, reason, before, report) {
    report = report || {};
    report.positions = positions;
    report.ok = false;
    report.reason = reason;
    report.volumeBefore = before;
    if (report.triangles == null) report.triangles = (positions.length / 9) | 0;
    if (report.trianglesBefore == null) report.trianglesBefore = (positions.length / 9) | 0;
    if (report.faces == null) report.faces = 0;
    return report;
  }

  root.OrcaPrismatic = {
    DEFAULTS: DEFAULTS,
    analyze: analyze,
    toSolid: toSolid,
    volumeOf: volumeOf,
    watertight: watertight
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.OrcaPrismatic;
})(typeof globalThis !== 'undefined' ? globalThis : window);
