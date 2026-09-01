/**
 * Web Slicer — what the file asks the head to do between extrusions.
 *
 * Two failures with one measurement behind them: stringing, which is travel
 * made with the pressure still on, and the hesitation mid-layer that comes of
 * asking a board to read more commands than it can act on.
 *
 * Stringing is not a mystery of the machine. A nozzle full of molten plastic
 * that moves without first pulling the filament back leaves some of it behind,
 * every time, and the length of that travel is the length of the string. So the
 * measurement is simple and it is the same one for any slicer: how far does the
 * head move, in the body of the print, with the pressure still on?
 *
 * This exists because it was answered wrongly for a long time. "Avoid
 * retraction inside the part" skipped the retraction whenever the straight line
 * stayed within the layer's outline — but the inside of a part at 15% infill is
 * mostly air, and the reference slicer moves at most a millimetre that way.
 *
 * Held against PrusaSlicer, which shares its perimeter and travel code with
 * Orca, when it is installed; against fixed bounds when it is not.
 *
 *   node test-stringing.js
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
var E = globalThis.OrcaEngine, P = globalThis.OrcaPresets;

var pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); }
}

/** Two towers with a gap: the classic stringing test, because it is the one. */
function boxTris(w, d, h, cx, cy) {
  var x0=cx-w/2, x1=cx+w/2, y0=cy-d/2, y1=cy+d/2, t=[];
  function q(a,b,c,e){ t.push(a,b,c,a,c,e); }
  var A=[x0,y0,0],B=[x1,y0,0],C=[x1,y1,0],D=[x0,y1,0];
  var E2=[x0,y0,h],F=[x1,y0,h],G=[x1,y1,h],H=[x0,y1,h];
  q(A,D,C,B); q(E2,F,G,H); q(A,B,F,E2); q(B,C,G,F); q(C,D,H,G); q(D,A,E2,H);
  return t;
}
var TRIS = boxTris(8, 8, 15, 140, 150).concat(boxTris(8, 8, 15, 175, 150));
function flat(t) {
  var o = new Float32Array(t.length * 3), a = 0;
  for (var i = 0; i < t.length; i++) { o[a++]=t[i][0]; o[a++]=t[i][1]; o[a++]=t[i][2]; }
  return o;
}

/**
 * Every travel in the body of a file, and whether the filament was pulled back
 * before it. Reads the G-code the way the printer does — absolute or relative
 * E, G92 resets and all — so it works on our output and on anyone else's.
 */
function oozing(gcode) {
  var lines = gcode.split('\n');
  var x=0, y=0, z=0, e=0, rel=false, retracted=false, body=false;
  var hot=0, hotLen=0, cold=0, longest=0, longestAt='';
  for (var i = 0; i < lines.length; i++) {
    var raw = lines[i];
    // The body is what lies between the machine's own scripts. Both slicers
    // name their extrusions, so the first named one is where printing starts;
    // the heaters going off is where it stops. A Z threshold would count the
    // priming move as a travel, and it is neither ours nor a string.
    if (!body && /^;\s*(TYPE|LAYER_CHANGE|LAYER:)/i.test(raw)) body = true;
    if (body && /^;END_GCODE|^M(104|140)\s+S0\b/i.test(raw.trim())) break;
    var L = raw.split(';')[0].trim();
    if (!L) continue;
    if (/^M83\b/.test(L)) { rel = true; continue; }
    if (/^M82\b/.test(L)) { rel = false; continue; }
    if (/^G92\b/.test(L)) { var g=/E(-?[\d.]+)/.exec(L); if (g) e = parseFloat(g[1]); continue; }
    if (!/^G[01]\b/.test(L)) continue;
    var nx=x, ny=y, de=0;
    var mx=/X(-?[\d.]+)/.exec(L); if (mx) nx = parseFloat(mx[1]);
    var my=/Y(-?[\d.]+)/.exec(L); if (my) ny = parseFloat(my[1]);
    var mz=/Z(-?[\d.]+)/.exec(L); if (mz) z = parseFloat(mz[1]);
    var me=/E(-?[\d.]+)/.exec(L);
    if (me) { var v = parseFloat(me[1]); de = rel ? v : v - e; e = rel ? e + v : v; }
    var d = Math.hypot(nx - x, ny - y);
    if (de < -0.01) retracted = true;
    if (d > 0.6 && Math.abs(de) < 1e-6 && body) {
      if (retracted) cold++;
      else {
        hot++; hotLen += d;
        if (d > longest) { longest = d; longestAt = 'z=' + z + ' line ' + (i + 1); }
      }
    }
    if (de > 0.01) retracted = false;
    x = nx; y = ny;
  }
  return { hot: hot, hotLen: hotLen, cold: cold, longest: longest, where: longestAt };
}

