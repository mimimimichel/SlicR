/**
 * Web Slicer — printing one object at a time.
 *
 *   node test-sequential.js
 */
globalThis.ClipperLib = require('./js/vendor/clipper.js');
globalThis.OrcaPresets = require('./js/slicer/presets.js');
require('./js/slicer/engine.js');
require('./js/slicer/beading.js');
require('./js/slicer/lightning.js');
require('./js/slicer/template.js');
require('./js/slicer/gcodecheck.js');
var E = globalThis.OrcaEngine, P = globalThis.OrcaPresets, C = globalThis.OrcaGcodeCheck;

function box(w, d, h, cx, cy) {
  var x0=cx-w/2, x1=cx+w/2, y0=cy-d/2, y1=cy+d/2, t=[];
  function q(a,b,c,e){ t.push(a[0],a[1],a[2],b[0],b[1],b[2],c[0],c[1],c[2],
                               a[0],a[1],a[2],c[0],c[1],c[2],e[0],e[1],e[2]); }
  var A=[x0,y0,0],B=[x1,y0,0],C2=[x1,y1,0],D=[x0,y1,0];
  var E2=[x0,y0,h],F=[x1,y0,h],G2=[x1,y1,h],H=[x0,y1,h];
  q(A,D,C2,B); q(E2,F,G2,H); q(A,B,F,E2); q(B,C2,G2,F); q(C2,D,H,G2); q(D,A,E2,H);
  return new Float32Array(t);
}
function merge(list) {
  var n = 0, i;
  for (i=0;i<list.length;i++) n += list[i].length;
  var out = new Float32Array(n), at = 0;
  for (i=0;i<list.length;i++) { out.set(list[i], at); at += list[i].length; }
  return out;
}
function settings(over) {
  var s = P.buildSettings('elegoo_centauri_carbon', 'pla', 'standard_02');
  s.brimWidth = 0; s.skirtLoops = 0; s.raftLayers = 0; s.supportEnable = false;
  for (var k in over) s[k] = over[k];
  return s;
}
var fails = 0;
function chk(name, ok, detail) {
  if (!ok) fails++;
  console.log((ok ? '  ok  ' : 'FAIL  ') + name + (detail ? ': ' + detail : ''));
}

// --- 1. two short cubes, well apart ---
var a = box(10,10,8, 100,100), b = box(10,10,8, 160,160);
var s = settings({ printSequence: 'object' });
var r = E.slice({
  positions: merge([a,b]),
  objects: [{ name: 'left', positions: a }, { name: 'right', positions: b }],
  settings: s
}, function(){});

var markers = r.gcode.split('\n').filter(function (l) { return /^;OBJECT:/.test(l); });
chk('each object gets its own marker', markers.length === 2, markers.join(' / '));
chk('printed front to back', /;OBJECT:left/.test(markers[0]), markers[0]);

// Z must climb, come back to the bed, and climb again.
var zs = [];
r.gcode.split('\n').forEach(function (l) { var m=/^;Z:([\d.]+)/.exec(l); if (m) zs.push(parseFloat(m[1])); });
var drops = 0, maxBefore = 0, i;
for (i=1;i<zs.length;i++) if (zs[i] < zs[i-1]) { drops++; maxBefore = zs[i-1]; }
chk('Z returns to the bed exactly once', drops === 1, drops + ' drops, from Z' + maxBefore);
chk('the first object was finished before the second started', maxBefore > 7.5,
    'reached Z' + maxBefore + ' before starting the next');

// The head must climb clear of the finished object before crossing the plate.
var lines = r.gcode.split('\n');
var atSecond = lines.findIndex(function (l) { return /^;OBJECT:right/.test(l); });
var lifted = false;
for (i = Math.max(0, atSecond - 12); i < atSecond; i++) {
  var m = /^G1 Z([\d.]+)/.exec(lines[i]);
  if (m && parseFloat(m[1]) > maxBefore + 5) lifted = true;
}
chk('it lifts clear before travelling to the next object', lifted);

