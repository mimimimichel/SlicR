/**
 * Prismatic — rebuilding a solid out of a mesh.
 *
 * The conversion is only worth having if it is exact where it claims to be and
 * timid everywhere else, so the shapes here are ones whose answer is known
 * before the code runs: a box has six faces and a volume of w*d*h, a plate with
 * a square hole through it has a volume short by exactly that hole, and a mesh
 * that was never prismatic — a sphere — has to come back through untouched
 * rather than flattened into something the printer would show.
 *
 *   node test-prismatic.js
 */
globalThis.earcut = require('./js/vendor/earcut.js');
var Prim = require('./prismatic/primitives.js');
var P = require('./prismatic/prismatic.js');
var Solid = require('./prismatic/solid.js');

var pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail !== undefined ? '  -> ' + detail : '')); }
}
function near(a, b, tol) { return Math.abs(a - b) <= tol; }
function tris(a) { return (a.length / 9) | 0; }
function sound(a) {
  for (var i = 0; i < a.length; i++) if (!isFinite(a[i])) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Shapes whose answer is known
// ---------------------------------------------------------------------------

function quad(out, p, a, b, c, d) {
  out.push(p[a][0], p[a][1], p[a][2], p[b][0], p[b][1], p[b][2], p[c][0], p[c][1], p[c][2]);
  out.push(p[a][0], p[a][1], p[a][2], p[c][0], p[c][1], p[c][2], p[d][0], p[d][1], p[d][2]);
}

/** An axis-aligned box with one corner at the origin, wound outward. */
function box(w, d, h) {
  var p = [
    [0, 0, 0], [w, 0, 0], [w, d, 0], [0, d, 0],
    [0, 0, h], [w, 0, h], [w, d, h], [0, d, h]
  ];
  var out = [];
  quad(out, p, 0, 3, 2, 1);   // bottom
  quad(out, p, 4, 5, 6, 7);   // top
  quad(out, p, 0, 1, 5, 4);   // front
  quad(out, p, 1, 2, 6, 5);   // right
  quad(out, p, 2, 3, 7, 6);   // back
  quad(out, p, 3, 0, 4, 7);   // left
  return new Float32Array(out);
}

/** Every triangle into four, as many times as asked — the same shape, finer. */
function subdivide(positions, times) {
  var current = positions;
  for (var pass = 0; pass < times; pass++) {
    var out = new Float32Array(current.length * 4);
    var at = 0;
    for (var i = 0; i < current.length; i += 9) {
      var a = [current[i], current[i + 1], current[i + 2]];
      var b = [current[i + 3], current[i + 4], current[i + 5]];
      var c = [current[i + 6], current[i + 7], current[i + 8]];
      var ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      [[a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]].forEach(function (t) {
        for (var k = 0; k < 3; k++) { out[at++] = t[k][0]; out[at++] = t[k][1]; out[at++] = t[k][2]; }
      });
    }
    current = out;
  }
  return current;
}
function mid(a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]; }

/** A regular prism: the shape an STL of a cylinder actually is. */
function prism(sides, r, h) {
  var out = [];
  function ring(i, z) {
    var a = 2 * Math.PI * i / sides;
    return [r * Math.cos(a), r * Math.sin(a), z];
  }
  for (var i = 0; i < sides; i++) {
    var j = (i + 1) % sides;
    var b0 = ring(i, 0), b1 = ring(j, 0), t0 = ring(i, h), t1 = ring(j, h);
    out.push(b0[0], b0[1], b0[2], b1[0], b1[1], b1[2], t1[0], t1[1], t1[2]);
    out.push(b0[0], b0[1], b0[2], t1[0], t1[1], t1[2], t0[0], t0[1], t0[2]);
  }
  for (var k = 1; k < sides - 1; k++) {
    var t = [ring(0, h), ring(k, h), ring(k + 1, h)];
    var bt = [ring(0, 0), ring(k + 1, 0), ring(k, 0)];
    for (var m = 0; m < 3; m++) out.push(t[m][0], t[m][1], t[m][2]);
    for (var n = 0; n < 3; n++) out.push(bt[n][0], bt[n][1], bt[n][2]);
  }
  return new Float32Array(out);
}

/** A UV sphere — a mesh with no flat face anywhere on it. */
function sphere(seg, r) {
  var out = [];
  function at(i, j) {
    var phi = Math.PI * j / seg, theta = 2 * Math.PI * i / seg;
    return [r * Math.sin(phi) * Math.cos(theta), r * Math.sin(phi) * Math.sin(theta), r * Math.cos(phi)];
  }
  for (var j = 0; j < seg; j++) {
    for (var i = 0; i < seg; i++) {
      var a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
      if (j > 0) out.push(a[0], a[1], a[2], d[0], d[1], d[2], b[0], b[1], b[2]);
      if (j < seg - 1) out.push(b[0], b[1], b[2], d[0], d[1], d[2], c[0], c[1], c[2]);
    }
  }
  return new Float32Array(out);
}

