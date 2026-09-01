/**
 * Web Slicer — what a bridge is made of.
 *
 * A bead laid on the layer below is squashed against it: it comes out as wide
 * as it was asked for and as tall as the layer, a rounded rectangle. A bead
 * laid across a gap is squashed against nothing. It hangs as a round strand of
 * its own width, and a round strand of 0.4 mm holds nearly twice what a
 * 0.4 × 0.2 mm one does. Extruding the flat figure over a gap is how a bridge
 * comes out as a row of strings: there was never enough plastic in it.
 *
 * Held against PrusaSlicer when it is installed, and against the arithmetic
 * either way.
 *
 *   node test-bridges.js
 */
var cp = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

globalThis.ClipperLib = require('./js/vendor/clipper.js');
globalThis.OrcaPresets = require('./js/slicer/presets.js');
require('./js/slicer/engine.js');
require('./js/slicer/beading.js');
require('./js/slicer/lightning.js');
require('./js/slicer/treesupport.js');
require('./js/slicer/template.js');
require('./js/slicer/gcodecheck.js');
var E = globalThis.OrcaEngine, P = globalThis.OrcaPresets;

var pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); }
}

function q(t,a,b,c,e){ t.push(a,b,c,a,c,e); }
function box(w,d,h,cx,cy,z0) {
  z0 = z0 || 0;
  var x0=cx-w/2, x1=cx+w/2, y0=cy-d/2, y1=cy+d/2, t=[];
  var A=[x0,y0,z0],B=[x1,y0,z0],C=[x1,y1,z0],D=[x0,y1,z0];
  var E2=[x0,y0,z0+h],F=[x1,y0,z0+h],G=[x1,y1,z0+h],H=[x0,y1,z0+h];
  q(t,A,D,C,B); q(t,E2,F,G,H); q(t,A,B,F,E2); q(t,B,C,G,F); q(t,C,D,H,G); q(t,D,A,E2,H);
  return t;
}
function flat(t){ var o=new Float32Array(t.length*3),a=0;
  for(var i=0;i<t.length;i++){o[a++]=t[i][0];o[a++]=t[i][1];o[a++]=t[i][2];} return o; }

// Two pillars with a slab across them: 20 mm of open air to cross.
var TRIS = box(8,20,10,140,150).concat(box(8,20,10,168,150)).concat(box(36,20,2,154,150,10));

/** Filament per millimetre on the lines a file calls a bridge. */
function perMm(gcode, wantInternal) {
  var lines = gcode.split('\n');
  var x=0, y=0, e=0, rel=false, type='', sumE=0, sumD=0;
  for (var i = 0; i < lines.length; i++) {
    var raw = lines[i];
    var t = /^;\s*TYPE:(.*)$/i.exec(raw);
    if (t) type = t[1].trim().toLowerCase();
    var L = raw.split(';')[0].trim();
    if (!L) continue;
    if (/^M83\b/.test(L)) { rel = true; continue; }
    if (/^M82\b/.test(L)) { rel = false; continue; }
    if (/^G92\b/.test(L)) { var g=/E(-?[\d.]+)/.exec(L); if (g) e = parseFloat(g[1]); continue; }
    if (!/^G[01]\b/.test(L)) continue;
    var nx=x, ny=y, de=0;
    var mx=/X(-?[\d.]+)/.exec(L); if (mx) nx = parseFloat(mx[1]);
    var my=/Y(-?[\d.]+)/.exec(L); if (my) ny = parseFloat(my[1]);
    var me=/E(-?[\d.]+)/.exec(L);
    if (me) { var v = parseFloat(me[1]); de = rel ? v : v - e; e = rel ? e + v : v; }
    var d = Math.hypot(nx - x, ny - y);
    var isInternal = /internal/.test(type);
    if (de > 0 && d > 0.5 && /bridge/.test(type) && isInternal === !!wantInternal) {
      sumE += de; sumD += d;
    }
    x = nx; y = ny;
  }
  return sumD > 0 ? { epm: sumE / sumD, mm: sumD } : null;
}
var FIL_AREA = Math.PI * Math.pow(1.75 / 2, 2);

function ourGcode(over) {
  var s = P.buildSettings('artillery_x2', 'pla', 'q020');
  s.skirtLoops = 0; s.brimWidth = 0; s.supportEnable = false;
  s.lineWidth = 0.42; s.externalLineWidth = 0.42;
  for (var k in over) s[k] = over[k];
  return E.slice({ positions: flat(TRIS), settings: s }, function () {});
}

