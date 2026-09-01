/**
 * Reading the G-code back.
 *
 * The slicer's preview used to be drawn from its own layer model, so a file
 * that came out empty or truncated would still have looked right on screen.
 * This exercises the reader that now feeds the preview: it walks the finished
 * text like a printer — coordinate mode, extruder mode, units, arcs — and what
 * it finds has to agree with what the slicer said it wrote.
 *
 *   node test-gcodeview.js
 */
globalThis.ClipperLib = require('./js/vendor/clipper.js');
globalThis.OrcaPresets = require('./js/slicer/presets.js');
require('./js/slicer/engine.js');
require('./js/slicer/beading.js');
require('./js/slicer/lightning.js');
require('./js/slicer/template.js');
require('./js/slicer/gcodecheck.js');
require('./js/slicer/gcodeview.js');
var E = globalThis.OrcaEngine, P = globalThis.OrcaPresets, V = globalThis.OrcaGcodeView;

var pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); }
}

/** A cube, the way the app puts a demo model on the plate. */
function cube(cx, cy, s) {
  var h = s / 2, t = [];
  var v = [[cx-h,cy-h,0],[cx+h,cy-h,0],[cx+h,cy+h,0],[cx-h,cy+h,0],
           [cx-h,cy-h,s],[cx+h,cy-h,s],[cx+h,cy+h,s],[cx-h,cy+h,s]];
  var f = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],
           [1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
  f.forEach(function (q) { q.forEach(function (i) { t.push(v[i][0], v[i][1], v[i][2]); }); });
  return new Float32Array(t);
}

/** The corners of one layer, as read out of the file. */
function layerBounds(layer) {
  var b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (var i = 0; i < layer.pts.length; i += 2) {
    if (layer.pts[i] < b.minX) b.minX = layer.pts[i];
    if (layer.pts[i] > b.maxX) b.maxX = layer.pts[i];
    if (layer.pts[i + 1] < b.minY) b.minY = layer.pts[i + 1];
    if (layer.pts[i + 1] > b.maxY) b.maxY = layer.pts[i + 1];
  }
  return b;
}

function sliceOn(printerKey, tweak) {
  var s = P.buildSettings(printerKey, 'pla', 'q020');
  if (tweak) tweak(s);
  var bed = s.bedX, bedY = s.bedY;
  return { settings: s, result: E.slice({ positions: cube(bed / 2, bedY / 2, 20), settings: s }, function () {}) };
}

// ---------------------------------------------------------------------------
// The file a printer would be given, read as a printer would read it.
// ---------------------------------------------------------------------------

