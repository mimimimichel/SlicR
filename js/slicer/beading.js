/**
 * Orca Web Slicer — variable-width beads over the medial axis.
 *
 * This is the part of Arachne that matters on a real print: a feature narrower
 * than two lines gets ONE bead of the right width running down its middle,
 * instead of two starved walls, a dropped loop, or a scribble of gap fill.
 *
 * It is not a port of Arachne's SkeletalTrapezoidation. The medial axis is
 * recovered numerically: rasterise the region, take an exact Euclidean distance
 * transform, walk its ridge, and read the local half-thickness straight off the
 * distance field to get each point's width.
 *
 * Requires ClipperLib and OrcaEngineGeom.
 */
(function (root) {
  'use strict';

  var G = root.OrcaEngineGeom;
  var SCALE = G.SCALE;
  var MAX_CELLS = 3e6;      // refuse to rasterise something absurd

  // ---------------------------------------------------------------------------
  // Rasterisation
  // ---------------------------------------------------------------------------

  /**
   * Scanline-fill clipper paths into a bitmap using the non-zero rule, matching
   * how every other stage of the engine interprets these polygons.
   */
  function rasterise(paths, res) {
    var bb = G.pathsBBox(paths);
    var pad = 2;
    var x0 = bb.minX / SCALE - pad * res;
    var y0 = bb.minY / SCALE - pad * res;
    var nx = Math.ceil((bb.maxX / SCALE - bb.minX / SCALE) / res) + pad * 2 + 1;
    var ny = Math.ceil((bb.maxY / SCALE - bb.minY / SCALE) / res) + pad * 2 + 1;
    if (nx < 3 || ny < 3 || nx * ny > MAX_CELLS) return null;

    var inside = new Uint8Array(nx * ny);
    var crossings = [];

    for (var j = 0; j < ny; j++) {
      var y = y0 + j * res;
      crossings.length = 0;

      for (var p = 0; p < paths.length; p++) {
        var path = paths[p];
        var n = path.length;
        for (var i = 0; i < n; i++) {
          var a = path[i], b = path[(i + 1) % n];
          var ay = a.Y / SCALE, by = b.Y / SCALE;
          if ((ay <= y && by > y) || (by <= y && ay > y)) {
            var t = (y - ay) / (by - ay);
            crossings.push({ x: a.X / SCALE + (b.X / SCALE - a.X / SCALE) * t, dir: by > ay ? 1 : -1 });
          }
        }
      }
      if (crossings.length < 2) continue;
      crossings.sort(function (u, v) { return u.x - v.x; });

      var winding = 0;
      for (var c = 0; c < crossings.length - 1; c++) {
        winding += crossings[c].dir;
        if (winding === 0) continue;
        var from = Math.ceil((crossings[c].x - x0) / res);
        var to = Math.floor((crossings[c + 1].x - x0) / res);
        if (to < 0 || from >= nx) continue;
        if (from < 0) from = 0;
        if (to >= nx) to = nx - 1;
        for (var xi = from; xi <= to; xi++) inside[j * nx + xi] = 1;
      }
    }
    return { inside: inside, nx: nx, ny: ny, x0: x0, y0: y0, res: res };
  }

  // ---------------------------------------------------------------------------
  // Exact squared Euclidean distance transform (Felzenszwalb & Huttenlocher)
  // ---------------------------------------------------------------------------

  function edt1d(f, n, d, v, z) {
    var k = 0;
    v[0] = 0;
    z[0] = -Infinity;
    z[1] = Infinity;
    for (var q = 1; q < n; q++) {
      var s;
      while (true) {
        var p = v[k];
        s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p);
        if (s > z[k]) break;
        k--;
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = Infinity;
    }
    k = 0;
    for (var qq = 0; qq < n; qq++) {
      while (z[k + 1] < qq) k++;
      var dv = qq - v[k];
      d[qq] = dv * dv + f[v[k]];
    }
  }

  /**
   * 1D transform that also reports which source won, so the caller can carry a
   * value along with the distance — the basis of a feature transform.
   */
  function edt1dWithSource(f, n, d, src, v, z) {
    var k = 0;
    v[0] = 0;
    z[0] = -Infinity;
    z[1] = Infinity;
    for (var q = 1; q < n; q++) {
      var s;
      while (true) {
        var p = v[k];
        s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p);
        if (s > z[k]) break;
        k--;
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = Infinity;
    }
    k = 0;
    for (var qq = 0; qq < n; qq++) {
      while (z[k + 1] < qq) k++;
      var dv = qq - v[k];
      d[qq] = dv * dv + f[v[k]];
      src[qq] = v[k];
    }
  }

  /**
   * For every cell, which seed cell is nearest. Used to carry the local
   * half-thickness outward from the medial axis to the whole interior: that is
   * the field Arachne needs to decide how many beads fit and how wide they are.
   */
  function featureTransform(grid, seeds) {
    var nx = grid.nx, ny = grid.ny;
    var big = (nx + ny) * (nx + ny) * 4;
    var work = new Float64Array(nx * ny);
    var srcY = new Int32Array(nx * ny);
    var i;
    for (i = 0; i < work.length; i++) work[i] = seeds[i] ? 0 : big;

    var maxDim = Math.max(nx, ny);
    var f = new Float64Array(maxDim), d = new Float64Array(maxDim);
    var src = new Int32Array(maxDim);
    var v = new Int32Array(maxDim), z = new Float64Array(maxDim + 1);

    for (var x = 0; x < nx; x++) {
      for (var y = 0; y < ny; y++) f[y] = work[y * nx + x];
      edt1dWithSource(f, ny, d, src, v, z);
      for (y = 0; y < ny; y++) { work[y * nx + x] = d[y]; srcY[y * nx + x] = src[y]; }
    }

    var owner = new Int32Array(nx * ny);
    for (var yy = 0; yy < ny; yy++) {
      var row = yy * nx;
      for (var xx = 0; xx < nx; xx++) f[xx] = work[row + xx];
      edt1dWithSource(f, nx, d, src, v, z);
      for (xx = 0; xx < nx; xx++) {
        var sx = src[xx];
        owner[row + xx] = srcY[row + sx] * nx + sx;
      }
    }
    return owner;
  }

  /** Squared distance (in cells) from every inside cell to the nearest outside cell. */
  function distanceTransform(grid) {
    var nx = grid.nx, ny = grid.ny;
    var big = (nx + ny) * (nx + ny);
    var dist = new Float64Array(nx * ny);
    var i;
    for (i = 0; i < dist.length; i++) dist[i] = grid.inside[i] ? big : 0;

    var maxDim = Math.max(nx, ny);
    var f = new Float64Array(maxDim), d = new Float64Array(maxDim);
    var v = new Int32Array(maxDim), z = new Float64Array(maxDim + 1);

    for (var x = 0; x < nx; x++) {
      for (var y = 0; y < ny; y++) f[y] = dist[y * nx + x];
      edt1d(f, ny, d, v, z);
      for (y = 0; y < ny; y++) dist[y * nx + x] = d[y];
    }
    for (var yy = 0; yy < ny; yy++) {
      var row = yy * nx;
      for (var xx = 0; xx < nx; xx++) f[xx] = dist[row + xx];
      edt1d(f, nx, d, v, z);
      for (xx = 0; xx < nx; xx++) dist[row + xx] = d[xx];
    }
    return dist;
  }

  // ---------------------------------------------------------------------------
  // Ridge extraction
  // ---------------------------------------------------------------------------

  /**
   * The medial axis sits on the ridge of the distance field: a cell that is a
   * local maximum along at least one axis.
   *
   * The maximum has to be strict on at least one side. Along a long thin rib the
   * distance field is perfectly flat in the lengthwise direction, so a plain
   * `>=` test would call every single cell a ridge.
   */
  function findRidge(grid, dist, minCellDist) {
    var nx = grid.nx, ny = grid.ny;
    var ridge = new Uint8Array(nx * ny);
    var floor2 = minCellDist * minCellDist;

    for (var y = 1; y < ny - 1; y++) {
      for (var x = 1; x < nx - 1; x++) {
        var i = y * nx + x;
        if (!grid.inside[i]) continue;
        var here = dist[i];
        if (here < floor2) continue;
        var left = dist[i - 1], right = dist[i + 1];
        var down = dist[i - nx], up = dist[i + nx];
        // Strict on the low side, permissive on the high side: an even-width rib
        // has two equally-deep centre cells, and this keeps exactly one of them,
        // so the ridge comes out one cell thick instead of a doubled track.
        var peakX = here > left && here >= right;
        var peakY = here > down && here >= up;
        if (peakX || peakY) ridge[i] = 1;
      }
    }
    return ridge;
  }

  var NEIGHBOURS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

  /** Walk the ridge cells into polylines, endpoints first, then any leftover loops. */
  function chainRidge(ridge, nx, ny) {
    function degree(x, y) {
      var count = 0;
      for (var k = 0; k < 8; k++) {
        var i = (y + NEIGHBOURS[k][1]) * nx + (x + NEIGHBOURS[k][0]);
        if (ridge[i]) count++;
      }
      return count;
    }

    var used = new Uint8Array(nx * ny);
    var chains = [];

    /**
     * Follow the ridge by always taking the neighbour that best continues the
     * current heading. Marching in a fixed compass order instead cuts corners
     * across curved ridges and shatters a ring into a dozen stubs.
     */
    function trace(sx, sy) {
      var chain = [[sx, sy]];
      used[sy * nx + sx] = 1;
      var x = sx, y = sy, hx = 0, hy = 0;

      while (true) {
        var best = null, bestScore = -Infinity, bestDir = null;
        for (var k = 0; k < 8; k++) {
          var stepX = NEIGHBOURS[k][0], stepY = NEIGHBOURS[k][1];
          var ux = x + stepX, uy = y + stepY;
          if (ux < 1 || uy < 1 || ux >= nx - 1 || uy >= ny - 1) continue;
          var i = uy * nx + ux;
          if (!ridge[i] || used[i]) continue;

          var len = Math.hypot(stepX, stepY);
          // Straight ahead scores 1, a right-angle turn 0, doubling back -1.
          var score = (hx || hy) ? (stepX * hx + stepY * hy) / len : 0;
          score += (len === 1 ? 0.05 : 0);            // nudge towards orthogonal steps
          if (score > bestScore) {
            bestScore = score;
            best = [ux, uy];
            bestDir = [stepX / len, stepY / len];
          }
        }
        if (!best) break;
        used[best[1] * nx + best[0]] = 1;
        chain.push(best);
        x = best[0]; y = best[1];
        hx = bestDir[0]; hy = bestDir[1];
      }
      return chain;
    }

    var x2, y2, i2;
    for (y2 = 1; y2 < ny - 1; y2++) {
      for (x2 = 1; x2 < nx - 1; x2++) {
        i2 = y2 * nx + x2;
        if (!ridge[i2] || used[i2]) continue;
        if (degree(x2, y2) !== 1) continue;
        chains.push(trace(x2, y2));
      }
    }
    for (y2 = 1; y2 < ny - 1; y2++) {
      for (x2 = 1; x2 < nx - 1; x2++) {
        i2 = y2 * nx + x2;
        if (!ridge[i2] || used[i2]) continue;
        chains.push(trace(x2, y2));
      }
    }
    return chains;
  }

  // ---------------------------------------------------------------------------
  // Simplification
  // ---------------------------------------------------------------------------

  /** Ramer–Douglas–Peucker on [x, y, width] points, keeping the widths aligned. */
  function simplify(points, tolerance) {
    if (points.length < 3) return points.slice();
    var keep = new Uint8Array(points.length);
    keep[0] = keep[points.length - 1] = 1;
    var stack = [[0, points.length - 1]];

    while (stack.length) {
      var range = stack.pop();
      var first = range[0], last = range[1];
      var ax = points[first][0], ay = points[first][1];
      var bx = points[last][0], by = points[last][1];
      var dx = bx - ax, dy = by - ay;
      var len = Math.hypot(dx, dy);
      var worst = -1, worstIdx = -1;

      for (var i = first + 1; i < last; i++) {
        var d = len < 1e-12
          ? Math.hypot(points[i][0] - ax, points[i][1] - ay)
          : Math.abs(dy * points[i][0] - dx * points[i][1] + bx * ay - by * ax) / len;
        if (d > worst) { worst = d; worstIdx = i; }
      }
      if (worst > tolerance && worstIdx > 0) {
        keep[worstIdx] = 1;
        stack.push([first, worstIdx], [worstIdx, last]);
      }
    }

    var out = [];
    for (var k = 0; k < points.length; k++) if (keep[k]) out.push(points[k]);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Entry point
  // ---------------------------------------------------------------------------

  /**
   * Beads covering `paths`, each a polyline with a width per point.
   * Returns [] when the region is not worth beading or is too large to raster.
   */
  function medialBeads(paths, opts) {
    if (!paths || !paths.length) return [];
    var minWidth = opts.minWidth;
    var maxWidth = opts.maxWidth;
    // The gap a bead has to fill is not the width it has to be commanded at:
    // beads are rounded rectangles that interlock with whatever is beside them.
    var interlock = opts.interlock || 0;
    var res = opts.resolution || Math.max(0.03, minWidth / 4);

    // Coarsen for large regions, but never past half the minimum bead — below
    // that the distance field is too crude to place a bead honestly.
    var bb = G.pathsBBox(paths);
    var spanX = (bb.maxX - bb.minX) / SCALE, spanY = (bb.maxY - bb.minY) / SCALE;
    var budget = opts.maxCells || 4e5;
    var needed = Math.sqrt((spanX * spanY) / budget);
    if (needed > res) res = needed;
    if (res > minWidth * 0.5) return [];

    var grid = rasterise(paths, res);
    if (!grid) return [];

    var dist = distanceTransform(grid);
    // Ignore anything thinner than half the minimum bead: it cannot be printed.
    var ridge = findRidge(grid, dist, (minWidth * 0.5) / res);
    var chains = chainRidge(ridge, grid.nx, grid.ny);

    var beads = [];
    // Long enough not to be a staircase spur, short enough that the centre
    // strand of a tapering rib is not thrown away piece by piece.
    var minLength = Math.max(minWidth, res * 3);

    for (var c = 0; c < chains.length; c++) {
      var chain = extendChain(chains[c], grid, dist);
      if (chain.length < 2) continue;

      var pts = new Array(chain.length);
      for (var i = 0; i < chain.length; i++) {
        var cx = chain[i][0], cy = chain[i][1];
        var half = Math.max(0, Math.sqrt(dist[cy * grid.nx + cx]) - 0.5) * res;
        pts[i] = [
          grid.x0 + cx * res,
          grid.y0 + cy * res,
          Math.max(minWidth, Math.min(maxWidth, half * 2 + interlock))
        ];
      }

      var simplified = simplify(pts, res * 0.7);
      if (simplified.length < 2) continue;

      var length = 0;
      for (var k = 1; k < simplified.length; k++) {
        length += Math.hypot(simplified[k][0] - simplified[k - 1][0], simplified[k][1] - simplified[k - 1][1]);
      }
      if (length < minLength) continue;

      var polyline = [], widths = [];
      for (var q = 0; q < simplified.length; q++) {
        polyline.push({ X: Math.round(simplified[q][0] * SCALE), Y: Math.round(simplified[q][1] * SCALE) });
        widths.push(simplified[q][2]);
      }
      beads.push({ pts: polyline, widths: widths, length: length });
    }
    return joinBeads(beads, res * 10 * SCALE);
  }

  /**
   * Carry a bead out to the ends of the region it sits in.
   *
   * The ridge only exists where the distance field peaks, so where a region has
   * been cut off — at the seam with whatever handled the material next door —
   * the axis stops short of the cut and the bead with it. On a tapering rib
   * that left a bare stretch a millimetre long right at the join. Walking the
   * last direction onward while the cells are still inside puts the bead where
   * the material is.
   */
  function extendChain(chain, grid, dist) {
    if (chain.length < 3) return chain;
    var out = chain.slice();
    var look = Math.min(6, chain.length - 1);

    function walk(end, back, push) {
      // Direction over several points, not one cell step: a single step off a
      // ridge that wiggles can point across the feature instead of along it,
      // and the walk then runs sideways to the far wall.
      var dx = end[0] - back[0], dy = end[1] - back[1];
      var len = Math.hypot(dx, dy);
      if (len < 1e-9) return;
      dx /= len; dy /= len;
      // A cut can only have taken the axis back by the local radius, so that is
      // as far as it is ever put back.
      var steps = Math.ceil(Math.sqrt(dist[end[1] * grid.nx + end[0]]));
      var x = end[0], y = end[1];
      for (var k = 1; k <= steps; k++) {
        var nx = Math.round(end[0] + dx * k), ny = Math.round(end[1] + dy * k);
        if (nx < 1 || ny < 1 || nx >= grid.nx - 1 || ny >= grid.ny - 1) break;
        if (!grid.inside[ny * grid.nx + nx]) break;
        if (nx === x && ny === y) continue;
        push([nx, ny]);
        x = nx; y = ny;
      }
    }
    walk(chain[0], chain[look], function (p) { out.unshift(p); });
    var n = chain.length;
    walk(chain[n - 1], chain[n - 1 - look], function (p) { out.push(p); });
    return out;
  }

  /**
   * The ridge of a curve breaks into pieces wherever the discrete plateau flips
   * between rows and columns. Stitch pieces back together so a ring comes out as
   * one continuous bead instead of a string of stutters and retractions.
   */
  function joinBeads(beads, tolerance) {
    if (beads.length < 2) return beads;
    var tol2 = tolerance * tolerance;

    function near(a, b) {
      var dx = a.X - b.X, dy = a.Y - b.Y;
      return dx * dx + dy * dy <= tol2;
    }
    function reverse(bead) {
      bead.pts.reverse();
      bead.widths.reverse();
      return bead;
    }

    var open = beads.slice();
    var out = [];
    while (open.length) {
      var current = open.shift();
      var merged = true;
      while (merged) {
        merged = false;
        for (var i = 0; i < open.length; i++) {
          var other = open[i];
          var head = current.pts[0], tail = current.pts[current.pts.length - 1];
          var oHead = other.pts[0], oTail = other.pts[other.pts.length - 1];

          if (near(tail, oHead)) { /* as-is */ }
          else if (near(tail, oTail)) { reverse(other); }
          else if (near(head, oHead)) { reverse(current); }
          else if (near(head, oTail)) { reverse(current); reverse(other); }
          else continue;

          current.pts = current.pts.concat(other.pts.slice(1));
          current.widths = current.widths.concat(other.widths.slice(1));
          current.length += other.length;
          open.splice(i, 1);
          merged = true;
          break;
        }
      }
      out.push(current);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Local thickness field
  // ---------------------------------------------------------------------------

  /** 3x3 box blur, edges clamped. Takes the staircase out of a cell-quantised field. */
  function blur(src, nx, ny) {
    var out = new Float32Array(src.length);
    for (var y = 0; y < ny; y++) {
      for (var x = 0; x < nx; x++) {
        var sum = 0, n = 0;
        for (var dy = -1; dy <= 1; dy++) {
          var yy = y + dy;
          if (yy < 0 || yy >= ny) continue;
          for (var dx = -1; dx <= 1; dx++) {
            var xx = x + dx;
            if (xx < 0 || xx >= nx) continue;
            sum += src[yy * nx + xx];
            n++;
          }
        }
        out[y * nx + x] = sum / n;
      }
    }
    return out;
  }

  /**
   * Local thickness: the diameter of the largest circle that fits inside the
   * region AND contains this cell.
   *
   * The tempting shortcut — carry the half-thickness out from the nearest point
   * of the medial axis — is wrong at a corner. The medial axis of a square runs
   * up its diagonals, so a cell halfway along an edge is nearest to a diagonal
   * cell close to a corner, where the inscribed circle is tiny. It would report
   * a 20 mm square as being a fraction of a millimetre thick near its edges and
   * throw away every wall but the first.
   *
   * So each maximal circle is painted into the cells it actually covers, largest
   * first. Radii are capped: past the depth of the whole wall stack the only
   * thing the caller does with the answer is "thick enough, use nominal widths",
   * and the cap is what keeps the discs small enough to paint cheaply. Cells
   * already deeper than the cap are thick by definition, and a one-cell band at
   * the cap paints inward for the cells just shallower than it.
   */
  function localThickness(grid, dist, res, hMax) {
    var nx = grid.nx, ny = grid.ny, n = nx * ny;

    // The transform measures from cell centre to cell centre, so the distance
    // it reports to the nearest outside cell overshoots the real distance to
    // the boundary by about half a cell — the edge sits between them. Left in,
    // a 0.9 mm wall reads as 1.0 mm thick and gets a bead a tenth too fat.
    function radiusOf(cells) {
      var r = (cells - 0.5) * res;
      return r > 0 ? r : 0;
    }

    var half = new Float32Array(n);
    var capCells = hMax / res;
    var painters = [];
    var ridge = findRidge(grid, dist, 0);
    var i, dc;

    for (i = 0; i < n; i++) {
      if (!grid.inside[i]) continue;
      dc = Math.sqrt(dist[i]);
      if (dc >= capCells) {
        half[i] = hMax;
        if (dc < capCells + 1.5) painters.push(i * 4 + 0);   // band at the cap
      } else if (ridge[i]) {
        painters.push(i * 4 + 1);
      }
      if (half[i] < radiusOf(dc)) half[i] = radiusOf(dc);
    }

    // Largest first, so a cell keeps the biggest circle that reaches it.
    painters.sort(function (a, b) {
      var ra = (a & 3) ? Math.sqrt(dist[(a - (a & 3)) / 4]) : capCells;
      var rb = (b & 3) ? Math.sqrt(dist[(b - (b & 3)) / 4]) : capCells;
      return rb - ra;
    });

    for (var k = 0; k < painters.length; k++) {
      var code = painters[k];
      var cell = (code - (code & 3)) / 4;
      var r = (code & 3) ? Math.sqrt(dist[cell]) : capCells;
      var value = (code & 3) ? radiusOf(r) : hMax;
      var cx = cell % nx, cy = (cell - cx) / nx;
      if (half[cell] > value + 1e-6) continue;              // already inside a bigger circle
      var ri = Math.floor(r);
      for (var dy = -ri; dy <= ri; dy++) {
        var y = cy + dy;
        if (y < 0 || y >= ny) continue;
        var span = Math.floor(Math.sqrt(r * r - dy * dy));
        var xa = cx - span, xb = cx + span;
        if (xa < 0) xa = 0;
        if (xb >= nx) xb = nx - 1;
        var row = y * nx;
        for (var x = xa; x <= xb; x++) {
          if (half[row + x] < value) half[row + x] = value;
        }
      }
    }
    return half;
  }

  /**
   * How thick is the material here?
   *
   * This is the field the rest of Arachne is built on: given any point inside a
   * region, how much material is it in the middle of. Knowing that, the wall
   * generator can choose how many beads fit across and how wide each has to be,
   * instead of laying a fixed line and leaving whatever does not divide evenly
   * as a void or a scribble of gap fill.
   *
   * Returns null when the region cannot be rastered finely enough to be honest
   * about it; callers then fall back to fixed-width walls.
   */
  function thicknessField(paths, opts) {
    if (!paths || !paths.length) return null;
    var res = opts.resolution || 0.08;
    var hMax = opts.maxHalfThickness || 2;

    var bb = G.pathsBBox(paths);
    var spanX = (bb.maxX - bb.minX) / SCALE, spanY = (bb.maxY - bb.minY) / SCALE;
    var budget = opts.maxCells || 4e5;
    var needed = Math.sqrt((spanX * spanY) / budget);
    if (needed > res) res = needed;
    if (res > (opts.maxRes || 0.2)) return null;

    var grid = rasterise(paths, res);
    if (!grid) return null;

    var dist = distanceTransform(grid);
    var half = blur(localThickness(grid, dist, res, hMax), grid.nx, grid.ny);

    var nx = grid.nx, ny = grid.ny, x0 = grid.x0, y0 = grid.y0;

    /** Local half-thickness in mm at a point given in mm, bilinearly. */
    function sample(x, y) {
      var fx = (x - x0) / res, fy = (y - y0) / res;
      if (fx < 0) fx = 0; else if (fx > nx - 1.001) fx = nx - 1.001;
      if (fy < 0) fy = 0; else if (fy > ny - 1.001) fy = ny - 1.001;
      var ix = fx | 0, iy = fy | 0;
      var tx = fx - ix, ty = fy - iy;
      var a = half[iy * nx + ix], b = half[iy * nx + ix + 1];
      var c = half[(iy + 1) * nx + ix], d = half[(iy + 1) * nx + ix + 1];
      return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }

    return { sample: sample, res: res, cap: hMax };
  }

  root.OrcaBeading = {
    medialBeads: medialBeads,
    thicknessField: thicknessField,
    featureTransform: featureTransform,
    rasterise: rasterise,
    distanceTransform: distanceTransform
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.OrcaBeading;
})(typeof globalThis !== 'undefined' ? globalThis : self);