// The second object's first layer must still be treated as a first layer: state
// is tracked from the top of the file so E and position are the real ones.
function layerWidthAt(gcode, s, startLine) {
  var L = gcode.split('\n'), x=0,y=0,e=0,h=s.layerHeight, on=false, area=0, len=0, seen=0;
  for (var i=0;i<L.length;i++) {
    if (i >= startLine && /^;LAYER_CHANGE/.test(L[i])) { if (seen++) break; on = true; }
    var mh = /^;HEIGHT:([\d.]+)/.exec(L[i]); if (mh && on) h = parseFloat(mh[1]);
    var T = L[i].split(';')[0].trim(); if (!T) continue;
    var mm, nx=x, ny=y, de=0;
    if (/^G92/.test(T)) { if ((mm=/E(-?[\d.]+)/.exec(T))) e=parseFloat(mm[1]); continue; }
    if (!/^G[0-3]\b/.test(T)) continue;
    if ((mm=/X(-?[\d.]+)/.exec(T))) nx=parseFloat(mm[1]);
    if ((mm=/Y(-?[\d.]+)/.exec(T))) ny=parseFloat(mm[1]);
    if ((mm=/E(-?[\d.]+)/.exec(T))) { de=parseFloat(mm[1])-e; e=parseFloat(mm[1]); }
    var seg=Math.hypot(nx-x,ny-y);
    if (on && de>1e-9 && seg>1e-6) { area += de*Math.PI*Math.pow(s.filamentDiameter/2,2)/s.flowRatio; len += seg; }
    x=nx;y=ny;
  }
  var cs = area/len;
  return { w: (cs - Math.PI*h*h/4)/h + h, h: h };
}
var w2 = layerWidthAt(r.gcode, s, atSecond);
chk('the second object gets first-layer beads too',
    Math.abs(w2.w - s.firstLayerLineWidth) < 0.06,
    w2.w.toFixed(3) + ' mm at h' + w2.h + ' vs ' + s.firstLayerLineWidth + ' expected');

var bad = r.report.findings.filter(function (f) { return f.severity !== 'info'; });
chk('verifier clean on a plate with room', bad.length === 0, bad.length ? JSON.stringify(bad[0]) : '');

// --- 2. two tall towers crowded together: refuse to pretend it will work ---
var t1 = box(10,10,40, 120,120), t2 = box(10,10,40, 135,120);
var sT = settings({ printSequence: 'object' });
var crowded = E.slice({
  positions: merge([t1,t2]),
  objects: [{ name: 'tower A', positions: t1 }, { name: 'tower B', positions: t2 }],
  settings: sT
}, function(){});
var clearance = crowded.report.findings.filter(function (f) { return f.code === 'sequence.clearance'; });
chk('crowded towers are reported as an error', clearance.length === 1 &&
    clearance[0].severity === 'error', clearance.length ? clearance[0].message : 'no finding');

// --- 2b. hulls, not boxes: two L-shapes nested corner to corner ---
// Their bounding boxes overlap completely; the parts are 50 mm apart.
function ell(cx, cy, h, flip) {
  var arm = 60, w = 8, f = flip ? -1 : 1;
  return merge([
    box(arm, w, h, cx + f*arm/2, cy),
    box(w, arm, h, cx + f*w/2, cy + f*arm/2)
  ]);
}
var e1 = ell(60, 60, 40, false), e2 = ell(200, 200, 40, true);
var lshape = E.slice({
  positions: merge([e1, e2]),
  objects: [{ name: 'L', positions: e1 }, { name: 'mirror L', positions: e2 }],
  settings: settings({ printSequence: 'object', kinematics: 'corexy' })
}, function(){});
chk('nested L-shapes are judged by their hulls, not their boxes',
    lshape.report.findings.filter(function (f) { return f.code === 'sequence.clearance'; }).length === 0,
    JSON.stringify(lshape.report.findings.filter(function (f) { return /^sequence/.test(f.code); })
      .map(function (f) { return f.code; })));

