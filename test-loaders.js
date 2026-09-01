/**
 * Web Slicer — reading files that are not quite right.
 *
 * A model downloaded from the internet is often a little broken: a face naming
 * a corner that was never given, a coordinate that does not parse, a file cut
 * short by a failed download. None of that should lose the whole model, and
 * none of it should hand the slicer a number that is not a number — one NaN in
 * the mesh and every measurement taken afterwards is NaN too.
 *
 *   node test-loaders.js
 */
globalThis.TextDecoder = globalThis.TextDecoder || require('util').TextDecoder;
var L = require('./js/slicer/loaders.js');

var pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); }
}
function tris(a) { return a ? a.length / 9 : 0; }
function sound(a) {
  for (var i = 0; i < a.length; i++) if (!isFinite(a[i])) return false;
  return true;
}
function enc(s) { return new TextEncoder().encode(s).buffer; }

/** A binary STL of `n` triangles, optionally lying about how many it holds. */
function binary(n, claimed) {
  var buf = new ArrayBuffer(84 + n * 50), v = new DataView(buf);
  v.setUint32(80, claimed === undefined ? n : claimed, true);
  for (var i = 0; i < n; i++) {
    var o = 84 + i * 50 + 12;
    for (var k = 0; k < 9; k++) { v.setFloat32(o, k + i, true); o += 4; }
  }
  return buf;
}

console.log('=== 1. binary STL ===');
ok('a sound one reads back', tris(L.parseSTL(binary(3))) === 3);
ok('one claiming more triangles than it holds reads what is there',
  tris(L.parseSTL(binary(3, 9999))) === 3, String(tris(L.parseSTL(binary(3, 9999)))));
ok('one claiming fewer is believed', tris(L.parseSTL(binary(3, 1))) === 1);
ok('a truncated one gives nothing rather than nonsense',
  tris(L.parseSTL(binary(3).slice(0, 120))) === 0);
// A corrupt float is still four bytes of file. Read as a coordinate it poisons
// the bounding box, the layer plan and everything after it.
var poisoned = binary(2), pv = new DataView(poisoned);
pv.setUint32(84 + 12, 0x7fc00000, true);                 // a NaN where X should be
var read = L.parseSTL(poisoned);
ok('a corrupt coordinate does not come through as one', sound(read),
  Array.from(read).slice(0, 3).join(','));

console.log('\n=== 2. ASCII STL ===');
var ascii = 'solid x\nfacet normal 0 0 0\nouter loop\n' +
  'vertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid x\n';
ok('a sound one reads back', tris(L.parseSTL(enc(ascii))) === 1);
ok('one cut in half gives nothing rather than half a triangle',
  tris(L.parseSTL(enc(ascii.slice(0, 60)))) === 0);
var twoTris = ascii.replace('endsolid x\n',
  'facet normal 0 0 0\nouter loop\nvertex 0 0 1\nvertex 1 0 1\nvertex 0 1 1\nendloop\nendfacet\nendsolid x\n');
var oneBad = twoTris.replace('vertex 0 0 1', 'vertex nan 0 1');
var kept = L.parseSTL(enc(oneBad));
ok('a corner that does not parse loses its own triangle, not the file (' +
   tris(kept) + ' of 2 kept)', tris(kept) === 1 && sound(kept), String(tris(kept)));
ok('and a file that is not a model at all reads as nothing',
  tris(L.parseSTL(enc('hello, this is a text file'))) === 0);

console.log('\n=== 3. OBJ ===');
ok('a triangle reads back', tris(L.parseOBJ('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n')) === 1);
ok('a quad is split into two', tris(L.parseOBJ('v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n')) === 2);
ok('negative indices count back from the end',
  tris(L.parseOBJ('v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1\n')) === 1);
ok('a face with texture and normal indices still reads',
  tris(L.parseOBJ('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1/1/1 2/2/2 3/3/3\n')) === 1);
// The one that mattered: a face naming a corner the file never gave used to
// come through as three NaNs.
var mixed = L.parseOBJ('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\nf 1 2 99\n');
ok('a face naming a corner that does not exist is dropped (' + tris(mixed) + ' of 2 kept)',
  tris(mixed) === 1 && sound(mixed), String(tris(mixed)));
ok('and a file of nothing but such faces reads as nothing',
  tris(L.parseOBJ('v 0 0 0\nf 1 2 3\n')) === 0);

console.log('\n=== 4. everything that comes out is a number ===');
[binary(3), binary(3, 9999), binary(3).slice(0, 120), new ArrayBuffer(84), new ArrayBuffer(0),
 enc(ascii), enc(oneBad), enc('nonsense')].forEach(function (buf, i) {
  var out = L.parseSTL(buf);
  if (!sound(out)) { fail++; console.log('  FAIL  case ' + i + ' produced a NaN'); }
});
['v 0 0 0\nf 1 2 3\n', 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 99\n', 'f 1 2 3\n', ''].forEach(function (t, i) {
  var out = L.parseOBJ(t);
  if (!sound(out)) { fail++; console.log('  FAIL  OBJ case ' + i + ' produced a NaN'); }
});
ok('across every damaged file above, not one NaN reaches the slicer', true);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
