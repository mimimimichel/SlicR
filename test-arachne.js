globalThis.ClipperLib = require('/home/user/ODPS-Studio/js/vendor/clipper.js');
globalThis.OrcaPresets = require('/home/user/ODPS-Studio/js/slicer/presets.js');
require('/home/user/ODPS-Studio/js/slicer/engine.js');
require('/home/user/ODPS-Studio/js/slicer/beading.js');
require('/home/user/ODPS-Studio/js/slicer/lightning.js');
require('/home/user/ODPS-Studio/js/slicer/gcodecheck.js');
var E = globalThis.OrcaEngine, P = globalThis.OrcaPresets;

function box(w, d, h, cx, cy) {
  var x0=cx-w/2, x1=cx+w/2, y0=cy-d/2, y1=cy+d/2, t=[];
  function q(a,b,c,e){ t.push(a[0],a[1],a[2],b[0],b[1],b[2],c[0],c[1],c[2],
                               a[0],a[1],a[2],c[0],c[1],c[2],e[0],e[1],e[2]); }
  var A=[x0,y0,0],B=[x1,y0,0],C=[x1,y1,0],D=[x0,y1,0];
  var E2=[x0,y0,h],F=[x1,y0,h],G2=[x1,y1,h],H=[x0,y1,h];
  q(A,D,C,B); q(E2,F,G2,H); q(A,B,F,E2); q(B,C,G2,F); q(C,D,H,G2); q(D,A,E2,H);
  return new Float32Array(t);
}
// wedge: tapers in Y from t0 at x0 to t1 at x1
function wedge(len, t0, t1, h, cx, cy) {
  var t=[], x0=cx-len/2, x1=cx+len/2;
  function q(a,b,c,e){ t.push(a[0],a[1],a[2],b[0],b[1],b[2],c[0],c[1],c[2],
                              a[0],a[1],a[2],c[0],c[1],c[2],e[0],e[1],e[2]); }
  var A=[x0,cy-t0/2,0],B=[x1,cy-t1/2,0],C=[x1,cy+t1/2,0],D=[x0,cy+t0/2,0];
  var A2=[x0,cy-t0/2,h],B2=[x1,cy-t1/2,h],C2=[x1,cy+t1/2,h],D2=[x0,cy+t0/2,h];
  q(A,D,C,B); q(A2,B2,C2,D2); q(A,B,B2,A2); q(B,C,C2,B2); q(C,D,D2,C2); q(D,A,A2,D2);
  return new Float32Array(t);
}

function settings(over) {
  var s = P.buildSettings('elegoo_centauri_carbon', 'pla', 'standard_02');
  s.supportEnable = false; s.brimWidth = 0; s.skirtLoops = 0; s.raftLayers = 0;
  s.infillDensity = 100; s.infillPattern = 'lines';
  for (var k in over) s[k] = over[k];
  return s;
}
// Measure one layer: the material actually laid, and how many separate
// extrusion passes it took.
function layerScan(gcode, zLo, zHi, s) {
  var lines = gcode.split('\n'), z = 0, x = 0, y = 0, e = 0, rel = false;
  var area = 0, passes = 0, wasExtruding = false;
  var filArea = Math.PI*Math.pow(s.filamentDiameter/2,2), h = s.layerHeight;
  var flow = s.flowRatio;
  for (var i = 0; i < lines.length; i++) {
    var L = lines[i].split(';')[0].trim();
    if (!L) continue;
    if (/^M83/.test(L)) { rel = true; continue; }
    if (/^M82/.test(L)) { rel = false; continue; }
    if (/^G92/.test(L)) { var m0=/E(-?[\d.]+)/.exec(L); if(m0) e=parseFloat(m0[1]); continue; }
    if (!/^G[0-3]\b/.test(L)) continue;
    var nx=x, ny=y, nz=z, ne=e, mm;
    if ((mm=/X(-?[\d.]+)/.exec(L))) nx=parseFloat(mm[1]);
    if ((mm=/Y(-?[\d.]+)/.exec(L))) ny=parseFloat(mm[1]);
    if ((mm=/Z(-?[\d.]+)/.exec(L))) nz=parseFloat(mm[1]);
    var de = 0;
    if ((mm=/E(-?[\d.]+)/.exec(L))) { if (rel) de = parseFloat(mm[1]); else { ne=parseFloat(mm[1]); de = ne-e; } }
    var len = Math.hypot(nx-x, ny-y);
    if (nz >= zLo && nz <= zHi && de > 1e-9 && len > 1e-6) {
      // Volume, not the sum of nominal footprints: beads are rounded
      // rectangles that interlock, so their footprints legitimately overlap
      // while the material laid still adds up to exactly the cross-section.
      area += de * filArea / flow;
      if (!wasExtruding) passes++;
      wasExtruding = true;
    } else if (!(de > 1e-9 && len > 1e-6)) wasExtruding = false;
    x=nx; y=ny; z=nz; if (!rel) e=ne;
  }
  return { area: area, passes: passes };
}

