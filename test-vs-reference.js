/**
 * Web Slicer — measured against the reference implementation.
 *
 * "As good as Orca" is not a thing you can assert; it is a thing you measure.
 * Orca's perimeter generator, Arachne included, is PrusaSlicer's — both trace
 * back to the same code — so PrusaSlicer's CLI is a fair reference to hold this
 * engine against on the numbers that decide whether a print comes out.
 *
 * Requires prusa-slicer on PATH. Skips cleanly (exit 0) when it is missing, so
 * this is a check you can run, not a build dependency.
 *
 *   node test-vs-reference.js
 */
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');

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
if (!REF) {
  console.log('prusa-slicer is not installed — nothing to compare against, skipping.');
  process.exit(0);
}
var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slicer-ref-'));

// --- shapes, written twice: as an STL for the reference, as triangles for us --

function boxTris(w, d, h, cx, cy) {
  var x0=cx-w/2, x1=cx+w/2, y0=cy-d/2, y1=cy+d/2, t=[];
  function q(a,b,c,e){ t.push(a,b,c,a,c,e); }
  var A=[x0,y0,0],B=[x1,y0,0],C=[x1,y1,0],D=[x0,y1,0];
  var E2=[x0,y0,h],F=[x1,y0,h],G=[x1,y1,h],H=[x0,y1,h];
  q(A,D,C,B); q(E2,F,G,H); q(A,B,F,E2); q(B,C,G,F); q(C,D,H,G); q(D,A,E2,H);
  return t;
}
function wedgeTris(len, t0, t1, h, cx, cy) {
  var t=[], x0=cx-len/2, x1=cx+len/2;
  function q(a,b,c,e){ t.push(a,b,c,a,c,e); }
  var A=[x0,cy-t0/2,0],B=[x1,cy-t1/2,0],C=[x1,cy+t1/2,0],D=[x0,cy+t0/2,0];
  var A2=[x0,cy-t0/2,h],B2=[x1,cy-t1/2,h],C2=[x1,cy+t1/2,h],D2=[x0,cy+t0/2,h];
  q(A,D,C,B); q(A2,B2,C2,D2); q(A,B,B2,A2); q(B,C,C2,B2); q(C,D,D2,C2); q(D,A,A2,D2);
  return t;
}
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

// --- the same settings on both sides ---

var COMMON = {
  layerHeight: 0.2, firstLayerHeight: 0.25, nozzle: 0.4,
  perimeters: 2, fill: 15, extW: 0.42, innerW: 0.42
};

function refSlice(stl, out, extra) {
  // Widths only stick when given with '='; as separate words they are ignored
  // and the reference quietly falls back to its own defaults.
  var args = [
    '--export-gcode', '--output', out,
    '--layer-height', COMMON.layerHeight, '--first-layer-height', COMMON.firstLayerHeight,
    '--nozzle-diameter', COMMON.nozzle, '--filament-diameter', '1.75',
    '--perimeters', COMMON.perimeters, '--fill-density', COMMON.fill + '%',
    '--extrusion-width=' + COMMON.innerW,
    '--external-perimeter-extrusion-width=' + COMMON.extW,
    '--perimeter-extrusion-width=' + COMMON.innerW,
    '--infill-extrusion-width=' + COMMON.innerW,
    '--solid-infill-extrusion-width=' + COMMON.innerW,
    '--top-infill-extrusion-width=' + COMMON.innerW,
    '--first-layer-extrusion-width=' + COMMON.innerW,
    '--skirts', '0', '--brim-width', '0', '--support-material=0',
    '--fill-pattern', 'rectilinear',
    '--top-solid-layers', '3', '--bottom-solid-layers', '3'
  ].concat(extra || []).concat([stl]);
  cp.execFileSync(REF, args.map(String), { stdio: ['ignore', 'pipe', 'pipe'] });
  return fs.readFileSync(out, 'utf8');
}

function ourSlice(tris, over) {
  var s = P.buildSettings('elegoo_centauri_carbon', 'pla', 'standard_02');
  s.layerHeight = COMMON.layerHeight; s.firstLayerHeight = COMMON.firstLayerHeight;
  s.nozzle = COMMON.nozzle; s.filamentDiameter = 1.75;
  s.wallLoops = COMMON.perimeters; s.infillDensity = COMMON.fill;
  s.lineWidth = COMMON.innerW; s.externalLineWidth = COMMON.extW;
  s.firstLayerLineWidth = COMMON.innerW;
  s.brimWidth = 0; s.skirtLoops = 0; s.raftLayers = 0; s.supportEnable = false;
  s.topLayers = 3; s.bottomLayers = 3; s.flowRatio = 1;
  for (var k in over) s[k] = over[k];
  return { gcode: E.slice({ positions: flat(tris), settings: s }, function(){}).gcode, s: s };
}

