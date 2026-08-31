/**
 * Web Slicer — tree supports.
 *
 * A tree support has to do three things: actually hold the overhang, use
 * markedly less material than a wall of normal support doing the same job, and
 * never grow through the part it is holding.
 *
 *   node test-treesupport.js
 */
globalThis.ClipperLib = require('./js/vendor/clipper.js');
globalThis.OrcaPresets = require('./js/slicer/presets.js');
require('./js/slicer/engine.js');
require('./js/slicer/beading.js');
require('./js/slicer/lightning.js');
require('./js/slicer/treesupport.js');
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
// A mushroom: a slim stalk with a broad flat cap, the classic support case.
function mushroom() { return new Float32Array(box(8,8,14,128,128,0).concat(box(34,34,3,128,128,14))); }

function settings(over) {
  var s = P.buildSettings('elegoo_centauri_carbon', 'pla', 'standard_02');
  s.brimWidth = 0; s.skirtLoops = 0; s.raftLayers = 0; s.supportEnable = true;
  for (var k in over) s[k] = over[k];
  return s;
}
// Support material laid, and where it lands, straight out of the G-code.
function supportScan(gcode, s) {
  var lines = gcode.split('\n'), z=0,x=0,y=0,e=0,on=false;
  var filArea = Math.PI*Math.pow(s.filamentDiameter/2,2);
  var vol = 0, minZ = Infinity, maxZ = -Infinity, pts = [];
  for (var i=0;i<lines.length;i++) {
    var raw = lines[i];
    if (/^;TYPE:/.test(raw)) on = /Support/i.test(raw);
    var mz = /^;Z:([\d.]+)/.exec(raw); if (mz) z = parseFloat(mz[1]);
    var L = raw.split(';')[0].trim(); if (!L) continue;
    if (/^G92/.test(L)) { var m0=/E(-?[\d.]+)/.exec(L); if(m0) e=parseFloat(m0[1]); continue; }
    if (!/^G[0-3]\b/.test(L)) continue;
    var mm, nx=x, ny=y, de=0;
    if ((mm=/X(-?[\d.]+)/.exec(L))) nx=parseFloat(mm[1]);
    if ((mm=/Y(-?[\d.]+)/.exec(L))) ny=parseFloat(mm[1]);
    if ((mm=/E(-?[\d.]+)/.exec(L))) { de=parseFloat(mm[1])-e; e=parseFloat(mm[1]); }
    if (on && de>1e-9 && Math.hypot(nx-x,ny-y)>1e-6) {
      vol += de*filArea;
      if (z<minZ) minZ=z;
      if (z>maxZ) maxZ=z;
      pts.push({ x:nx, y:ny, z:z });
    }
    x=nx;y=ny;
  }
  return { vol: vol, minZ: minZ, maxZ: maxZ, pts: pts };
}

var fails = 0;
function chk(name, ok, detail) {
  if (!ok) fails++;
  console.log((ok ? '  ok  ' : 'FAIL  ') + name + (detail ? ': ' + detail : ''));
}

var mesh = mushroom();
var sNormal = settings({ supportStyle: 'normal' });
var sTree = settings({ supportStyle: 'tree' });
var normal = E.slice({ positions: mesh, settings: sNormal }, function(){});
var tree = E.slice({ positions: mesh, settings: sTree }, function(){});
var nScan = supportScan(normal.gcode, sNormal), tScan = supportScan(tree.gcode, sTree);

console.log('  normal ' + nScan.vol.toFixed(1) + ' mm3, tree ' + tScan.vol.toFixed(1) + ' mm3');
chk('tree supports actually get built', tScan.vol > 5, tScan.vol.toFixed(1) + ' mm3');
chk('they reach the build plate', tScan.minZ < 0.5, 'lowest at Z' + tScan.minZ);
chk('they reach up to the overhang', tScan.maxZ > 13.5, 'highest at Z' + tScan.maxZ);
chk('they use markedly less material than normal supports',
    tScan.vol < nScan.vol * 0.6,
    tScan.vol.toFixed(1) + ' vs ' + nScan.vol.toFixed(1) + ' mm3 (' +
    (100*tScan.vol/nScan.vol).toFixed(0) + '%)');