['artillery_x2', 'centauri_carbon_2', 'prusa_mini', 'ender3'].forEach(function (key) {
  if (!P.PRINTERS[key]) { console.log('  (no printer ' + key + ', skipped)'); return; }
  var run = sliceOn(key);
  var read = V.parse(run.result.gcode);
  var name = P.PRINTERS[key].name;

  ok(name + ': the file contains something to print (' + read.stats.segments + ' moves)',
    read.stats.segments > 500, JSON.stringify(read.stats));

  // Every layer the slicer planned has to be found in the text, plus at most
  // one more for the priming that happens before the first one.
  var planned = run.result.layers.length;
  ok(name + ': every planned layer is in the file (' + planned + ' planned, ' +
    read.stats.layers + ' read)',
    read.stats.layers >= planned && read.stats.layers <= planned + 2,
    planned + ' vs ' + read.stats.layers);

  // The filament the file actually asks for, against the estimate. The reader
  // counts the priming line as well, which the estimate leaves out.
  var claimed = run.result.stats.filamentMm;
  var over = read.stats.filamentMm - claimed;
  ok(name + ': the filament in the file matches the estimate (' +
    Math.round(claimed) + ' mm claimed, ' + Math.round(read.stats.filamentMm) + ' mm in the file)',
    over > -1 && over < claimed * 0.15 + 60, 'difference ' + Math.round(over) + ' mm');

  // And it is in the right place. Measured halfway up, where there is nothing
  // but the part: the whole-file bounds also cover the priming line that the
  // machine's own start script draws along the front edge.
  var b = layerBounds(read.layers[Math.floor(read.layers.length / 2)]);
  var mid = run.settings.bedX / 2;
  ok(name + ': the part is where the model was (' + Math.round(b.minX) + '–' + Math.round(b.maxX) + ')',
    b.minX < mid && b.maxX > mid && (b.maxX - b.minX) > 18 && (b.maxX - b.minX) < 30,
    JSON.stringify(b));

  ok(name + ': and as tall as the model (' + read.stats.maxZ.toFixed(2) + ' mm)',
    Math.abs(read.stats.maxZ - 20) < 0.5, String(read.stats.maxZ));

  // Widths come out of the file, not out of the settings: extrusion per
  // millimetre travelled, at this layer's height. A 0.4 nozzle laying a
  // 0.42 mm line should read back as about that.
  var widths = [];
  read.layers.forEach(function (l) {
    for (var i = 0; i < l.pointWidths.length; i += 40) widths.push(l.pointWidths[i]);
  });
  widths.sort(function (a, b) { return a - b; });
  var median = widths[Math.floor(widths.length / 2)];
  ok(name + ': the line width measured from the file is believable (' + median.toFixed(2) + ' mm)',
    median > 0.25 && median < 0.75, String(median));

  // Every layer, not just the file as a whole. The first printed layer sits a
  // fraction above the priming line, and reading its height as that fraction
  // made every line on it eight times too fat — on screen, a lump of spikes
  // where the first layer should be.
  var fat = [];
  read.layers.forEach(function (l, li) {
    if (l.pointWidths.length < 20) return;         // the priming line itself
    var w = Array.prototype.slice.call(l.pointWidths).sort(function (a, b) { return a - b; });
    var m = w[Math.floor(w.length / 2)];
    if (m > run.settings.nozzle * 1.6) fat.push('layer ' + li + ' z' + l.z.toFixed(2) +
      ' median ' + m.toFixed(2) + ' mm');
  });
  ok(name + ': and no single layer reads back fat', fat.length === 0,
    JSON.stringify(fat.slice(0, 3)));
});

// ---------------------------------------------------------------------------
// The reader is a reader, not this slicer's twin: it has to cope with files
// written the other ways round.
// ---------------------------------------------------------------------------

var square = [
  'G21', 'G90', 'M83', 'G28', 'G92 E0',
  'G1 Z0.2 F600',
  'G1 X10 Y10 F3000',
  ';TYPE:External perimeter',
  'G1 X20 Y10 E0.4 F1200',
  'G1 X20 Y20 E0.4',
  'G1 X10 Y20 E0.4',
  'G1 X10 Y10 E0.4'
].join('\n');
var rel = V.parse(square);
ok('relative extrusion is understood (M83)', rel.stats.segments === 4, JSON.stringify(rel.stats));
ok('and adds up to the filament the file asked for (1.6 mm)',
  Math.abs(rel.stats.filamentMm - 1.6) < 1e-6, String(rel.stats.filamentMm));
ok('with the square in the right place',
  rel.stats.bounds.minX === 10 && rel.stats.bounds.maxY === 20, JSON.stringify(rel.stats.bounds));

// The same square in absolute extrusion has to read identically.
var abs = V.parse(square.replace('M83', 'M82')
  .replace('E0.4 F1200', 'E0.4 F1200')
  .replace(/E0\.4$/gm, function () { return 'E0.4'; })
  .split('\n').map(function (l, i) {
    var running = { 8: 'E0.4', 9: 'E0.8', 10: 'E1.2', 11: 'E1.6' };
    return running[i] ? l.replace(/E[\d.]+/, running[i]) : l;
  }).join('\n'));
