globalThis.ClipperLib = require('./js/vendor/clipper.js');
globalThis.OrcaPresets = require('./js/slicer/presets.js');
require('./js/slicer/engine.js');
var B = require('./js/slicer/beading.js');
var G = globalThis.OrcaEngineGeom, S = G.SCALE;
function rect(x0,y0,w,h){ return [[{X:x0*S,Y:y0*S},{X:(x0+w)*S,Y:y0*S},{X:(x0+w)*S,Y:(y0+h)*S},{X:x0*S,Y:(y0+h)*S}]]; }
var fails=0;
function chk(name, got, want, tol){ var ok=Math.abs(got-want)<=tol; if(!ok)fails++;
  console.log((ok?'  ok  ':'FAIL  ')+name+': '+got.toFixed(4)+' (want '+want+' +-'+tol+')'); }

// 1. a 20x20 square: half-thickness at the centre is 10
var sq = rect(0,0,20,20);
var f = B.thicknessField(sq, {resolution:0.08, maxRes:0.25, maxHalfThickness:11});
chk('square centre h', f.sample(10,10), 10, 0.2);
chk('square near edge h', f.sample(0.5,10), 10, 0.3);

// 2. a 1.2 mm rib: half-thickness is 0.6 everywhere along it
var rib = rect(0,0,20,1.2);
f = B.thicknessField(rib, {resolution:0.03, maxRes:0.25, maxHalfThickness:2});
chk('rib mid h', f.sample(10,0.6), 0.6, 0.05);
chk('rib off-axis h', f.sample(10,0.25), 0.6, 0.06);
chk('rib near end h', f.sample(19.4,0.6), 0.6, 0.08);

// 3. a wedge tapering 3.0 -> 0.4 mm over 20 mm: h must track x
var wedge=[[{X:0,Y:0},{X:20*S,Y:0},{X:20*S,Y:0.4*S},{X:0,Y:3.0*S}]];
f = B.thicknessField(wedge, {resolution:0.03, maxRes:0.25, maxHalfThickness:2});
[[2,2.74],[8,1.96],[14,1.18],[18,0.66]].forEach(function(c){
  var x=c[0], t=c[1];
  chk('wedge t@x='+x, f.sample(x, t/2)*2, t, 0.16);
});
console.log(fails? '\n'+fails+' FAILURES' : '\nall field checks pass');

// 4. corners must not read as thin: the outer wall of a 2 mm square must still
//    see enough material for both walls.
var sm = rect(0,0,2,2);
f = B.thicknessField(sm, {resolution:0.02, maxRes:0.25, maxHalfThickness:1.2});
chk('2mm square, wall0 mid-edge', f.sample(0.21,1), 1.0, 0.06);
chk('2mm square, wall1 corner', f.sample(0.645,0.645), 1.0, 0.06);
chk('20mm square, wall0 near corner', B.thicknessField(rect(0,0,20,20),
     {resolution:0.05, maxRes:0.25, maxHalfThickness:1.2}).sample(0.21,0.6), 1.2, 0.05);

// timing on a realistic layer: a 120 mm ring with a slot
var big=[[{X:0,Y:0},{X:120*S,Y:0},{X:120*S,Y:120*S},{X:0,Y:120*S}],
         [{X:20*S,Y:20*S},{X:20*S,Y:100*S},{X:100*S,Y:100*S},{X:100*S,Y:20*S}]];
var t0=Date.now();
for (var r=0;r<5;r++) B.thicknessField(big,{resolution:0.09,maxRes:0.25,maxHalfThickness:2.0});
console.log('  120 mm layer field: '+((Date.now()-t0)/5).toFixed(1)+' ms');
console.log(fails? '\n'+fails+' FAILURES' : '\nall field checks pass');