/**
 * A plate with a square hole straight through it, tiled as a three by three
 * grid with the middle missing so that no vertex lands in the middle of
 * somebody else's edge — the plate has to be watertight before the conversion
 * is asked whether it kept it that way.
 */
function plate(w, d, h, s) {
  var xs = [0, (w - s) / 2, (w + s) / 2, w];
  var ys = [0, (d - s) / 2, (d + s) / 2, d];
  var out = [];

  for (var i = 0; i < 3; i++) {
    for (var j = 0; j < 3; j++) {
      if (i === 1 && j === 1) continue;
      var cell = [[xs[i], ys[j]], [xs[i + 1], ys[j]], [xs[i + 1], ys[j + 1]], [xs[i], ys[j + 1]]];
      var top = cell.map(function (c) { return [c[0], c[1], h]; });
      var bot = cell.map(function (c) { return [c[0], c[1], 0]; });
      quad(out, top, 0, 1, 2, 3);
      quad(out, bot, 0, 3, 2, 1);
    }
  }

  // Outer walls, split where the top face is split so no T-junction opens.
  function wall(ax, ay, bx, by) {
    var p = [[ax, ay, 0], [bx, by, 0], [bx, by, h], [ax, ay, h]];
    quad(out, p, 0, 1, 2, 3);
  }
  for (var k = 0; k < 3; k++) {
    wall(xs[k], 0, xs[k + 1], 0);                  // front, facing -Y
    wall(xs[k + 1], d, xs[k], d);                  // back
    wall(w, ys[k], w, ys[k + 1]);                  // right
    wall(0, ys[k + 1], 0, ys[k]);                  // left
  }
  // The hole's walls face into the hole, so they wind the other way round.
  wall(xs[2], ys[1], xs[1], ys[1]);
  wall(xs[2], ys[2], xs[2], ys[1]);
  wall(xs[1], ys[2], xs[2], ys[2]);
  wall(xs[1], ys[1], xs[1], ys[2]);
  return new Float32Array(out);
}

/**
 * A plate with a round hole drilled through it — a big flat face against
 * thirty-two little ones, which is where a rebuild that prunes its outlines
 * one face at a time opens cracks.
 */
function drilled(w, d, h, r, sides) {
  var cx = w / 2, cy = d / 2;
  var outer = [[0, 0], [w, 0], [w, d], [0, d]];
  var hole = [];
  for (var i = 0; i < sides; i++) {
    var a = -2 * Math.PI * i / sides;                 // clockwise, so it is a hole
    hole.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  var flat = [], holes = [outer.length];
  outer.concat(hole).forEach(function (pt) { flat.push(pt[0], pt[1]); });
  var index = earcut(flat, holes, 2);
  var out = [];
  for (var k = 0; k < index.length; k += 3) {
    var a0 = index[k] * 2, b0 = index[k + 1] * 2, c0 = index[k + 2] * 2;
    out.push(flat[a0], flat[a0 + 1], h, flat[b0], flat[b0 + 1], h, flat[c0], flat[c0 + 1], h);
    out.push(flat[a0], flat[a0 + 1], 0, flat[c0], flat[c0 + 1], 0, flat[b0], flat[b0 + 1], 0);
  }
  var corners = [[0, 0, 0], [w, 0, 0], [w, d, 0], [0, d, 0],
                 [0, 0, h], [w, 0, h], [w, d, h], [0, d, h]];
  quad(out, corners, 0, 1, 5, 4);
  quad(out, corners, 1, 2, 6, 5);
  quad(out, corners, 2, 3, 7, 6);
  quad(out, corners, 3, 0, 4, 7);
  for (var j = 0; j < sides; j++) {
    var p0 = hole[j], p1 = hole[(j + 1) % sides];
    var wallPts = [[p0[0], p0[1], 0], [p1[0], p1[1], 0], [p1[0], p1[1], h], [p0[0], p0[1], h]];
    quad(out, wallPts, 0, 1, 2, 3);      // facing into the bore
  }
  return new Float32Array(out);
}

/** Turn the whole soup about Z, then X — a part that was not laid down square. */
function rotate(positions, az, ax) {
  var out = new Float32Array(positions.length);
  var ca = Math.cos(az), sa = Math.sin(az), cb = Math.cos(ax), sb = Math.sin(ax);
  for (var i = 0; i < positions.length; i += 3) {
    var x = positions[i], y = positions[i + 1], z = positions[i + 2];
    var x1 = x * ca - y * sa, y1 = x * sa + y * ca;
    out[i] = x1;
    out[i + 1] = y1 * cb - z * sb;
    out[i + 2] = y1 * sb + z * cb;
  }
  return out;
}

/**
 * Push every vertex that sits in the middle of a box face off that face, the
 * way an exporter's rounding does. Corners and edges are left where they are,
 * so the box is still exactly the box it was — only its facets are no longer
 * quite flat.
 */
function roughen(positions, w, d, h, amount) {
  var out = new Float32Array(positions);
  var seed = 7;
  function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; }
  var noise = new Map();
  for (var i = 0; i < out.length; i += 3) {
    var x = out[i], y = out[i + 1], z = out[i + 2];
    var onX = near(x, 0, 1e-6) || near(x, w, 1e-6);
    var onY = near(y, 0, 1e-6) || near(y, d, 1e-6);
    var onZ = near(z, 0, 1e-6) || near(z, h, 1e-6);
    if ((onX ? 1 : 0) + (onY ? 1 : 0) + (onZ ? 1 : 0) !== 1) continue;   // edge or corner
    var key = x.toFixed(4) + ',' + y.toFixed(4) + ',' + z.toFixed(4);
    var n = noise.get(key);
    if (n === undefined) { n = rnd() * 2 * amount; noise.set(key, n); }
    if (onX) out[i] += n; else if (onY) out[i + 1] += n; else out[i + 2] += n;
  }
  return out;
}

