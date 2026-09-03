/**
 * Prismatic — is what we wrote actually a solid?
 *
 * A STEP file is easy to write and hard to write correctly: the syntax will
 * accept a shell with a seam down it, a face whose outline runs backwards, or a
 * loop that never closes, and none of that shows up until somebody opens the
 * file in Fusion and finds a surface body that will not take a fillet.
 *
 * So this reads the file back knowing nothing about the code that produced it —
 * a small part 21 parser, then the questions a solid modeller would ask. Is
 * every reference resolved. Is every edge used exactly twice, once in each
 * direction, which is what makes a shell closed rather than merely folded. Does
 * every loop come back to where it started. Do the corners of a face lie on
 * the plane the face claims. Does the outline run anticlockwise about the face
 * normal and the holes the other way. And then the question that catches
 * whatever the others missed: what volume do those faces enclose, computed from
 * the file alone — because if the answer matches the box we started from, the
 * geometry in there is the geometry we meant.
 *
 *   node test-step.js
 */
globalThis.earcut = require('./js/vendor/earcut.js');
var P = require('./prismatic/prismatic.js');
var S = require('./prismatic/step.js');

var pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail !== undefined ? '  -> ' + detail : '')); }
}
function near(a, b, tol) { return Math.abs(a - b) <= tol; }

// ---------------------------------------------------------------------------
// A part 21 reader, which knows nothing about what wrote the file
// ---------------------------------------------------------------------------

function parse(text) {
  var data = text.slice(text.indexOf('DATA;') + 5, text.lastIndexOf('ENDSEC;'));
  var at = 0;
  var entities = new Map();

  function skip() { while (at < data.length && /\s/.test(data[at])) at++; }

  function value() {
    skip();
    var ch = data[at];
    if (ch === '#') {
      var start = at++;
      while (/\d/.test(data[at])) at++;
      return { ref: data.slice(start, at) };
    }
    if (ch === "'") {
      at++;
      var out = '';
      while (at < data.length) {
        if (data[at] === "'" && data[at + 1] === "'") { out += "'"; at += 2; continue; }
        if (data[at] === "'") { at++; break; }
        out += data[at++];
      }
      return out;
    }
    if (ch === '(') return list();
    if (ch === '*' || ch === '$') { at++; return null; }
    if (ch === '.') {
      var from = at++;
      while (data[at] !== '.') at++;
      at++;
      return { enum: data.slice(from + 1, at - 1) };
    }
    var begin = at;
    while (at < data.length && !/[,)]/.test(data[at])) at++;
    var raw = data.slice(begin, at).trim();
    if (/^[A-Z_0-9]+\($/.test(raw + '(')) { /* keyword handled below */ }
    if (/^[-+.0-9]/.test(raw)) return parseFloat(raw);
    // A typed value: LENGTH_MEASURE(1.E-06)
    if (data[at] === '(' || raw.indexOf('(') >= 0) return raw;
    return raw;
  }

  function list() {
    var out = [];
    at++;               // (
    skip();
    if (data[at] === ')') { at++; return out; }
    while (at < data.length) {
      // A typed value inside a list, e.g. LENGTH_MEASURE(...)
      skip();
      var mark = at;
      var word = /^[A-Za-z_][A-Za-z_0-9]*/.exec(data.slice(at));
      if (word && data[at + word[0].length] === '(') {
        at += word[0].length;
        out.push({ typed: word[0], value: list() });
      } else {
        at = mark;
        out.push(value());
      }
      skip();
      if (data[at] === ',') { at++; continue; }
      if (data[at] === ')') { at++; break; }
      break;
    }
    return out;
  }

  while (at < data.length) {
    skip();
    if (data[at] !== '#') { at++; continue; }
    var idStart = at++;
    while (/\d/.test(data[at])) at++;
    var id = data.slice(idStart, at);
    skip();
    if (data[at] !== '=') continue;
    at++;
    skip();
    var parts = [];
    while (true) {
      skip();
      if (data[at] === '(') {                      // a complex entity: (A(..)B(..))
        var inner = at;
        at++;
        while (true) {
          skip();
          var sub = /^[A-Za-z_][A-Za-z_0-9]*/.exec(data.slice(at));
          if (!sub) break;
          at += sub[0].length;
          parts.push({ name: sub[0], params: list() });
          skip();
          if (data[at] === ')') { at++; break; }
        }
        if (!parts.length) at = inner;
        break;
      }
      var key = /^[A-Za-z_][A-Za-z_0-9]*/.exec(data.slice(at));
      if (!key) break;
      at += key[0].length;
      parts.push({ name: key[0], params: list() });
      break;
    }
    skip();
    if (data[at] === ';') at++;
    if (parts.length) entities.set(id, parts.length === 1 ? parts[0] : { name: 'COMPLEX', parts: parts, params: [] });
  }
  return entities;
}