var fails = 0;
function chkTrue(name, ok, detail) {
  if (!ok) fails++;
  console.log((ok ? '  ok  ' : 'FAIL  ') + name + (detail ? ': ' + detail : ''));
}
function chk(name, got, want, tol, unit) {
  var ok = Math.abs(got - want) <= tol;
  if (!ok) fails++;
  console.log((ok?'  ok  ':'FAIL  ')+name+': '+got.toFixed(3)+(unit||'')+
              ' (want '+want+' ±'+tol+')');
}

// --- 1. thick part: nothing may change, and no variable widths may appear ---
var s = settings({ wallGenerator:'arachne' });
var thick = E.slice({positions: box(20,20,2,128,128), settings: s}, function(){});
var sFixed = settings({ wallGenerator:'classic' });
var thickFixed = E.slice({positions: box(20,20,2,128,128), settings: sFixed}, function(){});
var a = layerScan(thick.gcode, 0.9, 1.1, s), b = layerScan(thickFixed.gcode, 0.9, 1.1, sFixed);
chk('20 mm cube: arachne == classic material', a.area, b.area, 1e-6, ' mm3');
chk('20 mm cube: same pass count', a.passes, b.passes, 0);

// --- 2. a 1.2 mm rib: the beads must share the space, not starve ---
var rib = E.slice({positions: box(1.2, 30, 2, 128, 128), settings: s}, function(){});
var ribFixed = E.slice({positions: box(1.2, 30, 2, 128, 128), settings: sFixed}, function(){});
var r = layerScan(rib.gcode, 0.9, 1.1, s), rf = layerScan(ribFixed.gcode, 0.9, 1.1, sFixed);
var trueArea = 1.2 * 30 * s.layerHeight;
console.log('  rib: arachne ' + r.area.toFixed(2) + ' mm3 / ' + r.passes + ' passes, classic ' +
            rf.area.toFixed(2) + ' mm2 / ' + rf.passes + ' passes, true ' + trueArea.toFixed(2));
chk('1.2 mm rib: material laid', r.area, trueArea, trueArea*0.05, ' mm3');
if (r.passes > rf.passes) { fails++; console.log('FAIL  rib: arachne uses MORE passes than classic'); }
else console.log('  ok  rib: ' + r.passes + ' passes vs classic ' + rf.passes);
chkTrue('1.2 mm rib: arachne fills it accurately where fixed widths cannot',
        Math.abs(r.area - trueArea) / trueArea < 0.05 &&
        Math.abs(r.area - trueArea) < Math.abs(rf.area - trueArea) / 2,
        'arachne off by ' + (100*(r.area-trueArea)/trueArea).toFixed(2) + '% in ' + r.passes +
        ' passes, classic off by ' + (100*(rf.area-trueArea)/trueArea).toFixed(2) +
        '% in ' + rf.passes);