ok('absolute extrusion reads the same (M82)',
  abs.stats.segments === 4 && Math.abs(abs.stats.filamentMm - 1.6) < 1e-6,
  JSON.stringify(abs.stats));

// Relative coordinates.
var g91 = V.parse([
  'G90', 'G1 X10 Y10 Z0.2 F3000', 'M83',
  'G91', ';TYPE:Perimeter',
  'G1 X10 E0.4 F1200', 'G1 Y10 E0.4', 'G1 X-10 E0.4', 'G1 Y-10 E0.4'
].join('\n'));
ok('relative coordinates are followed (G91)',
  g91.stats.segments === 4 && g91.stats.bounds.maxX === 20 && g91.stats.bounds.minX === 10,
  JSON.stringify(g91.stats));

// Inches.
var inches = V.parse([
  'G20', 'G90', 'M83', 'G1 X1 Y1 Z0.01 F100', ';TYPE:Perimeter', 'G1 X2 E0.02'
].join('\n'));
ok('inches are converted (G20)',
  Math.abs(inches.stats.bounds.maxX - 50.8) < 0.01 &&
  Math.abs(inches.stats.filamentMm - 0.508) < 0.001, JSON.stringify(inches.stats));

// G92 moves the origin of the numbers without moving the head.
var g92 = V.parse([
  'G90', 'M82', 'G1 X10 Y10 Z0.2 F3000', ';TYPE:Perimeter',
  'G1 X20 E1', 'G92 E0', 'G1 X30 E1'
].join('\n'));
ok('G92 re-labels the extruder without inventing filament',
  Math.abs(g92.stats.filamentMm - 2) < 1e-9, String(g92.stats.filamentMm));

// Arcs are drawn as arcs, not as chords.
var arc = V.parse([
  'G90', 'M83', 'G1 X10 Y0 Z0.2 F3000', ';TYPE:Perimeter',
  'G2 X-10 Y0 I-10 J0 E10 F1200'
].join('\n'));
var half = arc.layers[0];
ok('an arc becomes a curve, not a straight line (' + arc.stats.segments + ' steps)',
  arc.stats.segments > 20, JSON.stringify(arc.stats));
ok('and bulges to the radius it was given (' + arc.stats.bounds.minY.toFixed(2) + ')',
  Math.abs(Math.abs(arc.stats.bounds.minY) - 10) < 0.2 || Math.abs(arc.stats.bounds.maxY - 10) < 0.2,
  JSON.stringify(arc.stats.bounds));

// A file with nothing in it reads as nothing, which is the whole point.
var startOnly = V.parse([
  'G90', 'M104 S215', 'M140 S60', 'M190 S60', 'G28', 'M109 S215',
  'G1 Z3 F3000', 'M84'
].join('\n'));
ok('a file that only heats and homes reads back as empty',
  startOnly.stats.segments === 0 && startOnly.layers.length === 0,
  JSON.stringify(startOnly.stats));

var truncated = V.parse(sliceOn('artillery_x2').result.gcode.slice(0, 4000));
ok('half a file reads back as half a file',
  truncated.stats.segments > 0 && truncated.stats.layers <= 2,
  JSON.stringify(truncated.stats));

// The ceiling holds, so an enormous file cannot take the tab down with it.
var capped = V.parse(sliceOn('artillery_x2').result.gcode, { maxSegments: 500 });
ok('the segment ceiling stops the reader and says so',
  capped.truncated === true && capped.stats.segments >= 500 && capped.stats.segments < 600,
  JSON.stringify(capped.stats));

// A ;TYPE: nobody has heard of still draws.
var unknown = V.parse([
  'G90', 'M83', 'G1 X10 Y10 Z0.2 F3000', ';TYPE:Something new', 'G1 X20 E0.4 F1200'
].join('\n'));
ok('an unfamiliar feature type still draws', unknown.stats.segments === 1,
  JSON.stringify(unknown.stats));