function ourGcode(over) {
  var s = P.buildSettings('artillery_x2', 'pla', 'standard_02');
  s.skirtLoops = 0; s.brimWidth = 0;
  for (var k in over) s[k] = over[k];
  return E.slice({ positions: flat(TRIS), settings: s }, function () {}).gcode;
}

console.log('=== 1. what the head drags across the gap ===');
var mine = oozing(ourGcode({}));
console.log('  ' + mine.cold + ' travels with the pressure off, ' + mine.hot +
  ' with it on (' + mine.hotLen.toFixed(0) + ' mm), longest ' + mine.longest.toFixed(1) + ' mm');
ok('nothing crosses open air with the pressure on (longest ' + mine.longest.toFixed(1) + ' mm)',
  mine.longest < 2, mine.longest.toFixed(2) + ' mm at ' + mine.where);
ok('and the total dragged distance is small (' + mine.hotLen.toFixed(0) + ' mm)',
  mine.hotLen < 400, mine.hotLen.toFixed(0) + ' mm');
ok('the head does retract, rather than never travelling at all', mine.cold > 100,
  String(mine.cold));

console.log('\n=== 2. the setting that used to cause it ===');
// Kept, because a print that is all solid has nothing to string across and the
// time is real — but it is off unless it is asked for, and even on it may only
// skip the retraction where the nozzle is over plastic rather than over infill.
var combed = oozing(ourGcode({ combing: true }));
console.log('  with it on: ' + combed.hot + ' hot travels (' + combed.hotLen.toFixed(0) + ' mm)');
ok('switching it on is what costs, not the default', combed.hotLen > mine.hotLen,
  combed.hotLen.toFixed(0) + ' vs ' + mine.hotLen.toFixed(0));
ok('and it is off unless it is asked for',
  P.buildSettings('artillery_x2', 'pla', 'standard_02').combing === false);

console.log('\n=== 3. linear advance, where the vendor publishes a value ===');
// Artillery gives a K for the X2 and none for the X1. Guessing one is worse
// than leaving it out, so the machines without a published value get nothing.
var x2 = P.PRINTERS.artillery_x2.startGcode;
var x1 = P.PRINTERS.artillery_x1.startGcode;
ok('the X2 is told the K value Artillery publishes for it',
  /^M900 K0\.12\b/m.test(x2), (x2.match(/M900.*/) || ['none'])[0]);
ok('and it is set before the heating, where the vendor puts it',
  x2.indexOf('M900') < x2.indexOf('M190'), 'M900 at ' + x2.indexOf('M900'));
ok('the X1, which has no published value, is left alone', !/M900/.test(x1));
ok('the Kobra 3 gets its own', /^M900 K0\.051\b/m.test(P.PRINTERS.anycubic_kobra3.startGcode),
  (P.PRINTERS.anycubic_kobra3.startGcode.match(/M900.*/) || ['none'])[0]);

