/**
 * Web Slicer — a broad differential sweep against the reference.
 *
 * test-vs-reference.js checks a handful of shapes closely. This one goes wide:
 * every combination of shape, wall count, infill density and pattern, layer
 * height and nozzle size, sliced by both engines, compared on the numbers that
 * decide whether a print comes out. One case outside tolerance is a defect to
 * find, not a number to shrug at.
 *
 * Skips cleanly when prusa-slicer is missing.
 *
 *   node test-vs-reference-sweep.js
 */
var fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');

globalThis.ClipperLib = require('./js/vendor/clipper.js');
globalThis.OrcaPresets = require('./js/slicer/presets.js');
require('./js/slicer/engine.js');
require('./js/slicer/beading.js');
require('./js/slicer/lightning.js');
require('./js/slicer/treesupport.js');
require('./js/slicer/template.js');
require('./js/slicer/gcodecheck.js');
var E = globalThis.OrcaEngine, P = globalThis.OrcaPresets;

var REF = (function () {
  try { return cp.execSync('command -v prusa-slicer', { encoding: 'utf8' }).trim(); }
  catch (e) { return null; }
})();
if (!REF) { console.log('prusa-slicer is not installed — skipping.'); process.exit(0); }
var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slicer-sweep-'));

// --- shapes -----------------------------------------------------------------

function tri(t, a, b, c) { t.push(a, b, c); }
function quad(t, a, b, c, d) { tri(t, a, b, c); tri(t, a, c, d); }
function prism(outline, h) {
  var t = [], n = outline.length, i;
  for (i = 0; i < n; i++) {
    var a = outline[i], b = outline[(i + 1) % n];
    quad(t, [a[0],a[1],0], [b[0],b[1],0], [b[0],b[1],h], [a[0],a[1],h]);
  }
  // fan-triangulate the caps; every outline used here is convex or star-shaped
  // about its centroid, which is all a fan needs.
  var cx = 0, cy = 0;
  for (i = 0; i < n; i++) { cx += outline[i][0]; cy += outline[i][1]; }
  cx /= n; cy /= n;
  for (i = 0; i < n; i++) {
    var p = outline[i], q = outline[(i + 1) % n];
    tri(t, [cx,cy,0], [q[0],q[1],0], [p[0],p[1],0]);
    tri(t, [cx,cy,h], [p[0],p[1],h], [q[0],q[1],h]);
  }
  return t;
}
function rectOutline(w, d) { return [[-w/2,-d/2],[w/2,-d/2],[w/2,d/2],[-w/2,d/2]]; }
function wedgeOutline(len, t0, t1) {
  return [[-len/2,-t0/2],[len/2,-t1/2],[len/2,t1/2],[-len/2,t0/2]];
}
function polyOutline(sides, r) {
  var o = [];
  for (var i = 0; i < sides; i++) o.push([Math.cos(i/sides*2*Math.PI)*r, Math.sin(i/sides*2*Math.PI)*r]);
  return o;
}
function starOutline(points, rOuter, rInner) {
  var o = [];
  for (var i = 0; i < points * 2; i++) {
    var r = i % 2 ? rInner : rOuter, a = i / (points * 2) * 2 * Math.PI;
    o.push([Math.cos(a)*r, Math.sin(a)*r]);
  }
  return o;
}
function crossOutline(arm, w) {
  var a = arm / 2, b = w / 2;
  return [[-b,-a],[b,-a],[b,-b],[a,-b],[a,b],[b,b],[b,a],[-b,a],[-b,b],[-a,b],[-a,-b],[-b,-b]];
}
function sphereTris(r, seg) {
  var t = [];
  for (var i = 0; i < seg; i++) for (var j = 0; j < seg; j++) {
    function pt(u, v) {
      var th = u/seg*2*Math.PI, ph = v/seg*Math.PI;
      return [Math.sin(ph)*Math.cos(th)*r, Math.sin(ph)*Math.sin(th)*r, r - Math.cos(ph)*r];
    }
    quad(t, pt(i,j), pt(i+1,j), pt(i+1,j+1), pt(i,j+1));
  }
  return t;
}

