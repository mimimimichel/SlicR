/**
 * Web Slicer — painted supports and seams.
 *
 * A painted enforcer must put support under a spot that no overhang rule would
 * have asked for; a blocker must take it away again; a painted seam must move
 * the seam to where it was painted and leave it alone elsewhere.
 *
 *   node test-paint.js
 */
globalThis.ClipperLib = require('./js/vendor/clipper.js');
globalThis.OrcaPresets = require('./js/slicer/presets.js');
require('./js/slicer/engine.js');
require('./js/slicer/beading.js');
require('./js/slicer/lightning.js');
require('./js/slicer/template.js');
require('./js/slicer/gcodecheck.js');
var E = globalThis.OrcaEngine, P = globalThis.OrcaPresets;

function box(w, d, h, cx, cy, z0) {
  var x0=cx-w/2, x1=cx+w/2, y0=cy-d/2, y1=cy+d/2, z1=(z0||0)+h, t=[];
  function q(a,b,c,e){ t.push(a[0],a[1],a[2],b[0],b[1],b[2],c[0],c[1],c[2],
                               a[0],a[1],a[2],c[0],c[1],c[2],e[0],e[1],e[2]); }
  var A=[x0,y0,z0||0],B=[x1,y0,z0||0],C=[x1,y1,z0||0],D=[x0,y1,z0||0];
  var E2=[x0,y0,z1],F=[x1,y0,z1],G2=[x1,y1,z1],H=[x0,y1,z1];
  q(A,D,C,B); q(E2,F,G2,H); q(A,B,F,E2); q(B,C,G2,F); q(C,D,H,G2); q(D,A,E2,H);
  return t;
}
// A table: a 4 mm post with a wide top, so the top is a genuine overhang.
function table() {
  return new Float32Array(box(6,6,4,128,128,0).concat(box(24,24,2,128,128,4)));
}
function settings(over) {
  var s = P.buildSettings('elegoo_centauri_carbon', 'pla', 'standard_02');
  s.brimWidth = 0; s.skirtLoops = 0; s.raftLayers = 0; s.supportEnable = false;
  for (var k in over) s[k] = over[k];
  return s;
}
// Support extrusion, by area, below a given height.
function supportArea(gcode, s, zMax) {
  var lines = gcode.split('\n'), z=0,x=0,y=0,e=0,on=false, area=0;
  var filArea = Math.PI*Math.pow(s.filamentDiameter/2,2), h=s.layerHeight;
  for (var i=0;i<lines.length;i++) {
    var raw = lines[i];
    if (/^;TYPE:/.test(raw)) on = /Support/i.test(raw);
    var L = raw.split(';')[0].trim(); if (!L) continue;
    if (/^G92/.test(L)) { var m0=/E(-?[\d.]+)/.exec(L); if(m0) e=parseFloat(m0[1]); continue; }
    if (!/^G[0-3]\b/.test(L)) continue;
    var nx=x,ny=y,nz=z,ne=e,mm;
    if ((mm=/X(-?[\d.]+)/.exec(L))) nx=parseFloat(mm[1]);
    if ((mm=/Y(-?[\d.]+)/.exec(L))) ny=parseFloat(mm[1]);
    if ((mm=/Z(-?[\d.]+)/.exec(L))) nz=parseFloat(mm[1]);
    var de=0; if ((mm=/E(-?[\d.]+)/.exec(L))) { ne=parseFloat(mm[1]); de=ne-e; }
    var seg=Math.hypot(nx-x,ny-y);
    if (on && de>1e-9 && seg>1e-6 && (zMax === undefined || nz <= zMax)) area += de*filArea/s.flowRatio/h;
    x=nx;y=ny;z=nz;e=ne;
  }
  return area;
}
// Where each layer's outer perimeter starts, from ;LAYER markers onward.
function seamPoints(gcode) {
  var lines = gcode.split('\n'), out=[], armed=false, z=0;
  for (var i=0;i<lines.length;i++) {
    var raw = lines[i];
    var mz = /^;Z:([\d.]+)/.exec(raw); if (mz) z = parseFloat(mz[1]);
    if (/^;TYPE:External perimeter/.test(raw)) { armed = true; continue; }
    if (!armed) continue;
    var m = /^G[01] X(-?[\d.]+) Y(-?[\d.]+)/.exec(raw.split(';')[0].trim());
    if (m) { out.push({ z: z, x: parseFloat(m[1]), y: parseFloat(m[2]) }); armed = false; }
  }
  return out;
}

var fails = 0;
function chk(name, ok, detail) {
  if (!ok) fails++;
  console.log((ok ? '  ok  ' : 'FAIL  ') + name + (detail ? ': ' + detail : ''));
}

var mesh = table();

// --- 1. no supports at all ---
var sOff = settings({});
var off = E.slice({ positions: mesh, settings: sOff }, function(){});
chk('supports off: none generated', supportArea(off.gcode, sOff) < 0.5,
    supportArea(off.gcode, sOff).toFixed(2) + ' mm2');

