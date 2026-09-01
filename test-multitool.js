/**
 * Web Slicer — printing with more than one tool.
 *
 *   node test-multitool.js
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

function box(w, d, h, cx, cy) {
  var x0=cx-w/2, x1=cx+w/2, y0=cy-d/2, y1=cy+d/2, t=[];
  function q(a,b,c,e){ t.push(a[0],a[1],a[2],b[0],b[1],b[2],c[0],c[1],c[2],
                               a[0],a[1],a[2],c[0],c[1],c[2],e[0],e[1],e[2]); }
  var A=[x0,y0,0],B=[x1,y0,0],C=[x1,y1,0],D=[x0,y1,0];
  var E2=[x0,y0,h],F=[x1,y0,h],G2=[x1,y1,h],H=[x0,y1,h];
  q(A,D,C,B); q(E2,F,G2,H); q(A,B,F,E2); q(B,C,G2,F); q(C,D,H,G2); q(D,A,E2,H);
  return new Float32Array(t);
}
function merge(list) {
  var n=0,i; for(i=0;i<list.length;i++) n+=list[i].length;
  var out=new Float32Array(n), at=0;
  for(i=0;i<list.length;i++){ out.set(list[i],at); at+=list[i].length; }
  return out;
}
function settings(over) {
  var s = P.buildSettings('prusa_xl', 'pla', 'standard_02');
  s.brimWidth = 0; s.skirtLoops = 0; s.raftLayers = 0; s.supportEnable = false;
  for (var k in over) s[k] = over[k];
  return s;
}
var fails = 0;
function chk(name, ok, detail) {
  if (!ok) fails++;
  console.log((ok ? '  ok  ' : 'FAIL  ') + name + (detail ? ': ' + detail : ''));
}

var a = box(14,14,4, 120,140), b = box(14,14,4, 160,140);
var s = settings({});
chk('the XL is known to have five tools', s.extruderCount === 5, String(s.extruderCount));

var job = {
  positions: merge([a,b]),
  objects: [{ name: 'red', positions: a, extruder: 0 },
            { name: 'blue', positions: b, extruder: 1 }],
  settings: s
};
var r = E.slice(job, function(){});
var lines = r.gcode.split('\n');

// --- tool changes ---
var changes = lines.filter(function (l) { return /^;TOOLCHANGE:/.test(l); });
var tCmds = lines.filter(function (l) { return /^T\d+\s*$/.test(l.trim()); });
chk('the file changes tool', changes.length > 4, changes.length + ' changes');
chk('every change emits a T command', tCmds.length === changes.length,
    tCmds.length + ' T commands for ' + changes.length + ' changes');
chk('only tools that exist are selected',
    tCmds.every(function (l) { return parseInt(l.trim().slice(1), 10) < s.extruderCount; }));

// --- and no more than one change per tool per layer ---
var perLayer = [], count = 0;
lines.forEach(function (l) {
  if (/^;LAYER:/.test(l)) { perLayer.push(count); count = 0; }
  else if (/^;TOOLCHANGE:/.test(l)) count++;
});
perLayer.push(count);
var worst = Math.max.apply(null, perLayer);
chk('each tool is picked up at most once a layer', worst <= 2, 'worst layer had ' + worst);

// --- the prime tower ---
// It has to stand somewhere that is neither object, and be printed by both.
function extrusionBoxByTool(gcode) {
  var L = gcode.split('\n'), tool = 0, x = 0, y = 0, e = 0, boxes = {};
  for (var i=0;i<L.length;i++) {
    var m = /^;TOOLCHANGE:(\d+)/.exec(L[i]); if (m) { tool = parseInt(m[1],10); continue; }
    var T = L[i].split(';')[0].trim(); if (!T) continue;
    if (/^G92/.test(T)) { var m0=/E(-?[\d.]+)/.exec(T); if(m0) e=parseFloat(m0[1]); continue; }
    if (!/^G[0-3]\b/.test(T)) continue;
    var mm, nx=x, ny=y, de=0;
    if ((mm=/X(-?[\d.]+)/.exec(T))) nx=parseFloat(mm[1]);
    if ((mm=/Y(-?[\d.]+)/.exec(T))) ny=parseFloat(mm[1]);
    if ((mm=/E(-?[\d.]+)/.exec(T))) { de=parseFloat(mm[1])-e; e=parseFloat(mm[1]); }
    if (de>1e-9 && Math.hypot(nx-x,ny-y)>1e-6) {
      var bx = boxes[tool] || (boxes[tool] = {minX:1e9,maxX:-1e9,minY:1e9,maxY:-1e9,n:0});
      bx.minX=Math.min(bx.minX,nx); bx.maxX=Math.max(bx.maxX,nx);
      bx.minY=Math.min(bx.minY,ny); bx.maxY=Math.max(bx.maxY,ny);
      bx.n++;
    }
    x=nx;y=ny;
  }
  return boxes;
}
var boxes = extrusionBoxByTool(r.gcode);
chk('both tools lay material', boxes[0] && boxes[1] && boxes[0].n > 50 && boxes[1].n > 50,
    Object.keys(boxes).map(function(k){ return 'T'+k+':'+boxes[k].n; }).join(' '));
// Each object is a 14 mm square; the tower must be somewhere else entirely.
var towerish = (boxes[0].maxX > 200 || boxes[0].maxY > 200 ||
                boxes[1].maxX > 200 || boxes[1].maxY > 200);
chk('a prime tower is printed off to the side', towerish,
    'T0 reaches ' + boxes[0].maxX.toFixed(0) + ',' + boxes[0].maxY.toFixed(0) +
    '; T1 reaches ' + boxes[1].maxX.toFixed(0) + ',' + boxes[1].maxY.toFixed(0));

// --- both objects still get printed where they belong ---
var single = E.slice({ positions: a, settings: settings({}) }, function(){});
chk('the plate is taller in material than one object alone',
    r.stats.volumeCm3 > single.stats.volumeCm3 * 2,
    r.stats.volumeCm3.toFixed(2) + ' vs ' + single.stats.volumeCm3.toFixed(2) + ' cm3');

var bad = r.report.findings.filter(function (f) { return f.severity !== 'info'; });
chk('two-tool plate: verifier clean', bad.length === 0, bad.length ? JSON.stringify(bad[0]) : '');

// --- a custom tool-change script goes through the expression language ---
var scripted = E.slice({
  positions: merge([a,b]),
  objects: job.objects,
  settings: settings({ toolChangeGcode: 'T{next_extruder}\n; was T{previous_extruder}' })
}, function(){});
chk('the tool change script is rendered',
    /; was T0/.test(scripted.gcode) && /; was T1/.test(scripted.gcode));

// --- one tool: nothing changes ---
var plain = E.slice({
  positions: merge([a,b]),
  objects: [{ name:'a', positions:a, extruder:0 }, { name:'b', positions:b, extruder:0 }],
  settings: settings({})
}, function(){});
chk('one tool means no tool changes and no tower',
    !/^;TOOLCHANGE:/m.test(plain.gcode) &&
    Math.abs(plain.stats.volumeCm3 - E.slice({positions: merge([a,b]), settings: settings({})},
      function(){}).stats.volumeCm3) < 1e-6,
    plain.stats.volumeCm3.toFixed(3) + ' cm3');

// --- no room for a tower is an error, not a silent omission ---
// Two slabs that between them cover the whole plate.
var big1 = box(340,170,3, 180,90), big2 = box(340,170,3, 180,270);
var crowded = E.slice({
  positions: merge([big1,big2]),
  objects: [{ name:'one', positions:big1, extruder:0 }, { name:'two', positions:big2, extruder:1 }],
  settings: settings({ primeTowerWidth: 100 })
}, function(){});
chk('no room for the tower is reported as an error',
    crowded.report.findings.some(function (f) {
      return f.code === 'primetower.nospace' && f.severity === 'error'; }),
    crowded.report.findings.filter(function(f){return f.severity==='error';})
      .map(function(f){return f.code;}).join(',') || 'nothing');

// Where the tower may stand is a fact about the plate. It once read the
// combing region for it, so switching a travel setting off left the tower
// thinking the plate was empty and it stood on the model.
[true, false].forEach(function (combing) {
  var same = E.slice({
    positions: merge([big1, big2]),
    objects: [{ name:'one', positions:big1, extruder:0 }, { name:'two', positions:big2, extruder:1 }],
    settings: settings({ primeTowerWidth: 100, combing: combing })
  }, function(){});
  chk('a full plate has no room for a tower with combing ' + (combing ? 'on' : 'off'),
      same.report.findings.some(function (f) { return f.code === 'primetower.nospace'; }),
      same.report.findings.map(function (f) { return f.code; }).join(',') || 'nothing reported');
});

// --- the purge rule has to fire when it is broken ---
// Strip the prime tower out of a good file: the same plate, now printing on
// the model straight after a tool change.
var stripped = r.gcode.split('\n').filter(function (l, i, all) {
  return true;
}).join('\n');
(function () {
  var L = r.gcode.split('\n'), out = [], dropping = false;
  for (var i = 0; i < L.length; i++) {
    if (/^;TYPE:/.test(L[i])) dropping = /Prime tower/.test(L[i]);
    if (!dropping) out.push(L[i]);
  }
  stripped = out.join('\n');
})();
var v = globalThis.OrcaGcodeCheck.verify(stripped, s);
var purge = v.findings.filter(function (f) { return f.code === 'tool.purge.missing'; });
chk('printing on the model straight after a tool change is caught',
    purge.length >= 1, purge.length ? purge[0].message : 'not caught');

// And a tool the machine does not have.
var badTool = r.gcode.replace(/^T1$/m, 'T7');
var v2 = globalThis.OrcaGcodeCheck.verify(badTool, s);
chk('selecting a tool the machine does not have is an error',
    v2.findings.some(function (f) { return f.code === 'tool.missing' && f.severity === 'error'; }),
    v2.findings.filter(function(f){return f.code==='tool.missing';}).map(function(f){return f.message;})[0] || 'not caught');

console.log(fails ? '\n' + fails + ' FAILURES' : '\nall multi-tool checks pass');
process.exit(fails ? 1 : 0);