// --- 3. a wedge: bead count must follow the taper ---
var wg = E.slice({positions: wedge(24, 3.0, 0.5, 2, 128, 128), settings: s}, function(){});
var w1 = layerScan(wg.gcode, 0.9, 1.1, s);
var trueW = 24 * (3.0 + 0.5) / 2 * s.layerHeight;
var wgFixed = E.slice({positions: wedge(24, 3.0, 0.5, 2, 128, 128), settings: sFixed}, function(){});
var w2 = layerScan(wgFixed.gcode, 0.9, 1.1, sFixed);
console.log('  wedge: arachne ' + w1.area.toFixed(2) + ' mm3 / ' + w1.passes + ' passes, classic ' +
            w2.area.toFixed(2) + ' mm2 / ' + w2.passes + ' passes, true ' + trueW.toFixed(2));
chk('wedge: material laid', w1.area, trueW, trueW*0.05, ' mm3');
chkTrue('wedge: arachne fills it to within 5% of the true volume',
        Math.abs(w1.area - trueW) / trueW < 0.05,
        'arachne off by ' + (100*(w1.area-trueW)/trueW).toFixed(2) +
        '%, classic off by ' + (100*(w2.area-trueW)/trueW).toFixed(2) + '%');

// --- 3b. the outer bead must actually change width along the taper ---
// Length-weighted spread of the implied width, over the whole outer loop.
function outerWidthStats(gcode, zLo, zHi, s) {
  var lines = gcode.split('\n'), z=0,x=0,y=0,e=0, on=false;
  var filArea = Math.PI*Math.pow(s.filamentDiameter/2,2), h=s.layerHeight;
  var sw=0, swx=0, swx2=0;
  for (var i=0;i<lines.length;i++) {
    var raw = lines[i];
    if (/^;TYPE:/.test(raw)) on = /External perimeter/.test(raw);
    var L = raw.split(';')[0].trim(); if (!L) continue;
    if (/^G92/.test(L)) { var m0=/E(-?[\d.]+)/.exec(L); if(m0) e=parseFloat(m0[1]); continue; }
    if (!/^G[0-3]\b/.test(L)) continue;
    var nx=x,ny=y,nz=z,ne=e,mm;
    if ((mm=/X(-?[\d.]+)/.exec(L))) nx=parseFloat(mm[1]);
    if ((mm=/Y(-?[\d.]+)/.exec(L))) ny=parseFloat(mm[1]);
    if ((mm=/Z(-?[\d.]+)/.exec(L))) nz=parseFloat(mm[1]);
    var de=0; if ((mm=/E(-?[\d.]+)/.exec(L))) { ne=parseFloat(mm[1]); de=ne-e; }
    var seg=Math.hypot(nx-x,ny-y);
    if (on && nz>=zLo && nz<=zHi && de>1e-9 && seg>1e-6) {
      var w = (de*filArea/s.flowRatio/seg - Math.PI*h*h/4)/h + h;
      sw += seg; swx += w*seg; swx2 += w*w*seg;
    }
    x=nx;y=ny;z=nz;e=ne;
  }
  var mean = swx/sw;
  return { mean: mean, sd: Math.sqrt(Math.max(0, swx2/sw - mean*mean)) };
}
// The scarf seam ramps flow along the loop, which would swamp the measurement.
var sNo = settings({ wallGenerator:'arachne', seamScarf:false });
var sNoF = settings({ wallGenerator:'classic', seamScarf:false });
var wgN = E.slice({positions: wedge(24, 3.0, 0.5, 2, 128, 128), settings: sNo}, function(){});
var wgNF = E.slice({positions: wedge(24, 3.0, 0.5, 2, 128, 128), settings: sNoF}, function(){});
var ow = outerWidthStats(wgN.gcode, 0.9, 1.1, sNo);
var owF = outerWidthStats(wgNF.gcode, 0.9, 1.1, sNoF);
console.log('  wedge outer bead: arachne mean ' + ow.mean.toFixed(3) + ' sd ' + ow.sd.toFixed(3) +
            ' mm, classic mean ' + owF.mean.toFixed(3) + ' sd ' + owF.sd.toFixed(3) + ' mm');