console.log('\n=== 4. commands the machine cannot act on ===');
// A curved wall used to come out of the offsetting with duplicate vertices a
// micron apart — hundreds of them, each one a command the board must read,
// plan and step through. A run of moves shorter than the time it takes to read
// them empties the look-ahead, and the head hesitates in the middle of a layer.
function segments(gcode) {
  var lines = gcode.split('\n');
  var x=0, y=0, f=3000, body=false, lens=[], times=[];
  for (var i = 0; i < lines.length; i++) {
    var raw = lines[i];
    if (!body && /^;\s*(TYPE|LAYER_CHANGE|LAYER:)/i.test(raw)) body = true;
    if (body && /^;END_GCODE|^M(104|140)\s+S0\b/i.test(raw.trim())) break;
    var L = raw.split(';')[0].trim();
    if (!L || !/^G[01]\b/.test(L)) continue;
    var nx=x, ny=y;
    var mx=/X(-?[\d.]+)/.exec(L); if (mx) nx = parseFloat(mx[1]);
    var my=/Y(-?[\d.]+)/.exec(L); if (my) ny = parseFloat(my[1]);
    var mf=/F([\d.]+)/.exec(L); if (mf) f = parseFloat(mf[1]);
    var d = Math.hypot(nx - x, ny - y);
    if (d > 1e-12) { lens.push(d); times.push(d / (f / 60)); }
    x = nx; y = ny;
  }
  // The most commands the board is asked to read in any one second of printing.
  var worst = 0, from = 0, acc = 0;
  for (var k = 0; k < times.length; k++) {
    acc += times[k];
    while (acc > 1 && from < k) acc -= times[from++];
    if (k - from + 1 > worst) worst = k - from + 1;
  }
  return { lens: lens, worst: worst,
           tiny: lens.filter(function (d) { return d < 0.0125; }).length };
}
// A round wall, because curves are where the duplicates came from.
function cylTris(r, h, cx, cy, n) {
  var t = [];
  function q(a,b,c,e){ t.push(a,b,c,a,c,e); }
  for (var i = 0; i < n; i++) {
    var a0 = i/n*2*Math.PI, a1 = (i+1)/n*2*Math.PI;
    var p0 = [cx + r*Math.cos(a0), cy + r*Math.sin(a0)];
    var p1 = [cx + r*Math.cos(a1), cy + r*Math.sin(a1)];
    q([p0[0],p0[1],0],[p1[0],p1[1],0],[p1[0],p1[1],h],[p0[0],p0[1],h]);
    t.push([cx,cy,0],[p1[0],p1[1],0],[p0[0],p0[1],0]);
    t.push([cx,cy,h],[p0[0],p0[1],h],[p1[0],p1[1],h]);
  }
  return t;
}
var CYL = cylTris(12, 15, 150, 150, 128);
function slice(tris, over) {
  var s = P.buildSettings('artillery_x2', 'pla', 'standard_02');
  s.skirtLoops = 0; s.brimWidth = 0;
  for (var k in over) s[k] = over[k];
  return E.slice({ positions: flat(tris), settings: s }, function () {}).gcode;
}
var round = segments(slice(CYL, {}));
console.log('  ' + round.lens.length + ' moves, busiest second ' + round.worst);
ok('a curved wall carries no move the machine cannot make (' + round.tiny + ')',
  round.tiny === 0, String(round.tiny));
ok('and the busiest second stays within what a board reads (' + round.worst + ')',
  round.worst < 400, String(round.worst));
var raw = segments(slice(CYL, { gcodeResolution: 0 }));
ok('which is the thinning doing it, not the shape (' + raw.tiny + ' without it)',
  raw.tiny > 100, String(raw.tiny));