function axisAligned(positions) {
  for (var i = 0; i < positions.length; i += 9) {
    var ux = positions[i + 3] - positions[i], uy = positions[i + 4] - positions[i + 1], uz = positions[i + 5] - positions[i + 2];
    var wx = positions[i + 6] - positions[i], wy = positions[i + 7] - positions[i + 1], wz = positions[i + 8] - positions[i + 2];
    var nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    var len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!(len > 0)) return false;
    var m = Math.max(Math.abs(nx), Math.abs(ny), Math.abs(nz)) / len;
    if (m < 1 - 1e-9) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------

console.log('=== 1. a box, cut into a thousand facets ===');
var plain = box(20, 30, 10);
var fine = subdivide(plain, 4);
ok('the fine box is the same shape, in ' + tris(fine) + ' triangles',
  tris(fine) === 12 * 256 && near(P.volumeOf(fine), 6000, 1e-3), P.volumeOf(fine));

var r1 = P.toSolid(fine);
ok('it converts', r1.ok, r1.reason);
ok('into six faces', r1.faces === 6, r1.faces);
ok('and twelve triangles, one solid box again', r1.triangles === 12, r1.triangles);
ok('holding the same volume', near(P.volumeOf(r1.positions), 6000, 1e-3), P.volumeOf(r1.positions));
ok('and still watertight', r1.watertight);
ok('with every face still on its axis', axisAligned(r1.positions));
ok('it says so: ' + r1.verdict, r1.verdict === 'prismatic');

console.log('\n=== 2. a box the exporter rounded off ===');
// Every facet is a little bent and no vertex sits quite on the face it belongs
// to. The corners are untouched, so the box is still 20 x 30 x 10.
var rough = roughen(subdivide(plain, 3), 20, 30, 10, 0.01);
var flat = P.toSolid(rough);
ok('the rough box is not flat to begin with',
  P.analyze(rough).deviation > 0.01, P.analyze(rough).deviation);
ok('it converts', flat.ok, flat.reason);
ok('into six faces', flat.faces === 6, flat.faces);
ok('flat to the last decimal now',
  P.analyze(flat.positions).deviation < 1e-6, P.analyze(flat.positions).deviation);
ok('within a thousandth of the volume it should have',
  near(P.volumeOf(flat.positions), 6000, 6), P.volumeOf(flat.positions));
ok('watertight', flat.watertight);
ok('and no vertex travelled further than the tolerance allowed',
  flat.moved <= P.DEFAULTS.deviation * 20, flat.moved);

console.log('\n=== 3. a part that was not laid down square ===');
var tilted = rotate(box(20, 30, 10), 10 * Math.PI / 180, 7 * Math.PI / 180);
var t1 = P.toSolid(subdivide(tilted, 3));
ok('six faces, whatever way round it sits', t1.ok && t1.faces === 6, t1.faces);
ok('same volume', near(P.volumeOf(t1.positions), 6000, 1e-2), P.volumeOf(t1.positions));
ok('and it is not dragged onto the axes it was never on', !axisAligned(t1.positions));

// A tenth of a degree out is a part that was meant to be square and is not
// — and squaring it up moves its far corner by 0.02 mm, inside the tolerance.
var barely = rotate(box(20, 30, 10), 0.1 * Math.PI / 180, 0);
var t2 = P.toSolid(subdivide(barely, 2));
ok('a tenth of a degree out, it is put back square', t2.ok && axisAligned(t2.positions), t2.reason);
ok('and left the size it was', near(P.volumeOf(t2.positions), 6000, 6), P.volumeOf(t2.positions));
var t3 = P.toSolid(subdivide(barely, 2), { snapAxes: false });
ok('unless you say not to', t3.ok && !axisAligned(t3.positions));

console.log('\n=== 4. a plate with a hole through it ===');
var holed = subdivide(plate(40, 30, 5, 10), 2);
ok('the plate is short by the hole', near(P.volumeOf(holed), (40 * 30 - 100) * 5, 1e-2), P.volumeOf(holed));
var h1 = P.toSolid(holed);
ok('it converts', h1.ok, h1.reason);
ok('into ten faces — two through the middle, eight walls', h1.faces === 10, h1.faces);
ok('the hole is still a hole', near(P.volumeOf(h1.positions), (40 * 30 - 100) * 5, 1e-2),
  P.volumeOf(h1.positions));
ok('the faces around it were rebuilt, not just kept', h1.rebuilt === 10, h1.rebuilt + ' rebuilt');
ok('from ' + tris(holed) + ' triangles down to ' + h1.triangles,
  h1.triangles < tris(holed) / 8, h1.triangles);
ok('watertight', h1.watertight);

console.log('\n=== 5. a plate with a hole drilled in it ===');
var bore = drilled(40, 30, 5, 6, 32);
var wall = 0.5 * 32 * 36 * Math.sin(2 * Math.PI / 32);
ok('the plate is short by the bore', near(P.volumeOf(bore), (40 * 30 - wall) * 5, 1e-2),
  P.volumeOf(bore));
var d1 = P.toSolid(bore);
ok('it converts', d1.ok, d1.reason);
ok('two faces through it, four walls, and one per facet of the bore: ' + d1.faces,
  d1.faces === 38, d1.faces);
ok('the bore is still round, not flattened',
  near(P.volumeOf(d1.positions), P.volumeOf(bore), Math.abs(P.volumeOf(bore)) * 0.002),
  P.volumeOf(d1.positions));
// The face around the bore drops the points along its straight sides. The
// thirty-two little faces on the bore itself keep every one of theirs. If that
// decision were made one face at a time the two would part company here.
ok('and the big face still meets the little ones', d1.watertight);

console.log('\n=== 6. a cylinder does not become one flat face ===');
// 512 sides puts 0.7 degrees between neighbouring facets — inside the angle
// tolerance. A face fitted as it grows would swallow the whole cylinder one
// harmless step at a time and hand back a sliver.
var fineCyl = prism(512, 10, 20);
var c1 = P.toSolid(fineCyl);
ok('the cylinder survives', c1.ok, c1.reason);
ok('as many faces, not one: ' + c1.faces, c1.faces > 20, c1.faces);
ok('holding its volume to within a percent',
  Math.abs(P.volumeOf(c1.positions) - Math.PI * 100 * 20) / (Math.PI * 100 * 20) < 0.01,
  P.volumeOf(c1.positions) + ' vs ' + (Math.PI * 100 * 20));
ok('watertight', c1.watertight);

// Told to hold a tighter line, it leaves the cylinder alone.
var c2 = P.toSolid(prism(64, 10, 20), { deviation: 0.001, angle: 0.2 });
ok('at a tight tolerance the facets are kept: ' + c2.faces + ' faces', c2.faces === 66, c2.faces);
ok('and the two caps are rebuilt from their outlines',
  c2.ok && c2.triangles === tris(prism(64, 10, 20)), c2.triangles);
ok('same volume', near(P.volumeOf(c2.positions), P.volumeOf(prism(64, 10, 20)), 1e-2));

console.log('\n=== 7. a mesh that was never prismatic ===');
var ball = sphere(24, 10);
var s1 = P.analyze(ball);
ok('it is called what it is: ' + s1.verdict, s1.verdict === 'organic', s1.planarArea);
var s2 = P.toSolid(ball);
ok('converting it changes nothing worth noticing',
  s2.ok && near(P.volumeOf(s2.positions), P.volumeOf(ball), Math.abs(P.volumeOf(ball)) * 0.005),
  P.volumeOf(s2.positions) + ' vs ' + P.volumeOf(ball));
ok('it stays whole', s2.watertight);
ok('and no triangles are invented', s2.triangles <= tris(ball), s2.triangles + ' of ' + tris(ball));
// A fine one is the hard case: thousands of faces of a handful of facets each,
// a few of them so nearly folded flat that the outline they triangulate to lays
// an edge some other face has already laid. Two of those on the whole sphere is
// enough to make it something other than a surface.
var fineBall = sphere(96, 10);
var s3 = P.toSolid(fineBall);
ok('a finer one comes back a surface, seams and all',
  s3.ok && s3.watertight, s3.reason + ' / ' + s3.triangles + ' triangles');
ok('holding its volume', near(P.volumeOf(s3.positions), P.volumeOf(fineBall),
  Math.abs(P.volumeOf(fineBall)) * 0.005), P.volumeOf(s3.positions));

console.log('\n=== 8. it refuses rather than reshapes ===');
// A hundredth of a millimetre of slack is one thing; two millimetres is the
// part itself. Asked for that, the conversion has to hand the mesh back.
var wild = P.toSolid(prism(32, 10, 20), { deviation: 4, angle: 40 });
ok('a tolerance wider than the part is rejected', !wild.ok, wild.faces + ' faces');
ok('and the mesh comes back exactly as it went in',
  wild.positions === undefined || tris(wild.positions) === tris(prism(32, 10, 20)));
ok('with a reason worth reading', /volume|empty|gaps/.test(wild.reason || ''), wild.reason);

console.log('\n=== 9. nothing here can hand the slicer a NaN ===');
var broken = [
  new Float32Array(0),
  new Float32Array(9),                                    // one degenerate triangle
  new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),          // a single facet, no solid
  new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0]),  // it, twice
  plain
];
broken.forEach(function (b, i) {
  var out;
  try { out = P.toSolid(b); } catch (e) { ok('case ' + i + ' does not throw', false, e.message); return; }
  ok('case ' + i + ' comes back sound', sound(out.positions) && out.positions.length % 9 === 0,
    out.positions.length);
});
var open = new Float32Array(plain.subarray(0, plain.length - 9));   // a box missing a facet
var o1 = P.toSolid(open);
ok('a box with a facet missing is not reported watertight', !o1.watertight);
ok('and is still converted rather than refused', o1.ok, o1.reason);