// --- measurement, identical on both files ---

/** Total filament, and per-layer extrusion geometry, from any G-code. */
function measure(gcode) {
  var lines = gcode.split('\n'), z=0,x=0,y=0,e=0, rel=false, started=false;
  var filament = 0, byLayer = {}, skin = false;
  for (var i=0;i<lines.length;i++) {
    var raw = lines[i];
    // Both files mark their layers the same way, and everything before the
    // first one is priming and start script — not part of what is being compared.
    if (/^;LAYER_CHANGE/.test(raw)) started = true;
    if (/^;TYPE:/.test(raw)) skin = /Skirt|Brim|Custom/i.test(raw);
    var mz = /^;Z:([\d.]+)/.exec(raw); if (mz) z = parseFloat(mz[1]);
    var L = raw.split(';')[0].trim(); if (!L) continue;
    if (/^M83/.test(L)) { rel = true; continue; }
    if (/^M82/.test(L)) { rel = false; continue; }
    if (/^G92/.test(L)) { var m0=/E(-?[\d.]+)/.exec(L); if (m0) e = parseFloat(m0[1]); continue; }
    if (!/^G[0-3]\b/.test(L)) continue;
    var mm, nx=x, ny=y, nz=z, de=0;
    if ((mm=/X(-?[\d.]+)/.exec(L))) nx=parseFloat(mm[1]);
    if ((mm=/Y(-?[\d.]+)/.exec(L))) ny=parseFloat(mm[1]);
    if ((mm=/Z(-?[\d.]+)/.exec(L))) { nz=parseFloat(mm[1]); z = nz; }
    if ((mm=/E(-?[\d.]+)/.exec(L))) { if (rel) de = parseFloat(mm[1]); else { de = parseFloat(mm[1]) - e; e = parseFloat(mm[1]); } }
    var seg = Math.hypot(nx-x, ny-y);
    if (de > 1e-9 && seg > 1e-6 && started) {
      filament += de;
      if (skin) { x=nx; y=ny; continue; }        // skirt and brim are not the part
      var key = Math.round(z * 100);
      var slot = byLayer[key] || (byLayer[key] = { z: z, e: 0, len: 0, passes: 0, lastEnd: null });
      slot.e += de; slot.len += seg;
      if (!slot.lastEnd || Math.hypot(slot.lastEnd[0]-x, slot.lastEnd[1]-y) > 1e-6) slot.passes++;
      slot.lastEnd = [nx, ny];
    }
    x=nx; y=ny;
  }
  return { filament: filament, byLayer: byLayer };
}
/** Filament laid across a height band, which is what actually compares. */
function bodyFilament(m, zLo, zHi) {
  var total = 0;
  Object.keys(m.byLayer).forEach(function (k) {
    var slot = m.byLayer[k];
    if (slot.z >= zLo && slot.z <= zHi) total += slot.e;
  });
  return total;
}

function layerNear(m, z, tol) {
  var best = null, bestD = Infinity;
  Object.keys(m.byLayer).forEach(function (k) {
    var slot = m.byLayer[k];
    var d = Math.abs(slot.z - z);
    if (d < bestD && d <= (tol || 0.15)) { bestD = d; best = slot; }
  });
  return best;
}

var fails = 0, notes = [];
function within(name, mine, theirs, tolPct, unit) {
  var diff = theirs === 0 ? (mine === 0 ? 0 : 100) : 100 * (mine - theirs) / theirs;
  var ok = Math.abs(diff) <= tolPct;
  if (!ok) fails++;
  console.log((ok ? '  ok  ' : 'FAIL  ') + name + ': ours ' + mine.toFixed(3) + (unit||'') +
              ', reference ' + theirs.toFixed(3) + (unit||'') +
              ' (' + (diff >= 0 ? '+' : '') + diff.toFixed(1) + '%, tolerance ' + tolPct + '%)');
}

console.log('reference: ' + cp.execSync(REF + ' --help 2>&1 | head -1', { encoding: 'utf8' }).trim());
console.log('');