console.log('\n=== 5. how far it goes to get there ===');
// Monotonic top surfaces exist so every line is laid the same way and the
// surface catches the light evenly. What they do NOT ask for is that a line
// wait for one it never touches — and a ring has a line on each side of the
// hole at every sweep position. Ordered by sweep position alone the nozzle
// crosses the ring twice per position: on a sphere that was 232 metres of
// travel and 43 minutes, for a constraint that was never real.
function travelled(gcode) {
  var lines = gcode.split('\n'), x = 0, y = 0, mm = 0, n = 0;
  for (var i = 0; i < lines.length; i++) {
    var L = lines[i].split(';')[0].trim();
    if (!/^G[01]\b/.test(L)) continue;
    var nx = x, ny = y;
    var mx = /X(-?[\d.]+)/.exec(L); if (mx) nx = parseFloat(mx[1]);
    var my = /Y(-?[\d.]+)/.exec(L); if (my) ny = parseFloat(my[1]);
    var d = Math.hypot(nx - x, ny - y);
    if (d > 0 && !/E-?\d/.test(L)) { mm += d; n++; }
    x = nx; y = ny;
  }
  return { m: mm / 1000, n: n };
}
function sphereTris(r, cx, cy, cz, n) {
  var t = [];
  function pt(u, v) {
    var th = u / n * Math.PI, ph = v / n * 2 * Math.PI;
    return [cx + r*Math.sin(th)*Math.cos(ph), cy + r*Math.sin(th)*Math.sin(ph), cz + r*Math.cos(th)];
  }
  for (var i = 0; i < n; i++) {
    for (var j = 0; j < n; j++) {
      var a = pt(i,j), b = pt(i+1,j), c = pt(i+1,j+1), d = pt(i,j+1);
      t.push(a, b, c, a, c, d);
    }
  }
  return t;
}
var BALL = sphereTris(25, 150, 150, 25, 48);
function sliceBall(over) {
  var s = P.buildSettings('artillery_x2', 'pla', 'standard_02');
  s.skirtLoops = 0; s.brimWidth = 0;
  for (var k in over) s[k] = over[k];
  return E.slice({ positions: flat(BALL), settings: s }, function () {});
}
var withMono = sliceBall({ monotonicSurfaces: 'top' });
var without = sliceBall({ monotonicSurfaces: 'none' });
var a = travelled(withMono.gcode), b = travelled(without.gcode);
console.log('  a 50 mm sphere: ' + a.m.toFixed(1) + ' m of travel with monotonic tops, ' +
  b.m.toFixed(1) + ' m without');
ok('an even top surface does not cost the print (' + a.m.toFixed(1) + ' m against ' +
   b.m.toFixed(1) + ')', a.m < b.m * 1.6, a.m.toFixed(1) + ' vs ' + b.m.toFixed(1));
ok('and the estimate stays in the same country (' +
   (withMono.stats.seconds / 60).toFixed(0) + ' min against ' +
   (without.stats.seconds / 60).toFixed(0) + ')',
  withMono.stats.seconds < without.stats.seconds * 1.3,
  withMono.stats.seconds + ' vs ' + without.stats.seconds);