/** Everything the file names, so a dangling reference cannot hide. */
function references(entities) {
  var out = [];
  function walk(v) {
    if (!v) return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v === 'object') {
      if (v.ref) { out.push(v.ref); return; }
      if (v.params) walk(v.params);
      if (v.parts) v.parts.forEach(walk);
      if (v.value) walk(v.value);
    }
  }
  entities.forEach(function (e) { walk(e.params); if (e.parts) e.parts.forEach(function (p) { walk(p.params); }); });
  return out;
}

// ---------------------------------------------------------------------------
// Reading the solid back out of it
// ---------------------------------------------------------------------------

function solidOf(entities) {
  var get = function (ref) { return entities.get(typeof ref === 'string' ? ref : ref.ref); };
  var pointOf = function (ref) { return get(ref).params[1]; };
  var dirOf = function (ref) { return get(ref).params[1]; };

  var faces = [];
  var edgeUse = new Map();     // EDGE_CURVE ref -> the senses it was used with
  var problems = [];

  function readLoop(loopRef, faceName) {
    var loop = get(loopRef);
    if (loop.name !== 'EDGE_LOOP') { problems.push('bound is not an EDGE_LOOP'); return null; }
    var chain = [];
    var oriented = loop.params[1];
    for (var i = 0; i < oriented.length; i++) {
      var oe = get(oriented[i]);
      if (oe.name !== 'ORIENTED_EDGE') { problems.push('loop holds ' + oe.name); return null; }
      var curveRef = oe.params[3].ref;
      var sense = oe.params[4].enum === 'T';
      var curve = get(curveRef);
      if (curve.name !== 'EDGE_CURVE') { problems.push('oriented edge on a ' + curve.name); return null; }
      var used = edgeUse.get(curveRef) || [];
      used.push(sense);
      edgeUse.set(curveRef, used);
      var v0 = curve.params[1].ref, v1 = curve.params[2].ref;
      chain.push(sense ? [v0, v1] : [v1, v0]);
    }
    // Head to tail, all the way round.
    for (var k = 0; k < chain.length; k++) {
      if (chain[k][1] !== chain[(k + 1) % chain.length][0]) {
        problems.push(faceName + ': loop does not close at step ' + k);
        return null;
      }
    }
    return chain.map(function (pair) {
      var vertex = get(pair[0]);
      return pointOf(vertex.params[1]);
    });
  }

  entities.forEach(function (e, id) {
    if (e.name !== 'ADVANCED_FACE') return;
    var bounds = e.params[1];
    var plane = get(e.params[2]);
    if (plane.name !== 'PLANE') { problems.push('face on a ' + plane.name); return; }
    var placement = get(plane.params[1]);
    var origin = pointOf(placement.params[1]);
    var axis = dirOf(placement.params[2]);
    var sameSense = e.params[3].enum === 'T';
    var loops = [];
    var outerFirst = true;
    for (var i = 0; i < bounds.length; i++) {
      var bound = get(bounds[i]);
      if (i === 0 && bound.name !== 'FACE_OUTER_BOUND') outerFirst = false;
      var points = readLoop(bound.params[1], '#' + id);
      if (!points) return;
      loops.push({ points: points, outer: bound.name === 'FACE_OUTER_BOUND', flip: bound.params[2].enum !== 'T' });
    }
    if (!outerFirst) problems.push('#' + id + ': the outer bound is not first');
    faces.push({ id: id, origin: origin, axis: axis, sameSense: sameSense, loops: loops });
  });

  return { faces: faces, edgeUse: edgeUse, problems: problems };
}

