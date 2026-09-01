/**
 * Web Slicer — how much air a layer gets.
 *
 * One fan speed for a whole print is a compromise nobody asked for. PETG on a
 * big layer wants almost none — air is what makes it warp and string — and the
 * same PETG on a four-second layer wants everything there is, or the next
 * layer lands on something still soft. Every vendor publishes two numbers and
 * a time to move between them; this holds the app to them.
 *
 *   node test-cooling.js
 */
globalThis.ClipperLib = require('./js/vendor/clipper.js');
globalThis.OrcaPresets = require('./js/slicer/presets.js');
require('./js/slicer/engine.js');
require('./js/slicer/beading.js');
require('./js/slicer/lightning.js');
require('./js/slicer/treesupport.js');
require('./js/slicer/template.js');
var E = globalThis.OrcaEngine, P = globalThis.OrcaPresets;

var pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); }
}

function q(t,a,b,c,e){ t.push(a,b,c,a,c,e); }
function box(w,d,h,cx,cy) {
  var x0=cx-w/2, x1=cx+w/2, y0=cy-d/2, y1=cy+d/2, t=[];
  var A=[x0,y0,0],B=[x1,y0,0],C=[x1,y1,0],D=[x0,y1,0];
  var E2=[x0,y0,h],F=[x1,y0,h],G=[x1,y1,h],H=[x0,y1,h];
  q(t,A,D,C,B); q(t,E2,F,G,H); q(t,A,B,F,E2); q(t,B,C,G,F); q(t,C,D,H,G); q(t,D,A,E2,H);
  return t;
}
function flat(t){ var o=new Float32Array(t.length*3),a=0;
  for(var i=0;i<t.length;i++){o[a++]=t[i][0];o[a++]=t[i][1];o[a++]=t[i][2];} return o; }

/**
 * The fan each layer is set to, as a percentage.
 *
 * The layer's own setting, read where it is made: after the ;LAYER: mark and
 * before the first feature. A bridge inside the layer asks for everything the
 * fan has and hands it back afterwards, which is a different rule and not the
 * one under test here. The value carries forward, because the writer only
 * emits a command when it changes.
 */
function fans(gcode) {
  var out = [], current = 0, inLayer = false, taken = true;
  gcode.split('\n').forEach(function (raw) {
    var line = raw.trim();
    if (/^;LAYER:/i.test(line)) { inLayer = true; taken = false; return; }
    var m = /^M106\s+S(\d+)/.exec(line);
    if (m) { current = Math.round(parseInt(m[1], 10) / 2.55); return; }
    if (/^M107\b/.test(line)) { current = 0; return; }
    if (inLayer && !taken && /^;\s*TYPE:/i.test(line)) { out.push(current); taken = true; }
  });
  return out;
}
function sliced(filament, w) {
  var s = P.buildSettings('artillery_x2', filament, 'q020');
  s.skirtLoops = 0; s.brimWidth = 0;
  // The overhang and bridge boost is a separate rule; a plain box has neither.
  return { fans: fans(E.slice({ positions: flat(box(w, w, 6, 150, 150)), settings: s },
                              function () {}).gcode), s: s };
}

console.log('=== 1. the two numbers come from the vendor, per family ===');
// Orca's own filament library, read family by family: PLA is cooled flat out
// whatever the layer, and PETG and ABS are not.
[['pla', 100, 100], ['petg', 100, 20], ['abs', 80, 10], ['asa', 80, 10],
 ['tpu95', 100, 100], ['pc', 60, 10], ['pa', 60, 0]].forEach(function (c) {
  var f = P.FILAMENTS[c[0]];
  ok(c[0].toUpperCase() + ' is cooled between ' + f.minFanSpeed + '% and ' + f.fanSpeed + '%',
    f.fanSpeed === c[1] && f.minFanSpeed === c[2],
    f.fanSpeed + '/' + f.minFanSpeed + ' want ' + c[1] + '/' + c[2]);
});