// The point of the ordering has to survive the saving: on a surface with no
// hole in it, every line still waits for the one beside it.
var square = [];
(function () {
  var w = 30, h = 4, cx = 150, cy = 150;
  var x0=cx-w/2, x1=cx+w/2, y0=cy-w/2, y1=cy+w/2;
  function qd(a,b,c,e){ square.push(a,b,c,a,c,e); }
  var A=[x0,y0,0],B=[x1,y0,0],C=[x1,y1,0],D=[x0,y1,0];
  var E2=[x0,y0,h],F=[x1,y0,h],G=[x1,y1,h],H=[x0,y1,h];
  qd(A,D,C,B); qd(E2,F,G,H); qd(A,B,F,E2); qd(B,C,G,F); qd(C,D,H,G); qd(D,A,E2,H);
})();
var sq = P.buildSettings('artillery_x2', 'pla', 'standard_02');
sq.skirtLoops = 0; sq.brimWidth = 0; sq.monotonicSurfaces = 'top'; sq.ironing = 'none';
var flatTop = E.slice({ positions: flat(square), settings: sq }, function () {}).gcode;
// Every top-solid line on the last layer, in the order they were printed.
var order = [], seen = {}, z = '', type = '', px = 0, py = 0, run = null;
// Extrusion is a rising E, not the letter E. In absolute mode the wipe that
// starts a retraction carries an E lower than the one before it, and reading
// it as a line makes every other line look as if it ran backwards.
var lastE = 0, relative = false;
flatTop.split('\n').forEach(function (raw) {
  var mz = /^;Z:([\d.]+)/.exec(raw); if (mz) { z = mz[1]; run = null; }
  var t = /^;\s*TYPE:(.*)$/i.exec(raw);
  if (t) { type = t[1].trim().toLowerCase(); run = null; }
  var L = raw.split(';')[0].trim();
  if (/^M83\b/.test(L)) { relative = true; return; }
  if (/^M82\b/.test(L)) { relative = false; return; }
  if (/^G92\b/.test(L)) { var g = /E(-?[\d.]+)/.exec(L); if (g) lastE = parseFloat(g[1]); return; }
  if (!/^G[01]\b/.test(L)) return;
  var nx = px, ny = py, de = 0;
  var mx = /X(-?[\d.]+)/.exec(L); if (mx) nx = parseFloat(mx[1]);
  var my = /Y(-?[\d.]+)/.exec(L); if (my) ny = parseFloat(my[1]);
  var me = /E(-?[\d.]+)/.exec(L);
  if (me) {
    var v = parseFloat(me[1]);
    de = relative ? v : v - lastE;
    lastE = relative ? lastE + v : v;
  }
  if (de > 1e-6 && /top solid/.test(type) && Math.hypot(nx - px, ny - py) > 1) {
    if (!run) { run = { z: z, x0: px, y0: py, x1: nx, y1: ny }; (seen[z] = seen[z] || []).push(run); }
    else { run.x1 = nx; run.y1 = ny; }
  }
  px = nx; py = ny;
});
var last = Object.keys(seen).sort(function (u, v) { return parseFloat(v) - parseFloat(u); })[0];
order = seen[last] || [];
var sameWay = 0, backwards = 0, prevAcross = null;
if (order.length > 1) {
  var d0 = Math.hypot(order[0].x1 - order[0].x0, order[0].y1 - order[0].y0);
  var ax = -(order[0].y1 - order[0].y0) / d0, ay = (order[0].x1 - order[0].x0) / d0;
  var lx = (order[0].x1 - order[0].x0) / d0, ly = (order[0].y1 - order[0].y0) / d0;
  order.forEach(function (r) {
    var len = Math.hypot(r.x1 - r.x0, r.y1 - r.y0) || 1;
    if (((r.x1 - r.x0) / len) * lx + ((r.y1 - r.y0) / len) * ly > 0.9) sameWay++;
    var across = ((r.x0 + r.x1) / 2) * ax + ((r.y0 + r.y1) / 2) * ay;
    if (prevAcross !== null && across < prevAcross - 0.05) backwards++;
    prevAcross = across;
  });
}
console.log('  a flat top: ' + order.length + ' lines, ' + sameWay + ' laid the same way, ' +
  backwards + ' out of sweep order');
ok('a flat top is still laid one way throughout (' + sameWay + ' of ' + order.length + ')',
  order.length > 5 && sameWay === order.length, sameWay + '/' + order.length);
ok('and still in sweep order from one side to the other', backwards === 0, String(backwards));

console.log('\n=== 6. against the reference ===');
var REF = (function () {
  try { return cp.execSync('command -v prusa-slicer', { encoding: 'utf8' }).trim(); }
  catch (e) { return null; }
})();
if (!REF) {
  console.log('  prusa-slicer is not installed — the bounds above are all there is.');
} else {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'string-'));
  var stl = path.join(dir, 'towers.stl'), out = path.join(dir, 'ref.gcode');
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
    '--retract-length', '1', '--retract-speed', '35', '--retract-lift', '0.4',
    '--retract-before-travel', '1', '--skirts', '0', '--brim-width', '0',
    '--fill-pattern', 'grid', '--top-solid-layers', '4', '--bottom-solid-layers', '3',
    stl].map(String), { stdio: ['ignore', 'pipe', 'pipe'] });
  var ref = oozing(fs.readFileSync(out, 'utf8'));
  console.log('  reference: ' + ref.hot + ' hot travels (' + ref.hotLen.toFixed(0) +
    ' mm), longest ' + ref.longest.toFixed(1) + ' mm');
  ok('we drag no further than the reference does (' + mine.hotLen.toFixed(0) + ' vs ' +
    ref.hotLen.toFixed(0) + ' mm)', mine.hotLen <= ref.hotLen * 1.3,
    mine.hotLen.toFixed(0) + ' vs ' + ref.hotLen.toFixed(0));
  ok('and no single travel goes further than its longest (' + mine.longest.toFixed(1) +
    ' vs ' + ref.longest.toFixed(1) + ' mm)', mine.longest <= Math.max(2, ref.longest * 2),
    mine.longest.toFixed(2) + ' vs ' + ref.longest.toFixed(2));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