// A thumbnail in the header must not hide the header from the reader.
var withThumb = (function () {
  var g = sliceOn('artillery_x2').result.gcode;
  var head = g.indexOf('\n');
  var junk = ['', '; thumbnail begin 300x300 40000'];
  for (var i = 0; i < 520; i++) junk.push('; ' + new Array(78).join('A'));
  junk.push('; thumbnail end', '');
  return g.slice(0, head + 1) + junk.join('\n') + g.slice(head + 1);
})();
var thumbed = V.parse(withThumb);
ok('a spliced-in thumbnail changes nothing about what is read',
  thumbed.stats.segments > 500 && thumbed.header.filamentDiameter === 1.75,
  JSON.stringify(thumbed.header));

// ---------------------------------------------------------------------------
// How thick a layer is.
//
// A width is only as good as the height it is divided by. The first printed
// layer sits a fraction of a millimetre above the priming line the machine's
// own start script draws — 0.28 above 0.25 — and reading that 0.03 as the
// layer's height makes every line on it eight times too wide. On screen that
// is a lump of spikes where the first layer should be, on a file that is
// perfectly good.
// ---------------------------------------------------------------------------

var primed = [
  '; generated by a slicer', '; filament_diameter = 1.75',
  'G90', 'M83', 'G28',
  'G1 Z0.25 F600', 'G1 X10 Y0.5 F5000',
  'G1 X100 Y0.5 E9 F1200',                     // the priming line, deliberately fat
  ';LAYER_CHANGE', ';Z:0.28', ';HEIGHT:0.28',
  'G1 Z0.28 F600', 'G0 X50 Y50 F9000', ';TYPE:External perimeter',
  // 0.36 mm wide at 0.28 high over 20 mm: 0.36*0.28*20 / 2.405 = 0.838 mm
  'G1 X70 Y50 E0.838 F1200',
  ';LAYER_CHANGE', ';Z:0.52', ';HEIGHT:0.24',
  'G1 Z0.52 F600', 'G0 X50 Y50 F9000', ';TYPE:External perimeter',
  'G1 X70 Y50 E0.718 F1200'
].join('\n');

var pr = V.parse(primed);
ok('the priming line is its own layer, and the print starts after it',
  pr.stats.layers === 3, JSON.stringify(pr.stats));
var firstW = pr.layers[1].pointWidths[1];
ok('the first printed layer is read at its own height, not at the step above the priming (' +
  firstW.toFixed(2) + ' mm)', Math.abs(firstW - 0.36) < 0.02, String(firstW));
var secondW = pr.layers[2].pointWidths[1];
ok('and the layer above it too (' + secondW.toFixed(2) + ' mm)',
  Math.abs(secondW - 0.36) < 0.02, String(secondW));

// A file that never says how thick its layers are has to come out the same.
var silent = primed.split('\n').filter(function (l) { return !/^;HEIGHT:/.test(l); }).join('\n');
var si = V.parse(silent);
ok('a file that never states its layer height still reads sensibly (' +
  si.layers[1].pointWidths[1].toFixed(2) + ' mm)',
  Math.abs(si.layers[1].pointWidths[1] - 0.36) < 0.08, String(si.layers[1].pointWidths[1]));

// ---------------------------------------------------------------------------
// Layers that go missing.
//
// A slice plane that lands on a ring of vertices is not a rare case: it happens
// whenever the layer height divides into the spacing of the model's own
// geometry, which is most of what comes out of CAD. The plane sits an ulp above
// the ring, the triangles below it get culled for ending below the plane, and
// the ones above contribute nothing because their on-plane vertices count as
// above — so the layer came out empty and the print had a hole through it. The
// demo cube never showed it: its only horizontal geometry is the top and the
// bottom.
// ---------------------------------------------------------------------------