// Nothing may be printed inside the stalk: it occupies x,y within 4 mm of centre
// all the way up, and support there would be fused into the part.
var inStalk = tScan.pts.filter(function (p) {
  return p.z < 13.5 && Math.abs(p.x-128) < 3.6 && Math.abs(p.y-128) < 3.6;
});
chk('no branch grows through the part', inStalk.length === 0,
    inStalk.length + ' support points inside the stalk');

// The branches must be under the cap, which is what needs holding.
var underCap = tScan.pts.filter(function (p) {
  return p.z > 10 && (Math.abs(p.x-128) > 5 || Math.abs(p.y-128) > 5);
});
chk('branches hold the overhanging cap', underCap.length > 20, underCap.length + ' points');

// And they must gather as they come down rather than staying a forest. The
// mushroom's stalk is in the way of that, so this uses a diving board: a plate
// held at one end, with nothing under the free end to bend around.
function board() {
  return new Float32Array(box(8,12,20,110,128,0).concat(box(46,12,2.5,131,128,20)));
}
var sTreeB = settings({ supportStyle: 'tree' });
var boardTree = E.slice({ positions: board(), settings: sTreeB }, function(){});
// Cluster the support extrusion points at a height: separate clusters are
// separate branches, however many loops each is traced with.
function branchesAt(gcode, zLo, zHi, s) {
  var pts = supportScan(gcode, s).pts.filter(function (p) { return p.z >= zLo && p.z <= zHi; });
  // Finer than the tip spacing, so two neighbouring tips do not read as one.
  var cell = 1.2, grid = {};
  pts.forEach(function (p) { grid[Math.round(p.x/cell) + ',' + Math.round(p.y/cell)] = true; });
  var seen = {}, groups = 0;
  Object.keys(grid).forEach(function (key) {
    if (seen[key]) return;
    groups++;
    var stack = [key];
    while (stack.length) {
      var at = stack.pop();
      if (seen[at]) continue;
      seen[at] = true;
      var xy = at.split(',').map(Number);
      for (var dx=-1; dx<=1; dx++) for (var dy=-1; dy<=1; dy++) {
        var nb = (xy[0]+dx) + ',' + (xy[1]+dy);
        if (grid[nb] && !seen[nb]) stack.push(nb);
      }
    }
  });
  return groups;
}
var nearCap = branchesAt(boardTree.gcode, 17.5, 19.5, sTreeB);
var nearPlate = branchesAt(boardTree.gcode, 0.2, 2.2, sTreeB);
console.log('  separate branches: ' + nearCap + ' near the overhang, ' +
            nearPlate + ' at the plate');
chk('branches merge into fewer trunks on the way down', nearPlate < nearCap,
    nearPlate + ' vs ' + nearCap);
var bScan2 = supportScan(boardTree.gcode, sTreeB);
chk('the diving board is held all the way to the plate',
    bScan2.minZ < 0.5 && bScan2.maxZ > 19, 'Z' + bScan2.minZ + '–' + bScan2.maxZ);
chk('diving board: verifier clean',
    boardTree.report.findings.filter(function (f) { return f.severity !== 'info'; }).length === 0);

[['normal', normal], ['tree', tree]].forEach(function (c) {
  var bad = c[1].report.findings.filter(function (f) { return f.severity !== 'info'; });
  chk(c[0] + ' supports: verifier clean', bad.length === 0, bad.length ? JSON.stringify(bad[0]) : '');
});

// A blocker still wins over a branch.
var blocked = E.slice({ positions: mesh, settings: settings({ supportStyle: 'tree',
  paintMarks: [{ x: 118, y: 128, z: 14.2, r: 7, kind: 'block' }] }) }, function(){});
var bScan = supportScan(blocked.gcode, sTree);
chk('a blocker still removes tree branches', bScan.vol < tScan.vol * 0.9,
    bScan.vol.toFixed(1) + ' vs ' + tScan.vol.toFixed(1) + ' mm3');

console.log(fails ? '\n' + fails + ' FAILURES' : '\nall tree support checks pass');
process.exit(fails ? 1 : 0);