console.log('=== 1. a bridge is a round strand, not a flat one ===');
var sliced = ourGcode({});
var mine = perMm(sliced.gcode, false);
ok('the slab over the gap is printed as a bridge at all', !!mine && mine.mm > 100,
  mine ? mine.mm + ' mm' : 'no bridge feature in the file');
var mm3 = mine.epm * FIL_AREA;
var round = Math.PI / 4 * 0.4 * 0.4;             // a 0.4 mm strand hanging free
var squashed = 0.2 * (0.4 - 0.2) + Math.PI * 0.01; // the same bead pressed flat
console.log('  ' + mm3.toFixed(4) + ' mm³/mm — a round 0.4 strand is ' + round.toFixed(4) +
  ', a flat one ' + squashed.toFixed(4));
ok('and it carries a round strand’s worth of plastic', Math.abs(mm3 - round * 0.95) < 0.006,
  mm3.toFixed(4) + ' vs ' + (round * 0.95).toFixed(4));
ok('which is nearly twice what the flat figure would have given',
  mm3 > squashed * 1.5, mm3.toFixed(4) + ' vs ' + squashed.toFixed(4));

console.log('\n=== 2. the ratio is the vendors’, and it is a setting ===');
ok('bridges are trimmed to 95% by default',
  P.buildSettings('artillery_x2', 'pla', 'q020').bridgeFlow === 0.95);
var lean = perMm(ourGcode({ bridgeFlow: 0.7 }).gcode, false);
ok('and asking for less gives less (' + (lean.epm * FIL_AREA).toFixed(4) + ' mm³/mm)',
  Math.abs(lean.epm * FIL_AREA - round * 0.7) < 0.006,
  (lean.epm * FIL_AREA).toFixed(4) + ' vs ' + (round * 0.7).toFixed(4));

console.log('\n=== 3. only a real bridge, not everything solid ===');
// An internal bridge is laid over sparse infill, which does hold it up. It
// keeps the flat figure and its own flow ratio.
var internal = perMm(sliced.gcode, true);
if (!internal) {
  console.log('  (no internal bridges on this shape)');
} else {
  ok('an internal bridge stays a flat bead (' + (internal.epm * FIL_AREA).toFixed(4) + ' mm³/mm)',
    internal.epm * FIL_AREA < round * 0.8, (internal.epm * FIL_AREA).toFixed(4));
}
var bad = sliced.report.findings.filter(function (f) { return f.severity === 'error'; });
ok('and the file is clean', bad.length === 0, JSON.stringify(bad[0]));

console.log('\n=== 4. against the reference ===');
var REF = (function () {
  try { return cp.execSync('command -v prusa-slicer', { encoding: 'utf8' }).trim(); }
  catch (e) { return null; }
})();
if (!REF) {
  console.log('  prusa-slicer is not installed — the arithmetic above is all there is.');
} else {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-'));
  var stl = path.join(dir, 'b.stl'), out = path.join(dir, 'b.gcode');
  var text = 'solid x\n';
  for (var i = 0; i < TRIS.length; i += 3) {
    text += 'facet normal 0 0 0\nouter loop\n';
    for (var k = 0; k < 3; k++) {
      text += 'vertex ' + TRIS[i + k].map(function (v) { return v.toFixed(5); }).join(' ') + '\n';
    }
    text += 'endloop\nendfacet\n';
  }
  fs.writeFileSync(stl, text + 'endsolid x\n');
  cp.execFileSync(REF, ['--export-gcode', '--output', out,
    '--layer-height', '0.2', '--first-layer-height', '0.25', '--nozzle-diameter', '0.4',
    '--filament-diameter', '1.75', '--perimeters', '2', '--fill-density', '15%',
    '--extrusion-width=0.42', '--skirts', '0', '--brim-width', '0', '--support-material=0',
    stl].map(String), { stdio: ['ignore', 'pipe', 'pipe'] });
  // The reference calls both kinds "bridge infill", so read them together and
  // compare against ours the same way.
  var refAll = perMm(fs.readFileSync(out, 'utf8'), false);
  console.log('  reference: ' + (refAll.epm * FIL_AREA).toFixed(4) + ' mm³/mm');
  ok('we put as much into a bridge as the reference does (within a tenth)',
    Math.abs(mm3 - refAll.epm * FIL_AREA) / (refAll.epm * FIL_AREA) < 0.1,
    mm3.toFixed(4) + ' vs ' + (refAll.epm * FIL_AREA).toFixed(4));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