/** Signed area of a loop in its own plane, and the volume the faces enclose. */
function measure(solid) {
  var volume = 0, offPlane = 0, backwards = 0;
  solid.faces.forEach(function (face) {
    var n = face.axis;
    if (!face.sameSense) n = [-n[0], -n[1], -n[2]];
    var d = n[0] * face.origin[0] + n[1] * face.origin[1] + n[2] * face.origin[2];
    var ax = Math.abs(n[0]) < 0.9 ? 1 : 0, ay = 1 - ax;
    var u = [-n[2] * ay, n[2] * ax, n[0] * ay - n[1] * ax];
    var len = Math.hypot(u[0], u[1], u[2]) || 1;
    u = [u[0] / len, u[1] / len, u[2] / len];
    var v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];

    var area = 0;
    face.loops.forEach(function (loop) {
      var sum = 0;
      for (var i = 0; i < loop.points.length; i++) {
        var a = loop.points[i], b = loop.points[(i + 1) % loop.points.length];
        var gap = Math.abs(a[0] * n[0] + a[1] * n[1] + a[2] * n[2] - d);
        if (gap > offPlane) offPlane = gap;
        sum += (a[0] * u[0] + a[1] * u[1] + a[2] * u[2]) * (b[0] * v[0] + b[1] * v[1] + b[2] * v[2]) -
               (b[0] * u[0] + b[1] * u[1] + b[2] * u[2]) * (a[0] * v[0] + a[1] * v[1] + a[2] * v[2]);
      }
      sum = (loop.flip ? -sum : sum) / 2;
      // An outline runs anticlockwise about the normal, a hole the other way.
      if (loop.outer ? sum <= 0 : sum >= 0) backwards++;
      area += sum;
    });
    volume += d * area / 3;
  });
  return { volume: volume, offPlane: offPlane, backwards: backwards };
}