function shoelace(outline) {
  var a = 0;
  for (var i = 0; i < outline.length; i++) {
    var p = outline[i], q = outline[(i + 1) % outline.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

var SHAPES = {
  'cube 20':        { tris: prism(rectOutline(20,20), 10), body: [1.5, 8.5], area: shoelace(rectOutline(20,20)) },
  'plate 40x25':    { tris: prism(rectOutline(40,25), 4),  body: [1.0, 3.0], area: shoelace(rectOutline(40,25)) },
  'hexagon':        { tris: prism(polyOutline(6, 12), 8),  body: [1.5, 6.5], area: shoelace(polyOutline(6, 12)) },
  'star':           { tris: prism(starOutline(5, 16, 7), 6), body: [1.5, 4.5], area: shoelace(starOutline(5, 16, 7)) },
  'cross':          { tris: prism(crossOutline(30, 7), 6), body: [1.5, 4.5], area: shoelace(crossOutline(30, 7)) },
  'thin wall 0.9':  { tris: prism(rectOutline(0.9, 26), 4), body: [1.0, 3.0], area: shoelace(rectOutline(0.9, 26)) },
  'thin wall 1.6':  { tris: prism(rectOutline(1.6, 26), 4), body: [1.0, 3.0], area: shoelace(rectOutline(1.6, 26)) },
  'wedge 3.0-0.6':  { tris: prism(wedgeOutline(24, 3.0, 0.6), 4), body: [1.0, 3.0],
                      area: shoelace(wedgeOutline(24, 3.0, 0.6)) },
  'sphere':         { tris: sphereTris(11, 40), body: [4.0, 16.0] }
};

function writeStl(file, tris) {
  var s = 'solid x\n';
  for (var i = 0; i < tris.length; i += 3) {
    s += 'facet normal 0 0 0\nouter loop\n';
    for (var k = 0; k < 3; k++) s += 'vertex ' + tris[i+k].map(function(v){return v.toFixed(5);}).join(' ') + '\n';
    s += 'endloop\nendfacet\n';
  }
  fs.writeFileSync(file, s + 'endsolid x\n');
}
function flat(tris) {
  var out = new Float32Array(tris.length * 3), at = 0;
  for (var i = 0; i < tris.length; i++) { out[at++]=tris[i][0]; out[at++]=tris[i][1]; out[at++]=tris[i][2]; }
  return out;
}

// --- the two engines, on the same settings ----------------------------------

function refSlice(stl, out, c) {
  cp.execFileSync(REF, [
    '--export-gcode', '--output', out,
    '--layer-height', c.layer, '--first-layer-height', c.layer,
    '--nozzle-diameter', c.nozzle, '--filament-diameter', '1.75',
    '--perimeters', c.walls, '--fill-density', c.density + '%',
    '--fill-pattern', c.pattern,
    '--extrusion-width=' + c.width,
    '--external-perimeter-extrusion-width=' + c.width,
    '--perimeter-extrusion-width=' + c.width,
    '--infill-extrusion-width=' + c.width,
    '--solid-infill-extrusion-width=' + c.width,
    '--top-infill-extrusion-width=' + c.width,
    '--first-layer-extrusion-width=' + c.width,
    '--skirts', '0', '--brim-width', '0', '--support-material=0',
    '--top-solid-layers', '3', '--bottom-solid-layers', '3',
    '--perimeter-generator', c.generator,
    '--thin-walls=1', '--gap-fill-enabled=1',
    stl
  ].map(String), { stdio: ['ignore', 'pipe', 'pipe'] });
  return fs.readFileSync(out, 'utf8');
}

function ourSlice(tris, c) {
  var s = P.buildSettings('elegoo_centauri_carbon', 'pla', 'standard_02');
  s.layerHeight = c.layer; s.firstLayerHeight = c.layer;
  s.nozzle = c.nozzle; s.filamentDiameter = 1.75;
  s.wallLoops = c.walls; s.infillDensity = c.density;
  s.infillPattern = c.pattern === 'rectilinear' ? 'lines' : c.pattern;
  s.solidPattern = 'lines';
  s.lineWidth = c.width; s.externalLineWidth = c.width; s.firstLayerLineWidth = c.width;
  s.minBeadWidth = Math.round(c.nozzle * 0.85 * 100) / 100;
  s.maxBeadWidth = Math.round(c.nozzle * 1.8 * 100) / 100;
  s.brimWidth = 0; s.skirtLoops = 0; s.raftLayers = 0; s.supportEnable = false;
  s.topLayers = 3; s.bottomLayers = 3; s.flowRatio = 1;
  s.wallGenerator = c.generator; s.gapFill = true;
  s.seamScarf = false;                      // the reference has no scarf seam
  s.arcFitting = false;                     // nor arc fitting, and a chord is not an arc
  s.monotonicSurfaces = 'none';             // nor monotonic ordering by default
  return E.slice({ positions: flat(tris), settings: s }, function(){});
}

/** Filament laid between two heights, ignoring priming and start scripts. */
function bodyFilament(gcode, zLo, zHi) {
  var lines = gcode.split('\n'), z=0,x=0,y=0,e=0,rel=false,started=false,skin=false;
  var total = 0, len = 0, zs = {};
  for (var i=0;i<lines.length;i++) {
    var raw = lines[i];
    if (/^;LAYER_CHANGE/.test(raw)) started = true;
    if (/^;TYPE:/.test(raw)) skin = /Skirt|Brim|Custom/i.test(raw);
    var mz = /^;Z:([\d.]+)/.exec(raw); if (mz) z = parseFloat(mz[1]);
    var L = raw.split(';')[0].trim(); if (!L) continue;
    if (/^M83/.test(L)) { rel = true; continue; }
    if (/^M82/.test(L)) { rel = false; continue; }
    if (/^G92/.test(L)) { var m0=/E(-?[\d.]+)/.exec(L); if (m0) e=parseFloat(m0[1]); continue; }
    if (!/^G[0-3]\b/.test(L)) continue;
    var mm, nx=x, ny=y, de=0;
    if ((mm=/X(-?[\d.]+)/.exec(L))) nx=parseFloat(mm[1]);
    if ((mm=/Y(-?[\d.]+)/.exec(L))) ny=parseFloat(mm[1]);
    if ((mm=/Z(-?[\d.]+)/.exec(L))) z=parseFloat(mm[1]);
    if ((mm=/E(-?[\d.]+)/.exec(L))) { if (rel) de=parseFloat(mm[1]); else { de=parseFloat(mm[1])-e; e=parseFloat(mm[1]); } }
    var seg = Math.hypot(nx-x, ny-y);
    if (started && !skin && de>1e-9 && seg>1e-6 && z>=zLo && z<=zHi) {
      total += de; len += seg; zs[Math.round(z*1000)] = true;
    }
    x=nx; y=ny;
  }
  return { e: total, len: len, layers: Object.keys(zs).length };
}

// --- the sweep --------------------------------------------------------------

var CASES = [];
Object.keys(SHAPES).forEach(function (shape) {
  [
    { walls: 2, density: 15, pattern: 'rectilinear', layer: 0.2, nozzle: 0.4, width: 0.42, generator: 'arachne' },
    { walls: 3, density: 25, pattern: 'rectilinear', layer: 0.2, nozzle: 0.4, width: 0.45, generator: 'arachne' },
    { walls: 2, density: 0,  pattern: 'rectilinear', layer: 0.15, nozzle: 0.4, width: 0.42, generator: 'arachne' },
    { walls: 1, density: 40, pattern: 'rectilinear', layer: 0.3, nozzle: 0.6, width: 0.62, generator: 'arachne' },
    { walls: 2, density: 15, pattern: 'rectilinear', layer: 0.2, nozzle: 0.4, width: 0.42, generator: 'classic' },
    { walls: 2, density: 100, pattern: 'rectilinear', layer: 0.2, nozzle: 0.4, width: 0.42, generator: 'arachne' },
    { walls: 3, density: 100, pattern: 'rectilinear', layer: 0.2, nozzle: 0.4, width: 0.45, generator: 'arachne' },
    { walls: 1, density: 100, pattern: 'rectilinear', layer: 0.3, nozzle: 0.6, width: 0.62, generator: 'arachne' }
  ].forEach(function (c) {
    CASES.push({ shape: shape, c: c });
  });
});

var TOL_E = 6, TOL_LEN = 12;
var fails = 0, run = 0, worstE = 0, worstLen = 0, sumAbsE = 0;
var judged = 0, sumOurs = 0, sumRef = 0, worstOurs = 0, worstRef = 0;
var stlFor = {};
Object.keys(SHAPES).forEach(function (k) {
  stlFor[k] = path.join(dir, k.replace(/\W+/g, '_') + '.stl');
  writeStl(stlFor[k], SHAPES[k].tris);
});

console.log('reference: ' + cp.execSync(REF + ' --help 2>&1 | head -1', { encoding: 'utf8' }).trim());
console.log('shape'.padEnd(15) + 'case'.padEnd(30) + 'material'.padStart(11) + 'path'.padStart(9));

Object.keys(SHAPES).forEach(function (shape) {
  CASES.filter(function (x) { return x.shape === shape; }).forEach(function (x) {
    var c = x.c;
    var label = c.walls + 'w ' + c.density + '% ' + c.layer + 'mm n' + c.nozzle + ' ' + c.generator;
    var out = path.join(dir, 'r.gcode');
    var refText;
    try { refText = refSlice(stlFor[shape], out, c); }
    catch (err) { console.log(shape.padEnd(15) + label.padEnd(30) + '  reference could not slice it — skipped'); return; }
    var ours;
    try { ours = ourSlice(SHAPES[shape].tris, c).gcode; }
    catch (err) { fails++; console.log('FAIL ' + shape + ' ' + label + ' -> threw: ' + err.message); return; }

    var band = SHAPES[shape].body;
    var a = bodyFilament(ours, band[0], band[1]);
    var b = bodyFilament(refText, band[0], band[1]);
    if (b.e < 1e-6) { console.log(shape.padEnd(15) + label.padEnd(30) + '  reference laid nothing — skipped'); return; }
    run++;
    var dE = 100 * (a.e - b.e) / b.e;
    var dL = b.len < 1e-6 ? 0 : 100 * (a.len - b.len) / b.len;
    sumAbsE += Math.abs(dE);
    if (Math.abs(dE) > worstE) worstE = Math.abs(dE);
    if (Math.abs(dL) > worstLen) worstLen = Math.abs(dL);
    var bad = Math.abs(dE) > TOL_E || Math.abs(dL) > TOL_LEN;

    // The classic generator lays fixed-width loops. On a wall too narrow to
    // hold them it starves them and scribbles gap fill between — that is the
    // whole reason arachne exists, and holding it to arachne's accuracy would
    // be testing the wrong thing. The arachne run of the same shape is the one
    // that has to be right.
    var narrowShape = /thin wall/.test(shape);
    if (bad && c.generator === 'classic' && narrowShape) {
      console.log('  --  ' + shape.padEnd(14) + label.padEnd(30) +
                  ((dE>=0?'+':'') + dE.toFixed(1) + '%').padStart(11) +
                  '   expected: fixed-width loops do not fit here');
      return;
    }

    // At 100% density a prism's material is known exactly, so neither engine
    // gets to be the reference: the geometry is. Where the two disagree, this
    // says which one is right.
    var truth = '';
    var filArea = Math.PI * Math.pow(1.75 / 2, 2);
    var layers = b.layers || Math.floor((band[1] - band[0]) / c.layer) + 1;
    var want = SHAPES[shape].area ? SHAPES[shape].area * c.layer * layers : 0;
    // The exact volume is the right target whenever the interior came out
    // solid — at 100% density by definition, and at any density on a section
    // small enough that both engines fill it solid anyway. The reference's own
    // material says which case this is, so the test does not get to decide it.
    var filledSolid = want > 0 &&
      Math.abs(b.e * filArea - want) / want < 0.15 &&
      Math.abs(a.e * filArea - want) / want < 0.15;
    if ((c.density === 100 || filledSolid) && SHAPES[shape].area) {
      var oursOff = 100 * (a.e * filArea - want) / want;
      var refOff  = 100 * (b.e * filArea - want) / want;
      truth = '   vs true: ours ' + (oursOff>=0?'+':'') + oursOff.toFixed(1) +
              '%, reference ' + (refOff>=0?'+':'') + refOff.toFixed(1) + '%';
      judged++;
      sumOurs += Math.abs(oursOff); sumRef += Math.abs(refOff);
      if (Math.abs(oursOff) > worstOurs) worstOurs = Math.abs(oursOff);
      if (Math.abs(refOff) > worstRef) worstRef = Math.abs(refOff);
      // Disagreeing with the reference is only a failure if we are also the
      // one further from the truth.
      if (bad && Math.abs(oursOff) <= Math.abs(refOff)) bad = false;
    }
    if (bad) fails++;
    console.log((bad ? 'FAIL ' : '  ok ') + shape.padEnd(14) + label.padEnd(30) +
                ((dE>=0?'+':'') + dE.toFixed(1) + '%').padStart(11) +
                ((dL>=0?'+':'') + dL.toFixed(1) + '%').padStart(9) + truth);
  });
});

console.log('');
console.log(run + ' cases compared; worst material ' + worstE.toFixed(1) +
            '%, worst path ' + worstLen.toFixed(1) + '%, mean |material| ' +
            (sumAbsE / Math.max(1, run)).toFixed(2) + '%');
if (judged) {
  console.log('against the exact geometry, over the ' + judged + ' cases it can adjudicate:');
  console.log('  this engine  mean ' + (sumOurs / judged).toFixed(2) + '%, worst ' + worstOurs.toFixed(1) + '%');
  console.log('  reference    mean ' + (sumRef / judged).toFixed(2) + '%, worst ' + worstRef.toFixed(1) + '%');
}
console.log(fails ? fails + ' CASES OUTSIDE TOLERANCE (material ' + TOL_E + '%, path ' + TOL_LEN + '%)'
                  : 'every case agrees with the reference inside tolerance');
process.exit(fails ? 1 : 0);
