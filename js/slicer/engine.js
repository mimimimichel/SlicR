/**
 * Orca Web Slicer — Slicing engine.
 *
 * Pure computation, no DOM. Runs inside a Web Worker (and under Node for tests).
 * Requires ClipperLib (js/vendor/clipper.js) to be loaded first.
 *
 * Coordinate system: printer space. X/Y on the bed, Z up, Z=0 is the bed surface.
 * Internally all 2D polygon work happens in integer "clipper units" = micrometres.
 */
(function (root) {
  'use strict';

  var ClipperLib = root.ClipperLib || (typeof require === 'function' ? require('../vendor/clipper.js') : null);
  if (!ClipperLib) throw new Error('ClipperLib is required by the slicing engine');

  var SCALE = 1000;                 // mm -> clipper units
  var NZ = ClipperLib.PolyFillType.pftNonZero;
  var CT = ClipperLib.ClipType;
  var PT = ClipperLib.PolyType;

  function mm(v) { return Math.round(v * SCALE); }
  function unmm(v) { return v / SCALE; }

  // ---------------------------------------------------------------------------
  // Clipper helpers
  // ---------------------------------------------------------------------------

  function boolOp(type, subject, clip) {
    if (!subject || !subject.length) return type === CT.ctUnion && clip ? copyPaths(clip) : [];
    if (!clip || !clip.length) {
      if (type === CT.ctIntersection) return [];
      return copyPaths(subject);
    }
    var c = new ClipperLib.Clipper();
    c.AddPaths(subject, PT.ptSubject, true);
    c.AddPaths(clip, PT.ptClip, true);
    var out = new ClipperLib.Paths();
    c.Execute(type, out, NZ, NZ);
    return out;
  }

  /**
   * Non-zero point-in-region test, matching how every other stage reads these
   * polygons. A point on a boundary counts as inside.
   */
  function pointInPaths(pt, paths) {
    if (!paths || !paths.length) return false;
    var winding = 0;
    for (var i = 0; i < paths.length; i++) {
      var where = ClipperLib.Clipper.PointInPolygon(pt, paths[i]);
      if (where === 0) continue;
      if (where === -1) return true;                       // on the edge
      winding += ClipperLib.Clipper.Orientation(paths[i]) ? 1 : -1;
    }
    return winding !== 0;
  }

  function unite(a, b) { return boolOp(CT.ctUnion, a, b); }
  function subtract(a, b) { return boolOp(CT.ctDifference, a, b); }
  function intersect(a, b) { return boolOp(CT.ctIntersection, a, b); }

  function uniteAll(list) {
    var nonEmpty = [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].length) nonEmpty.push(list[i]);
    if (!nonEmpty.length) return [];
    if (nonEmpty.length === 1) return copyPaths(nonEmpty[0]);
    var c = new ClipperLib.Clipper();
    c.AddPaths(nonEmpty[0], PT.ptSubject, true);
    for (var j = 1; j < nonEmpty.length; j++) c.AddPaths(nonEmpty[j], PT.ptClip, true);
    var out = new ClipperLib.Paths();
    c.Execute(CT.ctUnion, out, NZ, NZ);
    return out;
  }

  function copyPaths(paths) {
    var out = [];
    for (var i = 0; i < paths.length; i++) {
      var p = paths[i], q = new Array(p.length);
      for (var j = 0; j < p.length; j++) q[j] = { X: p[j].X, Y: p[j].Y };
      out.push(q);
    }
    return out;
  }

  /** Offset closed polygons by `deltaMm` (negative shrinks). */
  function offsetPaths(paths, deltaMm, joinType) {
    if (!paths || !paths.length) return [];
    if (deltaMm === 0) return copyPaths(paths);
    var co = new ClipperLib.ClipperOffset(2, 0.25 * SCALE);
    co.AddPaths(paths, joinType || ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
    var out = new ClipperLib.Paths();
    co.Execute(out, deltaMm * SCALE);
    return out;
  }

  /** Remove self-intersections and enforce consistent winding. */
  function simplify(paths) {
    if (!paths || !paths.length) return [];
    var s = ClipperLib.Clipper.SimplifyPolygons(paths, NZ);
    return ClipperLib.Clipper.CleanPolygons(s, 0.002 * SCALE);
  }

  function pathArea(path) { return Math.abs(ClipperLib.Clipper.Area(path)) / (SCALE * SCALE); }

  function totalArea(paths) {
    var a = 0;
    for (var i = 0; i < paths.length; i++) a += ClipperLib.Clipper.Area(paths[i]);
    return Math.abs(a) / (SCALE * SCALE);
  }

  /** Drop islands whose area is below `minAreaMm2`. */
  function dropTinyIslands(paths, minAreaMm2) {
    if (!paths || !paths.length) return [];
    var tree = new ClipperLib.PolyTree();
    var c = new ClipperLib.Clipper();
    c.AddPaths(paths, PT.ptSubject, true);
    c.Execute(CT.ctUnion, tree, NZ, NZ);
    var kept = [];
    var islands = extractIslands(tree);
    for (var i = 0; i < islands.length; i++) {
      if (pathArea(islands[i].outer) < minAreaMm2) continue;
      kept.push(islands[i].outer);
      for (var h = 0; h < islands[i].holes.length; h++) kept.push(islands[i].holes[h]);
    }
    return kept;
  }

  /** Split a region into islands: { outer, holes[] }, each with its own contours. */
  function toIslands(paths) {
    if (!paths || !paths.length) return [];
    var tree = new ClipperLib.PolyTree();
    var c = new ClipperLib.Clipper();
    c.AddPaths(paths, PT.ptSubject, true);
    c.Execute(CT.ctUnion, tree, NZ, NZ);
    return extractIslands(tree);
  }

  function extractIslands(tree) {
    var islands = [];
    function walkOuter(node) {
      var island = { outer: node.Contour(), holes: [] };
      var children = node.Childs();
      for (var i = 0; i < children.length; i++) {
        island.holes.push(children[i].Contour());
        var grand = children[i].Childs();
        for (var j = 0; j < grand.length; j++) walkOuter(grand[j]);
      }
      islands.push(island);
    }
    var top = tree.Childs();
    for (var k = 0; k < top.length; k++) walkOuter(top[k]);
    return islands;
  }

  function islandPaths(island) { return [island.outer].concat(island.holes); }

  /** Clip open polylines against a closed region. Returns arrays of points. */
  function clipLinesToRegion(lines, region) {
    if (!lines.length || !region.length) return [];
    var c = new ClipperLib.Clipper();
    c.AddPaths(lines, PT.ptSubject, false);
    c.AddPaths(region, PT.ptClip, true);
    var tree = new ClipperLib.PolyTree();
    c.Execute(CT.ctIntersection, tree, NZ, NZ);
    return ClipperLib.Clipper.OpenPathsFromPolyTree(tree);
  }

  /** The parts of open polylines that fall OUTSIDE a closed region. */
  function clipLinesOutsideRegion(lines, region) {
    if (!lines.length) return [];
    if (!region.length) return lines.slice();
    var c = new ClipperLib.Clipper();
    c.AddPaths(lines, PT.ptSubject, false);
    c.AddPaths(region, PT.ptClip, true);
    var tree = new ClipperLib.PolyTree();
    c.Execute(CT.ctDifference, tree, NZ, NZ);
    return ClipperLib.Clipper.OpenPathsFromPolyTree(tree);
  }

  function pathsBBox(paths) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < paths.length; i++) {
      var p = paths[i];
      for (var j = 0; j < p.length; j++) {
        if (p[j].X < minX) minX = p[j].X;
        if (p[j].X > maxX) maxX = p[j].X;
        if (p[j].Y < minY) minY = p[j].Y;
        if (p[j].Y > maxY) maxY = p[j].Y;
      }
    }
    return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
  }

  // ---------------------------------------------------------------------------
  // Mesh -> per-layer contours
  // ---------------------------------------------------------------------------

  /**
   * Intersect a triangle soup with a set of horizontal planes.
   * `positions` is a flat Float32Array/Array of x,y,z triplets, 3 per triangle.
   * Returns an array (one entry per plane) of clipper Paths.
   */
  function sliceMesh(positions, planes, onProgress) {
    var triCount = (positions.length / 9) | 0;
    var minZ = new Float32Array(triCount);
    var maxZ = new Float32Array(triCount);
    var order = new Int32Array(triCount);

    for (var t = 0; t < triCount; t++) {
      var o = t * 9;
      var z0 = positions[o + 2], z1 = positions[o + 5], z2 = positions[o + 8];
      minZ[t] = Math.min(z0, z1, z2);
      maxZ[t] = Math.max(z0, z1, z2);
      order[t] = t;
    }
    var orderArr = Array.prototype.slice.call(order);
    orderArr.sort(function (a, b) { return minZ[a] - minZ[b]; });

    var active = [];
    var cursor = 0;
    var result = new Array(planes.length);

    for (var L = 0; L < planes.length; L++) {
      var z = planes[L];
      // Which triangles this plane could touch. The margin matters: a plane
      // that lands a hair above a ring of vertices — which is what happens
      // whenever the layer height divides into the model's own spacing, and
      // that is most models — would otherwise drop every triangle below the
      // ring, while every triangle above it contributes nothing (its on-plane
      // vertices are counted as above, just below). The layer came out empty,
      // and the print had a hole in the middle of it.
      while (cursor < triCount && minZ[orderArr[cursor]] <= z + EPS) active.push(orderArr[cursor++]);
      for (var a = active.length - 1; a >= 0; a--) {
        if (maxZ[active[a]] < z - EPS) { active[a] = active[active.length - 1]; active.pop(); }
      }
      result[L] = contoursAtZ(positions, active, z);
      if (onProgress && (L & 15) === 0) onProgress(L / planes.length);
    }
    return result;
  }

  var EPS = 1e-7;

  function contoursAtZ(positions, triIndices, z) {
    // Collect oriented segments.
    var segs = [];
    for (var i = 0; i < triIndices.length; i++) {
      var o = triIndices[i] * 9;
      var ax = positions[o], ay = positions[o + 1], az = positions[o + 2];
      var bx = positions[o + 3], by = positions[o + 4], bz = positions[o + 5];
      var cx = positions[o + 6], cy = positions[o + 7], cz = positions[o + 8];

      var da = az - z, db = bz - z, dc = cz - z;
      if (Math.abs(da) < EPS) da = EPS;
      if (Math.abs(db) < EPS) db = EPS;
      if (Math.abs(dc) < EPS) dc = EPS;
      var sa = da > 0, sb = db > 0, sc = dc > 0;
      if (sa === sb && sb === sc) continue;

      var pts = [];
      if (sa !== sb) pts.push(crossEdge(ax, ay, az, bx, by, bz, z));
      if (sb !== sc) pts.push(crossEdge(bx, by, bz, cx, cy, cz, z));
      if (sc !== sa) pts.push(crossEdge(cx, cy, cz, ax, ay, az, z));
      if (pts.length !== 2) continue;

      // Orient so that material stays on the left of the segment:
      // for a CCW contour the outward normal at an edge (dx,dy) is (dy,-dx).
      var nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      var ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      var p = pts[0], q = pts[1];
      var dx = q[0] - p[0], dy = q[1] - p[1];
      if (dx * -ny + dy * nx < 0) { var tmp = p; p = q; q = tmp; }
      if (p[0] === q[0] && p[1] === q[1]) continue;
      segs.push([p[0], p[1], q[0], q[1]]);
    }
    if (!segs.length) return [];
    return stitchSegments(segs);
  }

  /**
   * Interpolate the plane crossing of an edge. Vertices are ordered
   * canonically so both triangles sharing the edge produce bit-identical points.
   */
  function crossEdge(x0, y0, z0, x1, y1, z1, z) {
    if (z0 > z1 || (z0 === z1 && (x0 > x1 || (x0 === x1 && y0 > y1)))) {
      var tx = x0; x0 = x1; x1 = tx;
      var ty = y0; y0 = y1; y1 = ty;
      var tz = z0; z0 = z1; z1 = tz;
    }
    var d = z1 - z0;
    var t = d === 0 ? 0 : (z - z0) / d;
    return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
  }

  var SNAP = 1e4; // 0.1 µm hashing grid
  function key(x, y) { return Math.round(x * SNAP) + '_' + Math.round(y * SNAP); }

  function stitchSegments(segs) {
    var starts = Object.create(null);
    var used = new Uint8Array(segs.length);
    for (var i = 0; i < segs.length; i++) {
      var k = key(segs[i][0], segs[i][1]);
      (starts[k] || (starts[k] = [])).push(i);
    }

    var paths = [];
    for (var s = 0; s < segs.length; s++) {
      if (used[s]) continue;
      used[s] = 1;
      var poly = [[segs[s][0], segs[s][1]], [segs[s][2], segs[s][3]]];
      var cx = segs[s][2], cy = segs[s][3];
      var startKey = key(segs[s][0], segs[s][1]);
      var guard = 0;

      while (guard++ < segs.length + 4) {
        var k2 = key(cx, cy);
        if (k2 === startKey) break;
        var cand = starts[k2], next = -1;
        if (cand) {
          for (var c = 0; c < cand.length; c++) if (!used[cand[c]]) { next = cand[c]; break; }
        }
        if (next < 0) break;
        used[next] = 1;
        cx = segs[next][2]; cy = segs[next][3];
        poly.push([cx, cy]);
      }

      // Force-close small gaps left by non-manifold meshes; drop hopeless chains.
      var gap = Math.hypot(poly[0][0] - cx, poly[0][1] - cy);
      if (gap > 0.5) continue;
      if (poly.length < 3) continue;

      var path = new Array(poly.length);
      for (var p = 0; p < poly.length; p++) path[p] = { X: mm(poly[p][0]), Y: mm(poly[p][1]) };
      paths.push(path);
    }
    return simplify(paths);
  }

  root.OrcaEngineGeom = {
    SCALE: SCALE, mm: mm, unmm: unmm,
    unite: unite, subtract: subtract, intersect: intersect, uniteAll: uniteAll,
    pointInPaths: pointInPaths,
    offsetPaths: offsetPaths, simplify: simplify, copyPaths: copyPaths,
    toIslands: toIslands, islandPaths: islandPaths, dropTinyIslands: dropTinyIslands,
    clipLinesToRegion: clipLinesToRegion, clipLinesOutsideRegion: clipLinesOutsideRegion,
    pathsBBox: pathsBBox,
    totalArea: totalArea, pathArea: pathArea,
    sliceMesh: sliceMesh, ClipperLib: ClipperLib
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);

/**
 * Orca Web Slicer — Infill patterns.
 * All generators return arrays of open polylines (clipper paths) clipped to the region.
 */
