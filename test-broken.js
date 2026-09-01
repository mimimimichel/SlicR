/**
 * Web Slicer — meshes that are not perfect, which most meshes are not.
 *
 * A file downloaded from the internet has holes in it, or normals the wrong
 * way round, or a stray vertex from whatever wrote it. None of that should
 * lose the print, and none of it should lose the app: the two failures worth
 * having are the right shape anyway, and a sentence saying what is wrong.
 *
 *   node test-broken.js
 */
globalThis.ClipperLib = require('./js/vendor/clipper.js');
globalThis.OrcaPresets = require('./js/slicer/presets.js');
require('./js/slicer/engine.js');
require('./js/slicer/beading.js');
require('./js/slicer/lightning.js');
require('./js/slicer/treesupport.js');
require('./js/slicer/template.js');
require('./js/slicer/gcodecheck.js');
var E = globalThis.OrcaEngine, P = globalThis.OrcaPresets, G = globalThis.OrcaEngineGeom;

var pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); }
}

function q(t, a, b, c, e) { t.push(a, b, c, a, c, e); }
function cubeTris(w, d, h, cx, cy) {
  var x0=cx-w/2, x1=cx+w/2, y0=cy-d/2, y1=cy+d/2, t=[];
  var A=[x0,y0,0], B=[x1,y0,0], C=[x1,y1,0], D=[x0,y1,0];
  var E2=[x0,y0,h], F=[x1,y0,h], G2=[x1,y1,h], H=[x0,y1,h];
  q(t,A,D,C,B); q(t,E2,F,G2,H); q(t,A,B,F,E2); q(t,B,C,G2,F); q(t,C,D,H,G2); q(t,D,A,E2,H);
  return t;
}
function flat(t) {
  var o = new Float32Array(t.length * 3), a = 0;
  for (var i = 0; i < t.length; i++) { o[a++]=t[i][0]; o[a++]=t[i][1]; o[a++]=t[i][2]; }
  return o;
}
function sliceIt(tris) {
  var s = P.buildSettings('artillery_x2', 'pla', 'q020');
  return E.slice({ positions: flat(tris), settings: s }, function () {});
}

console.log('=== 1. the outline closes even where the mesh does not ===');
// Slicing a cube at half height must give a 400 mm² square. Take facets out of
// it and it still has to: the walk runs off the end of the geometry, and what
// it has is joined up and closed rather than thrown away. An empty plate from
// a file that only needed a hole bridging is the worst answer available.
var whole = cubeTris(20, 20, 10, 150, 150);
function areaAtMidHeight(tris) {
  var r = G.sliceMesh(flat(tris), [5], function () {});
  var paths = r.layers ? r.layers[0] : r[0];
  return paths ? G.totalArea(paths) : 0;
}
ok('a sound cube slices to its own area (' + areaAtMidHeight(whole).toFixed(0) + ' mm²)',
  Math.abs(areaAtMidHeight(whole) - 400) < 0.5);

var oneGone = whole.slice(); oneGone.splice(12, 3);          // one triangle
ok('one facet missing is bridged exactly (' + areaAtMidHeight(oneGone).toFixed(0) + ' mm²)',
  Math.abs(areaAtMidHeight(oneGone) - 400) < 0.5, String(areaAtMidHeight(oneGone)));

var wallGone = whole.slice(); wallGone.splice(12, 6);        // a whole side
ok('a whole wall missing is bridged exactly (' + areaAtMidHeight(wallGone).toFixed(0) + ' mm²)',
  Math.abs(areaAtMidHeight(wallGone) - 400) < 0.5, String(areaAtMidHeight(wallGone)));

var halfGone = whole.slice(); halfGone.splice(12, 12);       // two sides
ok('but half an outline is not guessed at', areaAtMidHeight(halfGone) === 0,
  String(areaAtMidHeight(halfGone)));

console.log('\n=== 2. and the print comes out the same size ===');
var sound = sliceIt(whole);
[['one facet missing', oneGone], ['a whole wall missing', wallGone]].forEach(function (c) {
  var r = sliceIt(c[1]);
  ok(c[0] + ' prints the same material (' + r.stats.volumeCm3.toFixed(2) + ' cm³)',
    Math.abs(r.stats.volumeCm3 - sound.stats.volumeCm3) < 0.02,
    r.stats.volumeCm3 + ' vs ' + sound.stats.volumeCm3);
  var bad = r.report.findings.filter(function (f) { return f.severity === 'error'; });
  ok('and the file it makes is clean', bad.length === 0, JSON.stringify(bad[0]));
});

console.log('\n=== 3. the other kinds of damage ===');
var inverted = [];
for (var i = 0; i < whole.length; i += 3) inverted.push(whole[i], whole[i + 2], whole[i + 1]);
ok('normals the wrong way round print the same',
  Math.abs(sliceIt(inverted).stats.volumeCm3 - sound.stats.volumeCm3) < 0.02);

var degenerate = whole.slice();
for (var d = 0; d < 40; d++) degenerate.push([150,150,5], [150,150,5], [150,150,5]);
ok('triangles with no area are ignored',
  Math.abs(sliceIt(degenerate).stats.volumeCm3 - sound.stats.volumeCm3) < 0.02);

ok('the same solid twice, exactly overlapping, is printed once',
  Math.abs(sliceIt(whole.concat(whole)).stats.volumeCm3 - sound.stats.volumeCm3) < 0.02);

console.log('\n=== 4. what cannot be printed is refused in words ===');
// Not with a crash, and not with a tab that dies eight gigabytes later: one
// stray vertex used to mean fifty million layers, each of them an object.
function refuses(label, tris, match) {
  var err = null;
  try { sliceIt(tris); } catch (e) { err = e; }
  ok(label + (err ? ' (' + err.message.slice(0, 52) + '…)' : ''),
    !!err && match.test(err.message), err ? err.message : 'it did not refuse');
}
var stray = whole.slice(); stray[0] = [1e7, 1e7, 1e7];
refuses('a vertex ten metres out is refused', stray, /tall|layers/i);
var nan = whole.slice(); nan[0] = [NaN, 150, 0];
refuses('a corner that is not a number is refused', nan, /not a number/i);
var infinite = whole.slice(); infinite[0] = [Infinity, 150, 0];
refuses('and so is one at infinity', infinite, /not a number/i);
refuses('an empty mesh is refused', [], /empty/i);

// A file in metres is the everyday version of the same mistake, and the
// message has to be about the units rather than about layers.
var metres = cubeTris(20000, 20000, 10000, 150, 150);
var unitErr = null;
try { sliceIt(metres); } catch (e) { unitErr = e; }
ok('a mesh drawn in metres says so', !!unitErr && /units|metres/i.test(unitErr.message),
  unitErr ? unitErr.message : 'no error');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
