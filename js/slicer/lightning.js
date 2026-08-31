/**
 * Orca Web Slicer — lightning infill.
 *
 * Ordinary sparse infill fills the whole inside of a part evenly, even though
 * almost all of it holds nothing up. Lightning infill only grows where something
 * above needs support: a tree is seeded under each solid area and its branches
 * lean outward as they descend, meeting the walls and stopping there. On a part
 * that is mostly hollow volume under a flat top, it costs a fraction of the
 * material and the time.
 *
 * Built top-down, because that is the direction support propagates: each layer
 * inherits the branch tips of the layer above, pulls them toward the perimeter,
 * and drops them once they arrive.
 *
 * Requires OrcaEngineGeom.
 */
(function (root) {
  'use strict';

  var G = root.OrcaEngineGeom;
  var SCALE = G.SCALE;

  /** Every vertex of a region, as plain mm points, for nearest-boundary queries. */
  function boundaryPoints(paths) {
    var pts = [];
    for (var i = 0; i < paths.length; i++) {
      var path = paths[i];
      for (var j = 0; j < path.length; j++) {
        var a = path[j], b = path[(j + 1) % path.length];
        pts.push([a.X / SCALE, a.Y / SCALE]);
        // Long edges need intermediate samples or a node can "miss" the wall.
        var len = Math.hypot(b.X - a.X, b.Y - a.Y) / SCALE;
        var steps = Math.floor(len / 1.5);
        for (var k = 1; k < steps; k++) {
          var t = k / steps;
          pts.push([(a.X + (b.X - a.X) * t) / SCALE, (a.Y + (b.Y - a.Y) * t) / SCALE]);
        }
      }
    }
    return pts;
  }

  function nearest(point, list) {
    var best = null, bestD = Infinity;
    for (var i = 0; i < list.length; i++) {
      var dx = list[i][0] - point[0], dy = list[i][1] - point[1];
      var d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = list[i]; }
    }
    return best ? { point: best, distance: Math.sqrt(bestD) } : null;
  }

  function nearestNode(point, nodes, ignore) {
    var best = null, bestD = Infinity;
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i] === ignore) continue;
      var dx = nodes[i].x - point[0], dy = nodes[i].y - point[1];
      var d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = nodes[i]; }
    }
    return best ? { node: best, distance: Math.sqrt(bestD) } : null;
  }

  /** Grid samples inside a region — the places that need holding up. */
  function samplePoints(region, spacing) {
    if (!region || !region.length) return [];
    var bb = G.pathsBBox(region);
    var pts = [];
    var lines = [];
    for (var y = Math.ceil(bb.minY / (spacing * SCALE)) * spacing * SCALE; y <= bb.maxY; y += spacing * SCALE) {
      lines.push([{ X: bb.minX - 1000, Y: Math.round(y) }, { X: bb.maxX + 1000, Y: Math.round(y) }]);
    }
    if (!lines.length) return [];
    var inside = G.clipLinesToRegion(lines, region);
    for (var i = 0; i < inside.length; i++) {
      var a = inside[i][0], b = inside[i][inside[i].length - 1];
      var len = Math.hypot(b.X - a.X, b.Y - a.Y) / SCALE;
      var steps = Math.max(1, Math.round(len / spacing));
      for (var k = 0; k <= steps; k++) {
        var t = steps ? k / steps : 0;
        pts.push([(a.X + (b.X - a.X) * t) / SCALE, (a.Y + (b.Y - a.Y) * t) / SCALE]);
      }
    }
    return pts;
  }

  /**
   * Returns one array of clipper polylines per layer.
   * `inner` is where infill may live, `solid` is what needs holding up.
   */
  function build(inner, solid, layers, settings) {
    var n = inner.length;
    var out = new Array(n);
    var spacing = settings.lineWidth / Math.max(0.01, settings.infillDensity / 100);
    var lean = Math.tan((settings.lightningAngle || 40) * Math.PI / 180);

    var nodes = [];     // carried down between layers

    for (var L = n - 1; L >= 0; L--) {
      out[L] = [];
      var region = inner[L];
      if (!region || !region.length) { nodes = []; continue; }

      var edge = boundaryPoints(region);
      if (!edge.length) { nodes = []; continue; }

      // Anything carried down that has already left the part is finished.
      var live = [];
      for (var i = 0; i < nodes.length; i++) {
        var g = nearest([nodes[i].x, nodes[i].y], edge);
        if (g && g.distance > spacing * 0.3) { nodes[i].ground = g.point; live.push(nodes[i]); }
      }

      // Seed a node under anything solid that nothing already reaches.
      var demand = samplePoints(solid[L], spacing);
      for (var d = 0; d < demand.length; d++) {
        var p = demand[d];
        var close = nearestNode(p, live);
        if (close && close.distance < spacing * 0.8) continue;

        var toEdge = nearest(p, edge);
        if (!toEdge) continue;
        // Attach to whichever is nearer: an existing branch, or the wall.
        var attachToNode = close && close.distance < toEdge.distance;
        live.push({
          x: p[0], y: p[1],
          parent: attachToNode ? close.node : null,
          ground: toEdge.point
        });
      }
      if (!live.length) { nodes = []; continue; }

      // Each node draws the segment back to whatever holds it up.
      for (var e = 0; e < live.length; e++) {
        var node = live[e];
        var target = node.parent ? [node.parent.x, node.parent.y] : node.ground;
        if (!target) continue;
        if (Math.hypot(target[0] - node.x, target[1] - node.y) < 0.05) continue;
        out[L].push([
          { X: Math.round(node.x * SCALE), Y: Math.round(node.y * SCALE) },
          { X: Math.round(target[0] * SCALE), Y: Math.round(target[1] * SCALE) }
        ]);
      }
      out[L] = G.clipLinesToRegion(out[L], region);

      // Descend: pull every node toward what holds it, so branches lean out and
      // converge on the walls instead of dropping as straight columns.
      var step = (layers[L] ? layers[L].height : settings.layerHeight) * lean;
      var next = [];
      for (var m = 0; m < live.length; m++) {
        var nd = live[m];
        var goal = nd.parent ? [nd.parent.x, nd.parent.y] : nd.ground;
        if (!goal) continue;
        var dist = Math.hypot(goal[0] - nd.x, goal[1] - nd.y);
        if (dist <= step) {
          // Arrived. Its children now hang off whatever it was hanging off.
          for (var c = 0; c < live.length; c++) if (live[c].parent === nd) live[c].parent = nd.parent;
          continue;
        }
        next.push({
          x: nd.x + (goal[0] - nd.x) / dist * step,
          y: nd.y + (goal[1] - nd.y) / dist * step,
          parent: nd.parent,
          ground: nd.ground
        });
      }
      // Merge tips that have converged, so branches join rather than run parallel.
      nodes = [];
      for (var q = 0; q < next.length; q++) {
        var dup = nearestNode([next[q].x, next[q].y], nodes);
        if (dup && dup.distance < spacing * 0.4) continue;
        nodes.push(next[q]);
      }
    }
    return out;
  }

  root.OrcaLightning = { build: build, samplePoints: samplePoints };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.OrcaLightning;
})(typeof globalThis !== 'undefined' ? globalThis : self);