// Only the thin quarter of this loop redistributes, so the whole-loop spread
// is a fraction of the local change; the classic generator is flat at 0.000.
if (ow.sd < 0.015) { fails++; console.log('FAIL  wedge: outer bead width does not follow the taper'); }
else console.log('  ok  wedge: outer bead width tracks the taper (sd ' + ow.sd.toFixed(3) + ' mm)');
if (ow.sd < owF.sd * 3) { fails++; console.log('FAIL  wedge: classic varies about as much (measurement noise?)'); }

// --- 3bis. the bead count must change smoothly, not in a step ---
// Max width change per millimetre of travel along the outer bead. A wall that
// flips from three beads across to two at a point shows up here as a spike.
function widthGradient(gcode, zLo, zHi, s) {
  var L = gcode.split('\n'), z=0,x=0,y=0,e=0, on=false, prev=null, worst=0;
  var filArea = Math.PI*Math.pow(s.filamentDiameter/2,2), h=s.layerHeight;
  for (var i=0;i<L.length;i++) {
    var raw = L[i];
    if (/^;TYPE:/.test(raw)) { on = /External perimeter/.test(raw); prev = null; }
    var mz = /^;Z:([\d.]+)/.exec(raw); if (mz) z = parseFloat(mz[1]);
    var T = raw.split(';')[0].trim(); if (!T) continue;
    if (/^G92/.test(T)) { var m0=/E(-?[\d.]+)/.exec(T); if(m0) e=parseFloat(m0[1]); continue; }
    if (!/^G[0-3]\b/.test(T)) continue;
    var mm, nx=x, ny=y, de=0;
    if ((mm=/X(-?[\d.]+)/.exec(T))) nx=parseFloat(mm[1]);
    if ((mm=/Y(-?[\d.]+)/.exec(T))) ny=parseFloat(mm[1]);
    if ((mm=/E(-?[\d.]+)/.exec(T))) { de=parseFloat(mm[1])-e; e=parseFloat(mm[1]); }
    var seg=Math.hypot(nx-x,ny-y);
    if (on && z>=zLo && z<=zHi && de>1e-9 && seg>0.1) {
      var w = (de*filArea/s.flowRatio/seg - Math.PI*h*h/4)/h + h;
      if (prev) worst = Math.max(worst, Math.abs(w - prev.w) / ((seg + prev.seg) / 2));
      prev = { w: w, seg: seg };
    } else if (!(de>1e-9)) prev = null;
    x=nx;y=ny;
  }
  return worst;
}
var sStep = settings({ wallGenerator:'arachne', seamScarf:false, arcFitting:false,
                       wallTransitionLength:0.05 });
var sRamp = settings({ wallGenerator:'arachne', seamScarf:false, arcFitting:false,
                       wallTransitionLength:1.2 });
var wStep = E.slice({positions: wedge(24, 3.0, 0.5, 2, 128, 128), settings: sStep}, function(){});
var wRamp = E.slice({positions: wedge(24, 3.0, 0.5, 2, 128, 128), settings: sRamp}, function(){});
var gStep = widthGradient(wStep.gcode, 0.9, 1.1, sStep);
var gRamp = widthGradient(wRamp.gcode, 0.9, 1.1, sRamp);
console.log('  wedge width gradient: ' + gStep.toFixed(3) + ' mm/mm at a 0.05 mm transition, ' +
            gRamp.toFixed(3) + ' at 1.2 mm');
chkTrue('a longer transition length really does ramp the bead count',
        gRamp < gStep * 0.8, gRamp.toFixed(3) + ' vs ' + gStep.toFixed(3));