/** A drum with horizontal rings of vertices every `ring` millimetres. */
function ringed(cx, cy, height, radius, ring) {
  var t = [];
  function tri(a, b, c) { t.push(a[0],a[1],a[2],b[0],b[1],b[2],c[0],c[1],c[2]); }
  var N = 64, rows = Math.round(height / ring);
  for (var i = 0; i < N; i++) {
    var a0 = i / N * 2 * Math.PI, a1 = (i + 1) / N * 2 * Math.PI;
    for (var j = 0; j < rows; j++) {
      var z0 = j * ring, z1 = (j + 1) * ring;
      tri([cx+Math.cos(a0)*radius, cy+Math.sin(a0)*radius, z0],
          [cx+Math.cos(a1)*radius, cy+Math.sin(a1)*radius, z0],
          [cx+Math.cos(a1)*radius, cy+Math.sin(a1)*radius, z1]);
      tri([cx+Math.cos(a0)*radius, cy+Math.sin(a0)*radius, z0],
          [cx+Math.cos(a1)*radius, cy+Math.sin(a1)*radius, z1],
          [cx+Math.cos(a0)*radius, cy+Math.sin(a0)*radius, z1]);
    }
    tri([cx, cy, 0], [cx+Math.cos(a1)*radius, cy+Math.sin(a1)*radius, 0],
        [cx+Math.cos(a0)*radius, cy+Math.sin(a0)*radius, 0]);
    tri([cx, cy, height], [cx+Math.cos(a0)*radius, cy+Math.sin(a0)*radius, height],
        [cx+Math.cos(a1)*radius, cy+Math.sin(a1)*radius, height]);
  }
  return new Float32Array(t);
}

[0.2, 0.4, 1, 1.25, 2].forEach(function (ring) {
  var s = P.buildSettings('artillery_x2', 'pla', 'q020');
  var r = E.slice({ positions: ringed(s.bedX / 2, s.bedY / 2, 20, 10, ring), settings: s },
    function () {});

  // Every layer the slicer planned has to be in the text, at the height it
  // planned it. A missing one prints the next layer over thin air.
  var written = r.gcode.split('\n')
    .filter(function (l) { return /^;Z:/.test(l); })
    .map(function (l) { return parseFloat(l.slice(3)); });
  var missing = r.layers.map(function (l) { return l.z; }).filter(function (z) {
    return !written.some(function (w) { return Math.abs(w - z) < 1e-6; });
  });
  ok('a model with a ring of vertices every ' + ring + ' mm keeps every layer (' +
    written.length + ' of ' + r.layers.length + ')',
    missing.length === 0 && written.length === r.layers.length,
    missing.length + ' missing: ' + missing.slice(0, 4).map(function (z) { return z.toFixed(3); }).join(', '));

  // And the file reads back with no gap in it: consecutive layers, no jump.
  var read = V.parse(r.gcode);
  var gaps = [];
  for (var i = 2; i < read.layers.length; i++) {
    var rise = read.layers[i].z - read.layers[i - 1].z;
    if (rise > s.layerHeight * 1.5) gaps.push(read.layers[i - 1].z.toFixed(2) + '→' + read.layers[i].z.toFixed(2));
  }
  ok('  and the printed heights step evenly all the way up', gaps.length === 0,
    JSON.stringify(gaps.slice(0, 4)));
});

// ---------------------------------------------------------------------------
// A real model is not a cube: it has curves, overhangs and features switched
// on. Each of these produces a file, and each file has to read back as a part.
// ---------------------------------------------------------------------------

