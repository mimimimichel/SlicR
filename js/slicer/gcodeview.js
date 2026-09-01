/**
 * Orca Web Slicer — reading G-code back.
 *
 * The preview used to be drawn from the slicer's own layer model, which means
 * it could only ever agree with itself: a file that came out empty, truncated
 * or in the wrong units would still have looked perfect on screen. This reads
 * the finished text instead, the way a printer or any third-party viewer does —
 * one line at a time, tracking coordinate mode, extruder mode, units and
 * position — and hands back the same packed layers the viewer already draws.
 *
 * So what is on screen is what is in the file. Nothing else is claimed.
 *
 * It knows nothing about this slicer beyond the ;TYPE: comment used for
 * colouring, which every slicer since Slic3r has written, and which it only
 * uses to pick a colour. A file from another slicer parses the same way.
 */
(function (root) {
  'use strict';

  // The viewer's palette, by name. A ;TYPE: it has never heard of still draws —
  // in the colour of sparse infill — rather than disappearing.
  var TYPE_CODES = {
    'skirt': 0, 'brim': 1,
    'external perimeter': 2, 'outer wall': 2,
    'perimeter': 3, 'inner wall': 3, 'internal perimeter': 3,
    'solid infill': 4, 'internal solid infill': 4, 'bottom surface': 6,
    'top solid infill': 5, 'top surface': 5,
    'bridge infill': 7, 'bridge': 7,
    'internal infill': 8, 'sparse infill': 8, 'infill': 8,
    'support material': 9, 'support': 9,
    'ironing': 10,
    'gap fill': 11,
    'support material interface': 12, 'support interface': 12,
    'raft': 13,
    'overhang perimeter': 14, 'overhang wall': 14,
    'internal bridge infill': 15, 'internal bridge': 15,
    'prime tower': 8, 'wipe tower': 8, 'custom': 8, 'unknown': 8
  };
  var DEFAULT_TYPE = 8;

  /** Arcs are drawn as chords no longer than this, in millimetres. */
  var ARC_STEP = 0.4;

  /**
   * Read a file.
   *
   * opts.filamentDiameter — needed to turn extruded millimetres into a line
   *   width. Taken from the file's own header when it carries one.
   * opts.maxSegments — a ceiling, so a 200 MB file cannot take the tab down.
   *   Parsing stops there and says so in `truncated`.
   */
  function parse(text, opts) {
    opts = opts || {};
    var maxSegments = opts.maxSegments || 4000000;

    var header = readHeader(text);
    var filamentD = opts.filamentDiameter || header.filamentDiameter || 1.75;
    var filamentArea = Math.PI * filamentD * filamentD / 4;

    // Machine state, exactly the state a printer keeps.
    var x = 0, y = 0, z = 0, e = 0;
    var absXYZ = true, absE = true, mm = true;
    var seen = false;              // has anything set a position yet
    var type = DEFAULT_TYPE;

    // The layer being built: runs of consecutive extrusions, each with its own
    // type and per-point width.
    var layers = [];
    var current = null;            // { z, h, feats: [ {type, pts:[], widths:[]} ] }
    var run = null;                // the run of extrusion being extended
    var segments = 0, truncated = false;
    var extrudedMm = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    var maxZ = 0;
    // Where a layer starts. A file that says so is believed — which is the only
    // way a vase spiral comes out as layers rather than as one turn each. A
    // file that says nothing gets its layers from the Z it prints at.
    var sawLayerComment = false, pendingLayer = false;

    function startLayer(atZ) {
      var previous = current;
      current = { z: atZ, h: 0.2, feats: [] };
      if (previous) {
        var rise = atZ - previous.z;
        if (rise > 0.01 && rise < 2) current.h = rise;
        else current.h = previous.h;
      } else if (atZ > 0.01 && atZ < 2) {
        current.h = atZ;
      }
      layers.push(current);
      run = null;
      pendingLayer = false;
    }

    /** A move that lays plastic: extend the current run, or open a new one. */
    function extrude(nx, ny, nz, volumeMm) {
      if (!current || pendingLayer ||
          (!sawLayerComment && Math.abs(nz - current.z) > 1e-4)) startLayer(nz);
      var length = Math.hypot(nx - x, ny - y);
      if (length < 1e-9) return;

      // The width is measured, not assumed: the filament that went in, spread
      // over the distance travelled at this layer's height. An over-extruding
      // file therefore looks fat on screen, which is the point of looking.
      var h = current.h;
      var width = volumeMm > 0 && h > 0 ? (volumeMm * filamentArea) / (length * h) : 0;
      width = Math.max(0.05, Math.min(width, 5));

      if (!run) {
        run = { type: type, pts: [x, y], widths: [width] };
        current.feats.push(run);
      }
      run.pts.push(nx, ny);
      run.widths.push(width);
      run.widths[0] = run.widths[0] || width;
      segments++;
      if (nx < minX) minX = nx;
      if (nx > maxX) maxX = nx;
      if (ny < minY) minY = ny;
      if (ny > maxY) maxY = ny;
      if (nz > maxZ) maxZ = nz;
    }

    var lines = text.split('\n');
    for (var li = 0; li < lines.length && !truncated; li++) {
      var raw = lines[li];
      var semi = raw.indexOf(';');
      if (semi === 0) {
        // ;TYPE: is the only comment that changes anything on screen.
        var t = /^;\s*TYPE\s*:\s*(.+?)\s*$/i.exec(raw);
        if (t) {
          var code = TYPE_CODES[t[1].toLowerCase()];
          type = code == null ? DEFAULT_TYPE : code;
          run = null;               // a new type starts a new run, and a new colour
        } else if (/^;\s*(LAYER_CHANGE|LAYER\s*:|CHANGE_LAYER)/i.test(raw)) {
          sawLayerComment = true;
          pendingLayer = true;
        }
        continue;
      }
      var line = semi > 0 ? raw.slice(0, semi) : raw;
      if (!line.trim()) continue;

      var cmd = /^\s*([GM])\s*(\d+)/i.exec(line);
      if (!cmd) continue;
      var letter = cmd[1].toUpperCase(), num = parseInt(cmd[2], 10);

      if (letter === 'M') {
        if (num === 82) absE = true;
        else if (num === 83) absE = false;
        continue;
      }

      if (num === 20) { mm = false; continue; }        // inches
      if (num === 21) { mm = true; continue; }
      if (num === 90) { absXYZ = true; absE = true; continue; }
      if (num === 91) { absXYZ = false; absE = false; continue; }

      var w = words(line);
      var scale = mm ? 1 : 25.4;

      if (num === 92) {
        // G92 re-labels the current position without moving anything.
        if (w.X != null) x = w.X * scale;
        if (w.Y != null) y = w.Y * scale;
        if (w.Z != null) z = w.Z * scale;
        if (w.E != null) e = w.E * scale;
        continue;
      }

      if (num === 0 || num === 1 || num === 2 || num === 3) {
        var nx = x, ny = y, nz = z;
        if (absXYZ) {
          if (w.X != null) nx = w.X * scale;
          if (w.Y != null) ny = w.Y * scale;
          if (w.Z != null) nz = w.Z * scale;
        } else {
          if (w.X != null) nx = x + w.X * scale;
          if (w.Y != null) ny = y + w.Y * scale;
          if (w.Z != null) nz = z + w.Z * scale;
        }

        // How much filament this move consumes, in millimetres of filament.
        var de = 0;
        if (w.E != null) {
          var ev = w.E * scale;
          de = absE ? ev - e : ev;
          e = absE ? ev : e + ev;
        }

        if (!seen) { seen = true; x = nx; y = ny; z = nz; continue; }

        if ((num === 2 || num === 3) && (w.I != null || w.J != null || w.R != null)) {
          var pts = arcPoints(x, y, nx, ny, w, scale, num === 2);
          // Spread the filament over the arc in proportion to each chord.
          var total = 0, k;
          for (k = 1; k < pts.length; k++) {
            total += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
          }
          for (k = 1; k < pts.length; k++) {
            var chord = Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
            var share = total > 0 ? de * (chord / total) : 0;
            if (de > 0) extrude(pts[k][0], pts[k][1], nz, share);
            else run = null;
            x = pts[k][0]; y = pts[k][1];
          }
          if (de > 0) extrudedMm += de;
          z = nz;
        } else if (de > 0 && (nx !== x || ny !== y)) {
          extrude(nx, ny, nz, de);
          extrudedMm += de;
          x = nx; y = ny; z = nz;
        } else {
          // A travel, a retract, or a lift: it ends the run being drawn.
          run = null;
          x = nx; y = ny; z = nz;
        }
        if (segments >= maxSegments) truncated = true;
      }
    }

    return {
      layers: layers.map(pack),
      header: header,
      stats: {
        segments: segments,
        layers: layers.length,
        filamentMm: extrudedMm,
        maxZ: maxZ,
        bounds: segments ? { minX: minX, minY: minY, maxX: maxX, maxY: maxY } : null
      },
      truncated: truncated
    };
  }

  /** The parameters on one line, as numbers. */
  function words(line) {
    var out = {};
    var re = /([A-Za-z])\s*(-?\d*\.?\d+(?:[eE][-+]?\d+)?)/g;
    var m;
    while ((m = re.exec(line))) {
      var k = m[1].toUpperCase();
      if (k === 'G' || k === 'M') continue;
      if (out[k] == null) out[k] = parseFloat(m[2]);
    }
    return out;
  }

  /**
   * The points along a G2/G3, centre-form (I/J) or radius-form (R), stepped
   * finely enough that the curve looks like a curve.
   */
  function arcPoints(x0, y0, x1, y1, w, scale, clockwise) {
    var cx, cy;
    if (w.I != null || w.J != null) {
      cx = x0 + (w.I || 0) * scale;
      cy = y0 + (w.J || 0) * scale;
    } else {
      // R form: two circles pass through both ends; positive R takes the minor arc.
      var r = w.R * scale;
      var dx = x1 - x0, dy = y1 - y0;
      var d = Math.hypot(dx, dy);
      if (d < 1e-9 || Math.abs(r) < d / 2) return [[x0, y0], [x1, y1]];
      var h = Math.sqrt(r * r - d * d / 4) * (r > 0 ? 1 : -1);
      var sign = clockwise ? -1 : 1;
      cx = (x0 + x1) / 2 + sign * h * (-dy / d);
      cy = (y0 + y1) / 2 + sign * h * (dx / d);
    }
    var radius = Math.hypot(x0 - cx, y0 - cy);
    if (!(radius > 0)) return [[x0, y0], [x1, y1]];

    var a0 = Math.atan2(y0 - cy, x0 - cx);
    var a1 = Math.atan2(y1 - cy, x1 - cx);
    var sweep = a1 - a0;
    if (clockwise) { while (sweep >= 0) sweep -= 2 * Math.PI; }
    else { while (sweep <= 0) sweep += 2 * Math.PI; }
    // A G2/G3 with no endpoint is a full turn, which is how some vendor end
    // scripts lift off the part.
    if (Math.abs(x1 - x0) < 1e-9 && Math.abs(y1 - y0) < 1e-9) {
      sweep = clockwise ? -2 * Math.PI : 2 * Math.PI;
    }

    var steps = Math.max(2, Math.min(720, Math.ceil(Math.abs(sweep) * radius / ARC_STEP)));
    var pts = [];
    for (var i = 0; i <= steps; i++) {
      var a = a0 + sweep * (i / steps);
      pts.push([cx + Math.cos(a) * radius, cy + Math.sin(a) * radius]);
    }
    pts[pts.length - 1] = [x1, y1];
    return pts;
  }

  /** What the file says about itself. Only the header comments, no guessing. */
  function readHeader(text) {
    // Far enough in to clear a spliced-in thumbnail, which sits between the
    // first line and the rest of the header.
    var head = text.slice(0, 300000);
    var out = {};
    var d = /^;\s*filament_diameter\s*=\s*([\d.]+)/mi.exec(head);
    if (d) out.filamentDiameter = parseFloat(d[1]);
    var g = /^;\s*generated by\s*(.+)$/mi.exec(head);
    if (g) out.generator = g[1].trim();
    var b = /^;\s*bed_shape\s*=\s*(\S+)/mi.exec(head);
    if (b) out.bedShape = b[1];
    return out;
  }

  /** The shape the viewer draws: flat typed arrays, one entry per layer. */
  function pack(layer) {
    var feats = layer.feats, i, f;
    var nPts = 0;
    for (f = 0; f < feats.length; f++) nPts += feats[f].widths.length;

    var pts = new Float32Array(nPts * 2);
    var pointWidths = new Float32Array(nPts);
    var offsets = new Uint32Array(feats.length + 1);
    var types = new Uint8Array(feats.length);
    var widths = new Float32Array(feats.length);

    var cursor = 0;
    for (f = 0; f < feats.length; f++) {
      offsets[f] = cursor;
      types[f] = feats[f].type;
      var sum = 0;
      for (i = 0; i < feats[f].widths.length; i++) {
        pts[cursor * 2] = feats[f].pts[i * 2];
        pts[cursor * 2 + 1] = feats[f].pts[i * 2 + 1];
        pointWidths[cursor] = feats[f].widths[i];
        sum += feats[f].widths[i];
        cursor++;
      }
      widths[f] = feats[f].widths.length ? sum / feats[f].widths.length : 0.4;
    }
    offsets[feats.length] = cursor;
    return { z: layer.z, h: layer.h, pts: pts, pointWidths: pointWidths,
             offsets: offsets, types: types, widths: widths };
  }

  root.OrcaGcodeView = { parse: parse, TYPE_CODES: TYPE_CODES };
})(typeof globalThis !== 'undefined' ? globalThis : self);