(function (root) {
  'use strict';
  var G = root.OrcaEngineGeom;
  var ClipperLib = G.ClipperLib;
  var SCALE = G.SCALE;

  function rotate(x, y, c, s) { return { X: x * c - y * s, Y: x * s + y * c }; }

  /** Parallel lines at `angleDeg`, spaced `spacingMm`, clipped to `region`. */
  function rectilinear(region, spacingMm, angleDeg, phaseMm) {
    if (!region.length || spacingMm <= 0) return [];
    var rad = angleDeg * Math.PI / 180;
    var c = Math.cos(-rad), s = Math.sin(-rad);
    var bb = G.pathsBBox(region);

    // Rotate the bbox corners into line space to know the sweep range.
    var corners = [
      rotate(bb.minX, bb.minY, c, s), rotate(bb.maxX, bb.minY, c, s),
      rotate(bb.maxX, bb.maxY, c, s), rotate(bb.minX, bb.maxY, c, s)
    ];
    var rminX = Infinity, rmaxX = -Infinity, rminY = Infinity, rmaxY = -Infinity;
    for (var i = 0; i < 4; i++) {
      rminX = Math.min(rminX, corners[i].X); rmaxX = Math.max(rmaxX, corners[i].X);
      rminY = Math.min(rminY, corners[i].Y); rmaxY = Math.max(rmaxY, corners[i].Y);
    }

    var step = spacingMm * SCALE;
    // Anchor to an absolute grid so infill lines align between islands and layers.
    var phase = ((phaseMm || 0) * SCALE) % step;
    var y = Math.ceil((rminY - phase) / step) * step + phase;
    var cb = Math.cos(rad), sb = Math.sin(rad);
    var lines = [];
    var margin = step;
    for (; y <= rmaxY + 1; y += step) {
      var a = rotate(rminX - margin, y, cb, sb);
      var b = rotate(rmaxX + margin, y, cb, sb);
      lines.push([{ X: Math.round(a.X), Y: Math.round(a.Y) }, { X: Math.round(b.X), Y: Math.round(b.Y) }]);
    }
    return G.clipLinesToRegion(lines, region);
  }

  function multiDirection(region, spacingMm, angles) {
    var out = [];
    for (var i = 0; i < angles.length; i++) {
      var l = rectilinear(region, spacingMm * angles.length, angles[i]);
      for (var j = 0; j < l.length; j++) out.push(l[j]);
    }
    return out;
  }

  /** Concentric loops marching inward from the region boundary. */
  function concentric(region, spacingMm) {
    var out = [];
    var cur = G.offsetPaths(region, -spacingMm / 2);
    var guard = 0;
    while (cur.length && guard++ < 400) {
      for (var i = 0; i < cur.length; i++) {
        if (cur[i].length < 3) continue;
        var loop = cur[i].slice();
        loop.push({ X: loop[0].X, Y: loop[0].Y });   // close it as a polyline
        out.push(loop);
      }
      cur = G.offsetPaths(cur, -spacingMm);
    }
    return out;
  }

  /**
   * Hexagonal honeycomb. Every cell edge is emitted once, then the loose edges
   * are chained into long polylines so the nozzle is not constantly lifting.
   */
  function honeycomb(region, spacingMm) {
    var bb = G.pathsBBox(region);
    // A hex lattice lays 3 edges of length `a` per cell of area (3*sqrt(3)/2)a^2,
    // i.e. 2/sqrt(3)/a of line per unit area — so a = spacing * 2/sqrt(3) hits
    // exactly the requested density.
    var side = spacingMm * 2 / Math.sqrt(3);
    var w = side * 1.5;                       // horizontal pitch
    var h = side * Math.sqrt(3);              // vertical pitch
    var x0 = G.unmm(bb.minX) - w * 2, x1 = G.unmm(bb.maxX) + w * 2;
    var y0 = G.unmm(bb.minY) - h * 2, y1 = G.unmm(bb.maxY) + h * 2;
    if ((x1 - x0) / w * ((y1 - y0) / h) > 4e5) return [];

    var segs = [];
    var seen = Object.create(null);
    function edge(ax, ay, bx, by) {
      var ka = Math.round(ax * 1e3) + '_' + Math.round(ay * 1e3);
      var kb = Math.round(bx * 1e3) + '_' + Math.round(by * 1e3);
      var key = ka < kb ? ka + '|' + kb : kb + '|' + ka;
      if (seen[key]) return;
      seen[key] = 1;
      segs.push([ax, ay, bx, by]);
    }

    var cols = Math.ceil((x1 - x0) / w) + 1;
    var rows = Math.ceil((y1 - y0) / h) + 1;
    for (var i = 0; i < cols; i++) {
      for (var j = 0; j < rows; j++) {
        var cx = x0 + i * w;
        var cy = y0 + j * h + (i % 2 ? h / 2 : 0);
        var pts = [];
        for (var k = 0; k < 6; k++) {
          var a = Math.PI / 3 * k;
          pts.push([cx + side * Math.cos(a), cy + side * Math.sin(a)]);
        }
        for (var e = 0; e < 6; e++) {
          var p1 = pts[e], p2 = pts[(e + 1) % 6];
          edge(p1[0], p1[1], p2[0], p2[1]);
        }
      }
    }
    if (!segs.length) return [];

    var chains = chainSegments(segs, side * 0.02);
    var lines = [];
    for (var c = 0; c < chains.length; c++) {
      if (chains[c].length < 2) continue;
      var path = [];
      for (var q = 0; q < chains[c].length; q++) path.push({ X: G.mm(chains[c][q][0]), Y: G.mm(chains[c][q][1]) });
      lines.push(path);
    }
    return G.clipLinesToRegion(lines, region);
  }

  /**
   * Cubic: three line directions whose phase drifts with height, so the voids
   * stack into a lattice rather than straight columns.
   */
  function cubic(region, spacingMm, angleDeg, zMm) {
    var out = [];
    var period = spacingMm * 3;
    for (var i = 0; i < 3; i++) {
      var phase = ((zMm / Math.sqrt(3) + i * period / 3) % period);
      var lines = rectilinear(region, period, angleDeg + i * 60, phase);
      for (var j = 0; j < lines.length; j++) out.push(lines[j]);
    }
    return out;
  }

  // --- Gyroid -----------------------------------------------------------------

  /**
   * Gyroid isolines at height z: sin(x)cos(y) + sin(y)cos(z) + sin(z)cos(x) = 0,
   * extracted with marching squares and clipped to the region.
   */
  function gyroidRaw(region, periodMm, zMm) {
    var bb = G.pathsBBox(region);
    var k = 2 * Math.PI / periodMm;
    var res = Math.max(periodMm / 14, 0.15);          // sampling step in mm
    var x0 = G.unmm(bb.minX) - res, x1 = G.unmm(bb.maxX) + res;
    var y0 = G.unmm(bb.minY) - res, y1 = G.unmm(bb.maxY) + res;
    var nx = Math.max(2, Math.ceil((x1 - x0) / res) + 1);
    var ny = Math.max(2, Math.ceil((y1 - y0) / res) + 1);
    if (nx * ny > 4e6) return [];                      // guard against absurd grids

    var sz = Math.sin(zMm * k), cz = Math.cos(zMm * k);
    var field = new Float32Array(nx * ny);
    var sinX = new Float32Array(nx), cosX = new Float32Array(nx);
    for (var i = 0; i < nx; i++) { var xv = (x0 + i * res) * k; sinX[i] = Math.sin(xv); cosX[i] = Math.cos(xv); }
    for (var j = 0; j < ny; j++) {
      var yv = (y0 + j * res) * k, sy = Math.sin(yv), cy = Math.cos(yv);
      for (var ii = 0; ii < nx; ii++) field[j * nx + ii] = sinX[ii] * cy + sy * cz + sz * cosX[ii];
    }

    var segs = [];
    function interp(va, vb, a, b) { var t = va / (va - vb); return a + (b - a) * t; }

    for (var jy = 0; jy < ny - 1; jy++) {
      for (var ix = 0; ix < nx - 1; ix++) {
        var v00 = field[jy * nx + ix], v10 = field[jy * nx + ix + 1];
        var v11 = field[(jy + 1) * nx + ix + 1], v01 = field[(jy + 1) * nx + ix];
        var code = (v00 > 0 ? 1 : 0) | (v10 > 0 ? 2 : 0) | (v11 > 0 ? 4 : 0) | (v01 > 0 ? 8 : 0);
        if (code === 0 || code === 15) continue;
        var px = x0 + ix * res, py = y0 + jy * res;
        var bottom = { x: interp(v00, v10, px, px + res), y: py };
        var right = { x: px + res, y: interp(v10, v11, py, py + res) };
        var top = { x: interp(v01, v11, px, px + res), y: py + res };
        var left = { x: px, y: interp(v00, v01, py, py + res) };
        var pairs = MS_TABLE[code];
        for (var p = 0; p < pairs.length; p += 2) {
          var e1 = [bottom, right, top, left][pairs[p]];
          var e2 = [bottom, right, top, left][pairs[p + 1]];
          segs.push([e1.x, e1.y, e2.x, e2.y]);
        }
      }
    }
    if (!segs.length) return [];
    var polys = chainSegments(segs, res * 0.6);
    var lines = [];
    for (var s = 0; s < polys.length; s++) {
      if (polys[s].length < 2) continue;
      var path = [];
      for (var q = 0; q < polys[s].length; q++) path.push({ X: G.mm(polys[s][q][0]), Y: G.mm(polys[s][q][1]) });
      lines.push(path);
    }
    return G.clipLinesToRegion(lines, region);
  }

  // Marching-squares edge pairs: 0=bottom 1=right 2=top 3=left.
  var MS_TABLE = {
    1: [3, 0], 2: [0, 1], 3: [3, 1], 4: [1, 2], 5: [3, 2, 0, 1], 6: [0, 2], 7: [3, 2],
    8: [2, 3], 9: [2, 0], 10: [0, 3, 2, 1], 11: [2, 1], 12: [1, 3], 13: [1, 0], 14: [0, 3]
  };

  /** Chain loose segments into polylines by endpoint proximity. */
  function chainSegments(segs, tol) {
    var grid = Object.create(null);
    var cell = Math.max(tol, 1e-6) * 2;
    function ck(x, y) { return Math.round(x / cell) + '_' + Math.round(y / cell); }
    for (var i = 0; i < segs.length; i++) {
      (grid[ck(segs[i][0], segs[i][1])] || (grid[ck(segs[i][0], segs[i][1])] = [])).push(i * 2);
      (grid[ck(segs[i][2], segs[i][3])] || (grid[ck(segs[i][2], segs[i][3])] = [])).push(i * 2 + 1);
    }
    var used = new Uint8Array(segs.length);
    var out = [];
    var tol2 = tol * tol;

    function findNext(x, y) {
      var bx = Math.round(x / cell), by = Math.round(y / cell);
      for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) {
        var bucket = grid[(bx + dx) + '_' + (by + dy)];
        if (!bucket) continue;
        for (var b = 0; b < bucket.length; b++) {
          var si = bucket[b] >> 1, end = bucket[b] & 1;
          if (used[si]) continue;
          var ex = end ? segs[si][2] : segs[si][0];
          var ey = end ? segs[si][3] : segs[si][1];
          var d2 = (ex - x) * (ex - x) + (ey - y) * (ey - y);
          if (d2 <= tol2) return { seg: si, end: end };
        }
      }
      return null;
    }

    for (var s = 0; s < segs.length; s++) {
      if (used[s]) continue;
      used[s] = 1;
      var poly = [[segs[s][0], segs[s][1]], [segs[s][2], segs[s][3]]];
      var cx = segs[s][2], cy = segs[s][3], guard = 0;
      while (guard++ < segs.length) {
        var nx2 = findNext(cx, cy);
        if (!nx2) break;
        used[nx2.seg] = 1;
        cx = nx2.end ? segs[nx2.seg][0] : segs[nx2.seg][2];
        cy = nx2.end ? segs[nx2.seg][1] : segs[nx2.seg][3];
        poly.push([cx, cy]);
      }
      if (poly.length >= 2) out.push(poly);
    }
    return out;
  }

  function polylineLength(path) {
    var L = 0;
    for (var i = 1; i < path.length; i++) L += Math.hypot(path[i].X - path[i - 1].X, path[i].Y - path[i - 1].Y);
    return L / SCALE;
  }

  function totalLength(lines) {
    var L = 0;
    for (var i = 0; i < lines.length; i++) L += polylineLength(lines[i]);
    return L;
  }

  /**
   * Gyroid with the period auto-corrected so the produced line density matches
   * the requested spacing (one feedback pass — cheap and self-correcting).
   */
  function gyroid(region, spacingMm, zMm) {
    var area = G.totalArea(region);
    if (area <= 0) return [];
    var target = area / spacingMm;
    var period = spacingMm * 2.2;
    var lines = gyroidRaw(region, period, zMm);
    var len = totalLength(lines);
    if (len > 1e-3 && target > 1e-3) {
      var ratio = len / target;
      if (ratio > 1.15 || ratio < 0.87) {
        var p2 = Math.max(spacingMm * 0.8, Math.min(spacingMm * 20, period * ratio));
        var alt = gyroidRaw(region, p2, zMm);
        if (alt.length) lines = alt;
      }
    }
    return lines;
  }

  /** Dispatch by pattern name. `spacingMm` is the desired line-to-line distance. */
  function generateInfill(pattern, region, spacingMm, angleDeg, zMm) {
    if (!region.length || spacingMm <= 0) return [];
    switch (pattern) {
      case 'lines': return rectilinear(region, spacingMm, angleDeg);
      case 'grid': return multiDirection(region, spacingMm, [angleDeg, angleDeg + 90]);
      case 'triangles': return multiDirection(region, spacingMm, [angleDeg, angleDeg + 60, angleDeg + 120]);
      case 'gyroid': return gyroid(region, spacingMm, zMm);
      case 'concentric': return concentric(region, spacingMm);
      case 'honeycomb': return honeycomb(region, spacingMm);
      case 'cubic': return cubic(region, spacingMm, angleDeg, zMm);
      default: return rectilinear(region, spacingMm, angleDeg);
    }
  }

  /**
   * Monotonic ordering: sweep the lines in one direction across the surface and
   * lay every one the same way round, so each bead overlaps the one before it
   * identically. Nearest-endpoint ordering zig-zags, which alternates which side
   * of each bead gets squashed and leaves a visible banding on top surfaces.
   */
  function orderMonotonic(lines, angleDeg) {
    var rad = angleDeg * Math.PI / 180;
    // Across-the-lines direction, and along-the-lines direction.
    var ax = -Math.sin(rad), ay = Math.cos(rad);
    var lx = Math.cos(rad), ly = Math.sin(rad);

    var scored = lines.map(function (line) {
      var sum = 0;
      for (var i = 0; i < line.length; i++) sum += line[i].X * ax + line[i].Y * ay;
      var across = sum / line.length;
      var head = line[0].X * lx + line[0].Y * ly;
      var tail = line[line.length - 1].X * lx + line[line.length - 1].Y * ly;
      // Every line runs the same way along the fill direction.
      return { line: head <= tail ? line : line.slice().reverse(), across: across };
    });

    scored.sort(function (a, b) { return a.across - b.across; });
    return scored.map(function (entry) { return entry.line; });
  }

  /** Greedy nearest-endpoint ordering; returns polylines possibly reversed. */
  function orderPolylines(lines, start) {
    var remaining = lines.slice();
    var out = [];
    var cx = start ? start.X : 0, cy = start ? start.Y : 0;
    while (remaining.length) {
      var best = 0, bestD = Infinity, bestRev = false;
      for (var i = 0; i < remaining.length; i++) {
        var p = remaining[i];
        var a = p[0], b = p[p.length - 1];
        var da = (a.X - cx) * (a.X - cx) + (a.Y - cy) * (a.Y - cy);
        var db = (b.X - cx) * (b.X - cx) + (b.Y - cy) * (b.Y - cy);
        if (da < bestD) { bestD = da; best = i; bestRev = false; }
        if (db < bestD) { bestD = db; best = i; bestRev = true; }
      }
      var chosen = remaining.splice(best, 1)[0];
      if (bestRev) chosen = chosen.slice().reverse();
      out.push(chosen);
      var last = chosen[chosen.length - 1];
      cx = last.X; cy = last.Y;
    }
    return out;
  }

  root.OrcaEngineInfill = {
    rectilinear: rectilinear,
    concentric: concentric,
    gyroid: gyroid,
    honeycomb: honeycomb,
    cubic: cubic,
    generateInfill: generateInfill,
    orderPolylines: orderPolylines,
    orderMonotonic: orderMonotonic,
    polylineLength: polylineLength,
    totalLength: totalLength,
    chainSegments: chainSegments
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);

/**
 * Orca Web Slicer — Slicing pipeline + G-code generation.
 */
(function (root) {
  'use strict';
  var G = root.OrcaEngineGeom;
  var I = root.OrcaEngineInfill;
  var SCALE = G.SCALE;

  var FEATURE = {
    SKIRT: 'skirt', BRIM: 'brim', RAFT: 'raft',
    OUTER: 'wall-outer', INNER: 'wall-inner', OVERHANG: 'wall-overhang', GAP: 'gap',
    SOLID: 'solid', TOP: 'top', BOTTOM: 'bottom', BRIDGE: 'bridge',
    INTERNAL_BRIDGE: 'internal-bridge', IRONING: 'ironing',
    SPARSE: 'sparse', SUPPORT: 'support', SUPPORT_IFACE: 'support-interface'
  };

  var GCODE_TYPE = {
    'skirt': 'Skirt', 'brim': 'Brim', 'raft': 'Raft',
    'wall-outer': 'External perimeter', 'wall-inner': 'Perimeter',
    'wall-overhang': 'Overhang perimeter', 'gap': 'Gap fill',
    'solid': 'Solid infill', 'top': 'Top solid infill', 'bottom': 'Solid infill',
    'bridge': 'Bridge infill', 'internal-bridge': 'Internal bridge infill',
    'ironing': 'Ironing', 'sparse': 'Internal infill',
    'support': 'Support material', 'support-interface': 'Support material interface'
  };

  var TYPE_CODES = {
    'skirt': 0, 'brim': 1, 'wall-outer': 2, 'wall-inner': 3,
    'solid': 4, 'top': 5, 'bottom': 6, 'bridge': 7, 'sparse': 8, 'support': 9,
    'ironing': 10, 'gap': 11, 'support-interface': 12, 'raft': 13, 'wall-overhang': 14, 'internal-bridge': 15
  };

  // ---------------------------------------------------------------------------
  // Layer planning
  // ---------------------------------------------------------------------------

  /**
   * Uniform layers, or adaptive ones when asked: shallow surfaces get thin
   * layers to hide the stepping, vertical walls get thick ones to save time.
   */
  function planLayers(minZ, maxZ, s, positions) {
    var height = maxZ - minZ;
    if (height <= 0) return [];

    var layers = [];
    var h1 = Math.min(s.firstLayerHeight, height);
    layers.push({ printZ: h1, height: h1, sliceZ: minZ + h1 / 2 });
    var top = h1;

    var slope = s.adaptiveLayers ? buildSlopeProfile(positions, minZ, maxZ) : null;
    var minH = Math.max(0.04, s.layerHeight * 0.4);
    var maxH = Math.min(s.nozzle * 0.8, s.layerHeight * 1.6);

    while (top < height - 1e-6) {
      var h = s.layerHeight;
      if (slope) {
        // The flattest surface in reach decides: |nz| = 1 is horizontal.
        var flatness = slope.sample(minZ + top, minZ + top + maxH);
        var wanted = maxH - (maxH - minH) * Math.pow(flatness, 0.6);
        h = Math.max(minH, Math.min(maxH, wanted * (0.5 + s.adaptiveQuality) ));
        h = Math.max(minH, Math.min(maxH, h));
      }
      var next = Math.min(top + h, height);
      var lh = next - top;
      if (lh < minH * 0.6 && layers.length > 1) break;   // no sliver on top
      layers.push({ printZ: next, height: lh, sliceZ: minZ + next - lh / 2 });
      top = next;
    }
    return layers;
  }

  /** Bucket the steepest-to-flattest surface angle by height, for adaptive layers. */
  function buildSlopeProfile(positions, minZ, maxZ) {
    var buckets = 512;
    var span = Math.max(1e-6, maxZ - minZ);
    var flat = new Float32Array(buckets);
    var triCount = (positions.length / 9) | 0;

    for (var t = 0; t < triCount; t++) {
      var o = t * 9;
      var ax = positions[o], ay = positions[o + 1], az = positions[o + 2];
      var bx = positions[o + 3], by = positions[o + 4], bz = positions[o + 5];
      var cx = positions[o + 6], cy = positions[o + 7], cz = positions[o + 8];
      var nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      var ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      var nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      var len = Math.hypot(nx, ny, nz);
      if (len < 1e-12) continue;
      var horizontality = Math.abs(nz / len);
      var lo = Math.min(az, bz, cz), hi = Math.max(az, bz, cz);
      var b0 = Math.max(0, Math.floor((lo - minZ) / span * (buckets - 1)));
      var b1 = Math.min(buckets - 1, Math.ceil((hi - minZ) / span * (buckets - 1)));
      for (var b = b0; b <= b1; b++) if (horizontality > flat[b]) flat[b] = horizontality;
    }

    return {
      sample: function (zLo, zHi) {
        var i0 = Math.max(0, Math.floor((zLo - minZ) / span * (buckets - 1)));
        var i1 = Math.min(buckets - 1, Math.ceil((zHi - minZ) / span * (buckets - 1)));
        var best = 0;
        for (var i = i0; i <= i1; i++) if (flat[i] > best) best = flat[i];
        return best;
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Path helpers
  // ---------------------------------------------------------------------------

  function closedToPolyline(path, seamRef, seamMode) {
    if (path.length < 3) return null;
    var startIdx = 0;
    if (seamMode === 'random') {
      startIdx = (Math.random() * path.length) | 0;
    } else if (seamRef) {
      var best = Infinity;
      for (var i = 0; i < path.length; i++) {
        var d = (path[i].X - seamRef.X) * (path[i].X - seamRef.X) + (path[i].Y - seamRef.Y) * (path[i].Y - seamRef.Y);
        if (d < best) { best = d; startIdx = i; }
      }
    }
    var out = [];
    for (var k = 0; k < path.length; k++) out.push(path[(startIdx + k) % path.length]);
    out.push({ X: out[0].X, Y: out[0].Y });
    return out;
  }

  /**
   * Fuzzy skin: resample the loop at a fixed spacing and jitter each point along
   * its outward normal. Produces the matte, grippy finish Orca calls fuzzy skin.
   */
  function fuzzify(polyline, thicknessMm, pointDistMm, widths) {
    if (polyline.length < 3) return { pts: polyline, widths: widths };
    var step = Math.max(0.05, pointDistMm) * SCALE;
    var amp = Math.max(0, thicknessMm) * SCALE;
    var out = [];
    var outW = widths ? [] : null;
    var carry = 0;

    for (var i = 0; i < polyline.length - 1; i++) {
      var a = polyline[i], b = polyline[i + 1];
      var dx = b.X - a.X, dy = b.Y - a.Y;
      var len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      var nx = -dy / len, ny = dx / len;
      var pos = carry;
      while (pos < len) {
        var t = pos / len;
        var jitter = (Math.random() - 0.5) * amp;
        out.push({ X: Math.round(a.X + dx * t + nx * jitter), Y: Math.round(a.Y + dy * t + ny * jitter) });
        // Resampling moves the points, so a variable-width bead has to carry its
        // width across with them or the fuzz would flatten it back to one width.
        if (outW) outW.push(widths[i] + (widths[i + 1] - widths[i]) * t);
        pos += step;
      }
      carry = pos - len;
    }
    if (out.length < 3) return { pts: polyline, widths: widths };
    out.push({ X: out[0].X, Y: out[0].Y });
    if (outW) outW.push(outW[0]);
    return { pts: out, widths: outW };
  }

  function islandCentroid(island) {
    var bb = G.pathsBBox([island.outer]);
    return { X: (bb.minX + bb.maxX) / 2, Y: (bb.minY + bb.maxY) / 2 };
  }

  function convexHull(points) {
    if (points.length < 3) return points.slice();
    var pts = points.slice().sort(function (a, b) { return a.X === b.X ? a.Y - b.Y : a.X - b.X; });
    function cross(o, a, b) { return (a.X - o.X) * (b.Y - o.Y) - (a.Y - o.Y) * (b.X - o.X); }
    var lower = [], i;
    for (i = 0; i < pts.length; i++) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pts[i]) <= 0) lower.pop();
      lower.push(pts[i]);
    }
    var upper = [];
    for (var j = pts.length - 1; j >= 0; j--) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pts[j]) <= 0) upper.pop();
      upper.push(pts[j]);
    }
    lower.pop(); upper.pop();
    return lower.concat(upper);
  }

  function allPoints(paths) {
    var out = [];
    for (var i = 0; i < paths.length; i++) for (var j = 0; j < paths[i].length; j++) out.push(paths[i][j]);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Supports
  // ---------------------------------------------------------------------------

  /**
   * Walk down from the top accumulating everything the layer below cannot hold
   * up. Returns the full support column per layer plus the dense interface that
   * forms its top few layers, which is what the model actually rests on.
   */
  // ---------------------------------------------------------------------------
  // Painted marks
  // ---------------------------------------------------------------------------

  /** A circle as a clipper path, fine enough that offsetting it stays smooth. */
  function circlePath(xMm, yMm, rMm) {
    var steps = Math.max(12, Math.min(64, Math.round(rMm * 8)));
    var path = [];
    for (var i = 0; i < steps; i++) {
      var a = i / steps * 2 * Math.PI;
      path.push({
        X: Math.round((xMm + Math.cos(a) * rMm) * SCALE),
        Y: Math.round((yMm + Math.sin(a) * rMm) * SCALE)
      });
    }
    return path;
  }

  /**
   * Painted support marks become columns: everything under the spot the user
   * touched, all the way down. That is what the tool is for — "hold this bit
   * up" and "keep the support away from here" are both statements about the
   * column below the surface, not about the surface itself.
   */
  function paintColumns(marks, kind, layers) {
    var n = layers.length;
    var out = new Array(n);
    for (var i = 0; i < n; i++) out[i] = [];
    if (!marks || !marks.length) return out;

    for (var m = 0; m < marks.length; m++) {
      var mark = marks[m];
      if (mark.kind !== kind || !(mark.r > 0)) continue;
      var disc = [circlePath(mark.x, mark.y, mark.r)];
      var top = mark.z + mark.r;
      for (var L = 0; L < n; L++) {
        if (layers[L].sliceZ > top) break;
        out[L] = out[L].length ? G.unite(out[L], disc) : G.copyPaths(disc);
      }
    }
    return out;
  }

  function hasMarks(marks, kind) {
    if (!marks) return false;
    for (var i = 0; i < marks.length; i++) if (marks[i].kind === kind) return true;
    return false;
  }

  /**
   * The painted seam nearest this island on this layer, if the user asked for
   * one here. Marks are spheres, so one painted on a face steers the seam over
   * the height it actually covers and lets it go back to normal above and below.
   */
  function paintedSeam(marks, zMm, bb) {
    if (!marks || !marks.length) return null;
    var best = null, bestD = Infinity;
    var cx = (bb.minX + bb.maxX) / 2 / SCALE, cy = (bb.minY + bb.maxY) / 2 / SCALE;
    for (var i = 0; i < marks.length; i++) {
      var mk = marks[i];
      if (mk.kind !== 'seam') continue;
      var dz = Math.abs(zMm - mk.z);
      if (dz > mk.r) continue;
      var reach = Math.hypot(bb.maxX - bb.minX, bb.maxY - bb.minY) / 2 / SCALE + mk.r;
      var d = Math.hypot(mk.x - cx, mk.y - cy);
      if (d > reach || d >= bestD) continue;
      bestD = d;
      best = { X: Math.round(mk.x * SCALE), Y: Math.round(mk.y * SCALE) };
    }
    return best;
  }

  function buildSupports(regions, layers, s) {
    var n = regions.length;
    var base = new Array(n), iface = new Array(n);
    for (var i = 0; i < n; i++) { base[i] = []; iface[i] = []; }
    // An enforcer on its own is a complete instruction: support exactly here and
    // nowhere else. It works with the automatic supports switched off.
    var enforced = hasMarks(s.paintMarks, 'enforce');
    if ((!s.supportEnable && !enforced) || n < 2) return { base: base, iface: iface };
    var enforce = paintColumns(s.paintMarks, 'enforce', layers);
    var block = paintColumns(s.paintMarks, 'block', layers);

    // Tree supports replace the automatic pass wholesale: branches are grown
    // top-down instead of columns being extruded downward from each overhang.
    // Painted enforcers and blockers still apply on top, the same way.
    var tree = s.supportStyle === 'tree' && root.OrcaTreeSupport && s.supportEnable
      ? root.OrcaTreeSupport.build(regions, layers, s, { lineWidth: s.lineWidth })
      : null;

    var gapLayers = Math.max(1, Math.round(s.supportZGap / s.layerHeight));
    var minArea = Math.pow(s.lineWidth * 3, 2);
    var pending = [];
    var carry = [];
    var full = new Array(n);
    for (var z = 0; z < n; z++) full[z] = [];

    for (var L = n - 1; L >= 1; L--) {
      var below = regions[L - 1];
      var selfSupport = layers[L].height * Math.tan(s.supportThreshold * Math.PI / 180);
      var overhang = G.subtract(regions[L], G.offsetPaths(below, selfSupport));
      overhang = (s.supportEnable && !tree) ? G.dropTinyIslands(overhang, minArea) : [];

      pending.push(overhang);
      var due = pending.length > gapLayers ? pending.shift() : [];
      if (due.length) carry = G.unite(carry, due);
      if (!carry.length) { if (block[L - 1].length) carry = []; continue; }
      if (block[L - 1].length) carry = G.subtract(carry, block[L - 1]);

      carry = G.subtract(carry, G.offsetPaths(below, s.supportXYGap));
      carry = G.dropTinyIslands(carry, minArea);
      full[L - 1] = G.copyPaths(carry);
    }

    if (tree) for (var tl = 0; tl < n; tl++) full[tl] = tree[tl];

    // Painted columns are applied after the automatic pass so an enforcer can
    // put support where the overhang angle would never have asked for it, and a
    // blocker always wins over both.
    for (var pl = 0; pl < n; pl++) {
      if (enforce[pl].length) {
        var clear = pl + 1 < n
          ? G.offsetPaths(G.unite(regions[pl], regions[pl + 1]), s.supportXYGap)
          : G.offsetPaths(regions[pl], s.supportXYGap);
        full[pl] = G.unite(full[pl], G.subtract(enforce[pl], clear));
      }
      if (block[pl].length) full[pl] = G.subtract(full[pl], block[pl]);
      // A branch tip is one bead across. Judging it by the minimum area a slab
      // of normal support has to reach would prune the top off every branch.
      if (full[pl].length) {
        full[pl] = G.dropTinyIslands(full[pl], tree ? Math.pow(s.lineWidth, 2) * 0.4 : minArea);
      }
    }

    if (s.supportOnBuildplateOnly) {
      var allowed = full[0];
      for (var k = 1; k < n; k++) {
        allowed = G.intersect(full[k], G.offsetPaths(allowed, 2));
        full[k] = allowed;
      }
    }

    // The top `supportInterfaceLayers` of every column become dense interface.
    var ifaceCount = Math.max(0, s.supportInterfaceLayers | 0);
    for (var m = 0; m < n; m++) {
      if (!full[m].length) continue;
      if (ifaceCount === 0) { base[m] = full[m]; continue; }
      var above = m + ifaceCount < n ? full[m + ifaceCount] : [];
      var top = above.length ? G.subtract(full[m], above) : G.copyPaths(full[m]);
      top = G.dropTinyIslands(top, minArea);
      iface[m] = top;
      base[m] = top.length ? G.subtract(full[m], top) : full[m];
    }
    return { base: base, iface: iface };
  }

  // ---------------------------------------------------------------------------
  // Main pipeline
  // ---------------------------------------------------------------------------

  /** Everything from a triangle soup to a list of layers ready for the writer. */
  function buildObject(positions, s, progress) {
    var minZ = Infinity, maxZ = -Infinity;
    for (var v = 2; v < positions.length; v += 3) {
      if (positions[v] < minZ) minZ = positions[v];
      if (positions[v] > maxZ) maxZ = positions[v];
    }
    if (!isFinite(minZ)) throw new Error('Empty mesh');

    var layerPlan = planLayers(minZ, maxZ, s, positions);
    if (!layerPlan.length) throw new Error('Model is too thin to slice');

    var planes = layerPlan.map(function (l) { return l.sliceZ; });
    progress(0.02, 'Slicing mesh');
    var regions = G.sliceMesh(positions, planes, function (f) { progress(0.02 + f * 0.26, 'Slicing mesh'); });

    var n = regions.length;
    var minIsland = Math.pow(s.lineWidth, 2) * 0.5;
    for (var r = 0; r < n; r++) {
      var comp = s.xyCompensation - (r === 0 ? s.elephantFootCompensation : 0);
      if (Math.abs(comp) > 1e-4) regions[r] = G.offsetPaths(regions[r], comp);
      regions[r] = G.dropTinyIslands(regions[r], minIsland);
    }

    // Infill boundary per layer, inside the walls.
    progress(0.30, 'Building shells');
    var inner = new Array(n);
    for (var i = 0; i < n; i++) inner[i] = infillBoundary(regions[i], i, s, layerPlan[i].height);

    // Top / bottom solid detection, and bridges over thin air.
    var solidRegion = new Array(n), sparseRegion = new Array(n), bridgeRegion = new Array(n);
    var topRegion = new Array(n), internalBridge = new Array(n);
    for (var L = 0; L < n; L++) {
      var bottomSolid = [], topSolid = [], b, t;
      if (s.infillDensity >= 100) {
        bottomSolid = G.copyPaths(inner[L]);
      } else {
        if (L < s.bottomLayers) {
          bottomSolid = G.copyPaths(inner[L]);
        } else if (s.bottomLayers > 0) {
          var accB = inner[L - 1];
          for (b = 2; b <= s.bottomLayers; b++) accB = G.intersect(accB, inner[L - b]);
          bottomSolid = openSurface(G.subtract(inner[L], accB), s.lineWidth);
        }
        if (L >= n - s.topLayers) {
          topSolid = G.copyPaths(inner[L]);
        } else if (s.topLayers > 0) {
          var accT = inner[L + 1];
          for (t = 2; t <= s.topLayers; t++) accT = G.intersect(accT, inner[L + t]);
          topSolid = openSurface(G.subtract(inner[L], accT), s.lineWidth);
        }
      }
      var solid = G.dropTinyIslands(G.unite(bottomSolid, topSolid), Math.pow(s.lineWidth, 2));
      topRegion[L] = G.dropTinyIslands(topSolid, Math.pow(s.lineWidth, 2));
      bridgeRegion[L] = L > 0 && solid.length
        ? G.dropTinyIslands(G.subtract(solid, G.offsetPaths(regions[L - 1], 0.1)), Math.pow(s.lineWidth * 4, 2))
        : [];
      if (bridgeRegion[L].length) {
        solid = G.subtract(solid, bridgeRegion[L]);
        topRegion[L] = G.subtract(topRegion[L], bridgeRegion[L]);
      }
      solidRegion[L] = solid;
      sparseRegion[L] = s.infillDensity > 0 && s.infillDensity < 100 ? G.subtract(inner[L], solid) : [];

      // Solid infill that lands on sparse infill is spanning the gaps between
      // those lines. Printed as ordinary solid infill it sags into them and the
      // surface above never recovers; printed as a bridge it stretches across.
      internalBridge[L] = [];
      if (s.internalBridges && L > 0 && solid.length && sparseRegion[L - 1] && sparseRegion[L - 1].length) {
        internalBridge[L] = G.dropTinyIslands(
          G.intersect(solid, sparseRegion[L - 1]), Math.pow(s.lineWidth * 4, 2));
        if (internalBridge[L].length) {
          solidRegion[L] = G.subtract(solidRegion[L], internalBridge[L]);
          topRegion[L] = G.subtract(topRegion[L], internalBridge[L]);
        }
      }
      if ((L & 7) === 0) progress(0.30 + 0.18 * (L / n), 'Building shells');
    }

    // Lightning grows top-down across the whole part, so it is built in one pass
    // before per-layer work begins.
    var lightning = null;
    if (s.infillPattern === 'lightning' && root.OrcaLightning && s.infillDensity > 0) {
      progress(0.47, 'Growing infill');
      lightning = root.OrcaLightning.build(inner, solidRegion, layerPlan, s);
    }

    progress(0.49, 'Generating supports');
    var support = buildSupports(regions, layerPlan, s);

    progress(0.53, 'Generating toolpaths');
    var adhesion = buildAdhesion(regions, support, s);

    var outLayers = new Array(n);
    var lastPoint = { X: 0, Y: 0 };

    for (var Li = 0; Li < n; Li++) {
      var feats = [];
      var wl = widthsFor(Li, s);
      var angle = 45 + 90 * (Li % 2);
      var printZ = layerPlan[Li].printZ;

      if (Li === 0) {
        for (var ad = 0; ad < adhesion.length; ad++) {
          var aPaths = adhesion[ad].paths;
          for (var ap = 0; ap < aPaths.length; ap++) {
            var pl = closedToPolyline(aPaths[ap], lastPoint, 'nearest');
            if (pl) feats.push({ type: adhesion[ad].type, w: adhesion[ad].width, pts: pl, closed: true });
          }
        }
      }

      // Bands of decreasing support under this layer, for classifying how much of
      // each external wall is hanging over thin air. Computed once per layer.
      var supportBands = null;
      if (s.overhangSlowdown && Li > 0 && regions[Li - 1].length) {
        var beneath = regions[Li - 1];
        // The first layer is deliberately narrowed to fight elephant's foot, so
        // the second one hangs over it by exactly that much. That is compensation
        // working, not an overhang; undo it before judging.
        if (Li === 1 && s.elephantFootCompensation > 0) {
          beneath = G.offsetPaths(beneath, s.elephantFootCompensation);
        }
        // Screen on what this layer covers that the one below does not. Testing
        // against an inset of `beneath` instead would flag the whole perimeter of
        // a perfectly vertical wall, since the inset is smaller by construction.
        if (G.totalArea(G.subtract(regions[Li], beneath)) > Math.pow(wl.ext, 2)) {
          // The outer bead's centreline sits exactly at -ext/2, i.e. precisely on
          // the first band's edge. Without slack, Clipper's boundary handling
          // chops a vertical wall into alternating "supported" and "overhanging"
          // scraps. The tolerance puts it firmly inside.
          var slack = 0.05;
          supportBands = [
            G.offsetPaths(beneath, -wl.ext / 2 + slack),   // bead lands fully on material
            G.offsetPaths(beneath, -wl.ext / 4),
            beneath,
            G.offsetPaths(beneath, wl.ext / 4)
          ];
        }
      }

      var islands = orderIslands(G.toIslands(regions[Li]), lastPoint);

      for (var isl = 0; isl < islands.length; isl++) {
        var island = islands[isl];
        var iPaths = G.islandPaths(island);
        var bb = G.pathsBBox([island.outer]);
        var seamRef = s.seamPosition === 'nearest' ? lastPoint : { X: bb.minX, Y: bb.minY };
        var seamMark = paintedSeam(s.paintMarks, layerPlan[Li].sliceZ, bb);
        if (seamMark) seamRef = seamMark;

        // --- walls ---
        var arachne = s.wallGenerator === 'arachne' && root.OrcaBeading;

        // One screening test serves both the variable-width split and gap fill:
        // a morphological opening at the full wall depth. Mitred joins keep an
        // ordinary sharp corner from reading as a thin feature, and the area
        // threshold ignores the micron slivers offsetting always leaves behind.
        // Most islands on most parts fail it, and then neither pass runs at all.
        var hasThinFeatures = false;
        if ((s.gapFill || arachne) && s.wallLoops > 0) {
          // The stack plus room for something inside it — the same threshold the
          // redistribution itself uses, so the screen never says "nothing to do
          // here" about a case the redistribution would have changed.
          var screenDepth = wallStack(s.wallLoops, wl, layerPlan[Li].height) + wl.inner * 0.5;
          var miter = G.ClipperLib.JoinType.jtMiter;
          var screened = G.offsetPaths(G.offsetPaths(iPaths, -screenDepth, miter), screenDepth, miter);
          hasThinFeatures = G.totalArea(G.subtract(iPaths, screened)) > Math.pow(wl.inner * 0.5, 2);
        }

        // Anything too narrow to hold a full outer wall is pulled out and beaded
        // instead. Left to the classic generator, a 0.6 mm rib gets a closed loop
        // running up one side and back down the other — two overlapping lines in
        // a space that fits one. That is what Arachne exists to avoid.
        var wallBase = iPaths;
        var thinRegion = [];
        if (arachne && hasThinFeatures && s.wallLoops > 0) {
          // A region belongs to the single-bead path exactly where the layout
          // calls for ONE bead, which is where the thickness falls below one and
          // a half lines — the same rounding the redistribution uses. Splitting
          // at the widest bead the machine can lay instead put the seam where
          // the layout wanted two beads and the single-bead path could only
          // give one, and a sixth of the material went missing across it.
          var beadR = Math.min(wl.inner * 1.5, Math.max(s.minBeadWidth, s.maxBeadWidth)) / 2;
          var opened = G.offsetPaths(G.offsetPaths(iPaths, -beadR), beadR);
          var narrow = G.dropTinyIslands(G.subtract(iPaths, opened), Math.pow(s.minBeadWidth, 2));
          if (narrow.length) { thinRegion = narrow; wallBase = opened; }
        }

        var wallLevels = [];
        for (var lp = 0; lp < s.wallLoops; lp++) {
          var delta = -wallDepth(lp, wl, layerPlan[Li].height);
          var loopPaths = G.offsetPaths(wallBase, delta);
          if (!loopPaths.length) break;
          wallLevels.push({ index: lp, paths: loopPaths, w: lp === 0 ? wl.ext : wl.inner });
        }

        var layout = null;
        if (arachne && hasThinFeatures) {
          layout = redistributeWalls(wallLevels, iPaths, s, wl, layerPlan[Li].height);
        }
        var redistributed = !!(layout && layout.touched);

        var ordered = orderWalls(wallLevels, s.wallOrder);
        for (var wi = 0; wi < ordered.length; wi++) {
          var lvl = ordered[wi];
          if (lvl.variable) {
            for (var vr = 0; vr < lvl.variable.length; vr++) {
              var run = lvl.variable[vr];
              var vpts = run.pts, vws = run.widths;
              if (run.closed) {
                var rot = rotateVariableLoop(vpts, vws, seamRef, s.seamPosition);
                vpts = rot.pts; vws = rot.widths;
              }
              if (vpts.length < 2) continue;
              if (run.closed && (s.fuzzySkin === 'all' ||
                                 (s.fuzzySkin === 'outer' && lvl.index === 0))) {
                var fz = fuzzify(vpts, s.fuzzyThickness, s.fuzzyPointDistance, vws);
                vpts = fz.pts; vws = fz.widths;
              }
              var vlen = I.polylineLength(vpts);
              var vSpeed = (s.smallPerimeterSpeed > 0 && vlen < s.smallPerimeterThreshold)
                ? s.smallPerimeterSpeed : 0;
              if (lvl.index === 0 && supportBands) {
                emitClassifiedVariableWall(feats, vpts, vws, supportBands, run.closed, vSpeed);
              } else {
                var vsum = 0;
                for (var vq = 0; vq < vws.length; vq++) vsum += vws[vq];
                feats.push({
                  type: lvl.index === 0 ? FEATURE.OUTER : FEATURE.INNER,
                  w: vsum / vws.length, widths: vws, pts: vpts, closed: run.closed,
                  speed: vSpeed
                });
              }
              lastPoint = vpts[vpts.length - 1];
            }
          }
          for (var lpi = 0; lpi < lvl.paths.length; lpi++) {
            var poly = closedToPolyline(lvl.paths[lpi], seamRef, s.seamPosition);
            if (!poly) continue;
            var isOuter = lvl.index === 0;
            if (s.fuzzySkin === 'all' || (s.fuzzySkin === 'outer' && isOuter)) {
              poly = fuzzify(poly, s.fuzzyThickness, s.fuzzyPointDistance).pts;
            }

            // A short loop cannot accelerate and traps heat; Orca slows these too.
            var loopLength = I.polylineLength(poly);
            var small = s.smallPerimeterSpeed > 0 && loopLength < s.smallPerimeterThreshold;

            if (isOuter && supportBands) {
              emitClassifiedWall(feats, poly, supportBands, lvl.w, small ? s.smallPerimeterSpeed : 0);
            } else {
              feats.push({
                type: isOuter ? FEATURE.OUTER : FEATURE.INNER,
                w: lvl.w, pts: poly, closed: true,
                speed: small ? s.smallPerimeterSpeed : 0
              });
            }
            lastPoint = poly[poly.length - 1];
          }
        }

        var islandInfill = infillBoundary(wallBase, Li, s, layerPlan[Li].height);

        // What the walls actually cover. Needed for gap fill, and needed again
        // when the beads have been redistributed: the infill boundary is drawn
        // at the NOMINAL wall depth, so a wall that was widened to fill the
        // space would otherwise have solid infill laid straight on top of it.
        var covered = null;
        if ((s.gapFill || redistributed) && hasThinFeatures && wallLevels.length) {
          covered = [];
          var lace = layerPlan[Li].height * (1 - Math.PI / 4);
          for (var g = 0; g < wallLevels.length; g++) {
            if (wallLevels[g].variable) {
              covered = G.unite(covered, sweptRegion(wallLevels[g].variable, lace));
            }
            if (!wallLevels[g].paths.length) continue;
            var half = Math.max(0.05, wallLevels[g].w - lace) / 2;
            covered = G.unite(covered, G.subtract(
              G.offsetPaths(wallLevels[g].paths, half),
              G.offsetPaths(wallLevels[g].paths, -half)));
          }
          if (redistributed) {
            // What is left has to be at least a line wide to be worth filling.
            // Area alone lets a six-micron sliver 26 mm long through, and it
            // then gets a full-width line of solid infill laid down it.
            // Only what is too narrow to print at all. Trimming harder loses
            // real area off a tapering interior, and the bead generator does
            // not always pick up what solid infill drops.
            islandInfill = openSurface(G.subtract(islandInfill, covered), wl.inner * 0.25);
          }
        }

        // --- gap fill: what the walls could not reach ---
        var gaps = [];
        if (s.gapFill && covered) {
          // Gap fill goes down to the narrowest bead the machine can lay, so
          // the test here only has to throw out what is narrower than half of
          // that — a real gap must survive it intact or it comes back as a
          // string of stutters instead of one bead.
          gaps = G.dropTinyIslands(
            openSurface(G.subtract(G.subtract(wallBase, covered), islandInfill),
                        s.minBeadWidth * 0.5),
            Math.pow(wl.inner * 0.5, 2));
        }

        var beadRegion = thinRegion.length ? G.unite(thinRegion, gaps) : gaps;
        if (arachne && beadRegion.length) {
          pushBeads(feats, beadRegion, s, wl, lastPoint, layerPlan[Li].height, layout);
          if (feats.length) lastPoint = feats[feats.length - 1].pts[feats[feats.length - 1].pts.length - 1];
        } else if (gaps.length) {
          pushInfill(feats, gaps, 'lines', wl.inner * 0.9, angle, printZ, FEATURE.GAP, wl.inner, lastPoint, 0.4);
        }

        if (!islandInfill.length) continue;

        var myBridge = G.intersect(bridgeRegion[Li], islandInfill);
        var myInternalBridge = G.intersect(internalBridge[Li], islandInfill);
        var myTop = G.intersect(topRegion[Li], islandInfill);
        var mySolid = G.subtract(G.intersect(solidRegion[Li], islandInfill), myTop);
        if (myInternalBridge.length) {
          mySolid = G.subtract(mySolid, myInternalBridge);
          myTop = G.subtract(myTop, myInternalBridge);
        }
        var mySparse = G.intersect(sparseRegion[Li], islandInfill);

        // A sparse island small enough is not worth being sparse: a few
        // disconnected strands rattling inside a pocket hold nothing up and
        // give the layer above nothing to sit on. Below a threshold area they
        // are filled solid instead, which is what the interior of a tapering
        // rib gets and what it needs.
        if (mySparse.length && s.solidInfillBelowArea > 0) {
          var pockets = G.toIslands(mySparse);
          var tiny = [];
          for (var pk = 0; pk < pockets.length; pk++) {
            var pocket = G.islandPaths(pockets[pk]);
            if (G.totalArea(pocket) < s.solidInfillBelowArea) tiny = G.unite(tiny, pocket);
          }
          if (tiny.length) {
            mySolid = G.unite(mySolid, tiny);
            mySparse = G.subtract(mySparse, tiny);
          }
        }

        // Monotonic ordering costs travel, so spend it where it shows.
        var solidGap = extrusionSpacing(wl.inner, layerPlan[Li].height);
        var monoTop = s.monotonicSurfaces !== 'none' && s.solidPattern === 'lines';
        var monoSolid = s.monotonicSurfaces === 'all' && s.solidPattern === 'lines';
        if (myBridge.length) {
          var bridgeAngle = s.bridgeAngleDetection ? bestBridgeAngle(myBridge, wl.bridge, angle) : angle;
          pushInfill(feats, myBridge, 'lines', wl.bridge, bridgeAngle, printZ, FEATURE.BRIDGE, wl.bridge, lastPoint);
        }
        if (myInternalBridge.length) {
          // Run these across the infill lines below rather than along them.
          var internalAngle = angle + 90;
          pushInfill(feats, myInternalBridge, 'lines',
                     extrusionSpacing(wl.inner, layerPlan[Li].height), internalAngle, printZ,
                     FEATURE.INTERNAL_BRIDGE, wl.inner, lastPoint);
        }
        pushInfill(feats, mySolid, s.solidPattern, solidGap, angle, printZ, FEATURE.SOLID, wl.inner, lastPoint, null, monoSolid, false, 0, true);
        pushInfill(feats, myTop, s.solidPattern, solidGap, angle, printZ, FEATURE.TOP, wl.inner, lastPoint, null, monoTop, false, 0, true);

        if (mySparse.length && s.infillDensity > 0) {
          if (lightning) {
            var branches = G.clipLinesToRegion(lightning[Li], mySparse);
            if (branches.length) {
              branches = I.orderPolylines(branches, lastPoint);
              for (var bi = 0; bi < branches.length; bi++) {
                if (branches[bi].length < 2) continue;
                if (I.polylineLength(branches[bi]) < 0.3) continue;
                feats.push({ type: FEATURE.SPARSE, w: wl.inner, pts: branches[bi], closed: false });
              }
            }
          } else {
            pushInfill(feats, mySparse, s.infillPattern, solidGap / (s.infillDensity / 100),
                       angle, printZ, FEATURE.SPARSE, wl.inner, lastPoint, null, false, true,
                       Math.min(s.infillAnchor || 0, 12));
          }
        }

        // --- ironing: a near-dry pass that melts the top smooth ---
        if (s.ironing !== 'none') {
          var ironRegion = s.ironing === 'all-solid' ? G.unite(myTop, mySolid) : myTop;
          ironRegion = G.offsetPaths(ironRegion, -wl.inner * 0.3);
          if (ironRegion.length) {
            pushInfill(feats, ironRegion, 'lines', Math.max(0.05, s.ironingSpacing),
                       angle + 90, printZ, FEATURE.IRONING, wl.inner, lastPoint, 1.0, s.monotonicSurfaces !== 'none');
          }
        }

        if (feats.length) lastPoint = feats[feats.length - 1].pts[feats[feats.length - 1].pts.length - 1];
      }

      // --- support ---
      if (support.base[Li] && support.base[Li].length) {
        // A branch is barely wider than the bead that draws it, so tracing its
        // outline IS the support. Hatching it would be a dot per layer.
        if (s.supportStyle === 'tree') {
          pushContours(feats, support.base[Li], wl.inner, FEATURE.SUPPORT, lastPoint, s);
        } else {
          pushInfill(feats, support.base[Li], s.supportPattern,
                     wl.inner / Math.max(0.03, s.supportDensity / 100), Li % 2 ? 90 : 0,
                     printZ, FEATURE.SUPPORT, wl.inner, lastPoint);
        }
      }
      if (support.iface[Li] && support.iface[Li].length) {
        pushInfill(feats, support.iface[Li], 'lines',
                   wl.inner / Math.max(0.05, s.supportInterfaceDensity / 100), Li % 2 ? 0 : 90,
                   printZ, FEATURE.SUPPORT_IFACE, wl.inner, lastPoint);
      }
      if (feats.length) lastPoint = feats[feats.length - 1].pts[feats[feats.length - 1].pts.length - 1];

      outLayers[Li] = {
        z: printZ,
        h: layerPlan[Li].height,
        feats: feats,
        // What this layer covers. Read by the prime tower, which has to know
        // where the parts are before it can stand anywhere else. Dropped
        // before the layers are packed.
        region: regions[Li],
        // Where the nozzle may travel without retracting, when that is asked
        // for: only where it would actually run over plastic, so the walls and
        // the solid areas. The sparse interior is mostly air, and a travel
        // across it with the pressure still on drips into the cavity and comes
        // out of the far side as a string.
        comb: s.combing
          ? G.subtract(G.offsetPaths(regions[Li], -wl.ext * 0.6), sparseRegion[Li] || [])
          : null
      };
      if ((Li & 3) === 0) progress(0.53 + 0.30 * (Li / n), 'Generating toolpaths');
    }

    if (s.adhesion === 'raft' && s.raftLayers > 0) outLayers = prependRaft(outLayers, regions, support, s);
    return { layers: outLayers, minZ: minZ, maxZ: maxZ };
  }

  // ---------------------------------------------------------------------------
  // More than one tool
  // ---------------------------------------------------------------------------

  /**
   * Interleave several objects' layers into one plate, tagging every feature
   * with the tool that prints it and grouping by tool within each layer.
   *
   * Grouping is the whole point: a tool change costs a purge, so touching each
   * tool once per layer instead of once per object is the difference between a
   * few grams of waste and a spool of it.
   */
  function interleaveObjects(built, s) {
    var byZ = {};
    var order = [];
    for (var o = 0; o < built.length; o++) {
      var tool = built[o].extruder || 0;
      var layers = built[o].layers;
      for (var L = 0; L < layers.length; L++) {
        var layer = layers[L];
        if (!layer.feats.length) continue;
        var key = Math.round(layer.z * 1000);
        if (!byZ[key]) { byZ[key] = { z: layer.z, h: layer.h, comb: [], tools: {} }; order.push(key); }
        var slot = byZ[key];
        slot.h = Math.max(slot.h, layer.h);
        if (layer.comb && layer.comb.length) slot.comb = G.unite(slot.comb, layer.comb);
        (slot.tools[tool] || (slot.tools[tool] = [])).push.apply(slot.tools[tool], layer.feats);
      }
    }
    order.sort(function (a, b) { return a - b; });

    var out = [];
    var lastTool = 0;
    for (var i = 0; i < order.length; i++) {
      var slot = byZ[order[i]];
      var tools = Object.keys(slot.tools).map(Number);
      // Carry on with the tool already in the hotend where we can.
      tools.sort(function (a, b) {
        if (a === lastTool) return -1;
        if (b === lastTool) return 1;
        return a - b;
      });
      var feats = [];
      for (var t = 0; t < tools.length; t++) {
        var list = slot.tools[tools[t]];
        for (var f = 0; f < list.length; f++) list[f].extruder = tools[t];
        feats.push.apply(feats, list);
      }
      lastTool = tools[tools.length - 1];
      out.push({ z: slot.z, h: slot.h, feats: feats, comb: slot.comb.length ? slot.comb : null,
                 idx: i, tools: tools });
    }
    return out;
  }

  /**
   * A block printed beside the part, one strip per tool, so a tool that has
   * just been swapped in pushes the previous colour out of the melt zone
   * somewhere that is not the model.
   *
   * The strips are the same every layer, so the tower stands up on itself.
   */
  function addPrimeTower(layers, s, keepClear) {
    var side = Math.max(15, s.primeTowerWidth || 45);
    var spot = placeTower(side, s, keepClear);
    if (!spot) return { placed: false, findings: [{
      severity: 'error', code: 'primetower.nospace', line: 0, text: '',
      message: 'No room on the plate for a ' + side.toFixed(0) + ' mm prime tower',
      detail: 'Printing with more than one tool needs somewhere off the model to push the ' +
              'old colour out. Make the tower smaller, move the objects, or place it by hand.'
    }] };

    var used = 0;
    for (var L = 0; L < layers.length; L++) {
      var tools = layers[L].tools || [];
      if (tools.length < 2 && used === 0) continue;      // nothing to purge into yet
      if (tools.length < 2 && L > 0 && !(layers[L - 1].tools || []).length) continue;
      used++;

      // Enough cross-section that a layer of one strip holds the purge volume.
      var strips = Math.max(2, tools.length);
      var stripW = side / strips;
      var lineW = s.lineWidth;
      var byTool = {};
      for (var t = 0; t < tools.length; t++) {
        var x0 = spot.x + t * stripW, x1 = x0 + stripW;
        byTool[tools[t]] = rectRegion(x0 + lineW * 0.5, spot.y + lineW * 0.5,
                                      x1 - lineW * 0.5, spot.y + side - lineW * 0.5);
      }
      // Anything left over is swept by the first tool so the block stays solid.
      for (t = tools.length; t < strips; t++) {
        var ex0 = spot.x + t * stripW, ex1 = ex0 + stripW;
        byTool[tools[0]] = G.unite(byTool[tools[0]],
          rectRegion(ex0 + lineW * 0.5, spot.y + lineW * 0.5, ex1 - lineW * 0.5,
                     spot.y + side - lineW * 0.5));
      }

      var extra = [];
      for (t = 0; t < tools.length; t++) {
        var tool = tools[t];
        var region = byTool[tool];
        if (!region || !region.length) continue;
        var feats = [];
        pushInfill(feats, region, 'lines', lineW, L % 2 ? 45 : 135, layers[L].z,
                   FEATURE.SOLID, lineW, { X: 0, Y: 0 });
        for (var k = 0; k < feats.length; k++) {
          feats[k].extruder = tool;
          feats[k].primeTower = true;
        }
        extra.push({ tool: tool, feats: feats });
      }
      // Each tool's strip goes in BEFORE that tool touches the model. The point
      // of the tower is to push the previous colour out; printing it afterwards
      // would put the contamination on the part and the clean plastic in the bin.
      var merged = [];
      var placed = {};
      for (var f = 0; f < layers[L].feats.length; f++) {
        var here = layers[L].feats[f].extruder || 0;
        if (!placed[here]) {
          for (var e = 0; e < extra.length; e++) {
            if (extra[e].tool !== here) continue;
            merged.push.apply(merged, extra[e].feats);
          }
          placed[here] = true;
        }
        merged.push(layers[L].feats[f]);
      }
      layers[L].feats = merged;
    }
    return { placed: true, findings: [], x: spot.x, y: spot.y, side: side };
  }

  function rectRegion(x0, y0, x1, y1) {
    return [[{ X: Math.round(x0 * SCALE), Y: Math.round(y0 * SCALE) },
             { X: Math.round(x1 * SCALE), Y: Math.round(y0 * SCALE) },
             { X: Math.round(x1 * SCALE), Y: Math.round(y1 * SCALE) },
             { X: Math.round(x0 * SCALE), Y: Math.round(y1 * SCALE) }]];
  }

  /** Somewhere on the plate the tower fits without touching anything. */
  function placeTower(side, s, keepClear) {
    if (s.primeTowerX >= 0 && s.primeTowerY >= 0) {
      return { x: s.primeTowerX, y: s.primeTowerY };
    }
    var margin = 5;
    var corners = [
      { x: s.bedX - side - margin, y: s.bedY - side - margin },
      { x: margin, y: s.bedY - side - margin },
      { x: s.bedX - side - margin, y: margin },
      { x: margin, y: margin }
    ];
    for (var i = 0; i < corners.length; i++) {
      var c = corners[i];
      if (c.x < 0 || c.y < 0) continue;
      var box = rectRegion(c.x - 2, c.y - 2, c.x + side + 2, c.y + side + 2);
      if (G.totalArea(G.intersect(box, keepClear)) > 0.01) continue;
      return c;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Sequential printing
  // ---------------------------------------------------------------------------

  /** Footprint and height of a triangle soup, for the clearance arithmetic. */
  function objectExtent(positions) {
    var minX = Infinity, minY = Infinity, minZ = Infinity;
    var maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (var i = 0; i + 2 < positions.length; i += 3) {
      var x = positions[i], y = positions[i + 1], z = positions[i + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    // Hull of the footprint, decimated so a 200k-triangle mesh does not turn
    // this into the slowest thing in the pipeline.
    var pts = [];
    var stride = Math.max(1, Math.floor(positions.length / 3 / 4000));
    for (i = 0; i + 2 < positions.length; i += 3 * stride) {
      pts.push({ X: Math.round(positions[i] * SCALE), Y: Math.round(positions[i + 1] * SCALE) });
    }
    return {
      minX: minX, maxX: maxX, minY: minY, maxY: maxY, minZ: minZ, maxZ: maxZ,
      hull: convexHull(pts),
      cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, height: maxZ - Math.min(0, minZ)
    };
  }

  /**
   * Shortest distance between two footprints, 0 if they touch or overlap.
   *
   * Convex hulls, not bounding boxes. Two parts arranged around each other —
   * an L beside its mirror image, a pair of brackets nested corner to corner —
   * have boxes that overlap while the parts themselves are centimetres apart,
   * and refusing to print those one at a time would be refusing for no reason.
   */
  function hullGap(a, b) {
    var best = Infinity, i, j;
    for (i = 0; i < a.hull.length; i++) {
      if (pointInConvex(a.hull[i], b.hull)) return 0;
    }
    for (i = 0; i < b.hull.length; i++) {
      if (pointInConvex(b.hull[i], a.hull)) return 0;
    }
    for (i = 0; i < a.hull.length; i++) {
      var a0 = a.hull[i], a1 = a.hull[(i + 1) % a.hull.length];
      for (j = 0; j < b.hull.length; j++) {
        var b0 = b.hull[j], b1 = b.hull[(j + 1) % b.hull.length];
        var d = segmentDistance(a0, a1, b0, b1);
        if (d < best) best = d;
      }
    }
    return best === Infinity ? 0 : best / SCALE;
  }

  function pointInConvex(pt, hull) {
    if (hull.length < 3) return false;
    var sign = 0;
    for (var i = 0; i < hull.length; i++) {
      var a = hull[i], b = hull[(i + 1) % hull.length];
      var cross = (b.X - a.X) * (pt.Y - a.Y) - (b.Y - a.Y) * (pt.X - a.X);
      if (cross === 0) continue;
      var here = cross > 0 ? 1 : -1;
      if (sign === 0) sign = here;
      else if (sign !== here) return false;
    }
    return true;
  }

  function pointSegmentDistance(p, a, b) {
    var dx = b.X - a.X, dy = b.Y - a.Y;
    var len2 = dx * dx + dy * dy;
    var t = len2 < 1e-9 ? 0 : ((p.X - a.X) * dx + (p.Y - a.Y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.X - (a.X + dx * t), p.Y - (a.Y + dy * t));
  }

  function segmentDistance(a0, a1, b0, b1) {
    return Math.min(
      pointSegmentDistance(a0, b0, b1), pointSegmentDistance(a1, b0, b1),
      pointSegmentDistance(b0, a0, a1), pointSegmentDistance(b1, a0, a1));
  }

  /**
   * Decide the order objects are printed in, and say plainly when the plate
   * cannot be printed this way at all.
   *
   * Front to back is the order that matters on a bed-slinger: the gantry beam
   * runs across X and sweeps everything behind the nozzle, so a finished part
   * must never be left in front of the one being printed. Within a row, left to
   * right keeps the travels short.
   *
   * The extruder body is what collides first, so a part taller than the
   * clearance height needs a clear radius around it before anything else is
   * printed. When it does not have one, that is an error and not a warning: the
   * head will drive into a finished part.
   */
  function sequencePlan(objects, s) {
    var radius = s.extruderClearanceRadius > 0 ? s.extruderClearanceRadius : 45;
    var lift = s.extruderClearanceHeight > 0 ? s.extruderClearanceHeight : 25;
    var items = objects.map(function (obj, i) {
      return { index: i, positions: obj.positions || obj, name: obj.name || ('object ' + (i + 1)),
               extent: objectExtent(obj.positions || obj) };
    });
    items.sort(function (a, b) {
      var dy = a.extent.cy - b.extent.cy;
      if (Math.abs(dy) > 1e-6) return dy;
      return a.extent.cx - b.extent.cx;
    });

    var slinger = s.kinematics === 'bedslinger';
    var findings = [];
    for (var i = 0; i < items.length; i++) {
      var first = items[i].extent;
      // Only the part printed FIRST is standing there when the other is made.
      if (first.height <= lift) continue;

      for (var j = i + 1; j < items.length; j++) {
        var later = items[j].extent;
        var gap = hullGap(first, later);
        if (gap < radius) {
          findings.push({
            severity: 'error', code: 'sequence.clearance', line: 0, text: '',
            message: items[i].name + ' and ' + items[j].name + ' are only ' +
                     gap.toFixed(1) + ' mm apart, and one at a time needs ' + radius.toFixed(0) + ' mm',
            detail: items[i].name + ' is ' + first.height.toFixed(1) +
                    ' mm tall, above the ' + lift.toFixed(0) + ' mm the extruder body clears. ' +
                    'Printing one object at a time would drive the head into it. Move them further ' +
                    'apart, or print by layer instead.'
          });
          continue;
        }

        // On a bed-slinger the whole X beam is at the nozzle's Y, so a finished
        // part anywhere on that line is in its path however far away in X it is.
        // The XY gap around it is no help at all; only Y separation is.
        if (!slinger) continue;
        var yGap = Math.max(0, later.minY - first.maxY);
        if (yGap >= lift) continue;
        findings.push({
          severity: 'error', code: 'sequence.gantry', line: 0, text: '',
          message: items[i].name + ' is only ' + yGap.toFixed(1) +
                   ' mm in front of ' + items[j].name + ', and the gantry needs ' +
                   lift.toFixed(0) + ' mm',
          detail: 'This printer slings the bed under a fixed X beam, so everything at ' +
                  'the nozzle\'s Y is swept whatever its X. ' + items[i].name + ' stands ' +
                  first.height.toFixed(1) + ' mm tall and would be printed first. Separate ' +
                  'them along Y, or print by layer instead.'
        });
      }
    }
    return { items: items, findings: findings, radius: radius, lift: lift };
  }

  function slice(job, onProgress) {
    var s = job.settings;
    var progress = onProgress || function () {};

    if (s.spiralVase) {
      s.wallLoops = 1; s.infillDensity = 0; s.topLayers = 0;
      s.ironing = 'none'; s.gapFill = false; s.supportEnable = false;
    }

    var objects = job.objects && job.objects.length ? job.objects : null;
    var sequential = s.printSequence === 'object' && objects && objects.length > 1 && !s.spiralVase;

    // More than one tool in play means the layers have to be woven together so
    // each tool is picked up once per layer rather than once per object.
    var tools = {};
    if (objects) for (var oi = 0; oi < objects.length; oi++) tools[objects[oi].extruder | 0] = true;
    var multiTool = !sequential && !s.spiralVase && objects && (s.extruderCount || 1) > 1 &&
                    Object.keys(tools).length > 1;

    var outLayers, minZ, maxZ, extra = [];

    if (sequential) {
      var plan = sequencePlan(objects, s);
      extra = plan.findings;
      outLayers = [];
      minZ = Infinity; maxZ = -Infinity;
      for (var o = 0; o < plan.items.length; o++) {
        var item = plan.items[o];
        var span = 0.8 / plan.items.length;
        var built = buildObject(item.positions, s, function (f, label) {
          progress(f * span + o * span, label + ' — ' + item.name);
        });
        for (var b = 0; b < built.layers.length; b++) {
          built.layers[b].idx = b;                   // first layer of THIS object
          built.layers[b].object = item.name;
          if (b === 0) built.layers[b].objectStart = o > 0;
        }
        minZ = Math.min(minZ, built.minZ);
        maxZ = Math.max(maxZ, built.maxZ);
        outLayers = outLayers.concat(built.layers);
      }
    } else if (multiTool) {
      var built = [];
      outLayers = [];
      minZ = Infinity; maxZ = -Infinity;
      var footprints = [];
      for (var mo = 0; mo < objects.length; mo++) {
        var obj = objects[mo];
        var mSpan = 0.7 / objects.length;
        var mBuilt = buildObject(obj.positions, s, function (f, label) {
          progress(f * mSpan + mo * mSpan, label + ' — ' + (obj.name || 'object'));
        });
        mBuilt.extruder = Math.max(0, Math.min((s.extruderCount || 1) - 1, obj.extruder | 0));
        built.push(mBuilt);
        minZ = Math.min(minZ, mBuilt.minZ);
        maxZ = Math.max(maxZ, mBuilt.maxZ);
        for (var ml = 0; ml < mBuilt.layers.length; ml++) {
          // The outline, never the combing region: where the tower may stand
          // is a fact about the plate, and must not change because somebody
          // switched a travel setting off.
          var foot = mBuilt.layers[ml].region;
          if (foot && foot.length) footprints = G.unite(footprints, foot);
        }
      }
      outLayers = interleaveObjects(built, s);
      progress(0.78, 'Building the prime tower');
      var tower = addPrimeTower(outLayers, s, G.offsetPaths(footprints, s.lineWidth * 4));
      extra = tower.findings;
    } else {
      var single = buildObject(job.positions, s, function (f, label) { progress(f * 0.85, label); });
      outLayers = single.layers;
      minZ = single.minZ;
      maxZ = single.maxZ;
    }

    progress(0.85, 'Writing G-code');
    var gcode = generateGcode(outLayers, s);
    for (var c = 0; c < outLayers.length; c++) { outLayers[c].comb = null; outLayers[c].region = null; }

    progress(0.95, 'Verifying G-code');
    var report = verifyOutput(gcode.text, s);
    if (extra.length) {
      report = {
        ok: false,
        errors: report.errors + extra.length,
        warnings: report.warnings,
        findings: extra.concat(report.findings),
        summary: report.summary
      };
    }
    progress(1, 'Done');

    return {
      layers: outLayers,
      gcode: gcode.text,
      stats: gcode.stats,
      report: report,
      bounds: { minZ: minZ, maxZ: maxZ, layerCount: outLayers.length }
    };
  }

  /**
   * Run the safety verifier over what was actually written. A checker that
   * silently disappears is worse than no checker, so both its absence and its
   * own failure are reported as problems rather than passing quietly.
   */
  function verifyOutput(text, s) {
    if (!root.OrcaGcodeCheck) {
      return {
        ok: false, errors: 1, warnings: 0,
        findings: [{
          severity: 'error', code: 'checker.missing', line: 0, text: '',
          message: 'The G-code safety check could not run',
          detail: 'gcodecheck.js was not loaded, so this file has not been verified.'
        }],
        summary: {}
      };
    }
    try {
      return root.OrcaGcodeCheck.verify(text, s);
    } catch (err) {
      return {
        ok: false, errors: 1, warnings: 0,
        findings: [{
          severity: 'error', code: 'checker.failed', line: 0, text: '',
          message: 'The G-code safety check itself failed',
          detail: (err && err.message) || String(err)
        }],
        summary: {}
      };
    }
  }

  /**
   * Keep only what is at least one line wide, by opening the region.
   *
   * A detected surface narrower than a line is not a surface: it is the edge of
   * a slope, and the perimeters have already covered it. On a gently curved
   * underside every layer hangs a few hundredths of a millimetre past the one
   * below, and treating that as a bottom surface wraps the whole part in a
   * solid ring it does not need — a fifth of the material on a sphere, laid
   * into a sliver far too narrow to hold it.
   *
   * Only DETECTED surfaces get this. A region that is solid because the whole
   * interior is solid has nothing to detect and nothing to filter.
   */
  function openSurface(paths, lineWidth) {
    if (!paths || !paths.length) return paths || [];
    var r = lineWidth * 0.5;
    return G.offsetPaths(G.offsetPaths(paths, -r), r);
  }

  /**
   * Where the centreline of wall `k` goes.
   *
   * Walls sit a SPACING apart, not a width apart. Two beads interlock — the
   * top and bottom of each pinches in to meet its neighbour — so their centres
   * end up w - h(1 - pi/4) apart. Stepping by the nominal width instead leaves
   * a hairline void between every pair of walls: invisible on a part with
   * infill to swallow it, and a measurable hole through the middle of a rib
   * that is nothing but walls.
   */
  function wallDepth(k, wl, h) {
    if (k <= 0) return wl.ext / 2;
    return wl.ext / 2 + (extrusionSpacing(wl.ext, h) + extrusionSpacing(wl.inner, h)) / 2 +
           (k - 1) * extrusionSpacing(wl.inner, h);
  }

  /** How deep the whole wall stack reaches, inner edge of the last wall. */
  function wallStack(loops, wl, h) {
    if (loops <= 0) return 0;
    return wallDepth(loops - 1, wl, h) +
           extrusionSpacing(loops === 1 ? wl.ext : wl.inner, h) / 2;
  }

  function infillBoundary(paths, layerIndex, s, layerH) {
    if (!paths || !paths.length) return [];
    if (s.wallLoops <= 0) return G.copyPaths(paths);
    var w = widthsFor(layerIndex, s);
    var shrink = wallStack(s.wallLoops, w, layerH || s.layerHeight);
    return G.offsetPaths(paths, -shrink + s.infillOverlap * w.inner);
  }

  function widthsFor(layerIndex, s) {
    if (layerIndex === 0) return { ext: s.firstLayerLineWidth, inner: s.firstLayerLineWidth, bridge: s.nozzle };
    return { ext: s.externalLineWidth, inner: s.lineWidth, bridge: s.nozzle };
  }

  /**
   * Which wall to lay first.
   *
   * inner-outer-inner is Orca's default and the reason is mechanical: the outer
   * wall goes down with one inner wall already behind it to press against, so it
   * holds its line, while the walls further in still get laid against it
   * afterwards. Printing the outer wall first leaves it unsupported; printing it
   * last means it is squeezed against everything and bulges.
   */
  function orderWalls(levels, mode) {
    if (levels.length < 2) return levels.slice();
    if (mode === 'outer-inner') return levels.slice();
    if (mode === 'inner-outer' || levels.length < 3) return levels.slice().reverse();
    var out = [levels[1], levels[0]];
    for (var i = 2; i < levels.length; i++) out.push(levels[i]);
    return out;
  }

  function orderIslands(islands, from) {
    var rest = islands.slice(), out = [], cx = from.X, cy = from.Y;
    while (rest.length) {
      var best = 0, bd = Infinity;
      for (var i = 0; i < rest.length; i++) {
        var c = islandCentroid(rest[i]);
        var d = (c.X - cx) * (c.X - cx) + (c.Y - cy) * (c.Y - cy);
        if (d < bd) { bd = d; best = i; }
      }
      var chosen = rest.splice(best, 1)[0];
      out.push(chosen);
      var cc = islandCentroid(chosen); cx = cc.X; cy = cc.Y;
    }
    return out;
  }

  /**
   * Variable-width beads down the medial axis of `region`. Each bead carries a
   * width per point, so the extruder tracks the real local thickness instead of
   * laying a fixed line and leaving voids or over-filling.
   */
  /** Insert points so no segment of a closed path is longer than `maxStep`. */
  function densifyClosed(path, maxStep) {
    var out = [];
    for (var i = 0; i < path.length; i++) {
      var a = path[i], b = path[(i + 1) % path.length];
      out.push(a);
      var dx = b.X - a.X, dy = b.Y - a.Y;
      var steps = Math.floor(Math.hypot(dx, dy) / maxStep);
      for (var k = 1; k <= steps; k++) {
        var t = k / (steps + 1);
        out.push({ X: Math.round(a.X + dx * t), Y: Math.round(a.Y + dy * t) });
      }
    }
    return out;
  }

  /** Inward (material-side) unit normals for a closed vertex ring. */
  function inwardNormals(pts) {
    var n = pts.length, out = new Array(n);
    for (var i = 0; i < n; i++) {
      var prev = pts[(i - 1 + n) % n], next = pts[(i + 1) % n];
      var ax = pts[i].X - prev.X, ay = pts[i].Y - prev.Y;
      var bx = next.X - pts[i].X, by = next.Y - pts[i].Y;
      var la = Math.hypot(ax, ay) || 1, lb = Math.hypot(bx, by) || 1;
      // With outer rings counter-clockwise and holes clockwise, the material is
      // always to the left of travel.
      var nx = (-ay / la) + (-by / lb), ny = (ax / la) + (bx / lb);
      var len = Math.hypot(nx, ny);
      out[i] = len < 1e-9 ? { x: 0, y: 0 } : { x: nx / len, y: ny / len };
    }
    return out;
  }

  /** Three-tap smoothing of a per-vertex value along a ring, alive vertices only. */
  function smoothRing(values, alive, passes) {
    var n = values.length;
    for (var p = 0; p < passes; p++) {
      var copy = values.slice();
      for (var i = 0; i < n; i++) {
        if (!alive[i]) continue;
        var a = (i - 1 + n) % n, b = (i + 1) % n;
        var sum = copy[i] * 2, weight = 2;
        if (alive[a]) { sum += copy[a]; weight++; }
        if (alive[b]) { sum += copy[b]; weight++; }
        values[i] = sum / weight;
      }
    }
  }

  /**
   * Pinch a bead out rather than stopping it dead.
   *
   * Where a wall runs out of room the loop simply ended, which leaves the full
   * bead width extruding right up to the last point and a blob where the
   * pressure has nowhere to go. Ramping the width down to the minimum over the
   * transition length ends it the way it started.
   */
  function taperEnds(width, alive, rampPoints, minWidth) {
    var n = width.length;
    for (var i = 0; i < n; i++) {
      if (!alive[i]) continue;
      // Distance in points to the nearest dead neighbour, in either direction.
      var reach = rampPoints + 1;
      var d = reach;
      for (var k = 1; k <= rampPoints; k++) {
        if (!alive[(i + k) % n] || !alive[(i - k + n) % n]) { d = k; break; }
      }
      if (d > rampPoints) continue;
      var t = d / (rampPoints + 1);            // 0 at the end, 1 a full ramp in
      var target = Math.min(width[i], minWidth);
      width[i] = target + (width[i] - target) * t;
    }
  }

  /** Maximal runs of equal flag around a ring, as [start, length] pairs. */
  function ringRuns(flag, n) {
    var start = 0;
    while (start < n && flag[start] === flag[(start - 1 + n) % n]) start++;
    if (start === n) return [[0, n]];               // uniform ring
    var runs = [], i = 0;
    while (i < n) {
      var at = (start + i) % n, len = 1;
      while (len < n - i && flag[(at + len) % n] === flag[at]) len++;
      runs.push([at, len]);
      i += len;
    }
    return runs;
  }

  /**
   * Arachne's redistribution, applied to every wall loop rather than only to the
   * scraps the fixed-width loops could not reach.
   *
   * At each vertex the local thickness says how many beads fit across the
   * material there. Where the whole stack fits, nothing changes and the loops
   * stay exactly where clipper put them — which keeps arc fitting and scarf
   * seams eligible on ordinary parts. Where it does not, the beads that do fit
   * are widened to share the space evenly and the ones that do not are dropped,
   * so a 1.1 mm rib gets two beads that meet instead of two starved walls and a
   * strand of gap fill squeezed between them.
   *
   * Bead 0 keeps its outer edge on the outline whatever width it is given, so
   * the printed surface never moves.
   */
  /**
   * `levels` are offsets of the region the walls were drawn in; `base` is the
   * whole island. They differ: anything too narrow for a bead is taken out
   * before the walls are drawn. The thickness field has to describe the
   * material, not the part of it the walls were allowed to use — measuring the
   * opened subset makes the taper read thinner than it is exactly where the two
   * mechanisms meet, and the bead that has to cover it comes out a sixth narrow.
   */
  function redistributeWalls(levels, base, s, wl, layerH) {
    if (!root.OrcaBeading || !root.OrcaBeading.thicknessField) return null;
    var loops = s.wallLoops;
    var stack = wallStack(loops, wl, layerH || s.layerHeight);

    // A cell-centre distance transform is only accurate to about half a cell,
    // and half a cell of error on a 0.9 mm wall is a tenth of the bead. The
    // grid is fine enough that the residual is a few hundredths of a
    // millimetre; the cell budget coarsens it again for regions big enough not
    // to care.
    var minW = Math.max(0.05, s.minBeadWidth || wl.inner * 0.6);
    var maxW = Math.max(minW, s.maxBeadWidth || wl.inner * 1.8);
    var field = root.OrcaBeading.thicknessField(base, {
      resolution: Math.max(0.012, wl.inner / 20),
      maxRes: wl.inner * 0.45,
      maxCells: 6e5,
      maxHalfThickness: stack + wl.inner
    });
    if (!field) return false;

    // A bead-count change has to persist to be worth acting on: rounding a
    // corner dips the local thickness for a fraction of a millimetre, and
    // following that would put a kink in an otherwise straight wall.
    var minRun = Math.max(1.0, wl.inner * 2) * SCALE;
    var step = Math.max(field.res * 1.5, wl.inner * 0.5) * SCALE;
    var maxShift = wl.inner;
    var touched = false;

    // A wall does not change its mind at a point. Widths ramp across this
    // distance and a wall about to end tapers over it, so two loops become one
    // as a smooth pinch instead of a step and a blob.
    // The raster field is a good estimate almost everywhere and a bad one at a
    // reflex corner, where it reads a star polygon's arms as a fifth of a
    // millimetre thick. So the same question is also asked exactly, of the
    // polygons themselves: material is at least R thick at a point when some
    // disc of radius R fits inside it AND covers that point, which is exactly
    // what survives an opening at R. A handful of openings — one per bead the
    // stack could hold — gives a floor the estimate can only be raised by.
    var bands = [];
    // "The stack fits" has to mean the stack AND something for it to enclose.
    // With one wall on a 1.6 mm rib the nominal 0.62 bead fits twice over with
    // 0.36 mm left in the middle — too little for infill, so the bead should
    // widen to 0.8 and cover it. Judged on the stack alone it stayed nominal
    // and the leftover was filled at full width on top of itself.
    var roomy = stack + wl.inner * 0.5;
    var bandRadii = [roomy, stack];
    for (var bn = 2 * loops; bn >= 1; bn--) bandRadii.push((bn - 0.5) * wl.inner / 2);
    for (var bq = 0; bq < bandRadii.length; bq++) {
      var bR = bandRadii[bq];
      if (bq && bR >= bandRadii[bq - 1]) continue;
      var opened = G.offsetPaths(G.offsetPaths(base, -bR), bR);
      if (opened.length) bands.push({ r: bR, region: opened });
    }
    function provenHalf(pt) {
      for (var bi = 0; bi < bands.length; bi++) {
        if (G.pointInPaths(pt, bands[bi].region)) return bands[bi].r;
      }
      return 0;
    }

    var interlock = (layerH || s.layerHeight) * (1 - Math.PI / 4);
    var transition = Math.max(wl.inner * 0.5, s.wallTransitionLength || wl.inner);
    var rampPoints = Math.max(1, Math.round(transition * SCALE / step));

    for (var k = 0; k < levels.length; k++) {
      var lvl = levels[k];
      var nomW = k === 0 ? wl.ext : wl.inner;
      var nomD = wallDepth(k, wl, layerH || s.layerHeight);
      var varRuns = [], plainPaths = [], levelTouched = false;


      for (var pi = 0; pi < lvl.paths.length; pi++) {
        var pts = densifyClosed(lvl.paths[pi], step);
        var n = pts.length;
        if (n < 3) continue;
        var norms = inwardNormals(pts);

        var alive = new Uint8Array(n), width = new Float64Array(n), depth = new Float64Array(n);
        var plain = new Uint8Array(n);        // 1 = nothing to change here
        var i;

        for (i = 0; i < n; i++) {
          var h = Math.max(field.sample(pts[i].X / SCALE, pts[i].Y / SCALE),
                           provenHalf(pts[i]));
          // The raster is only sure of itself to half a cell. Where a ray cast
          // through the point along its own normal agrees with it to within
          // that, the ray is exact and is believed instead: on a 0.9 mm wall
          // that is the difference between a 0.482 bead and the 0.493 that
          // tiles it. Where they disagree the point is near a corner, the
          // perpendicular is not the local thickness, and the raster stands.
          var exact = rayHalfThickness(pts[i], norms[i], base);
          if (exact > 0 && Math.abs(exact - h) < field.res * 1.5) h = exact;
          var N = Math.round(2 * h / wl.inner);
          if (N < 1) N = 1;
          if (N > 2 * loops) N = 2 * loops;
          var w = 2 * h / N;
          while (w < minW && N > 1) { N--; w = 2 * h / N; }
          while (w > maxW && N < 2 * loops) { N++; w = 2 * h / N; }

          // Room for the whole stack is a question about DEPTH, not bead count.
          // Rounding 2h/w up to the full count lets a 1.6 mm wall claim it fits
          // two 0.42 walls a side — 1.68 mm of bead in 1.6 mm of material, and
          // the two sides overlap by a tenth.
          if (h >= roomy - 1e-9) {
            alive[i] = 1; plain[i] = 1; width[i] = nomW; depth[i] = nomD;
          } else {
            alive[i] = (2 * k + 2 <= N) ? 1 : 0;
            // `w` is the SPACING the beads sit at, which is not their width: two
            // rounded-rectangle beads interlock, so a bead that fills a slot `w`
            // wide has to be commanded `w + h(1 - pi/4)` wide. Treating the two
            // as the same thing under-fills a 1.2 mm rib by a tenth.
            width[i] = Math.min(maxW, Math.max(minW, w + interlock));
            depth[i] = (k + 0.5) * w;
          }
        }

        // Transition filter, both ways: a short stretch of redistribution inside
        // an otherwise plain wall is noise, and so is a short gap in a wall that
        // is otherwise continuous.
        var rs = ringRuns(plain, n), r, at, len, arc, j;
        for (r = 0; r < rs.length; r++) {
          at = rs[r][0]; len = rs[r][1];
          if (plain[at] || len === n) continue;
          arc = runArc(pts, at, len);
          if (arc >= minRun) continue;
          for (j = 0; j < len; j++) {
            var q = (at + j) % n;
            plain[q] = 1; alive[q] = 1; width[q] = nomW; depth[q] = nomD;
          }
        }
        rs = ringRuns(alive, n);
        for (r = 0; r < rs.length; r++) {
          at = rs[r][0]; len = rs[r][1];
          if (alive[at] || len === n) continue;
          if (runArc(pts, at, len) >= minRun) continue;
          var before = (at - 1 + n) % n, after = (at + len) % n;
          for (j = 0; j < len; j++) {
            var c = (at + j) % n, t = (j + 1) / (len + 1);
            alive[c] = 1;
            width[c] = width[before] * (1 - t) + width[after] * t;
            depth[c] = depth[before] * (1 - t) + depth[after] * t;
          }
        }

        var pathVaried = false;
        for (i = 0; i < n; i++) {
          if (!alive[i] || Math.abs(width[i] - nomW) > 1e-6 || Math.abs(depth[i] - nomD) > 1e-6) {
            pathVaried = true;
            break;
          }
        }
        // Untouched loops go out exactly as clipper drew them, which keeps arc
        // fitting and scarf seams eligible for them.
        if (!pathVaried) { plainPaths.push(lvl.paths[pi]); continue; }
        levelTouched = true;

        // Smoothing over the transition length turns the quantised bead count
        // into a ramp: a stretch at three beads across meeting one at two comes
        // out as a gradual widening rather than a step in the extrusion.
        var passes = Math.max(1, Math.min(12, Math.round(rampPoints * 0.8)));
        smoothRing(depth, alive, passes);
        smoothRing(width, alive, passes);
        taperEnds(width, alive, rampPoints, minW);

        var normals = inwardNormals(pts);
        var moved = new Array(n);
        for (i = 0; i < n; i++) {
          var shift = depth[i] - nomD;
          if (shift > maxShift) shift = maxShift; else if (shift < -maxShift) shift = -maxShift;
          moved[i] = {
            X: Math.round(pts[i].X + normals[i].x * shift * SCALE),
            Y: Math.round(pts[i].Y + normals[i].y * shift * SCALE)
          };
        }

        var allAlive = true;
        for (i = 0; i < n; i++) if (!alive[i]) { allAlive = false; break; }
        if (allAlive) {
          varRuns.push({ pts: moved, widths: Array.prototype.slice.call(width), closed: true });
          continue;
        }
        var live = ringRuns(alive, n);
        for (r = 0; r < live.length; r++) {
          at = live[r][0]; len = live[r][1];
          if (!alive[at] || len < 2) continue;
          var rp = [], rw = [];
          for (j = 0; j < len; j++) { var idx = (at + j) % n; rp.push(moved[idx]); rw.push(width[idx]); }
          varRuns.push({ pts: rp, widths: rw, closed: false });
        }
      }

      // A level every one of whose vertices was dropped produces no runs at
      // all. Leaving its original paths in place would emit the wall the
      // redistribution had just decided there was no room for — on a 1.2 mm
      // rib, a second loop 0.026 mm inside the first.
      if (varRuns.length || levelTouched) {
        lvl.variable = varRuns.length ? varRuns : null;
        lvl.paths = plainPaths;
        touched = true;
      }
    }
    // The field goes back to the caller: the strand down the middle of an
    // odd-numbered bead layout has to be as wide as the layout says, not as
    // wide as whatever the walls happened to leave behind.
    // The layout is worth having even when there were no wall levels to change:
    // a section too narrow for any wall at all still gets a bead down its
    // middle, and that bead should be as wide as the layout says rather than
    // as wide as a raster of the leftover measures.
    return { field: field, widthAt: designWidth, touched: touched };

    function designWidth(pt, across) {
      var h = Math.max(field.sample(pt.X / SCALE, pt.Y / SCALE), provenHalf(pt));
      // Same cross-check as the walls get: an exact ray, believed only where it
      // already agrees with the raster to within the raster's own uncertainty.
      if (across) {
        var exact = rayHalfThickness(pt, across, base);
        if (exact > 0 && Math.abs(exact - h) < field.res * 1.5) h = exact;
      }
      var N = Math.round(2 * h / wl.inner);
      if (N < 1) N = 1;
      if (N > 2 * loops) N = 2 * loops;
      var w = 2 * h / N;
      while (w < minW && N > 1) { N--; w = 2 * h / N; }
      while (w > maxW && N < 2 * loops) { N++; w = 2 * h / N; }
      return w + interlock;
    }
  }

  /**
   * Half the material's thickness through `pt` along `normal`, measured against
   * the polygons themselves. Returns 0 if the ray leaves the region either way
   * without a clean pair of exits.
   */
  function rayHalfThickness(pt, normal, region) {
    if (!normal || (!normal.x && !normal.y)) return 0;
    var fwd = rayExit(pt, normal.x, normal.y, region);
    var back = rayExit(pt, -normal.x, -normal.y, region);
    if (!(fwd > 0) || !(back > 0)) return 0;
    return (fwd + back) / 2 / SCALE;
  }

  /** Distance from `pt` along (dx, dy) to the first boundary crossing. */
  function rayExit(pt, dx, dy, region) {
    var best = Infinity;
    for (var p = 0; p < region.length; p++) {
      var path = region[p];
      for (var i = 0; i < path.length; i++) {
        var a = path[i], b = path[(i + 1) % path.length];
        var ex = b.X - a.X, ey = b.Y - a.Y;
        var denom = dx * ey - dy * ex;
        if (Math.abs(denom) < 1e-9) continue;
        var t = ((a.X - pt.X) * ey - (a.Y - pt.Y) * ex) / denom;
        if (t <= 1e-6 || t >= best) continue;
        var u = ((a.X - pt.X) * dy - (a.Y - pt.Y) * dx) / denom;
        if (u < 0 || u > 1) continue;
        best = t;
      }
    }
    return best === Infinity ? 0 : best;
  }

  /** Arc length of a run of `len` vertices starting at `at` around a ring. */
  function runArc(pts, at, len) {
    var n = pts.length, total = 0;
    for (var j = 0; j < len - 1; j++) {
      var a = pts[(at + j) % n], b = pts[(at + j + 1) % n];
      total += Math.hypot(b.X - a.X, b.Y - a.Y);
    }
    return total;
  }

  /** Rotate a closed variable-width loop so it starts at the seam. */
  function rotateVariableLoop(pts, widths, seamRef, seamMode) {
    var n = pts.length, start = 0;
    if (seamMode === 'random') {
      start = (Math.random() * n) | 0;
    } else if (seamRef) {
      var best = Infinity;
      for (var i = 0; i < n; i++) {
        var d = (pts[i].X - seamRef.X) * (pts[i].X - seamRef.X) + (pts[i].Y - seamRef.Y) * (pts[i].Y - seamRef.Y);
        if (d < best) { best = d; start = i; }
      }
    }
    var op = [], ow = [];
    for (var k = 0; k <= n; k++) { var j = (start + k) % n; op.push(pts[j]); ow.push(widths[j]); }
    return { pts: op, widths: ow };
  }

  /**
   * The ground a set of beads actually covers, for deciding what is left over.
   *
   * Measured by SPACING, not by commanded width. Neighbouring beads are meant
   * to interlock — their footprints overlap by h(1 - pi/4) by design — so
   * charging each bead its full width here shrinks the leftover gap by that
   * overlap and the strand filling it comes out a tenth too thin.
   */
  function sweptRegion(runs, interlock) {
    var quads = [];
    for (var r = 0; r < runs.length; r++) {
      var pts = runs[r].pts, ws = runs[r].widths, n = pts.length;
      var segs = runs[r].closed ? n : n - 1;
      for (var i = 0; i < segs; i++) {
        var a = pts[i], b = pts[(i + 1) % n];
        var dx = b.X - a.X, dy = b.Y - a.Y;
        var len = Math.hypot(dx, dy);
        if (len < 1) continue;
        var hw = Math.max(0.05, (ws[i] + ws[(i + 1) % n]) / 2 - interlock) / 2 * SCALE;
        var ox = -dy / len * hw, oy = dx / len * hw;
        quads.push([[
          { X: Math.round(a.X + ox), Y: Math.round(a.Y + oy) },
          { X: Math.round(b.X + ox), Y: Math.round(b.Y + oy) },
          { X: Math.round(b.X - ox), Y: Math.round(b.Y - oy) },
          { X: Math.round(a.X - ox), Y: Math.round(a.Y - oy) }
        ]]);
      }
      for (var v = 0; v < n; v++) {          // patch the notch a turn leaves
        var hv = Math.round(Math.max(0.05, ws[v] - interlock) / 2 * SCALE);
        quads.push([[
          { X: pts[v].X - hv, Y: pts[v].Y - hv }, { X: pts[v].X + hv, Y: pts[v].Y - hv },
          { X: pts[v].X + hv, Y: pts[v].Y + hv }, { X: pts[v].X - hv, Y: pts[v].Y + hv }
        ]]);
      }
    }
    return G.uniteAll(quads);
  }

  /**
   * Split an external wall into pieces by how much of the bead is unsupported,
   * so each can be printed at a speed the overhang can actually take. Pieces are
   * contiguous, so the head never lifts: only the feedrate changes.
   */
  function emitClassifiedWall(feats, poly, bands, width, smallSpeed) {
    var remaining = [poly];
    var pieces = [];

    for (var band = 0; band < bands.length && remaining.length; band++) {
      var inside = G.clipLinesToRegion(remaining, bands[band]);
      for (var i = 0; i < inside.length; i++) pieces.push({ pts: inside[i], level: band });
      remaining = G.clipLinesOutsideRegion(remaining, bands[band]);
    }
    for (var r = 0; r < remaining.length; r++) pieces.push({ pts: remaining[r], level: bands.length });

    if (pieces.length <= 1) {
      var level = pieces.length ? pieces[0].level : 0;
      feats.push({
        type: level === 0 ? FEATURE.OUTER : FEATURE.OVERHANG,
        w: width, pts: poly, closed: true, overhang: level, speed: smallSpeed
      });
      return;
    }

    // Walk the pieces back into print order along the original loop.
    var index = {};
    for (var p = 0; p < poly.length; p++) index[key2(poly[p])] = p;
    pieces.forEach(function (piece) {
      var at = index[key2(piece.pts[0])];
      piece.order = at === undefined ? 1e9 : at;
    });
    pieces.sort(function (a, b) { return a.order - b.order; });

    for (var k = 0; k < pieces.length; k++) {
      if (pieces[k].pts.length < 2) continue;
      feats.push({
        type: pieces[k].level === 0 ? FEATURE.OUTER : FEATURE.OVERHANG,
        w: width, pts: pieces[k].pts, closed: false,
        overhang: pieces[k].level, speed: smallSpeed
      });
    }
  }

  /**
   * The same overhang split, for a bead whose width changes along its length.
   *
   * The fixed-width version clips the polyline against each band, which makes
   * new points at the crossings — and a new point has no width. These beads are
   * already resampled every fraction of a millimetre, so classifying each
   * existing point and cutting between them is both accurate and lossless.
   */
  function emitClassifiedVariableWall(feats, pts, widths, bands, closed, smallSpeed) {
    var n = pts.length;
    var level = new Uint8Array(n);
    var i, b;
    for (i = 0; i < n; i++) {
      level[i] = bands.length;
      for (b = 0; b < bands.length; b++) {
        if (G.pointInPaths(pts[i], bands[b])) { level[i] = b; break; }
      }
    }

    var uniform = true;
    for (i = 1; i < n; i++) if (level[i] !== level[0]) { uniform = false; break; }

    var sum = 0;
    for (i = 0; i < widths.length; i++) sum += widths[i];
    var avg = sum / widths.length;

    if (uniform) {
      feats.push({
        type: level[0] === 0 ? FEATURE.OUTER : FEATURE.OVERHANG,
        w: avg, widths: widths, pts: pts, closed: closed,
        overhang: level[0], speed: smallSpeed
      });
      return;
    }

    // Cut between points where the classification changes, keeping the shared
    // point in both pieces so the head never lifts: only the feedrate changes.
    var start = 0;
    for (i = 1; i <= n; i++) {
      if (i < n && level[i] === level[start]) continue;
      var end = Math.min(i, n - 1);
      if (end > start) {
        var piecePts = pts.slice(start, end + 1);
        var pieceW = widths.slice(start, end + 1);
        var ps = 0;
        for (b = 0; b < pieceW.length; b++) ps += pieceW[b];
        feats.push({
          type: level[start] === 0 ? FEATURE.OUTER : FEATURE.OVERHANG,
          w: ps / pieceW.length, widths: pieceW, pts: piecePts, closed: false,
          overhang: level[start], speed: smallSpeed
        });
      }
      start = end;
      if (i >= n) break;
    }
  }

  /**
   * Trace a region as nested loops rather than hatching it. Loops keep going
   * until the middle is used up, so a thick trunk comes out solid and a thin
   * branch comes out as one line down its centre.
   */
  function pushContours(feats, region, width, type, from, s) {
    var level = 0, base = region;
    var cursor = from;
    while (level < 12) {
      var loops = G.offsetPaths(base, -(width / 2 + level * width));
      if (!loops.length) break;
      for (var i = 0; i < loops.length; i++) {
        var poly = closedToPolyline(loops[i], cursor, 'nearest');
        if (!poly) continue;
        feats.push({ type: type, w: width, pts: poly, closed: true, speed: 0 });
        cursor = poly[poly.length - 1];
      }
      level++;
    }
    // Whatever the loops could not reach is too thin to hold a line of its own.
    if (level > 0 && root.OrcaBeading && s.wallGenerator === 'arachne') {
      var covered = G.offsetPaths(base, -(level * width));
      var leftover = G.dropTinyIslands(covered, Math.pow(width * 0.5, 2));
      if (leftover.length) {
        pushBeads(feats, leftover, s, { inner: width, ext: width }, cursor, s.layerHeight);
      }
    }
  }

  /**
   * Custom G-code goes through the expression language, so a profile can say
   * "only wait for the chamber if this machine has one" instead of shipping a
   * command that hangs a printer that has no chamber to heat.
   *
   * Every setting is in scope under its own name and under the snake_case
   * spelling profiles are written in, plus whatever the caller adds. Without
   * the language loaded the old placeholders still resolve, because a start
   * script that silently loses its temperatures is a cold-extrusion crash.
   */
  // Under Node the modules are pulled in one by one, and a suite that forgets
  // the template renderer would otherwise write '{max_z + 0.5}' into a real
  // file. In the browser and the worker it is already loaded by the time this
  // runs; either way, the engine does not emit a command it cannot fill in.
  function templateEngine() {
    if (root.OrcaTemplate) return root.OrcaTemplate;
    if (typeof require === 'function') {
      try { root.OrcaTemplate = require('./template.js'); } catch (e) { /* browser */ }
    }
    return root.OrcaTemplate;
  }

  function renderTemplate(text, s, extra) {
    if (!text) return '';
    var vars = {};
    var key;
    for (key in s) {
      if (!Object.prototype.hasOwnProperty.call(s, key)) continue;
      var v = s[key];
      if (v === null || typeof v === 'object' || typeof v === 'function') continue;
      vars[key] = v;
      vars[key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()] = v;
    }
    // Names profiles use that are not settings keys in their own right.
    vars.nozzle_temp = s.firstLayerNozzleTemp;
    vars.first_layer_temp = s.firstLayerNozzleTemp;
    vars.bed_temp = s.firstLayerBedTemp;
    vars.bed_x = s.bedX;
    vars.bed_y = s.bedY;
    vars.bed_z = s.bedZ;
    for (key in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, key)) vars[key] = extra[key];
    }
    vars.z = extra && extra.layer_z !== undefined ? extra.layer_z : 0;

    var tpl = templateEngine();
    if (tpl) return tpl.render(text, vars);
    return String(text).replace(/\{([a-z_][a-z0-9_]*)\}/g, function (whole, name) {
      return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole;
    });
  }

  function key2(pt) { return pt.X + '_' + pt.Y; }

  function pushBeads(feats, region, s, wl, from, layerH, layout) {
    var beads = root.OrcaBeading.medialBeads(region, {
      minWidth: s.minBeadWidth,
      maxWidth: Math.max(s.minBeadWidth, s.maxBeadWidth),
      // Fine enough that the half-cell the distance transform is accurate to
      // is a few hundredths of a millimetre rather than a tenth of a bead.
      resolution: Math.max(0.02, s.minBeadWidth / 10),
      maxCells: 6e5,
      // A bead filling a slot of a given width has to be commanded wider than
      // that slot, because its top and bottom pinch in to meet its neighbours.
      interlock: (layerH || s.layerHeight) * (1 - Math.PI / 4)
    });
    if (!beads.length) return;

    // Where the wall layout knows how wide this strand was meant to be, use
    // that. Measuring the leftover gap instead makes the strand inherit every
    // rounding the walls around it already made.
    if (layout) {
      var lo = s.minBeadWidth, hi = Math.max(lo, s.maxBeadWidth);
      for (var bi = 0; bi < beads.length; bi++) {
        var bw = beads[bi].widths, bp = beads[bi].pts;
        for (var wi = 0; wi < bw.length; wi++) {
          // Across the bead, which for a strand on the medial axis is the
          // direction its thickness is measured in.
          var prev = bp[wi > 0 ? wi - 1 : wi], next = bp[wi + 1 < bp.length ? wi + 1 : wi];
          var tx = next.X - prev.X, ty = next.Y - prev.Y;
          var tl = Math.hypot(tx, ty);
          var across = tl > 1e-9 ? { x: -ty / tl, y: tx / tl } : null;
          var want = layout.widthAt(bp[wi], across);
          if (want > bw[wi]) bw[wi] = Math.min(hi, Math.max(lo, want));
        }
      }
    }

    // Nearest-endpoint ordering, keeping each bead's widths aligned with it.
    var rest = beads.slice(), cx = from.X, cy = from.Y;
    while (rest.length) {
      var best = 0, bestD = Infinity, flip = false;
      for (var i = 0; i < rest.length; i++) {
        var head = rest[i].pts[0], tail = rest[i].pts[rest[i].pts.length - 1];
        var dh = (head.X - cx) * (head.X - cx) + (head.Y - cy) * (head.Y - cy);
        var dt = (tail.X - cx) * (tail.X - cx) + (tail.Y - cy) * (tail.Y - cy);
        if (dh < bestD) { bestD = dh; best = i; flip = false; }
        if (dt < bestD) { bestD = dt; best = i; flip = true; }
      }
      var bead = rest.splice(best, 1)[0];
      if (flip) { bead.pts.reverse(); bead.widths.reverse(); }

      var sum = 0;
      for (var k = 0; k < bead.widths.length; k++) sum += bead.widths[k];
      feats.push({
        type: FEATURE.GAP,
        w: sum / bead.widths.length,      // representative width, for the speed caps
        pts: bead.pts,
        widths: bead.widths,
        closed: false
      });
      var last = bead.pts[bead.pts.length - 1];
      cx = last.X; cy = last.Y;
    }
  }

  /**
   * Pick the direction to bridge in. A bridge is strongest and droops least when
   * its strands cross the gap the short way, so try a fan of angles and keep the
   * one whose longest unsupported runs are shortest. Slicing at the layer angle
   * instead — as this did before — can lay every strand along the gap rather
   * than across it, which is the difference between a bridge and a sag.
   */
  function bestBridgeAngle(region, spacing, fallbackAngle) {
    var best = fallbackAngle, bestScore = Infinity;
    for (var deg = 0; deg < 180; deg += 10) {
      var lines = I.rectilinear(region, spacing, deg);
      if (!lines.length) continue;

      var lengths = [];
      for (var i = 0; i < lines.length; i++) lengths.push(I.polylineLength(lines[i]));
      lengths.sort(function (a, b) { return b - a; });

      // Judge on the worst fifth: one long strand is what fails, not the average.
      var take = Math.max(1, Math.round(lengths.length * 0.2));
      var score = 0;
      for (var k = 0; k < take; k++) score += lengths[k];
      score /= take;

      if (score < bestScore - 1e-6) { bestScore = score; best = deg; }
    }
    return best;
  }

  /**
   * Link consecutive infill lines into one continuous path wherever the segment
   * that would join them stays inside the region being filled.
   *
   * Unconnected infill is a line, a retraction, a travel, a de-retraction, a
   * line — over and over. Joining them turns a layer's infill from a dozen
   * separate passes into one or two, which is less time, far less stringing,
   * and infill that is actually tied together rather than laid side by side.
   *
   * Every candidate join is tested in a single clip against the region, so this
   * costs one clipper call per infill call however many lines there are.
   */
  function connectInfill(lines, region, maxJoin) {
    if (lines.length < 2) return lines;
    var out = [], current = lines[0];

    for (var i = 0; i + 1 < lines.length; i++) {
      var a = current[current.length - 1], b = lines[i + 1][0];
      var d = Math.hypot(a.X - b.X, a.Y - b.Y);
      if (d > 1 && d <= maxJoin && joinStaysInside(a, b, region)) {
        current = current.concat(lines[i + 1]);
      } else {
        out.push(current);
        current = lines[i + 1];
      }
    }
    out.push(current);
    return out;
  }

  /**
   * Would the head stay in the material walking straight from a to b?
   *
   * Sampled rather than clipped. Infill lines end exactly on the region's edge,
   * so the join between two of them runs along that edge, and a boolean clip of
   * a boundary-coincident segment is exactly the case clipper is least willing
   * to give a straight answer about.
   */
  function joinStaysInside(a, b, region) {
    for (var k = 1; k <= 5; k++) {
      var t = k / 6;
      var pt = { X: Math.round(a.X + (b.X - a.X) * t), Y: Math.round(a.Y + (b.Y - a.Y) * t) };
      if (!G.pointInPaths(pt, region)) return false;
    }
    return true;
  }

  /**
   * Tie each loose end of the infill to the wall it meets.
   *
   * A sparse infill line that simply stops where it meets the perimeter is
   * held on by one point of contact. Running it a few millimetres along the
   * wall instead bonds it, which is what stops sparse infill peeling away from
   * the shell and taking the surface with it. The anchor follows the boundary
   * the line actually landed on, and only as far as it stays in the material.
   */
  function anchorInfill(lines, region, anchorMm) {
    if (anchorMm <= 0 || !region.length) return lines;
    var anchor = anchorMm * SCALE;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.length < 2) continue;
      var head = anchorAlongBoundary(line[0], line[1], region, anchor);
      if (head) for (var h = head.length - 1; h >= 0; h--) line.unshift(head[h]);
      var n = line.length;
      var tail = anchorAlongBoundary(line[n - 1], line[n - 2], region, anchor);
      if (tail) for (var t2 = 0; t2 < tail.length; t2++) line.push(tail[t2]);
    }
    return lines;
  }

  /**
   * Follow the boundary away from `inward` for `anchor`, and return the points
   * walked through.
   *
   * Across segments, not just the one the line landed on. An offset outline is
   * tessellated into whatever pieces clipper chose — a long straight run on one
   * part, a dozen tiny arc segments on another — and stopping at the first of
   * them made the anchor's real length depend on that rather than on the
   * setting. It came out full length along a hexagon's flat side and a fraction
   * of it around a star's corners.
   */
  function anchorAlongBoundary(end, inward, region, anchor) {
    var best = null, bestD = 0.08 * SCALE;
    var p, k;
    for (p = 0; p < region.length; p++) {
      var path = region[p];
      for (k = 0; k < path.length; k++) {
        var a = path[k], b = path[(k + 1) % path.length];
        var dx = b.X - a.X, dy = b.Y - a.Y;
        var len2 = dx * dx + dy * dy;
        if (len2 < 1) continue;
        var t = ((end.X - a.X) * dx + (end.Y - a.Y) * dy) / len2;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        var d = Math.hypot(end.X - (a.X + dx * t), end.Y - (a.Y + dy * t));
        if (d >= bestD) continue;
        bestD = d;
        best = { path: path, at: k, t: t };
      }
    }
    if (!best) return null;

    var ring = best.path, n = ring.length;
    var here = { X: Math.round(ring[best.at].X + (ring[(best.at + 1) % n].X - ring[best.at].X) * best.t),
                 Y: Math.round(ring[best.at].Y + (ring[(best.at + 1) % n].Y - ring[best.at].Y) * best.t) };
    // Whichever way along the ring leads away from the line it anchors.
    var ahead = ring[(best.at + 1) % n];
    var forward = ((ahead.X - here.X) * (end.X - inward.X) +
                   (ahead.Y - here.Y) * (end.Y - inward.Y)) >= 0;

    var out = [];
    var left = anchor, idx = best.at, cur = here;
    for (var step = 0; step < n && left > 0; step++) {
      var next = forward ? ring[(idx + 1) % n] : ring[idx];
      var vx = next.X - cur.X, vy = next.Y - cur.Y;
      var seg = Math.hypot(vx, vy);
      if (seg < 1) {
        idx = forward ? (idx + 1) % n : (idx - 1 + n) % n;
        continue;
      }
      if (seg >= left) {
        out.push({ X: Math.round(cur.X + vx / seg * left), Y: Math.round(cur.Y + vy / seg * left) });
        break;
      }
      out.push({ X: next.X, Y: next.Y });
      left -= seg;
      cur = next;
      idx = forward ? (idx + 1) % n : (idx - 1 + n) % n;
    }
    return out.length ? out : null;
  }

  /**
   * Nudge the line spacing so a whole number of lines exactly spans the region.
   *
   * A solid strip 1.63 mm across takes 2.94 lines at 0.556 mm. Laying 2 leaves
   * a tenth of it empty and laying 3 puts a tenth too much in; either way the
   * error is a fixed fraction of a line, which on a narrow strip is a large
   * fraction of the strip. Closing the spacing to 0.545 lays exactly 3 and
   * fills it. Only ever tightened, and never by more than a fifth, so a
   * genuinely wide region is left alone.
   */
  function fitSpacing(region, spacing, angleDeg) {
    var rad = angleDeg * Math.PI / 180;
    var ax = -Math.sin(rad), ay = Math.cos(rad);      // across the lines
    var lo = Infinity, hi = -Infinity;
    for (var p = 0; p < region.length; p++) {
      var path = region[p];
      for (var i = 0; i < path.length; i++) {
        var d = (path[i].X * ax + path[i].Y * ay) / SCALE;
        if (d < lo) lo = d;
        if (d > hi) hi = d;
      }
    }
    var span = hi - lo;
    if (!(span > 0)) return spacing;
    var intervals = Math.floor(span / spacing);
    if (intervals < 1) return spacing;
    var tighter = span / intervals;
    if (tighter > spacing || tighter < spacing * 0.8) return spacing;
    return tighter;
  }

  function pushInfill(feats, region, pattern, spacing, angle, z, type, width, from, minLen, monotonic, connect, anchorLen, fit) {
    if (!region || !region.length || spacing <= 0) return;
    if (fit) spacing = fitSpacing(region, spacing, angle);
    var lines = I.generateInfill(pattern, region, spacing, angle, z);
    if (!lines.length) return;
    lines = monotonic ? I.orderMonotonic(lines, angle) : I.orderPolylines(lines, from);
    // Monotonic ordering exists so every line is laid in the same direction
    // against the one before it; joining them would undo exactly that.
    // Only straight parallel lines join cleanly end to end. Joining a curved
    // pattern puts a corner in the middle of a smooth path, which is neither
    // what the pattern is for nor something the arc fitter should have to see.
    //
    // And only sparse infill is worth joining at all. Solid lines already touch,
    // so the segment between two of them runs along the boundary over material
    // the perimeter has just covered — a few percent of the part's whole mass,
    // extruded twice — to save a travel of half a millimetre.
    if (connect && !monotonic && (pattern === 'lines' || pattern === 'rectilinear')) {
      lines = connectInfill(lines, region, spacing * 2.2 * SCALE);
    }
    if (anchorLen > 0 && !monotonic && (pattern === 'lines' || pattern === 'rectilinear')) {
      lines = anchorInfill(lines, region, anchorLen);
    }
    var floor = minLen != null ? minLen : 0.1;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].length < 2) continue;
      if (I.polylineLength(lines[i]) < floor) continue;
      feats.push({ type: type, w: width, pts: lines[i], closed: false });
    }
  }

  // ---------------------------------------------------------------------------
  // Adhesion
  // ---------------------------------------------------------------------------

  function buildAdhesion(regions, support, s) {
    var out = [];
    if (!regions[0] || !regions[0].length) return out;
    var w = widthsFor(0, s);
    var first = support.base[0] && support.base[0].length ? G.unite(regions[0], support.base[0]) : regions[0];

    if (s.adhesion === 'brim' && s.brimWidth > 0) {
      var loops = Math.max(1, Math.round(s.brimWidth / w.inner));
      if (s.brimType === 'outer' || s.brimType === 'both') {
        var outer = first;
        for (var i = 0; i < loops; i++) {
          outer = G.offsetPaths(outer, i === 0 ? s.brimGap + w.ext / 2 + w.inner / 2 : w.inner);
          out.push({ type: FEATURE.BRIM, paths: G.copyPaths(outer), width: w.inner });
        }
      }
      if (s.brimType === 'inner' || s.brimType === 'both') {
        // Brim inside holes, which is where big flat parts usually lift.
        var islands = G.toIslands(first);
        var holes = [];
        for (var k = 0; k < islands.length; k++) {
          for (var h = 0; h < islands[k].holes.length; h++) holes.push(islands[k].holes[h]);
        }
        if (holes.length) {
          var innerLoop = holes;
          for (var j = 0; j < loops; j++) {
            innerLoop = G.offsetPaths(innerLoop, j === 0 ? -(s.brimGap + w.ext / 2 + w.inner / 2) : -w.inner);
            if (!innerLoop.length) break;
            out.push({ type: FEATURE.BRIM, paths: G.copyPaths(innerLoop), width: w.inner });
          }
        }
      }

    } else if (s.adhesion === 'skirt' && s.skirtLoops > 0) {
      var hull = convexHull(allPoints(first));
      if (hull.length >= 3) {
        var sk = [hull];
        for (var sl = 0; sl < s.skirtLoops; sl++) {
          sk = G.offsetPaths(sk, sl === 0 ? s.skirtDistance + w.inner / 2 : w.inner);
          out.push({ type: FEATURE.SKIRT, paths: G.copyPaths(sk), width: w.inner });
        }
      }
    }
    return out;
  }

  /**
   * A raft is printed first and everything else rides on top of it, so the
   * object layers all shift up by the raft's height plus the release gap.
   */
  function prependRaft(layers, regions, support, s) {
    var w = widthsFor(0, s);
    var first = support.base[0] && support.base[0].length ? G.unite(regions[0], support.base[0]) : regions[0];
    if (!first.length) return layers;

    var hull = convexHull(allPoints(first));
    if (hull.length < 3) return layers;
    var area = G.offsetPaths([hull], 3);
    if (!area.length) return layers;

    var raftLayers = [];
    var z = 0;
    for (var i = 0; i < s.raftLayers; i++) {
      var isBase = i === 0;
      var h = isBase ? s.firstLayerHeight : s.layerHeight;
      var width = isBase ? s.nozzle * 2 : w.inner;
      z += h;
      var feats = [];
      // A coarse base for grip, then progressively finer layers to print onto.
      var spacing = isBase ? width * 1.4 : width;
      pushInfill(feats, area, 'lines', spacing, i % 2 ? 45 : 135, z, FEATURE.RAFT, width, { X: 0, Y: 0 });
      // One outline keeps the raft edges from curling.
      var loop = G.offsetPaths(area, -width / 2);
      for (var l = 0; l < loop.length; l++) {
        var pl = closedToPolyline(loop[l], { X: 0, Y: 0 }, 'nearest');
        if (pl) feats.unshift({ type: FEATURE.RAFT, w: width, pts: pl, closed: true });
      }
      raftLayers.push({ z: z, h: h, feats: feats, comb: null });
    }

    var lift = z + s.raftGap;
    for (var k = 0; k < layers.length; k++) layers[k].z += lift;
    return raftLayers.concat(layers);
  }

  // ---------------------------------------------------------------------------
  // G-code
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Arc fitting
  // ---------------------------------------------------------------------------

  /**
   * Replace runs of points that sit on a common circle with a single arc.
   *
   * A sliced curve arrives as hundreds of tiny straight segments. Sent that way,
   * an 8-bit board spends longer parsing them than moving, and the head stutters
   * its way round every fillet. One G2 says the same thing in one line.
   *
   * Returns a list of moves: { type: 'line', to } or { type: 'arc', to, centre, cw }.
   */
  function fitArcs(points, toleranceMm, minPoints) {
    var tol = toleranceMm * SCALE;
    var out = [];
    var i = 0;
    var n = points.length;
    var minRun = Math.max(4, minPoints || 5);

    while (i < n - 1) {
      var best = null;
      // Only bother looking when there is enough left to make an arc worthwhile.
      if (n - i >= minRun) {
        for (var end = i + minRun - 1; end < n; end++) {
          var circle = circleThrough(points[i], points[(i + end) >> 1], points[end]);
          if (!circle) break;
          if (circle.r < 0.4 * SCALE || circle.r > 500 * SCALE) break;
          if (!arcFits(points, i, end, circle, tol)) break;
          best = { end: end, circle: circle };
        }
      }

      if (best) {
        out.push({
          type: 'arc',
          to: points[best.end],
          centre: best.circle,
          cw: turnsClockwise(points[i], points[(i + best.end) >> 1], points[best.end])
        });
        i = best.end;
      } else {
        out.push({ type: 'line', to: points[i + 1] });
        i++;
      }
    }
    return out;
  }

  function circleThrough(a, b, c) {
    var ax = a.X, ay = a.Y, bx = b.X, by = b.Y, cx = c.X, cy = c.Y;
    var d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(d) < 1e-6) return null;                     // collinear
    var a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
    var ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
    var uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
    return { X: ux, Y: uy, r: Math.hypot(ax - ux, ay - uy) };
  }

  /** Every point between `from` and `to` must sit on the circle, and keep turning the same way. */
  function arcFits(points, from, to, circle, tol) {
    var sign = 0;
    for (var k = from; k <= to; k++) {
      if (Math.abs(Math.hypot(points[k].X - circle.X, points[k].Y - circle.Y) - circle.r) > tol) return false;
      if (k > from && k < to) {
        var t = turnsClockwise(points[k - 1], points[k], points[k + 1]) ? 1 : -1;
        if (sign === 0) sign = t;
        else if (t !== sign) return false;                   // an inflection, not an arc
      }
    }
    // Every point being ON the circle is not enough: G2/G3 sweep from one
    // endpoint to the other in a given direction, and a point can sit on the
    // circle while lying outside the piece of it the machine will actually
    // travel. Left unchecked the head takes the long way round — an arc fitted
    // through a corner in gyroid infill swept 260 mm off the side of the bed,
    // which the G-code verifier caught and this now prevents.
    var cw = turnsClockwise(points[from], points[(from + to) >> 1], points[to]);
    var a0 = Math.atan2(points[from].Y - circle.Y, points[from].X - circle.X);
    function sweptTo(p) {
      var a = Math.atan2(p.Y - circle.Y, p.X - circle.X);
      var d = cw ? (a0 - a) : (a - a0);
      while (d < 0) d += 2 * Math.PI;
      while (d >= 2 * Math.PI) d -= 2 * Math.PI;
      return d;
    }
    var total = sweptTo(points[to]);
    if (total < 1e-9 || total > Math.PI) return false;        // never the long way
    for (var m = from + 1; m < to; m++) {
      if (sweptTo(points[m]) > total + 1e-9) return false;    // not on the swept piece
    }
    return true;
  }

  function turnsClockwise(a, b, c) {
    return ((b.X - a.X) * (c.Y - a.Y) - (b.Y - a.Y) * (c.X - a.X)) < 0;
  }

  function crossSection(w, h) {
    if (w <= h) return Math.PI * (w / 2) * (h / 2);
    return h * (w - h) + Math.PI * (h / 2) * (h / 2);
  }

  /**
   * How far apart two of these extrusions sit when they just touch.
   *
   * NOT the nominal width. A bead is a rounded rectangle, not a rectangle: it
   * bulges to `w` at mid-height and pinches to `w - h` at the top and bottom, so
   * two neighbours interlock and their centres end up `w - h(1 - pi/4)` apart.
   *
   * Spacing solid infill at the nominal width instead leaves a gap between every
   * pair of lines — a tenth of a millimetre on a 0.4 nozzle, which is a visibly
   * porous top surface and a measurably weaker part. It also makes every sparse
   * infill about a tenth under the density that was asked for.
   */
  function extrusionSpacing(w, h) {
    if (w <= h) return w;                        // an ellipse: they meet at their widest
    return w - h * (1 - Math.PI / 4);
  }

  function speedFor(type, layerIndex, s) {
    var sp = s.speeds;
    if (layerIndex === 0) return sp.firstLayer;
    switch (type) {
      case FEATURE.OUTER: case FEATURE.OVERHANG: return sp.externalPerimeter;
      case FEATURE.INNER: return sp.perimeter;
      case FEATURE.TOP: return sp.topSolid;
      case FEATURE.SOLID: case FEATURE.BOTTOM: return sp.solidInfill;
      case FEATURE.BRIDGE: return sp.bridge;
      case FEATURE.INTERNAL_BRIDGE: return sp.internalBridge || sp.bridge;
      case FEATURE.SPARSE: return sp.infill;
      case FEATURE.GAP: return sp.gapFill;
      case FEATURE.IRONING: return sp.ironing;
      case FEATURE.SUPPORT: case FEATURE.SUPPORT_IFACE: return sp.support;
      case FEATURE.RAFT: return sp.firstLayer;
      case FEATURE.SKIRT: case FEATURE.BRIM: return sp.firstLayer;
      default: return sp.perimeter;
    }
  }

  function flowFor(type, s) {
    if (type === FEATURE.BRIDGE) return 1.0;
    if (type === FEATURE.INTERNAL_BRIDGE) return s.internalBridgeFlow;
    if (type === FEATURE.IRONING) return s.ironingFlow;
    if (type === FEATURE.SUPPORT || type === FEATURE.SUPPORT_IFACE) return s.flowRatio * 0.9;
    return s.flowRatio;
  }

  /** Speed a feature will actually run at, after every cap the profile imposes. */
  function effectiveSpeed(feat, layerIndex, layerHeight, s) {
    var speed = Math.min(speedFor(feat.type, layerIndex, s), s.maxSpeed || 1e9);

    // A bead hanging over air has nothing to conduct heat into and nothing to
    // hold it down, so the further out it reaches the slower it has to go.
    if (feat.overhang > 0 && s.overhangSpeeds && layerIndex > 0) {
      var limit = s.overhangSpeeds[Math.min(feat.overhang, s.overhangSpeeds.length) - 1];
      if (limit > 0) speed = Math.min(speed, limit);
    }
    // An explicit override — a loop too short to accelerate along, say.
    if (feat.speed > 0) speed = Math.min(speed, feat.speed);

    var area = crossSection(feat.w, layerHeight);
    if (s.maxVolumetric > 0 && area > 0 && feat.type !== FEATURE.IRONING) {
      speed = Math.min(speed, s.maxVolumetric / area);
    }
    return Math.max(1, speed);
  }

  /**
   * How long a layer takes at nominal speed. Used to decide whether the layer
   * needs slowing down so it has time to cool before the next one lands.
   */
  function estimateLayerSeconds(layer, layerIndex, s) {
    var seconds = 0;
    var prev = null;
    for (var f = 0; f < layer.feats.length; f++) {
      var feat = layer.feats[f];
      var speed = effectiveSpeed(feat, layerIndex, layer.h, s);
      var len = I.polylineLength(feat.pts);
      seconds += len / speed;
      if (prev) {
        seconds += Math.hypot(feat.pts[0].X - prev.X, feat.pts[0].Y - prev.Y) / SCALE / s.travelSpeed;
      }
      prev = feat.pts[feat.pts.length - 1];
    }
    return seconds;
  }

  function generateGcode(layers, s) {
    var flavor = (root.OrcaPresets && root.OrcaPresets.FLAVORS[s.gcodeFlavor]) ||
                 { fan: function (p) { return p > 0 ? 'M106 S' + p : 'M107'; },
                   acceleration: function (a) { return 'M204 S' + Math.round(a); } };

    var out = [];
    var filamentArea = Math.PI * Math.pow(s.filamentDiameter / 2, 2);
    // Deltas take coordinates about the centre of the plate; everything upstream
    // works from a corner, so shift on the way out.
    var originX = s.originCenter ? s.bedX / 2 : 0;
    var originY = s.originCenter ? s.bedY / 2 : 0;
    var E = 0, retracted = false;
    var cx = 0, cy = 0, cz = 0, lastF = -1;
    var lastDir = null;
    var moves = { L: [], V: [], C: [] };
    var prevDir = null;
    var extrudedVolume = 0;
    var featureCounts = {};
    var arcCount = 0;
    var combPaths = null;
    var currentFan = -1;

    function fmt(v) { return (Math.round(v * 1000) / 1000).toString(); }
    function fmtE(v) { return (Math.round(v * 10000) / 10000).toString(); }

    function emitE(delta) {
      if (s.relativeE) return 'E' + fmtE(delta);
      E += delta;
      return 'E' + fmtE(E);
    }

    function recordMove(dx, dy, speed, lengthOverride) {
      var L = lengthOverride != null ? lengthOverride : Math.hypot(dx, dy);
      if (L < 1e-9) return;
      var chord = Math.hypot(dx, dy) || 1;
      var dir = [dx / chord, dy / chord];
      var cos = prevDir ? Math.max(-1, Math.min(1, dir[0] * prevDir[0] + dir[1] * prevDir[1])) : -1;
      moves.L.push(L); moves.V.push(speed); moves.C.push(cos);
      prevDir = dir;
    }

    function setFan(pwm) {
      if (pwm === currentFan) return;
      currentFan = pwm;
      out.push(flavor.fan(pwm));
    }

    /** True when the straight line A→B never leaves the printed area. */
    function travelStaysInside(x, y) {
      if (!combPaths || !combPaths.length) return false;
      var seg = [[{ X: Math.round(cx * SCALE), Y: Math.round(cy * SCALE) },
                  { X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }]];
      var inside = G.clipLinesToRegion(seg, combPaths);
      if (!inside.length) return false;
      var full = Math.hypot(x - cx, y - cy);
      var kept = 0;
      for (var i = 0; i < inside.length; i++) kept += I.polylineLength(inside[i]);
      return kept >= full - 0.02;
    }

    // Z moves at the Z axis's own speed, never the XY travel speed.
    var zFeed = Math.round(Math.min(s.travelSpeed, s.maxZSpeed || 12) * 60);

    function retract() {
      if (retracted || s.retractLength <= 0) return;
      if (s.wipeOnRetract && s.wipeDistance > 0 && lastDir) {
        // Wipe back along the path just printed, bleeding the pressure off.
        var wipe = Math.min(s.wipeDistance, 5);
        var wx = cx - lastDir[0] * wipe, wy = cy - lastDir[1] * wipe;
        out.push('G1 X' + fmt(wx - originX) + ' Y' + fmt(wy - originY) + ' ' + emitE(-s.retractLength) +
                 ' F' + Math.round(s.retractSpeed * 60));
        recordMove(wx - cx, wy - cy, s.retractSpeed);
        cx = wx; cy = wy;
      } else {
        out.push('G1 ' + emitE(-s.retractLength) + ' F' + Math.round(s.retractSpeed * 60));
      }
      retracted = true;
      lastF = -1;
      if (s.zHop > 0) out.push('G1 Z' + fmt(cz + s.zHop) + ' F' + zFeed);
    }

    function unretract() {
      if (!retracted) return;
      if (s.zHop > 0) out.push('G1 Z' + fmt(cz) + ' F' + zFeed);
      out.push('G1 ' + emitE(s.retractLength) + ' F' + Math.round(s.deretractSpeed * 60));
      retracted = false;
      lastF = -1;
    }

    function travelTo(x, y) {
      var d = Math.hypot(x - cx, y - cy);
      if (d < 1e-6) return;
      var wantRetract = s.retractLength > 0 && d > s.minTravelForRetract && !s.spiralVase;
      if (wantRetract && s.combing && travelStaysInside(x, y)) wantRetract = false;
      if (wantRetract) retract();

      out.push('G0 X' + fmt(x - originX) + ' Y' + fmt(y - originY) + ' F' + Math.round(s.travelSpeed * 60));
      recordMove(x - cx, y - cy, s.travelSpeed);
      cx = x; cy = y;
      lastF = -1;
      unretract();
    }

    function extrudeTo(x, y, z, w, h, speed, flow) {
      var d = Math.hypot(x - cx, y - cy);
      if (d < 1e-6 && Math.abs(z - cz) < 1e-9) return;
      var vol = crossSection(w, h) * d;
      var delta = vol * flow / filamentArea;
      extrudedVolume += vol * flow;
      var f = Math.round(speed * 60);
      var line = 'G1 X' + fmt(x - originX) + ' Y' + fmt(y - originY);
      if (Math.abs(z - cz) > 1e-9) { line += ' Z' + fmt(z); cz = z; }
      line += ' ' + emitE(delta);
      if (f !== lastF) { line += ' F' + f; lastF = f; }
      out.push(line);
      recordMove(x - cx, y - cy, speed);
      if (d > 1e-6) lastDir = [(x - cx) / d, (y - cy) / d];
      cx = x; cy = y;
    }

    /**
     * Scarf seam: instead of a loop starting and stopping at one point — which
     * leaves a blob where it ends and a notch where it began — the flow ramps up
     * over the first stretch and the loop then carries on past its own start,
     * ramping back down over the same stretch. Every point in the overlap gets
     * printed twice at complementary flows, so the wall is uniform and the seam
     * is spread over centimetres instead of concentrated at a dot.
     *
     * Returns { pts, flows } where flows[i] applies to the segment ending at i.
     */
    function scarfLoop(pts, scarfLength, widths) {
      var i, total = 0;
      for (i = 1; i < pts.length; i++) {
        total += Math.hypot(pts[i].X - pts[i - 1].X, pts[i].Y - pts[i - 1].Y) / SCALE;
      }
      if (total < scarfLength * 4) return null;      // too short to be worth it

      // Walk the loop and then carry on past its start for the scarf length.
      var path = [{ pt: pts[0], d: 0, w: widths ? widths[0] : 0 }];
      var run = 0;
      for (i = 1; i < pts.length; i++) {
        run += Math.hypot(pts[i].X - pts[i - 1].X, pts[i].Y - pts[i - 1].Y) / SCALE;
        path.push({ pt: pts[i], d: run, w: widths ? widths[i] : 0 });
      }
      var extra = 0, j = 1;
      while (extra < scarfLength - 1e-9 && j < pts.length) {
        var seg = Math.hypot(pts[j].X - pts[j - 1].X, pts[j].Y - pts[j - 1].Y) / SCALE;
        if (extra + seg >= scarfLength) {
          var t = (scarfLength - extra) / seg;
          path.push({
            pt: { X: Math.round(pts[j - 1].X + (pts[j].X - pts[j - 1].X) * t),
                  Y: Math.round(pts[j - 1].Y + (pts[j].Y - pts[j - 1].Y) * t) },
            d: total + scarfLength,
            w: widths ? widths[j - 1] + (widths[j] - widths[j - 1]) * t : 0
          });
          break;
        }
        extra += seg;
        path.push({ pt: pts[j], d: total + extra, w: widths ? widths[j] : 0 });
        j++;
      }

      // A wall segment is usually far longer than the ramp — a cube's side is
      // 30 mm against a 10 mm scarf. Judging flow at the segment midpoint then
      // gives one flat step instead of a ramp, and lays far too much plastic.
      // Subdivide anything that overlaps either ramp.
      var step = scarfLength / 8;
      var dense = [path[0]];
      for (i = 1; i < path.length; i++) {
        var a = path[i - 1], b = path[i];
        var inRamp = a.d < scarfLength || b.d > total;
        var span = b.d - a.d;
        if (inRamp && span > step) {
          var pieces = Math.ceil(span / step);
          for (var k = 1; k < pieces; k++) {
            var f = k / pieces;
            dense.push({
              pt: { X: Math.round(a.pt.X + (b.pt.X - a.pt.X) * f),
                    Y: Math.round(a.pt.Y + (b.pt.Y - a.pt.Y) * f) },
              d: a.d + span * f,
              w: a.w + (b.w - a.w) * f
            });
          }
        }
        dense.push(b);
      }

      var out = [dense[0].pt];
      var flows = [0];
      var outW = widths ? [dense[0].w] : null;
      for (i = 1; i < dense.length; i++) {
        var mid = (dense[i].d + dense[i - 1].d) / 2;
        var flow = 1;
        if (mid < scarfLength) flow = mid / scarfLength;
        else if (mid > total) flow = Math.max(0, 1 - (mid - total) / scarfLength);
        out.push(dense[i].pt);
        flows.push(flow);
        if (outW) outW.push(dense[i].w);
      }
      return { pts: out, flows: flows, widths: outW };
    }

    /** One G2/G3 in place of the dozens of tiny segments that trace a curve. */
    function extrudeArc(target, centre, clockwise, w, h, speed, flow) {
      var x = target.X / SCALE, y = target.Y / SCALE;
      var ccx = centre.X / SCALE, ccy = centre.Y / SCALE;
      var i = ccx - cx, j = ccy - cy;
      var radius = Math.hypot(i, j);
      if (!(radius > 0)) return;

      var a0 = Math.atan2(cy - ccy, cx - ccx);
      var a1 = Math.atan2(y - ccy, x - ccx);
      var sweep = clockwise ? a0 - a1 : a1 - a0;
      while (sweep <= 1e-9) sweep += 2 * Math.PI;
      var arcLength = radius * sweep;

      var vol = crossSection(w, h) * arcLength;
      var delta = vol * flow / filamentArea;
      extrudedVolume += vol * flow;

      var f = Math.round(speed * 60);
      var line2 = (clockwise ? 'G2' : 'G3') +
        ' X' + fmt(x - originX) + ' Y' + fmt(y - originY) +
        ' I' + fmt(i) + ' J' + fmt(j) + ' ' + emitE(delta);
      if (f !== lastF) { line2 += ' F' + f; lastF = f; }
      out.push(line2);

      var chord = Math.hypot(x - cx, y - cy);
      recordMove(x - cx, y - cy, speed, arcLength);
      if (chord > 1e-6) lastDir = [(x - cx) / chord, (y - cy) / chord];
      cx = x; cy = y;
    }

    // --- header ------------------------------------------------------------
    out.push('; generated by Orca Web Slicer');
    out.push('; ' + new Date().toISOString());
    out.push('; printer = ' + s.printerKey + ' (' + s.gcodeFlavor + ')');
    out.push('; layer_height = ' + s.layerHeight);
    out.push('; first_layer_height = ' + s.firstLayerHeight);
    out.push('; nozzle_diameter = ' + s.nozzle);
    out.push('; filament_diameter = ' + s.filamentDiameter);
    out.push('; filament_type = ' + s.filamentKey);
    out.push('; perimeters = ' + s.wallLoops);
    out.push('; top_solid_layers = ' + s.topLayers);
    out.push('; bottom_solid_layers = ' + s.bottomLayers);
    out.push('; fill_density = ' + s.infillDensity + '%');
    out.push('; fill_pattern = ' + s.infillPattern);
    out.push('; support_material = ' + (s.supportEnable ? 1 : 0));
    out.push('; brim_type = ' + s.adhesion);
    out.push('; ironing = ' + s.ironing);
    out.push('; bed_shape = ' + (s.bedShape === 'circle' ? 'circular d=' + s.bedX : s.bedX + 'x' + s.bedY));
    out.push('; origin = ' + (s.originCenter ? 'centre' : 'front-left'));
    out.push('');

    // Positioning mode BEFORE anything moves. The start script homes, lifts and
    // draws a prime line at absolute coordinates; if the machine was left in
    // relative mode by the previous job or by its own macros, every one of those
    // is taken as an offset — the lift becomes a climb, the prime line goes
    // somewhere else entirely, and Z is wrong for the whole print.
    out.push('G90 ; absolute positioning');
    // Start scripts write their prime line in absolute E — 'E15' then 'E30'
    // meaning fifteen millimetres and then fifteen more. Handing them relative E
    // makes that thirty and then thirty. The profile's own choice is applied
    // after the script, where the rest of the file needs it.
    out.push('M82 ; absolute extrusion');
    out.push('G92 E0');

    // Where the first layer actually sits on the plate. A machine that probes
    // only the area it is about to print on needs to be told what that is, and
    // a start script that draws its purge line along the front edge needs to
    // know whether the part is in the way of it.
    var firstBox = { minX: 0, minY: 0, maxX: s.bedX, maxY: s.bedY };
    if (layers.length && layers[0].feats.length) {
      var fb = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      for (var ff = 0; ff < layers[0].feats.length; ff++) {
        var fpts = layers[0].feats[ff].pts;
        for (var fp = 0; fp < fpts.length; fp++) {
          var fx = fpts[fp].X / SCALE - originX, fy = fpts[fp].Y / SCALE - originY;
          if (fx < fb.minX) fb.minX = fx;
          if (fy < fb.minY) fb.minY = fy;
          if (fx > fb.maxX) fb.maxX = fx;
          if (fy > fb.maxY) fb.maxY = fy;
        }
      }
      if (fb.minX <= fb.maxX) firstBox = fb;
    }

    out.push(renderTemplate(s.startGcode, s, {
      total_layers: layers.length,
      first_layer_min_x: Math.round(firstBox.minX * 100) / 100,
      first_layer_min_y: Math.round(firstBox.minY * 100) / 100,
      first_layer_max_x: Math.round(firstBox.maxX * 100) / 100,
      first_layer_max_y: Math.round(firstBox.maxY * 100) / 100
    }));

    if (s.chamberTemp > 0) { out.push('M141 S' + s.chamberTemp + ' ; chamber'); }
    // Asserted again: a machine's own start macro is free to leave either mode
    // however it likes, and the body that follows assumes both.
    out.push('G90 ; absolute positioning');
    out.push(s.relativeE ? 'M83 ; relative extrusion' : 'M82 ; absolute extrusion');
    out.push('G92 E0');
    if (s.emitAcceleration) out.push(flavor.acceleration(s.maxAccel));
    setFan(Math.round(s.firstLayerFanSpeed * 2.55));

    // --- cooling pass: work out which layers need slowing down --------------
    var scales = new Float64Array(layers.length);
    for (var p = 0; p < layers.length; p++) {
      scales[p] = 1;
      if (!s.minLayerTime || !layers[p].feats.length) continue;
      var seconds = estimateLayerSeconds(layers[p], p, s);
      if (seconds > 0 && seconds < s.minLayerTime) scales[p] = seconds / s.minLayerTime;
    }

    var tempSwitched = false;
    var baseFan = Math.round(s.firstLayerFanSpeed * 2.55);
    var lastObject = null;
    var currentTool = 0;
    var printedTopZ = 0;
    var clearanceLift = s.extruderClearanceHeight > 0 ? s.extruderClearanceHeight : 25;

    for (var Li = 0; Li < layers.length; Li++) {
      var layer = layers[Li];
      if (!layer.feats.length) continue;
      combPaths = layer.comb;

      // Printing one object at a time, every object starts its own first layer:
      // slow speeds, wide first-layer beads, first-layer fan. The writer keeps a
      // separate index for that, and `Li` stays the file-wide layer number the
      // preview and the host slicer conventions expect.
      var Lo = layer.idx === undefined ? Li : layer.idx;

      // Moving on to the next object: climb clear of everything already printed
      // before crossing the plate, then come down over the new one. The wipe on
      // the way out still belongs to the object being left, so this runs before
      // the new one is announced.
      if (layer.objectStart && layer.feats.length) {
        retract();
        var safeZ = Math.min(s.bedZ || 1e9, printedTopZ + clearanceLift);
        if (safeZ > cz) { out.push('G1 Z' + fmt(safeZ) + ' F' + zFeed); cz = safeZ; }
        var entry = layer.feats[0].pts[0];
        out.push('G0 X' + fmt(entry.X / SCALE - originX) + ' Y' + fmt(entry.Y / SCALE - originY) +
                 ' F' + Math.round(s.travelSpeed * 60));
        recordMove(entry.X / SCALE - cx, entry.Y / SCALE - cy, s.travelSpeed);
        cx = entry.X / SCALE; cy = entry.Y / SCALE;
        lastF = -1;
      }

      // Everything after this belongs to the new object, the height it prints at
      // included, so the marker goes ahead of the layer header.
      if (layer.object && layer.object !== lastObject) {
        lastObject = layer.object;
        out.push(';OBJECT:' + layer.object);
      }

      out.push(';LAYER_CHANGE');
      out.push(';LAYER:' + Li);
      out.push(';Z:' + fmt(layer.z));
      out.push(';HEIGHT:' + fmt(layer.h));

      if (layer.z > printedTopZ) printedTopZ = layer.z;

      if (Lo === 1 && !tempSwitched) {
        tempSwitched = true;
        if (s.nozzleTemp !== s.firstLayerNozzleTemp) out.push('M104 S' + s.nozzleTemp);
        if (s.bedTemp !== s.firstLayerBedTemp) out.push('M140 S' + s.bedTemp);
      }

      // Cooling: a layer that prints too fast to set gets slowed and blown on.
      var scale = scales[Li];
      baseFan = Lo + 1 >= s.fanFromLayer ? Math.round(s.fanSpeed * 2.55) : Math.round(s.firstLayerFanSpeed * 2.55);
      if (scale < 1) baseFan = Math.max(baseFan, Math.round(s.fanSpeed * 2.55));
      setFan(baseFan);

      if (s.layerGcode) {
        out.push(renderTemplate(s.layerGcode, s, {
          layer: Li, layer_num: Li, layer_z: layer.z,
          object_layer: Lo, layer_height: layer.h, total_layers: layers.length
        }));
      }

      if (!s.spiralVase || Lo < s.bottomLayers) {
        out.push('G1 Z' + fmt(layer.z) + ' F' + zFeed);
        cz = layer.z;
        lastF = -1;
      }

      for (var fi = 0; fi < layer.feats.length; fi++) {
        var f = layer.feats[fi];
        var pts = f.pts;
        if (pts.length < 2) continue;

        // Changing tool: pull the filament back first, then hand over. The
        // purge that makes the new tool trustworthy is the prime tower, which
        // the planner has already slotted in right after this.
        var wantTool = f.extruder || 0;
        if (wantTool !== currentTool) {
          retract();
          out.push(';TOOLCHANGE:' + wantTool);
          out.push(renderTemplate(s.toolChangeGcode || 'T{next_extruder}', s, {
            next_extruder: wantTool, previous_extruder: currentTool,
            layer: Li, layer_z: layer.z
          }));
          currentTool = wantTool;
          lastF = -1;
          retracted = true;              // the tool arrives with its filament back
        }

        featureCounts[f.type] = (featureCounts[f.type] || 0) + 1;
        out.push(';TYPE:' + (f.primeTower ? 'Prime tower' : (GCODE_TYPE[f.type] || f.type)));

        // Bridges and far overhangs get everything the fan has.
        if (f.type === FEATURE.BRIDGE || f.type === FEATURE.INTERNAL_BRIDGE ||
            (s.overhangFanBoost && f.overhang >= 2)) setFan(255);
        else setFan(baseFan);

        var speed = effectiveSpeed(f, Lo, layer.h, s);
        if (scale < 1) speed = Math.max(s.slowDownMinSpeed, speed * scale);
        var flow = flowFor(f.type, s);
        var width = f.type === FEATURE.IRONING ? f.w : f.w;

        travelTo(pts[0].X / SCALE, pts[0].Y / SCALE);

        var vase = s.spiralVase && Lo >= s.bottomLayers && f.type === FEATURE.OUTER;
        var totalLen = 0, q;
        if (vase) {
          for (q = 1; q < pts.length; q++) totalLen += Math.hypot(pts[q].X - pts[q - 1].X, pts[q].Y - pts[q - 1].Y);
        }
        var run = 0, zPrev = (Lo > 0 && layers[Li - 1]) ? layers[Li - 1].z : layer.z;

        // A scarfed loop varies its flow along the path, so it cannot be an arc
        // and it is not a plain constant-flow run either.
        if (s.seamScarf && f.type === FEATURE.OUTER && f.closed && !vase && Lo > 0) {
          var scarf = scarfLoop(pts, s.scarfLength, f.widths);
          if (scarf) {
            for (var si = 1; si < scarf.pts.length; si++) {
              var sw = scarf.widths ? (scarf.widths[si - 1] + scarf.widths[si]) / 2 : width;
              extrudeTo(scarf.pts[si].X / SCALE, scarf.pts[si].Y / SCALE, layer.z,
                        sw, layer.h, speed, flow * scarf.flows[si]);
            }
            continue;
          }
        }

        // Arcs need a constant width and a flat layer, so variable-width beads
        // and the vase spiral keep their straight segments.
        if (s.arcFitting && flavor.supportsArcs && s.machineArcs !== false &&
            !f.widths && !vase && pts.length >= 6) {
          var fitted = fitArcs(pts, s.arcTolerance);
          for (var mi = 0; mi < fitted.length; mi++) {
            var mv = fitted[mi];
            if (mv.type === 'arc') {
              extrudeArc(mv.to, mv.centre, mv.cw, width, layer.h, speed, flow);
              arcCount++;
            } else {
              extrudeTo(mv.to.X / SCALE, mv.to.Y / SCALE, layer.z, width, layer.h, speed, flow);
            }
          }
          continue;
        }

        for (var pi = 1; pi < pts.length; pi++) {
          var X = pts[pi].X / SCALE, Y = pts[pi].Y / SCALE;
          var zTarget = layer.z;
          if (vase && totalLen > 0) {
            run += Math.hypot(pts[pi].X - pts[pi - 1].X, pts[pi].Y - pts[pi - 1].Y);
            zTarget = zPrev + (layer.z - zPrev) * (run / totalLen);
          }
          // A variable-width bead extrudes the average width of each segment.
          var segWidth = f.widths ? (f.widths[pi - 1] + f.widths[pi]) / 2 : width;
          extrudeTo(X, Y, zTarget, segWidth, layer.h, speed, flow);
        }
      }
    }

    // --- footer ------------------------------------------------------------
    out.push(';END');
    // Marks where the machine's own script takes over again, so a reader — the
    // verifier included — can tell the part's moves from the machine's.
    out.push(';END_GCODE');
    out.push(renderTemplate(s.endGcode, s, { max_z: printedTopZ, total_layers: layers.length }));

    var seconds = estimateTime(moves, s.maxAccel);
    var volume = extrudedVolume;
    var filamentLength = volume / filamentArea;
    var grams = volume * (s.filamentDensity || 1.24) / 1000;
    var cost = grams / 1000 * (s.filamentCost || 0);

    out.push([
      '',
      '; estimated printing time = ' + formatDuration(seconds),
      '; filament used [mm] = ' + Math.round(filamentLength),
      '; filament used [cm3] = ' + (volume / 1000).toFixed(2),
      '; filament used [g] = ' + grams.toFixed(2),
      '; filament cost = ' + cost.toFixed(2),
      '; total layers = ' + layers.length
    ].join('\n'));

    return {
      text: out.join('\n') + '\n',
      stats: {
        seconds: seconds,
        filamentMm: filamentLength,
        volumeCm3: volume / 1000,
        grams: grams,
        cost: cost,
        layers: layers.length,
        moves: moves.L.length,
        arcs: arcCount,
        features: featureCounts,
        slowedLayers: Array.prototype.filter.call(scales, function (x) { return x < 1; }).length
      }
    };
  }

  /** Trapezoidal motion estimate with junction speeds and a look-ahead pass. */
  function estimateTime(moves, accel) {
    var n = moves.L.length;
    if (!n) return 0;
    var a = Math.max(200, accel || 1500);
    var minJunction = 5;
    var entry = new Float64Array(n), exit = new Float64Array(n), junction = new Float64Array(n + 1);

    for (var i = 1; i < n; i++) {
      var vlim = Math.min(moves.V[i - 1], moves.V[i]);
      var factor = Math.max(0, moves.C[i]);
      junction[i] = Math.max(Math.min(minJunction, vlim), vlim * factor);
    }
    junction[0] = 0; junction[n] = 0;

    for (var f = 0; f < n; f++) {
      entry[f] = Math.min(junction[f], moves.V[f]);
      exit[f] = Math.min(moves.V[f], Math.sqrt(entry[f] * entry[f] + 2 * a * moves.L[f]), junction[f + 1]);
    }
    for (var b = n - 1; b >= 0; b--) {
      entry[b] = Math.min(entry[b], Math.sqrt(exit[b] * exit[b] + 2 * a * moves.L[b]));
      if (b > 0) exit[b - 1] = Math.min(exit[b - 1], entry[b]);
    }

    var t = 0;
    for (var k = 0; k < n; k++) {
      var L = moves.L[k], ve = entry[k], vx = exit[k], vmax = moves.V[k];
      var peak = Math.sqrt(Math.max(0, (2 * a * L + ve * ve + vx * vx) / 2));
      var vc = Math.min(vmax, peak);
      if (vc < 1e-6) { t += L / Math.max(vmax, 1); continue; }
      var dAcc = Math.max(0, (vc * vc - ve * ve) / (2 * a));
      var dDec = Math.max(0, (vc * vc - vx * vx) / (2 * a));
      t += (vc - ve) / a + (vc - vx) / a + Math.max(0, L - dAcc - dDec) / vc;
    }
    return t;
  }

  function formatDuration(sec) {
    sec = Math.round(sec);
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s2 = sec % 60;
    return (h ? h + 'h ' : '') + (h || m ? m + 'm ' : '') + s2 + 's';
  }

  /**
   * Flatten a layer's features into typed arrays. The worker transfers these
   * straight to the main thread; the in-page fallback hands over the same shape.
   */
  function packLayer(layer) {
    var feats = layer.feats;
    var nPts = 0, i;
    for (i = 0; i < feats.length; i++) nPts += feats[i].pts.length;

    var pts = new Float32Array(nPts * 2);
    var pointWidths = new Float32Array(nPts);   // per point, so beads render true to width
    var offsets = new Uint32Array(feats.length + 1);
    var types = new Uint8Array(feats.length);
    var widths = new Float32Array(feats.length);

    var cursor = 0;
    for (var f = 0; f < feats.length; f++) {
      offsets[f] = cursor;
      types[f] = TYPE_CODES[feats[f].type] != null ? TYPE_CODES[feats[f].type] : 8;
      widths[f] = feats[f].w;
      var p = feats[f].pts;
      var pw = feats[f].widths;
      for (var k = 0; k < p.length; k++) {
        pts[cursor * 2] = p[k].X / SCALE;
        pts[cursor * 2 + 1] = p[k].Y / SCALE;
        pointWidths[cursor] = pw ? pw[k] : feats[f].w;
        cursor++;
      }
    }
    offsets[feats.length] = cursor;
    return {
      z: layer.z, h: layer.h, pts: pts, pointWidths: pointWidths,
      offsets: offsets, types: types, widths: widths
    };
  }

  function packLayers(layers) {
    var out = new Array(layers.length);
    for (var i = 0; i < layers.length; i++) out[i] = packLayer(layers[i]);
    return out;
  }

  root.OrcaEngine = {
    slice: slice,
    verifyOutput: verifyOutput,
    packLayer: packLayer,
    packLayers: packLayers,
    TYPE_CODES: TYPE_CODES,
    FEATURE: FEATURE,
    formatDuration: formatDuration,
    planLayers: planLayers,
    crossSection: crossSection,
    estimateTime: estimateTime
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