// --- 2c. a bed-slinger sweeps the whole X beam ---
// Two tall towers 90 mm apart in X but on the same Y line: fine on a corexy,
// a crash on a machine that throws the bed back and forth under a fixed beam.
var s1 = box(10,10,40, 80,120), s2 = box(10,10,40, 170,120);
function sequenced(kin) {
  return E.slice({
    positions: merge([s1,s2]),
    objects: [{ name: 'left tower', positions: s1 }, { name: 'right tower', positions: s2 }],
    settings: settings({ printSequence: 'object', kinematics: kin })
  }, function(){}).report.findings.filter(function (f) { return /^sequence/.test(f.code); });
}
var onCore = sequenced('corexy'), onSling = sequenced('bedslinger');
chk('side by side is fine when the head moves over the plate', onCore.length === 0,
    onCore.map(function (f) { return f.code; }).join(','));
chk('the same plate is refused on a bed-slinger',
    onSling.some(function (f) { return f.code === 'sequence.gantry' && f.severity === 'error'; }),
    onSling.length ? onSling[0].message : 'nothing reported');

// --- 3. the verifier catches a head driving through a finished object ---
function plate(tail) {
  return ['M82', 'G92 E0', 'G1 Z0.2 F600',
    ';OBJECT:first', ';LAYER:0', ';Z:0.2',
    'G1 X100 Y100 E1 F1200', 'G1 X110 Y100 E2', 'G1 X110 Y110 E3', 'G1 X100 Y110 E4',
    ';LAYER:1', ';Z:20', 'G1 Z20 F600',
    'G1 X100 Y100 E5 F1200', 'G1 X110 Y100 E6', 'G1 X110 Y110 E7', 'G1 X100 Y110 E8',
    ';OBJECT:second', ';LAYER:2', ';Z:0.2'].concat(tail).join('\n');
}
function collisions(text) {
  return C.verify(text, settings({})).findings.filter(function (f) {
    return f.code === 'sequence.collision';
  });
}

// Straight across the finished tower at printing height.
var through = collisions(plate([
  'G1 Z0.2 F600', 'G0 X160 Y160 F9000', 'G1 X170 Y160 E9 F1200']));
chk('a move through a finished object is an error',
    through.length >= 1 && through[0].severity === 'error',
    through.length ? through[0].message : 'not caught');

// Dropping to the next layer height while still parked over the finished tower.
var descend = collisions(plate([
  'G1 Z0.2 F600', 'G0 X160 Y160 F9000']));
chk('descending onto a finished object is an error', descend.length >= 1,
    descend.length ? 'line ' + descend[0].line : 'not caught');

// Lift, cross, then come down over the new spot: the safe order, and clean.
var overhead = collisions(plate([
  'G1 Z25 F600', 'G0 X160 Y160 F9000', 'G1 Z0.2 F600', 'G1 X170 Y160 E9 F1200']));
chk('lifting clear first is not flagged', overhead.length === 0,
    overhead.length ? overhead[0].message : '');

// And what the writer actually produces has to pass the same rule.
chk('the real sequential file passes the collision rule',
    collisions(r.gcode).length === 0);

// --- 4. layer-by-layer is untouched ---
var byLayer = E.slice({
  positions: merge([a,b]),
  objects: [{ name: 'left', positions: a }, { name: 'right', positions: b }],
  settings: settings({ printSequence: 'layer' })
}, function(){});
chk('layer-by-layer emits no object markers',
    !/^;OBJECT:/m.test(byLayer.gcode));
chk('layer-by-layer verifier clean',
    byLayer.report.findings.filter(function (f) { return f.severity !== 'info'; }).length === 0);

console.log(fails ? '\n' + fails + ' FAILURES' : '\nall sequential checks pass');
process.exit(fails ? 1 : 0);