/** Everything above, on one shape. */
function check(label, positions, expect, options, exact) {
  console.log('\n=== ' + label + ' ===');
  var rebuilt = P.toSolid(positions, options);
  ok('it converts', rebuilt.ok, rebuilt.reason);
  var file = S.write(rebuilt.brep, { name: label });
  var text = file.text;

  ok('the file is part 21, and says which schema',
    /^ISO-10303-21;/.test(text) && /AUTOMOTIVE_DESIGN/.test(text) && /END-ISO-10303-21;\s*$/.test(text));
  // Part 21 keeps reals and integers apart, and a coordinate written as a bare
  // integer is an integer: some readers take it, some reject the file.
  var numeric = text.split('\n').filter(function (line) {
    return /CARTESIAN_POINT|DIRECTION\(|VECTOR\(|LENGTH_MEASURE/.test(line);
  });
  var bare = numeric.filter(function (line) { return /[(,]\s*-?\d+\s*[,)]/.test(line); });
  ok('every coordinate is written as a real, not an integer', bare.length === 0, bare[0]);
  ok('and nothing came out as a NaN', !/NaN|Infinity|undefined/.test(text));

  var entities = parse(text);
  ok('it reads back as ' + entities.size + ' entities', entities.size > 10);
  var dangling = references(entities).filter(function (r) { return !entities.has(r); });
  ok('with every reference resolved', dangling.length === 0, dangling.slice(0, 3).join(', '));

  var solid = solidOf(entities);
  ok('and ' + solid.faces.length + ' faces, each on a plane, each loop closed',
    solid.faces.length === file.faces && solid.problems.length === 0, solid.problems.slice(0, 2).join(' | '));

  // The one that makes it a solid rather than a heap of surfaces.
  var once = 0, twice = 0, sameWay = 0;
  solid.edgeUse.forEach(function (senses) {
    if (senses.length === 1) once++;
    else if (senses.length === 2) { twice++; if (senses[0] === senses[1]) sameWay++; }
  });
  ok('every edge is used by exactly two faces (' + twice + ' of ' + solid.edgeUse.size + ')',
    once === 0 && twice === solid.edgeUse.size, once + ' used once');
  ok('and the two run opposite ways down it', sameWay === 0, sameWay + ' agree');

  var found = measure(solid);
  // A file says how accurate it is, and then has to be that accurate. On a
  // part that came out of CAD the corners are exact intersections and land on
  // their planes to the last bit; on a mesh that never had corners, a vertex
  // shared by five faces that do not meet at a point cannot lie on all five,
  // and what the file promises has to be what it delivers.
  var declared = parseFloat(/LENGTH_MEASURE\(([^)]+)\)/.exec(text)[1]);
  ok('the file declares an accuracy of ' + declared.toExponential(1) + ' mm',
    declared >= 1e-7 && declared <= 1e-4, declared);
  ok('and every corner is on its plane to within it (' + found.offPlane.toExponential(1) + ' mm out)',
    found.offPlane <= declared, found.offPlane + ' vs ' + declared);
  if (exact !== false) {
    ok('exactly on it, this being a part that had corners', found.offPlane < 1e-9, found.offPlane);
  }
  ok('outlines run anticlockwise, holes clockwise', found.backwards === 0, found.backwards + ' backwards');
  ok('and the faces enclose ' + found.volume.toFixed(3) + ' mm3, which is the part',
    near(found.volume, expect, Math.max(Math.abs(expect) * 1e-6, 1e-4)), found.volume + ' vs ' + expect);
  return file;
}

// The same eyes are wanted on the file the browser saves, so they are lent out
// rather than written twice.
module.exports = { parse: parse, references: references, solidOf: solidOf, measure: measure };
if (require.main !== module) return;

// ---------------------------------------------------------------------------
// The shapes, borrowed from the conversion's own tests
// ---------------------------------------------------------------------------

var shapes = require('fs').readFileSync(__dirname + '/test-prismatic.js', 'utf8');
eval(shapes.slice(shapes.indexOf('function quad('), shapes.indexOf('// ------', shapes.indexOf('function quad(') + 100)));

console.log('Reading back what we write, as a solid modeller would.');

check('box', subdivide(box(20, 30, 10), 3), 6000);
check('plate-with-bore', drilled(40, 30, 5, 6, 32), (40 * 30 - 0.5 * 32 * 36 * Math.sin(2 * Math.PI / 32)) * 5);
check('cylinder', prism(64, 10, 20), 0.5 * 64 * 100 * Math.sin(2 * Math.PI / 64) * 20, { deviation: 0.001, angle: 0.2 });

// A mesh that was never prismatic still has to come out as a sound file, since
// nothing stops somebody trying it on one.
var ball = sphere(24, 10);
check('sphere', ball, P.volumeOf(P.toSolid(ball).positions), null, false);

console.log('\n=== two parts in one file ===');
var one = box(10, 10, 10);
var other = box(10, 10, 10);
for (var i = 0; i < other.length; i += 3) other[i] += 40;
var both = new Float32Array(one.length * 2);
both.set(one, 0); both.set(other, one.length);
var pair = S.write(P.toSolid(both).brep, { name: 'pair' });
ok('two bodies, not one impossible one', pair.bodies === 2, pair.bodies);
ok('written as solids', pair.solid);
var pairEntities = parse(pair.text);
var breps = 0, shells = 0;
pairEntities.forEach(function (e) {
  if (e.name === 'MANIFOLD_SOLID_BREP') breps++;
  if (e.name === 'CLOSED_SHELL') shells++;
});
ok('one closed shell and one solid each', breps === 2 && shells === 2, breps + ' / ' + shells);
ok('and they are named apart', /body 1/.test(pair.text) && /body 2/.test(pair.text));

console.log('\n=== a mesh with a hole in it is not called a solid ===');
var holed = new Float32Array(box(20, 30, 10).subarray(0, box(20, 30, 10).length - 9));
var surface = S.write(P.toSolid(holed).brep, { name: 'broken' });
ok('it is written as surfaces', !surface.solid && /SHELL_BASED_SURFACE_MODEL/.test(surface.text));
ok('as an open shell, which is what it is', /OPEN_SHELL/.test(surface.text));
ok('and not as a solid body', !/MANIFOLD_SOLID_BREP/.test(surface.text));
ok('under the representation that means surfaces',
  /MANIFOLD_SURFACE_SHAPE_REPRESENTATION/.test(surface.text) &&
  !/ADVANCED_BREP_SHAPE_REPRESENTATION/.test(surface.text));
var brokenRefs = parse(surface.text);
ok('and it still reads back whole',
  references(brokenRefs).filter(function (r) { return !brokenRefs.has(r); }).length === 0);

console.log('\n=== the numbers themselves ===');
ok('a whole number keeps its point', S.num(20) === '20.', S.num(20));
ok('a small one does not lose its digits', S.num(0.05) === '0.05', S.num(0.05));
ok('a tiny one goes to an exponent', /E-1[0-9]$/.test(S.num(1e-15)), S.num(1e-15));
ok('zero is zero', S.num(0) === '0.' && S.num(-0) === '0.', S.num(-0));
ok('and a long one is not written longer than a double is true',
  S.num(1 / 3).length <= 14, S.num(1 / 3));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