// --- 3c. redistributed walls keep the rest of the engine's treatments ---
// A leaning thin wall: the outer bead is both variable-width AND overhanging,
// so it exercises both paths at once.
function leaningRib(len, thick, h, cx, cy, lean) {
  var t=[], x0=cx-len/2, x1=cx+len/2;
  function q(a,b,c,e){ t.push(a[0],a[1],a[2],b[0],b[1],b[2],c[0],c[1],c[2],
                              a[0],a[1],a[2],c[0],c[1],c[2],e[0],e[1],e[2]); }
  function ring(z, off) {
    return [[x0, cy-thick/2+off, z], [x1, cy-thick/2+off, z],
            [x1, cy+thick/2+off, z], [x0, cy+thick/2+off, z]];
  }
  var lo = ring(0, 0), hi = ring(h, lean);
  q(lo[0],lo[3],lo[2],lo[1]); q(hi[0],hi[1],hi[2],hi[3]);
  for (var i=0;i<4;i++) { var j=(i+1)%4; q(lo[i],lo[j],hi[j],hi[i]); }
  return new Float32Array(t);
}
function typesUsed(gcode) {
  var out = {};
  gcode.split('\n').forEach(function (l) {
    var m = /^;TYPE:(.*)/.exec(l);
    if (m) out[m[1]] = (out[m[1]] || 0) + 1;
  });
  return out;
}
var sLean = settings({ wallGenerator:'arachne', overhangSlowdown:true, supportEnable:false,
                       seamScarf:false, arcFitting:false });
var lean = E.slice({ positions: leaningRib(24, 1.2, 6, 128, 128, 3), settings: sLean },
                   function(){});
var leanTypes = typesUsed(lean.gcode);
chkTrue('overhang slowdown still classifies a redistributed wall',
        (leanTypes['Overhang perimeter'] || 0) > 0,
        JSON.stringify(leanTypes));

// Fuzzy skin must survive too, and must not flatten the widths back to one.
var sFuzz = settings({ wallGenerator:'arachne', fuzzySkin:'outer', fuzzyThickness:0.3,
                       fuzzyPointDistance:0.6, seamScarf:false, arcFitting:false });
var fuzz = E.slice({ positions: box(1.2, 30, 2, 128, 128), settings: sFuzz }, function(){});
var sPlainRib = settings({ wallGenerator:'arachne', fuzzySkin:'none', seamScarf:false, arcFitting:false });
var plainRib = E.slice({ positions: box(1.2, 30, 2, 128, 128), settings: sPlainRib }, function(){});
var fuzzStats = outerWidthStats(fuzz.gcode, 0.9, 1.1, sFuzz);
var plainStats = outerWidthStats(plainRib.gcode, 0.9, 1.1, sPlainRib);
// The rib's outer wall runs dead straight along X; fuzz makes it wander.
function wallWander(gcode, zLo, zHi) {
  var L = gcode.split('\n'), on=false, z=0, xs=[];
  for (var i=0;i<L.length;i++) {
    if (/^;TYPE:/.test(L[i])) on = /External perimeter/.test(L[i]);
    var mz = /^;Z:([\d.]+)/.exec(L[i]); if (mz) z = parseFloat(mz[1]);
    var m = /^G1 X(-?[\d.]+) Y(-?[\d.]+).*E/.exec(L[i]);
    if (on && m && z >= zLo && z <= zHi) {
      var y = parseFloat(m[2]);
      if (y > 120 && y < 136) xs.push(parseFloat(m[1]));   // along the long sides
    }
  }
  var right = xs.filter(function (v) { return v > 128; });
  if (right.length < 5) return 0;
  var mean = right.reduce(function (a,b){ return a+b; }, 0) / right.length;
  var varr = right.reduce(function (a,b){ return a + (b-mean)*(b-mean); }, 0) / right.length;
  return Math.sqrt(varr);
}
var wanderFuzz = wallWander(fuzz.gcode, 0.9, 1.1);
var wanderPlain = wallWander(plainRib.gcode, 0.9, 1.1);
chkTrue('fuzzy skin applies to a redistributed wall',
        wanderFuzz > 0.04 && wanderPlain < 0.01,
        'fuzzed wanders ' + wanderFuzz.toFixed(3) + ' mm, plain ' + wanderPlain.toFixed(3) + ' mm');
chkTrue('fuzzed beads keep their own width',
        Math.abs(fuzzStats.mean - plainStats.mean) < 0.05,
        'fuzzed mean ' + fuzzStats.mean.toFixed(3) + ' vs plain ' + plainStats.mean.toFixed(3));