console.log('\n=== 10. what analyze says before anything is touched ===');
var a1 = P.analyze(fine);
ok('the fine box reads as six faces over ' + a1.triangles + ' triangles',
  a1.faces === 6 && a1.triangles === 3072, a1.faces);
ok('all of its surface is flat', a1.planarArea > 0.999, a1.planarArea);
ok('and it is whole', a1.watertight);
ok('an empty mesh is empty, not a crash', P.analyze(new Float32Array(0)).verdict === 'empty');

console.log('\n=== 11. how coarse the mesh is, and drawing what was found ===');
{
  // The number that says what recognising a mesh's curves will cost. A polygon
  // standing in for a circle has the arc outside it, and calling the polygon a
  // cylinder moves the surface out there: below that price nothing can be
  // recognised at all, however loose the tolerance. It is a property of the
  // mesh, not of the part, which is the whole reason it has to be measured.
  ok('a box has no curves to pay for', P.analyze(fine).faceting < 1e-9,
    P.analyze(fine).faceting);
  // And how big its curves are, which is not how big the part is. A rosary is
  // sixty-four millimetres across and made of beads four millimetres round: a
  // percent of the part is a sixth of a bead, and at that tolerance a bead is
  // within reach of being called a cylinder. It came back as ten little drums.
  ok('a ball of ten knows it is a ball of ten (' + P.analyze(sphere(32, 10)).radius.toFixed(2) + ')',
    near(P.analyze(sphere(32, 10)).radius, 10, 0.3), P.analyze(sphere(32, 10)).radius);
  ok('and a six millimetre bore that it is six (' + P.analyze(drilled(40, 30, 5, 6, 32)).radius.toFixed(2) + ')',
    near(P.analyze(drilled(40, 30, 5, 6, 32)).radius, 6, 0.2),
    P.analyze(drilled(40, 30, 5, 6, 32)).radius);
  ok('a part with no curves in it has no radius to report',
    P.analyze(fine).radius === 0, P.analyze(fine).radius);

  var fineBall = P.analyze(sphere(64, 10)).faceting;
  var roughBall = P.analyze(sphere(16, 10)).faceting;
  ok('the same ball costs more the more coarsely it is drawn (' +
    fineBall.toFixed(4) + ' vs ' + roughBall.toFixed(4) + ' mm)',
    roughBall > fineBall * 5, fineBall + ' vs ' + roughBall);
  // A 16-sided ball of radius 10 has its arc 0.19 mm outside its facets, and
  // the estimate has to land near that or it is no use as something to aim at.
  var truth = 10 * (1 - Math.cos(Math.PI / 16));
  ok('and the price is about what the geometry says it is (' + roughBall.toFixed(3) +
    ' against ' + truth.toFixed(3) + ' mm)',
    roughBall > truth * 0.5 && roughBall < truth * 3, roughBall + ' vs ' + truth);

  // Drawing it. The triangles are put back onto the surfaces they were
  // recognised as, which is the only way the screen can answer "did it find the
  // shape". Done carelessly it is worse than not doing it: a sliver whose
  // corner is pulled further than the sliver is wide comes out as a spike
  // through the surface, and a few hundred of those is shrapnel rather than a
  // part. So: nothing may turn inside out, and nothing may move further than
  // the tolerance that put the surface there.
  // A doughnut the way somebody models one: the shape is exact, the surface is
  // not. It is the case the whole of this is for, and the one the clean shapes
  // above never reach — the rebuild leaves folded slivers where a wobbly
  // surface turns over, and every one of them used to be promoted to a face of
  // its own. On the part this came from, forty-two of fifty-nine faces carried
  // three hundredths of one percent of the surface between them, which is what
  // turns a doughnut and three cylinders into a mosaic.
  function roughTorus(R, r, round, tube, wobble) {
    var seed = 12345;
    var rnd = function () { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
    var pts = [], out = [];
    for (var i = 0; i < round; i++) {
      pts.push([]);
      for (var j = 0; j < tube; j++) {
        var u = 2 * Math.PI * i / round, v = 2 * Math.PI * j / tube;
        var rr = r + wobble * rnd();
        pts[i].push([(R + rr * Math.cos(v)) * Math.cos(u), (R + rr * Math.cos(v)) * Math.sin(u),
          rr * Math.sin(v)]);
      }
    }
    for (var a = 0; a < round; a++) {
      for (var b = 0; b < tube; b++) {
        var p = pts[a][b], q = pts[(a + 1) % round][b];
        var w = pts[(a + 1) % round][(b + 1) % tube], t = pts[a][(b + 1) % tube];
        out.push(p[0], p[1], p[2], q[0], q[1], q[2], w[0], w[1], w[2]);
        out.push(p[0], p[1], p[2], w[0], w[1], w[2], t[0], t[1], t[2]);
      }
    }
    return new Float32Array(out);
  }
  function areaOf(body, face) {
    // The two halves of a whole ball or a whole doughnut are bounded by a seam
    // that is one point, so there is no outline to measure and nothing to ask.
    if (face.seam) return Infinity;
    var whole = 0;
    face.points.forEach(function (loop) {
      var nx = 0, ny = 0, nz = 0;
      for (var i = 0; i < loop.length; i++) {
        var A = loop[i], B = loop[(i + 1) % loop.length];
        nx += (body.vertices[A * 3 + 1] - body.vertices[B * 3 + 1]) * (body.vertices[A * 3 + 2] + body.vertices[B * 3 + 2]);
        ny += (body.vertices[A * 3 + 2] - body.vertices[B * 3 + 2]) * (body.vertices[A * 3] + body.vertices[B * 3]);
        nz += (body.vertices[A * 3] - body.vertices[B * 3]) * (body.vertices[A * 3 + 1] + body.vertices[B * 3 + 1]);
      }
      whole += Math.hypot(nx, ny, nz) / 2;
    });
    return whole;
  }
  {
    var wobbly = roughTorus(12, 3, 96, 48, 0.05);
    var rebuilt = P.toSolid(wobbly, { deviation: 0.02 });
    ok('a doughnut nobody drew exactly still converts', rebuilt.ok, rebuilt.reason);

    var loose = Solid.build(rebuilt.brep, { tolerance: 0.3 });
    ok('and opened up far enough it is one doughnut, in two halves (' +
      loose.faces.length + ' faces)',
      loose.counts.torus === 1 && loose.faces.length === 2, JSON.stringify(loose.counts));

    // Held closer it keeps more of its lumps, and that is right — but what it
    // keeps has to be faces. Anything smaller than the square of the distance
    // the surfaces were allowed to move is smaller than the answer's own
    // resolution: there is nothing in it to describe, and it is given to
    // whichever neighbour it shares the most boundary with.
    var tight = Solid.build(rebuilt.brep, { tolerance: 0.1 });
    var sizes = tight.faces.map(function (f) { return areaOf(tight, f); });
    var real = sizes.filter(function (a) { return isFinite(a); });
    var whole = real.reduce(function (t, a) { return t + a; }, 0);
    var least = 0.1 * 0.1;
    var crumbs = real.filter(function (a) { return a < least; });
    var dust = crumbs.reduce(function (t, a) { return t + a; }, 0);
    ok('and held closer, next to none of its ' + tight.faces.length +
      ' faces is too small to be one (' + crumbs.length + ')',
      crumbs.length <= tight.faces.length * 0.05, crumbs.length + ' of ' + tight.faces.length);
    ok('nor is any measurable part of the surface in them (' +
      (100 * dust / whole).toFixed(4) + '%)', dust < whole * 0.001, dust + ' of ' + whole);
  }

  // Where two faces meet, the curve they meet along is the curve their surfaces
  // cross in — an exact thing, not something to be recovered from the staircase
  // of facet edges that approximates it. This is what a modeller does and what
  // this did not: fitting a circle to the staircase only works when the
  // staircase is tidy, and where a plane cuts a doughnut it is not, so the
  // boundary came back as a hundred and forty separate little lines.
  {
    var ring = { type: 'torus', centre: [0, 0, 0], axis: [0, 0, 1], major: 12, minor: 3,
      radius: 3, outward: true };
    var lid = { type: 'plane', x: 0, y: 0, z: 1, d: 1.5 };
    // At that height the tube is sqrt(9 - 2.25) wide, so the plane cuts the
    // doughnut in two circles, one either side of the ring.
    var reach = Math.sqrt(9 - 2.25);
    var outer = Prim.crossing(lid, ring, [14.5, 0, 1.5], 0.05);
    var inner = Prim.crossing(lid, ring, [9.5, 0, 1.5], 0.05);
    ok('a plane through a doughnut crosses it in a circle, exactly (' +
      (outer && outer.radius.toFixed(6)) + ')',
      outer && outer.type === 'circle' && near(outer.radius, 12 + reach, 1e-9),
      outer && outer.radius);
    ok('and it finds the branch it was asked about (' + (inner && inner.radius.toFixed(6)) + ')',
      inner && near(inner.radius, 12 - reach, 1e-9), inner && inner.radius);

    var bore = { type: 'cylinder', axis: [0, 0, 1], point: [0, 0, 0], radius: 5, outward: true };
    var square = Prim.crossing({ type: 'plane', x: 0, y: 0, z: 1, d: 7 }, bore, [5, 0, 7], 0.05);
    ok('a plane square to a bore crosses it in the bore\'s own circle',
      square && square.type === 'circle' && near(square.radius, 5, 1e-9), square && square.radius);
    // Along the bore they cross in two straight lines, which is not a circle
    // and not something to pretend about.
    ok('a plane along a bore is left to the mesh',
      Prim.crossing({ type: 'plane', x: 1, y: 0, z: 0, d: 0 }, bore, [0, 5, 0], 0.05) === null);
    ok('and two planes cross in a line',
      (Prim.crossing({ type: 'plane', x: 0, y: 0, z: 1, d: 3 },
        { type: 'plane', x: 1, y: 0, z: 0, d: 2 }, [2, 0, 3], 0.05) || {}).type === 'line');

    // End to end, on the doughnut nobody drew exactly. What matters is that a
    // boundary is a few edges rather than one per facet.
    var edged = Solid.build(P.toSolid(roughTorus(12, 3, 96, 48, 0.05), { deviation: 0.02 }).brep,
      { tolerance: 0.2 });
    ok('and a boundary comes back as a few edges, not one per facet (' +
      (edged.edges.length / edged.faces.length).toFixed(1) + ' per face)',
      edged.edges.length < edged.faces.length * 6,
      edged.edges.length + ' edges over ' + edged.faces.length + ' faces');
  }

  // Working the drawing out used to be given up on past four hundred faces,
  // and the edges of the solid went on being drawn over the colours of the mesh
  // underneath — one thing's boundaries on another thing's faces. There is no
  // limit now: the faces are looked up by where they are rather than asked one
  // by one.
  {
    var many = P.toSolid(sphere(48, 10), { deviation: 0.002, angle: 0.2 });
    var crowd = Solid.build(many.brep, { tolerance: 0.002 });
    ok('a solid of ' + crowd.faces.length + ' faces is still worked out',
      crowd.faces.length > 400 && !!Solid.featuresOf(crowd, many.positions, 0.002),
      crowd.faces.length);
  }

  // The ball moves and the bore does not, and both are right. Every corner of a
  // bore's facets already sits on the cylinder — the polygon touches the circle
  // there, it is the middles that are inside it, and a mesh has no vertex in
  // the middle of a facet. A ball has rings of vertices between its poles that
  // are off the sphere, and those are the ones that move.
  [['ball', sphere(32, 10), 0.3, true], ['bore', drilled(40, 30, 5, 6, 32), 0.2, false]]
    .forEach(function (each) {
    var name = each[0], mesh = each[1], tol = each[2], expectMove = each[3];
    var built = P.toSolid(mesh, { deviation: 0.02 });
    var body = Solid.build(built.brep, { tolerance: tol });
    var features = Solid.featuresOf(body, built.positions, tol);
    ok(name + ': every triangle is asked which face it is on', !!features);
    // And every one of them has an answer. A triangle left on no face is drawn
    // in the leftover colour, so it shows as a patch of a different colour in
    // the middle of a face with no edge between it and its neighbours — because
    // there is no edge between them, they are the same face. It happens when
    // this asks a stricter question than the recognition did.
    var orphans = 0;
    for (var q = 0; q < features.length; q++) if (features[q] === body.faces.length) orphans++;
    ok(name + ': and none of them is left belonging to nothing', orphans === 0,
      orphans + ' of ' + features.length);
    var drawn = Solid.smoothed(body, built.positions, features, tol);
    var count = built.positions.length / 9;
    var turned = 0, blown = 0, worst = 0;
    function facing(a, o) {
      var ux = a[o + 3] - a[o], uy = a[o + 4] - a[o + 1], uz = a[o + 5] - a[o + 2];
      var wx = a[o + 6] - a[o], wy = a[o + 7] - a[o + 1], wz = a[o + 8] - a[o + 2];
      return [uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx];
    }
    for (var t = 0; t < count; t++) {
      var o = t * 9;
      var was = facing(built.positions, o), now = facing(drawn, o);
      if (was[0] * now[0] + was[1] * now[1] + was[2] * now[2] < 0) turned++;
      var before = Math.hypot(was[0], was[1], was[2]), after = Math.hypot(now[0], now[1], now[2]);
      if (before > 0 && after > before * 4) blown++;
    }
    for (var v = 0; v < built.positions.length; v += 3) {
      var moved = Math.hypot(drawn[v] - built.positions[v], drawn[v + 1] - built.positions[v + 1],
        drawn[v + 2] - built.positions[v + 2]);
      if (moved > worst) worst = moved;
    }
    ok(name + ': and none of them is turned inside out drawing it', turned === 0, turned);
    ok(name + ': nor stretched out of all recognition', blown === 0, blown);
    ok(name + ': no corner moves further than the tolerance (' + worst.toFixed(4) + ' mm)',
      worst <= tol + 1e-9, worst + ' vs ' + tol);
    ok(expectMove ? name + ': and the corners that were off the surface moved onto it'
      : name + ': and its corners were on the surface already, so nothing moved',
      expectMove ? worst > 1e-6 : worst < 1e-9, worst);
  });
}

console.log('\n=== 12. what a setting actually cost, as opposed to what it allowed ===');
{
  // Choosing a setting by the tolerance it was given is choosing by the budget
  // rather than by the bill. What matters is how far the mesh really had to
  // move to become these surfaces, which is a fraction of what was allowed on
  // a part that fits well and all of it on one that does not — so it is
  // measured and reported, and the search upstairs spends it rather than the
  // tolerance.
  var flat = P.toSolid(box(20, 12, 8), { deviation: 0.01 });
  var square = Solid.build(flat.brep, { tolerance: 0.5 });
  ok('a box sits exactly on its own planes, however loose the setting (' +
    square.strain.toExponential(1) + ')', square.strain < 1e-9, square.strain);

  var holed = P.toSolid(drilled(40, 30, 5, 6, 32), { deviation: 0.01 });
  var bore = Solid.build(holed.brep, { tolerance: 0.3 });
  ok('a bore found as a cylinder says how far off the mesh it sits (' +
    bore.strain.toFixed(4) + ' mm)', bore.strain > 1e-6 && bore.strain <= 0.3 + 1e-9,
    bore.strain);
  // The whole point of measuring it: the setting had to be 0.3 for the
  // cylinder to be found at all, and having found it the surface sits a good
  // deal closer than that. Reporting 0.3 would be reporting the permission.
  ok('and that it sits closer than it was allowed to', bore.strain < 0.3 * 0.9,
    bore.strain);
  ok('a body with nothing recognised in it has nothing to declare',
    Solid.build(holed.brep, { recognise: false }).strain === 0);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
