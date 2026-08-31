/**
 * Orca Web Slicer — mesh manipulation.
 *
 * Split a model into its separate parts, and cut one with a horizontal plane.
 * Both work on the same flat Float32Array of triangle vertices the loaders and
 * the slicer use, so nothing else in the pipeline has to know they happened.
 *
 * Capping a cut needs OrcaEngineGeom (for the cross-section) and earcut (to
 * triangulate it); without them the cut still works, it just leaves the face
 * open — which the slicer handles fine, since it only ever intersects surfaces.
 */
(function (root) {
  'use strict';

  var WELD = 1e4;   // 0.1 µm grid for treating two vertices as the same point

  // ---------------------------------------------------------------------------
  // Split into connected parts
  // ---------------------------------------------------------------------------

  /**
   * Group triangles into connected components by welded vertex position, the
   * way "split to objects" works in every slicer: one STL holding six separate
   * bodies becomes six models you can move independently.
   */
  function splitParts(positions, maxParts) {
    var triCount = (positions.length / 9) | 0;
    if (triCount < 2) return [positions];

    var ids = new Int32Array(triCount * 3);
    var lookup = new Map();
    var nextId = 0;

    for (var t = 0; t < triCount; t++) {
      for (var v = 0; v < 3; v++) {
        var o = t * 9 + v * 3;
        var key = Math.round(positions[o] * WELD) + '_' +
                  Math.round(positions[o + 1] * WELD) + '_' +
                  Math.round(positions[o + 2] * WELD);
        var id = lookup.get(key);
        if (id === undefined) { id = nextId++; lookup.set(key, id); }
        ids[t * 3 + v] = id;
      }
    }

    var parent = new Int32Array(nextId);
    for (var i = 0; i < nextId; i++) parent[i] = i;
    function find(x) {
      while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
      return x;
    }
    function union(a, b) {
      var ra = find(a), rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    }
    for (var t2 = 0; t2 < triCount; t2++) {
      union(ids[t2 * 3], ids[t2 * 3 + 1]);
      union(ids[t2 * 3 + 1], ids[t2 * 3 + 2]);
    }

    var buckets = new Map();
    for (var t3 = 0; t3 < triCount; t3++) {
      var rootId = find(ids[t3 * 3]);
      var bucket = buckets.get(rootId);
      if (!bucket) { bucket = []; buckets.set(rootId, bucket); }
      bucket.push(t3);
    }
    if (buckets.size < 2) return [positions];

    var parts = [];
    buckets.forEach(function (tris) {
      var out = new Float32Array(tris.length * 9);
      for (var k = 0; k < tris.length; k++) {
        out.set(positions.subarray(tris[k] * 9, tris[k] * 9 + 9), k * 9);
      }
      parts.push(out);
    });

    parts.sort(function (a, b) { return b.length - a.length; });
    if (maxParts && parts.length > maxParts) parts = parts.slice(0, maxParts);
    return parts;
  }

  // ---------------------------------------------------------------------------
  // Cut with a horizontal plane
  // ---------------------------------------------------------------------------

  function lerp(positions, ia, ib, z) {
    var az = positions[ia + 2], bz = positions[ib + 2];
    var t = (z - az) / (bz - az);
    return [
      positions[ia] + (positions[ib] - positions[ia]) * t,
      positions[ia + 1] + (positions[ib + 1] - positions[ia + 1]) * t,
      z
    ];
  }

  /**
   * Split a triangle soup at `z`. Triangles straddling the plane are clipped, so
   * both halves keep clean geometry rather than a ragged sawtooth.
   */
  function cutAtZ(positions, z, options) {
    options = options || {};
    var above = [], below = [];
    var triCount = (positions.length / 9) | 0;
    var EPS = 1e-7;

    function push(target, a, b, c) {
      target.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    }
    function vertex(o) { return [positions[o], positions[o + 1], positions[o + 2]]; }

    for (var t = 0; t < triCount; t++) {
      var base = t * 9;
      var d = [positions[base + 2] - z, positions[base + 5] - z, positions[base + 8] - z];
      for (var k = 0; k < 3; k++) if (Math.abs(d[k]) < EPS) d[k] = 0;

      var up = (d[0] > 0 ? 1 : 0) + (d[1] > 0 ? 1 : 0) + (d[2] > 0 ? 1 : 0);
      var down = (d[0] < 0 ? 1 : 0) + (d[1] < 0 ? 1 : 0) + (d[2] < 0 ? 1 : 0);

      if (down === 0) { push(above, vertex(base), vertex(base + 3), vertex(base + 6)); continue; }
      if (up === 0) { push(below, vertex(base), vertex(base + 3), vertex(base + 6)); continue; }

      // Rotate so the lone vertex on its own side comes first.
      var order = [0, 1, 2];
      for (var r = 0; r < 3; r++) {
        var lone = order[r], o1 = order[(r + 1) % 3], o2 = order[(r + 2) % 3];
        if ((d[lone] > 0 && d[o1] <= 0 && d[o2] <= 0) || (d[lone] < 0 && d[o1] >= 0 && d[o2] >= 0)) {
          var A = base + lone * 3, B = base + o1 * 3, C = base + o2 * 3;
          var ab = lerp(positions, A, B, z);
          var ac = lerp(positions, A, C, z);
          var soloUp = d[lone] > 0;
          var solo = soloUp ? above : below;
          var pair = soloUp ? below : above;
          push(solo, vertex(A), ab, ac);
          push(pair, ab, vertex(B), vertex(C));
          push(pair, ab, vertex(C), ac);
          break;
        }
      }
    }

    var result = {
      above: new Float32Array(above),
      below: new Float32Array(below)
    };

    if (options.cap !== false) capCut(result, positions, z);
    return result;
  }

  /**
   * Close both halves with a flat face, so a cut model reads as solid instead of
   * a shell. Silently skipped when the geometry helpers are not loaded.
   */
  function capCut(result, positions, z) {
    var G = root.OrcaEngineGeom;
    var earcut = root.earcut;
    if (!G || !earcut) return;

    var layers = G.sliceMesh(positions, [z]);
    var section = layers && layers[0];
    if (!section || !section.length) return;

    var islands = G.toIslands(section);
    var top = [], bottom = [];

    for (var i = 0; i < islands.length; i++) {
      var rings = [islands[i].outer].concat(islands[i].holes);
      var flat = [], holeIndices = [];
      for (var r = 0; r < rings.length; r++) {
        if (r > 0) holeIndices.push(flat.length / 2);
        for (var p = 0; p < rings[r].length; p++) {
          flat.push(rings[r][p].X / G.SCALE, rings[r][p].Y / G.SCALE);
        }
      }
      var indices = earcut(flat, holeIndices.length ? holeIndices : null, 2);
      for (var k = 0; k < indices.length; k += 3) {
        var a = indices[k] * 2, b = indices[k + 1] * 2, c = indices[k + 2] * 2;
        // Upper half gets a floor (normal down), lower half a lid (normal up).
        bottom.push(flat[a], flat[a + 1], z, flat[b], flat[b + 1], z, flat[c], flat[c + 1], z);
        top.push(flat[a], flat[a + 1], z, flat[c], flat[c + 1], z, flat[b], flat[b + 1], z);
      }
    }

    result.above = concat(result.above, new Float32Array(top));
    result.below = concat(result.below, new Float32Array(bottom));
  }

  function concat(a, b) {
    if (!b.length) return a;
    if (!a.length) return b;
    var out = new Float32Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  root.OrcaMeshTools = {
    splitParts: splitParts,
    cutAtZ: cutAtZ,
    concat: concat
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.OrcaMeshTools;
})(typeof globalThis !== 'undefined' ? globalThis : window);