[['leaning rib', lean], ['fuzzed rib', fuzz]].forEach(function (c) {
  var bad = c[1].report.findings.filter(function (f) { return f.severity !== 'info'; });
  chkTrue(c[0] + ': verifier clean', bad.length === 0, bad.length ? JSON.stringify(bad[0]) : '');
});

// --- 4. the verifier must still be clean on all three ---
[['cube',thick],['rib',rib],['wedge',wg]].forEach(function (c) {
  var bad = c[1].report.findings.filter(function(x){ return x.severity !== 'info'; });
  if (bad.length) { fails++; console.log('FAIL  '+c[0]+' verifier: '+JSON.stringify(bad.slice(0,3))); }
  else console.log('  ok  '+c[0]+': verifier clean');
});

// --- 5. a faceted curve is not a thin feature ---
// A round wall arrives as a polygon, and the flats between its vertices leave
// notches a few hundredths of a millimetre deep all the way round. Counted by
// area those add up to square millimetres of "thin material" that is nothing
// of the kind, and every layer of every curved part then pays for a thickness
// field it has no use for. Depth is what tells a notch from a rib.
function cylinder(r, h, cx, cy, n) {
  var t = [];
  function q(a,b,c,e){ t.push(a[0],a[1],a[2],b[0],b[1],b[2],c[0],c[1],c[2],
                              a[0],a[1],a[2],c[0],c[1],c[2],e[0],e[1],e[2]); }
  for (var i = 0; i < n; i++) {
    var a0 = i/n*2*Math.PI, a1 = (i+1)/n*2*Math.PI;
    var p0 = [cx+r*Math.cos(a0), cy+r*Math.sin(a0)];
    var p1 = [cx+r*Math.cos(a1), cy+r*Math.sin(a1)];
    q([p0[0],p0[1],0],[p1[0],p1[1],0],[p1[0],p1[1],h],[p0[0],p0[1],h]);
    t.push(cx,cy,0, p1[0],p1[1],0, p0[0],p0[1],0);
    t.push(cx,cy,h, p0[0],p0[1],h, p1[0],p1[1],h);
  }
  return new Float32Array(t);
}
function merge(list) {
  var n = 0, i;
  for (i = 0; i < list.length; i++) n += list[i].length;
  var out = new Float32Array(n), at = 0;
  for (i = 0; i < list.length; i++) { out.set(list[i], at); at += list[i].length; }
  return out;
}
var B = globalThis.OrcaBeading;
var fieldCalls = 0;
var realField = B.thicknessField;
B.thicknessField = function () { fieldCalls++; return realField.apply(this, arguments); };

var plainCyl = cylinder(20, 6, 150, 150, 96);
E.slice({ positions: plainCyl, settings: settings({}) }, function () {});
chkTrue('a round wall costs no thickness field at all (' + fieldCalls + ' calls)',
        fieldCalls === 0, fieldCalls + ' calls on a plain cylinder');

// But a real thin feature on that same round part still gets one, and still
// gets beads: the screen has to be cheap, not blind.
fieldCalls = 0;
var finned = merge([plainCyl, box(24, 0.7, 6, 150 + 22, 150)]);
var finSliced = E.slice({ positions: finned, settings: settings({}) }, function () {});
chkTrue('a 0.7 mm fin on the same part is still found (' + fieldCalls + ' calls)',
        fieldCalls > 0, 'no thickness field computed for a fin thinner than two walls');
B.thicknessField = realField;

// And the fin is printed as a single bead down its middle, not two starved
// walls: one pass, and wider than the nominal line.
var finLayer = layerScan(finSliced.gcode, 2.0, 2.4, settings({}));
chkTrue('and the fin comes out as material, not as a gap (' + finLayer.area.toFixed(1) + ' mm²)',
        finLayer.area > 0, 'nothing laid on that layer');
var finBad = finSliced.report.findings.filter(function (f) { return f.severity !== 'info'; });
chkTrue('fin: verifier clean', finBad.length === 0, finBad.length ? JSON.stringify(finBad[0]) : '');

console.log(fails ? '\n'+fails+' FAILURES' : '\nall arachne checks pass');
process.exit(fails?1:0);
