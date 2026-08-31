/**
 * Orca Web Slicer — tree supports.
 *
 * Normal supports are a wall of material standing under everything that
 * overhangs. Tree supports carry the same overhangs on branches: a tip under
 * each spot that needs holding, growing thicker and leaning inwards as it comes
 * down, merging with its neighbours, and reaching the plate as a few trunks.
 * They use a fraction of the material, come away in one piece, and leave far
 * less witness on the part because they touch it only at the tips.
 *
 * Branches are grown from the top down, one layer at a time, because that is
 * the direction the information runs: a branch only exists because something
 * above it needs holding.
 *
 * Requires ClipperLib and OrcaEngineGeom.
 */
(function (root) {
  'use strict';

  var G = root.OrcaEngineGeom;
  var SCALE = G.SCALE;
  var MAX_NODES = 4000;          // a pathological plate must not wedge the tab

  /** A circle as a clipper path, fine enough to union cleanly. */
  function disc(xMm, yMm, rMm) {
    var steps = Math.max(10, Math.min(40, Math.round(rMm * 12)));
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
   * Tips on a lattice across the region that needs holding. A grid rather than
   * the region's own outline: an overhang wants supporting across its whole
   * area, and the spacing is what decides how much it can bridge unaided.
   */
  function seedTips(region, spacing, into, tipRadius, delay) {
    var bb = G.pathsBBox(region);
    var x0 = bb.minX / SCALE, x1 = bb.maxX / SCALE;
    var y0 = bb.minY / SCALE, y1 = bb.maxY / SCALE;
    // Offset the lattice by half a step from the bounding box so a narrow strip
    // still gets a tip down its middle rather than one on each edge.
    var nx = Math.max(1, Math.round((x1 - x0) / spacing));
    var ny = Math.max(1, Math.round((y1 - y0) / spacing));
    var added = 0;

    for (var i = 0; i < nx; i++) {
      for (var j = 0; j < ny; j++) {
        var x = x0 + (i + 0.5) * (x1 - x0) / nx;
        var y = y0 + (j + 0.5) * (y1 - y0) / ny;
        var pt = { X: Math.round(x * SCALE), Y: Math.round(y * SCALE) };
        if (!G.pointInPaths(pt, region)) continue;
        into.push({ x: x, y: y, r: tipRadius, dist: 0, wait: delay });
        added++;
      }
    }
    return added;
  }

  /** Fold nodes that have grown into each other into one thicker branch. */
  function mergeNodes(nodes) {
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var merged = false;
      for (var k = 0; k < out.length; k++) {
        var other = out[k];
        var d = Math.hypot(node.x - other.x, node.y - other.y);
        if (d > (node.r + other.r) * 0.8) continue;
        // Weight by cross-section so a trunk is not dragged off course by a twig,
        // and keep the total area: two branches carry what one of area a+b does.
        var wa = other.r * other.r, wb = node.r * node.r;
        other.x = (other.x * wa + node.x * wb) / (wa + wb);
        other.y = (other.y * wa + node.y * wb) / (wa + wb);
        other.r = Math.sqrt(wa + wb);
        other.dist = Math.max(other.dist, node.dist);
        other.wait = Math.min(other.wait, node.wait);
        merged = true;
        break;
      }
      if (!merged) out.push(node);
    }
    return out;
  }

  /**
   * Branch regions, one entry per layer.
   *
   * `regions` are the model's own cross-sections and `layers` the layer plan.
   * Everything the caller does afterwards — the interface split, the XY gap
   * against the part, dropping slivers — is the same as for normal supports.
   */
  function build(regions, layers, s, opts) {
    var n = regions.length;
    var out = new Array(n);
    for (var i = 0; i < n; i++) out[i] = [];
    if (n < 2) return out;

    var lineW = opts.lineWidth;
    var tipR = Math.max(lineW * 0.6, (s.supportTipDiameter || lineW * 2) / 2);
    var maxR = Math.max(tipR, (s.supportBranchDiameter || 5) / 2);
    var lean = Math.tan(Math.max(0, Math.min(75, s.supportBranchAngle || 40)) * Math.PI / 180);
    var grow = Math.tan(Math.max(0, Math.min(45, s.supportBranchDiameterAngle || 5)) * Math.PI / 180);
    var spacing = Math.max(lineW * 3, s.supportTipSpacing || lineW * 8);
    // A fresh tip is one bead wide. Judging it by the same minimum area as a
    // slab of normal support throws away the top of every branch, and the tree
    // stops a millimetre short of what it is meant to be holding.
    var seedArea = Math.pow(lineW * 2, 2);
    var minArea = Math.PI * tipR * tipR * 0.5;
    var gapLayers = Math.max(1, Math.round(s.supportZGap / s.layerHeight));

    var nodes = [];

    for (var L = n - 1; L >= 0; L--) {
      var below = L > 0 ? regions[L - 1] : [];
      var height = layers[L].height;

      // --- new tips wherever this layer hangs off what is under it ---
      if (L > 0 && nodes.length < MAX_NODES) {
        var reach = height * Math.tan(s.supportThreshold * Math.PI / 180);
        var overhang = G.dropTinyIslands(
          G.subtract(regions[L], G.offsetPaths(below, reach)), seedArea);
        if (overhang.length) seedTips(overhang, spacing, nodes, tipR, gapLayers);
      }

      // --- draw whatever is already growing ---
      var drawn = [];
      for (i = 0; i < nodes.length; i++) {
        if (nodes[i].wait > 0) continue;
        drawn.push([disc(nodes[i].x, nodes[i].y, nodes[i].r)]);
      }
      if (drawn.length) out[L] = G.uniteAll(drawn);

      if (!L) break;

      // --- carry the branches down one layer ---
      var drift = height * lean;
      // What the branches have to stay out of on the layer they are moving into.
      var solid = G.offsetPaths(below, s.supportXYGap);
      var next = [];

      for (i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        if (node.wait > 0) { node.wait--; next.push(node); continue; }

        // Lean towards the nearest neighbours so branches meet and become trunks
        // instead of coming down as a forest of separate sticks.
        var tx = 0, ty = 0, weight = 0;
        for (var k = 0; k < nodes.length; k++) {
          if (k === i || nodes[k].wait > 0) continue;
          var dx = nodes[k].x - node.x, dy = nodes[k].y - node.y;
          var d = Math.hypot(dx, dy);
          if (d < 1e-6 || d > spacing * 3) continue;
          var w = nodes[k].r * nodes[k].r / d;
          tx += dx / d * w; ty += dy / d * w; weight += w;
        }
        var stepX = 0, stepY = 0;
        if (weight > 0) {
          var mag = Math.hypot(tx, ty);
          if (mag > 1e-9) { stepX = tx / mag * drift; stepY = ty / mag * drift; }
        }

        var nx = node.x + stepX, ny = node.y + stepY;
        node.dist += height;
        var wantR = Math.min(maxR, tipR + node.dist * grow);

        // Never lean into the part. If the step would put the branch inside it,
        // walk out of the model instead — the branch bends around it.
        var pt = { X: Math.round(nx * SCALE), Y: Math.round(ny * SCALE) };
        if (G.pointInPaths(pt, solid)) {
          var away = pushOut(node.x, node.y, solid, drift, wantR);
          if (!away) continue;                   // boxed in: end the branch here
          nx = away.x; ny = away.y;
        }

        node.x = nx; node.y = ny; node.r = wantR;
        next.push(node);
      }

      nodes = mergeNodes(next);
      if (nodes.length > MAX_NODES) nodes.length = MAX_NODES;
    }

    for (i = 0; i < n; i++) {
      if (out[i].length) out[i] = G.dropTinyIslands(out[i], minArea);
    }
    return out;
  }

  /** Nearest step of at most `reach` that gets the branch out of `solid`. */
  function pushOut(x, y, solid, reach, radius) {
    for (var ring = 1; ring <= 3; ring++) {
      var dist = reach * ring;
      for (var a = 0; a < 12; a++) {
        var ang = a / 12 * 2 * Math.PI;
        var cx = x + Math.cos(ang) * dist, cy = y + Math.sin(ang) * dist;
        if (!G.pointInPaths({ X: Math.round(cx * SCALE), Y: Math.round(cy * SCALE) }, solid)) {
          return { x: cx, y: cy };
        }
      }
    }
    return null;
  }

  root.OrcaTreeSupport = { build: build };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.OrcaTreeSupport;
})(typeof globalThis !== 'undefined' ? globalThis : self);