// --- 2. an enforcer alone puts support under the spot, supports still off ---
var sEnf = settings({ paintMarks: [{ x: 118, y: 128, z: 4.2, r: 3, kind: 'enforce' }] });
var enf = E.slice({ positions: mesh, settings: sEnf }, function(){});
var enfArea = supportArea(enf.gcode, sEnf);
chk('enforcer alone builds a column', enfArea > 20, enfArea.toFixed(1) + ' mm2 of support');

// The column has to be under the painted spot, not somewhere else.
var enfXY = (function () {
  var lines = enf.gcode.split('\n'), on=false, x=0, e=0, minx=1e9, maxx=-1e9;
  for (var i=0;i<lines.length;i++) {
    var raw = lines[i];
    if (/^;TYPE:/.test(raw)) on = /Support/i.test(raw);
    var L = raw.split(';')[0].trim(); if (!L) continue;
    if (/^G92/.test(L)) { var m0=/E(-?[\d.]+)/.exec(L); if(m0) e=parseFloat(m0[1]); continue; }
    if (!/^G[0-3]\b/.test(L)) continue;
    var nx=x, mm, de=0;
    if ((mm=/X(-?[\d.]+)/.exec(L))) nx=parseFloat(mm[1]);
    if ((mm=/E(-?[\d.]+)/.exec(L))) { de = parseFloat(mm[1]) - e; e = parseFloat(mm[1]); }
    if (on && de > 1e-9) {            // extruding moves only, not the travel in
      if (Math.min(x,nx)<minx) minx=Math.min(x,nx);
      if (Math.max(x,nx)>maxx) maxx=Math.max(x,nx);
    }
    x=nx;
  }
  return { minx: minx, maxx: maxx };
})();
chk('enforcer column sits under the painted spot',
    enfXY.minx > 114 && enfXY.maxx < 122, 'x ' + enfXY.minx.toFixed(1) + '–' + enfXY.maxx.toFixed(1));

// --- 3. automatic supports, then a blocker over the same spot ---
var sAuto = settings({ supportEnable: true });
var auto = E.slice({ positions: mesh, settings: sAuto }, function(){});
var autoArea = supportArea(auto.gcode, sAuto);
chk('automatic supports fill under the table top', autoArea > 100, autoArea.toFixed(1) + ' mm2');

var sBlk = settings({ supportEnable: true,
  paintMarks: [{ x: 118, y: 128, z: 4.2, r: 5, kind: 'block' }] });
var blk = E.slice({ positions: mesh, settings: sBlk }, function(){});
var blkArea = supportArea(blk.gcode, sBlk);
chk('a blocker takes support away', blkArea < autoArea * 0.92,
    blkArea.toFixed(1) + ' mm2 vs ' + autoArea.toFixed(1) + ' unblocked');

// --- 4. a painted seam moves the seam, and only over the height it covers ---
var sSeam = settings({ seamPosition: 'aligned', seamScarf: false });
var plain = E.slice({ positions: new Float32Array(box(20,20,10,128,128,0)), settings: sSeam }, function(){});
var sSeam2 = settings({ seamPosition: 'aligned', seamScarf: false,
  paintMarks: [{ x: 138, y: 128, z: 5, r: 2.5, kind: 'seam' }] });
var painted = E.slice({ positions: new Float32Array(box(20,20,10,128,128,0)), settings: sSeam2 }, function(){});

var pts = seamPoints(painted.gcode), base = seamPoints(plain.gcode);
function within(list, lo, hi) { return list.filter(function(p){ return p.z >= lo && p.z <= hi; }); }
var inBand = within(pts, 2.7, 7.3), outBand = pts.filter(function(p){ return p.z < 2.2 || p.z > 7.8; });
var onRight = inBand.filter(function(p){ return p.x > 136; }).length;
chk('painted seam is used through the mark',
    inBand.length > 5 && onRight === inBand.length,
    onRight + '/' + inBand.length + ' layers seam on the painted face');
var offRight = outBand.filter(function(p){ return p.x > 136; }).length;
chk('seam goes back to normal above and below', offRight === 0,
    offRight + '/' + outBand.length + ' layers still on the painted face');
var baseRight = base.filter(function(p){ return p.x > 136; }).length;
chk('unpainted model does not use that corner', baseRight === 0, baseRight + ' layers');

// --- 5. the verifier stays clean with paint in play ---
[['enforcer', enf], ['blocker', blk], ['seam', painted]].forEach(function (c) {
  var bad = c[1].report.findings.filter(function (f) { return f.severity !== 'info'; });
  chk(c[0] + ': verifier clean', bad.length === 0, bad.length ? JSON.stringify(bad[0]) : '');
});

console.log(fails ? '\n' + fails + ' FAILURES' : '\nall paint checks pass');
process.exit(fails ? 1 : 0);