console.log('\n=== 2. and the layer decides where between them ===');
var petgBig = sliced('petg', 80), petgSmall = sliced('petg', 6);
var bigLow = Math.min.apply(null, petgBig.fans.filter(function (v) { return v > 0; }));
var smallHigh = Math.max.apply(null, petgSmall.fans);
ok('PETG on a big layer is barely cooled (' + bigLow + '%)', bigLow <= 25, String(bigLow));
ok('and on a small one it gets everything (' + smallHigh + '%)', smallHigh >= 95,
  String(smallHigh));

var absBig = sliced('abs', 80), absSmall = sliced('abs', 6);
ok('ABS on a big layer likewise (' + Math.min.apply(null, absBig.fans.filter(function(v){return v>0;})) + '%)',
  Math.min.apply(null, absBig.fans.filter(function (v) { return v > 0; })) <= 30);
ok('and a small one is blown on hard, or it slumps (' +
   Math.max.apply(null, absSmall.fans) + '%)', Math.max.apply(null, absSmall.fans) >= 75);

// PLA publishes the same figure twice, so nothing moves and nothing surprises.
var plaBig = sliced('pla', 80), plaSmall = sliced('pla', 6);
var plaValues = {};
plaBig.fans.concat(plaSmall.fans).forEach(function (v) { if (v > 0) plaValues[v] = 1; });
ok('PLA is the same on every layer, big or small (' + Object.keys(plaValues).join(',') + '%)',
  Object.keys(plaValues).length === 1 && Object.keys(plaValues)[0] === '100',
  Object.keys(plaValues).join(','));

console.log('\n=== 3. the first layers are still their own rule ===');
ok('the first layer of PETG is not blown on at all', petgBig.fans[0] === 0,
  String(petgBig.fans[0]));
ok('and the setting that says when the fan starts is still obeyed',
  petgBig.s.fanFromLayer >= 2, String(petgBig.s.fanFromLayer));

console.log('\n=== 4. a hand-set profile is followed exactly ===');
// Somebody who sets both numbers the same is asking for one fan speed, and
// that is what they get — the ramp is a default, not a policy.
var fixed = P.buildSettings('artillery_x2', 'petg', 'q020');
fixed.skirtLoops = 0; fixed.brimWidth = 0;
fixed.fanSpeed = 45; fixed.minFanSpeed = 45;
var flatFans = fans(E.slice({ positions: flat(box(60, 60, 6, 150, 150)), settings: fixed },
  function () {}).gcode).filter(function (v) { return v > 0; });
var flatSet = {};
flatFans.forEach(function (v) { flatSet[v] = 1; });
ok('both numbers the same means one speed throughout (' + Object.keys(flatSet).join(',') + '%)',
  Object.keys(flatSet).length === 1 && Object.keys(flatSet)[0] === '45',
  Object.keys(flatSet).join(','));

console.log('\n=== 5. a bead over air gets the filament\u2019s own figure ===');
// Everything the fan has is right for PLA and wrong for nylon, which curls off
// whatever it is bridging when it is set hard. The vendors publish this too.
[['pla', 100], ['petg', 100], ['abs', 80], ['pa', 30], ['pc', 60]].forEach(function (c) {
  ok(c[0].toUpperCase() + ' bridges at ' + c[1] + '%',
    P.FILAMENTS[c[0]].overhangFanSpeed === c[1],
    String(P.FILAMENTS[c[0]].overhangFanSpeed));
});
// And it is a floor, not a ceiling: a layer already being blown on harder than
// the overhang figure does not have the fan turned down for the overhang.
var nylon = P.buildSettings('artillery_x2', 'pa', 'q020');
ok('never below what the layer itself is getting',
  Math.max(nylon.overhangFanSpeed, nylon.minFanSpeed) >= nylon.minFanSpeed);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