/** A shape with curvature, an overhang and a flat top — a model, not a box. */
function vase(cx, cy) {
  var t = [];
  function tri(a, b, c) { t.push(a[0],a[1],a[2],b[0],b[1],b[2],c[0],c[1],c[2]); }
  var H = 30, N = 48, M = 24;
  function r(z) { return 12 * (0.5 + 0.5 * Math.sin(Math.PI * (0.2 + 0.7 * z / H))); }
  for (var i = 0; i < N; i++) {
    var a0 = i / N * 2 * Math.PI, a1 = (i + 1) / N * 2 * Math.PI;
    for (var j = 0; j < M; j++) {
      var z0 = j / M * H, z1 = (j + 1) / M * H;
      tri([cx+Math.cos(a0)*r(z0), cy+Math.sin(a0)*r(z0), z0],
          [cx+Math.cos(a1)*r(z0), cy+Math.sin(a1)*r(z0), z0],
          [cx+Math.cos(a1)*r(z1), cy+Math.sin(a1)*r(z1), z1]);
      tri([cx+Math.cos(a0)*r(z0), cy+Math.sin(a0)*r(z0), z0],
          [cx+Math.cos(a1)*r(z1), cy+Math.sin(a1)*r(z1), z1],
          [cx+Math.cos(a0)*r(z1), cy+Math.sin(a0)*r(z1), z1]);
    }
    tri([cx, cy, 0], [cx+Math.cos(a1)*r(0), cy+Math.sin(a1)*r(0), 0],
        [cx+Math.cos(a0)*r(0), cy+Math.sin(a0)*r(0), 0]);
    tri([cx, cy, H], [cx+Math.cos(a0)*r(H), cy+Math.sin(a0)*r(H), H],
        [cx+Math.cos(a1)*r(H), cy+Math.sin(a1)*r(H), H]);
  }
  return new Float32Array(t);
}

var FEATURES = [
  ['plain', function () {}],
  ['supports', function (s) { s.supportEnable = true; }],
  ['tree supports', function (s) { s.supportEnable = true; s.supportStyle = 'tree'; }],
  ['brim', function (s) { s.adhesion = 'brim'; }],
  ['raft', function (s) { s.adhesion = 'raft'; }],
  ['ironing', function (s) { s.ironing = 'top'; }],
  ['fuzzy skin', function (s) { s.fuzzySkin = 'outer'; }],
  ['arachne walls', function (s) { s.wallGenerator = 'arachne'; }],
  ['adaptive layers', function (s) { s.adaptiveLayers = true; }],
  ['scarf seam', function (s) { s.seamScarf = true; }],
  ['monotonic surfaces', function (s) { s.monotonicSurfaces = 'all'; }],
  ['spiral vase', function (s) { s.spiralVase = true; s.topLayers = 0; s.infillDensity = 0; s.perimeters = 1; }],
  ['arc fitting', function (s) { s.arcFitting = true; }],
  ['everything at once', function (s) {
    s.supportEnable = true; s.supportStyle = 'tree'; s.ironing = 'top'; s.adhesion = 'brim';
    s.fuzzySkin = 'outer'; s.wallGenerator = 'arachne'; s.seamScarf = true;
    s.monotonicSurfaces = 'all'; s.gapFill = true; s.internalBridges = true;
  }]
];

FEATURES.forEach(function (f) {
  var s = P.buildSettings('artillery_x2', 'pla', 'q020');
  f[1](s);
  var r;
  try { r = E.slice({ positions: vase(s.bedX / 2, s.bedY / 2), settings: s }, function () {}); }
  catch (err) { ok('a model with ' + f[0] + ' slices', false, err.message); return; }
  var read = V.parse(r.gcode);
  var nan = /NaN|undefined|Infinity/.test(r.gcode);
  ok('a model with ' + f[0] + ' reads back as a part (' + read.stats.layers + ' layers, ' +
    read.stats.segments + ' moves, ' + Math.round(read.stats.filamentMm) + ' mm)',
    !nan && read.stats.segments > 200 && read.stats.layers >= r.layers.length &&
    read.stats.maxZ > 20 && read.stats.filamentMm > r.stats.filamentMm * 0.5,
    JSON.stringify(read.stats) + ' for ' + r.layers.length + ' planned' + (nan ? ' NaN!' : ''));
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