// === 1. a 20 mm cube: the plain case, where nothing clever should happen ===
var cube = boxTris(20, 20, 10, 0, 0);
writeStl(path.join(dir, 'cube.stl'), cube);
var refCube = measure(refSlice(path.join(dir, 'cube.stl'), path.join(dir, 'cube_ref.gcode')));
var ourCube = measure(ourSlice(cube, { infillPattern: 'lines' }).gcode);
console.log('20 mm cube, 2 walls, 15% infill');
within('material in the body (Z 1–9)', bodyFilament(ourCube,1,9), bodyFilament(refCube,1,9), 2, ' mm');
var rc = layerNear(refCube, 5), oc = layerNear(ourCube, 5);
within('mid-layer material', oc.e, rc.e, 3, ' mm');
within('mid-layer path length', oc.len, rc.len, 5, ' mm');
console.log('  passes on that layer: ours ' + oc.passes + ', reference ' + rc.passes);
if (oc.passes > rc.passes * 2 + 1) {
  fails++;
  console.log('FAIL  we break the layer into far more passes than the reference');
} else {
  console.log('  ok  the layer is walked in about as few passes as the reference');
}
console.log('');

// === 2. a 1.2 mm rib: the case Arachne exists for ===
// Two walls do not fit; a fixed-width generator starves them and scribbles gap
// fill between. This is the measurement that says whether the redistribution is
// doing the same job as the reference's.
var rib = boxTris(1.2, 30, 3, 0, 0);
writeStl(path.join(dir, 'rib.stl'), rib);
var refRib = measure(refSlice(path.join(dir, 'rib.stl'), path.join(dir, 'rib_ref.gcode'),
                              ['--perimeter-generator', 'arachne']));
var ourRib = measure(ourSlice(rib, { wallGenerator: 'arachne', infillPattern: 'lines' }).gcode);
console.log('1.2 mm rib, arachne on both sides');
within('material in the body (Z 1–2.8)', bodyFilament(ourRib,1,2.8), bodyFilament(refRib,1,2.8), 8, ' mm');
var rr = layerNear(refRib, 1.45), orr = layerNear(ourRib, 1.45);
if (rr && orr) {
  within('mid-layer material', orr.e, rr.e, 8, ' mm');
  console.log('  passes on that layer: ours ' + orr.passes + ', reference ' + rr.passes);
  if (orr.passes > rr.passes * 2) {
    fails++;
    console.log('FAIL  we take more than twice the reference\'s passes on a thin rib');
  } else {
    console.log('  ok  pass count is in the same league as the reference');
  }
}
console.log('');

// === 3. a tapering wedge: variable width along a single wall ===
var wedge = wedgeTris(24, 3.0, 0.6, 3, 0, 0);
writeStl(path.join(dir, 'wedge.stl'), wedge);
var refWedge = measure(refSlice(path.join(dir, 'wedge.stl'), path.join(dir, 'wedge_ref.gcode'),
                                ['--perimeter-generator', 'arachne', '--fill-density', '100%',
                                 '--fill-pattern', 'rectilinear']));
var ourWedge = measure(ourSlice(wedge, { wallGenerator: 'arachne', infillDensity: 100,
                                         infillPattern: 'lines' }).gcode);
console.log('3.0 → 0.6 mm wedge, arachne, solid');
within('material in the body (Z 1–2.8)', bodyFilament(ourWedge,1,2.8), bodyFilament(refWedge,1,2.8), 10, ' mm');
var rw = layerNear(refWedge, 1.45), ow = layerNear(ourWedge, 1.45);
if (rw && ow) within('mid-layer material', ow.e, rw.e, 10, ' mm');
console.log('');

// === 4. the classic generator, where the two should agree closely ===
var refClassic = measure(refSlice(path.join(dir, 'cube.stl'), path.join(dir, 'cube_cl.gcode'),
                                  ['--perimeter-generator', 'classic']));
var ourClassic = measure(ourSlice(cube, { wallGenerator: 'classic', infillPattern: 'lines' }).gcode);
console.log('20 mm cube, classic perimeters on both sides');
within('material in the body (Z 1–9)', bodyFilament(ourClassic,1,9), bodyFilament(refClassic,1,9), 2, ' mm');
console.log('');

console.log(fails ? fails + ' MEASUREMENTS OUTSIDE TOLERANCE' :
            'every measurement agrees with the reference inside tolerance');
process.exit(fails ? 1 : 0);
