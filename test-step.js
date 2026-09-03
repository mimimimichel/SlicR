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
 * every loop come back to where it started. Does every corner lie on the
 * surface its face claims — a plane, or now a cylinder, a cone or a sphere.
 *
 * And then the question that catches whatever the others missed. The faces are
 * built back into a mesh from nothing but what the file says — circles sampled
 * round, cylinders walked over, each face triangulated in its own surface —
 * and the volume of that mesh is compared with the volume of the part. If a
 * cylinder is the wrong radius, if a circle turns the wrong way, if a face is
 * inside out, the number moves. For a plate with a six millimetre bore it has
 * to come back short by exactly the bore.
 *
 *   node test-step.js
 */
globalThis.earcut = require('./js/vendor/earcut.js');
require('./prismatic/primitives.js');
var P = require('./prismatic/prismatic.js');
var Solid = require('./prismatic/solid.js');
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

function unit(v) {
  var len = Math.hypot(v[0], v[1], v[2]);
  return len > 0 ? [v[0] / len, v[1] / len, v[2] / len] : [0, 0, 1];
}
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function add(a, b, k) { return [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k]; }
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }

function solidOf(entities) {
  var get = function (ref) { return entities.get(typeof ref === 'string' ? ref : ref.ref); };
  var raw = function (ref) { return get(ref).params[1]; };

  var faces = [];
  var edgeUse = new Map();
  var problems = [];

  function placementOf(ref) {
    var p = get(ref);
    var axis = p.params[2] ? raw(p.params[2]) : [0, 0, 1];
    var refDir = p.params[3] ? raw(p.params[3]) : null;
    return { at: raw(p.params[1]), axis: unit(axis), ref: refDir ? unit(refDir) : null };
  }

  function curveOf(ref) {
    var c = get(ref);
    if (c.name === 'LINE') return { type: 'line' };
    if (c.name === 'CIRCLE') {
      var place = placementOf(c.params[1]);
      return { type: 'circle', centre: place.at, axis: place.axis, radius: c.params[2] };
    }
    problems.push('an edge on a ' + c.name);
    return null;
  }

  function readLoop(loopRef, name) {
    var loop = get(loopRef);
    if (loop.name !== 'EDGE_LOOP') { problems.push('bound is not an EDGE_LOOP'); return null; }
    var steps = [];
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
      var geometry = curveOf(curve.params[3]);
      if (!geometry) return null;
      var from = sense ? v0 : v1, to = sense ? v1 : v0;
      steps.push({
        from: raw(get(from).params[1]), to: raw(get(to).params[1]),
        fromRef: from, toRef: to, geometry: geometry, forward: sense
      });
    }
    for (var k = 0; k < steps.length; k++) {
      if (steps[k].toRef !== steps[(k + 1) % steps.length].fromRef) {
        problems.push(name + ': loop does not close at step ' + k);
        return null;
      }
    }
    return steps;
  }

  entities.forEach(function (e, id) {
    if (e.name !== 'ADVANCED_FACE') return;
    var bounds = e.params[1];
    var surf = get(e.params[2]);
    var sameSense = e.params[3].enum === 'T';
    var surface = null;
    if (surf.name === 'PLANE') {
      var p0 = placementOf(surf.params[1]);
      surface = { type: 'plane', at: p0.at, axis: p0.axis };
    } else if (surf.name === 'CYLINDRICAL_SURFACE') {
      var p1 = placementOf(surf.params[1]);
      surface = { type: 'cylinder', at: p1.at, axis: p1.axis, radius: surf.params[2] };
    } else if (surf.name === 'CONICAL_SURFACE') {
      var p2 = placementOf(surf.params[1]);
      surface = { type: 'cone', at: p2.at, axis: p2.axis, radius: surf.params[2], half: surf.params[3] };
    } else if (surf.name === 'TOROIDAL_SURFACE') {
      var p4 = placementOf(surf.params[1]);
      surface = { type: 'torus', at: p4.at, axis: p4.axis, major: surf.params[2], minor: surf.params[3] };
    } else if (surf.name === 'SPHERICAL_SURFACE') {
      var p3 = placementOf(surf.params[1]);
      surface = { type: 'sphere', at: p3.at, axis: p3.axis, radius: surf.params[2] };
    } else {
      problems.push('a face on a ' + surf.name);
      return;
    }

    var loops = [];
    for (var i = 0; i < bounds.length; i++) {
      var bound = get(bounds[i]);
      var steps = readLoop(bound.params[1], '#' + id);
      if (!steps) return;
      loops.push({ steps: steps, outer: bound.name === 'FACE_OUTER_BOUND' });
    }
    faces.push({ id: id, surface: surface, sameSense: sameSense, loops: loops });
  });

  return { faces: faces, edgeUse: edgeUse, problems: problems };
}

// ---------------------------------------------------------------------------
// Building the solid back into a mesh, from the file alone
// ---------------------------------------------------------------------------

// Steps to walk a full circle in. A circle rebuilt as an N sided polygon is
// short of the real thing by about (2*pi/N)^2/6 of its area — a hundred and
// eighty steps puts that at two parts in ten thousand, comfortably inside what
// the volume is checked to.
var ROUND = 180;

/** Where a point on this surface faces, material outward. */
function normalOf(surface, sameSense, p) {
  var n;
  if (surface.type === 'plane') n = surface.axis;
  else if (surface.type === 'sphere') n = unit(sub(p, surface.at));
  else if (surface.type === 'torus') {
    var wt = sub(p, surface.at);
    var alongT = dot(wt, surface.axis);
    var radialT = unit(sub(wt, [surface.axis[0] * alongT, surface.axis[1] * alongT, surface.axis[2] * alongT]));
    n = unit(sub(p, add(surface.at, radialT, surface.major)));
  }
  else {
    var w = sub(p, surface.at);
    var along = dot(w, surface.axis);
    var radial = unit(sub(w, [surface.axis[0] * along, surface.axis[1] * along, surface.axis[2] * along]));
    if (surface.type === 'cylinder') n = radial;
    else n = unit([
      radial[0] * Math.cos(surface.half) - surface.axis[0] * Math.sin(surface.half),
      radial[1] * Math.cos(surface.half) - surface.axis[1] * Math.sin(surface.half),
      radial[2] * Math.cos(surface.half) - surface.axis[2] * Math.sin(surface.half)
    ]);
  }
  return sameSense ? n : [-n[0], -n[1], -n[2]];
}

/** How far a point is from the surface it is supposed to be on. */
function offSurface(surface, p) {
  if (surface.type === 'plane') return Math.abs(dot(sub(p, surface.at), surface.axis));
  if (surface.type === 'torus') {
    var wt = sub(p, surface.at);
    var alongT = dot(wt, surface.axis);
    var radialT = Math.hypot.apply(null, sub(wt, [surface.axis[0] * alongT, surface.axis[1] * alongT, surface.axis[2] * alongT]));
    var outT = radialT - surface.major;
    return Math.abs(Math.sqrt(outT * outT + alongT * alongT) - surface.minor);
  }
  if (surface.type === 'sphere') return Math.abs(Math.hypot.apply(null, sub(p, surface.at)) - surface.radius);
  var w = sub(p, surface.at);
  var along = dot(w, surface.axis);
  var radial = Math.hypot.apply(null, sub(w, [surface.axis[0] * along, surface.axis[1] * along, surface.axis[2] * along]));
  if (surface.type === 'cylinder') return Math.abs(radial - surface.radius);
  // A cone's radius grows along its axis at the tangent of its half angle.
  return Math.abs((radial - surface.radius) * Math.cos(surface.half) - along * Math.sin(surface.half));
}

/** A loop of edges, walked as a polyline: circles sampled, lines taken as they are. */
function walkLoop(steps) {
  var out = [];
  steps.forEach(function (step) {
    if (step.geometry.type === 'line') { out.push(step.from); return; }
    var c = step.geometry;
    var axis = step.forward ? c.axis : [-c.axis[0], -c.axis[1], -c.axis[2]];
    var u = unit(sub(step.from, c.centre));
    var v = cross(axis, u);
    var end = sub(step.to, c.centre);
    var angle = Math.atan2(dot(end, v), dot(end, u));
    if (angle <= 1e-9) angle += 2 * Math.PI;      // a closed edge goes all the way round
    var steps2 = Math.max(2, Math.ceil(ROUND * angle / (2 * Math.PI)));
    for (var i = 0; i < steps2; i++) {
      var t = angle * i / steps2;
      out.push([
        c.centre[0] + c.radius * (u[0] * Math.cos(t) + v[0] * Math.sin(t)),
        c.centre[1] + c.radius * (u[1] * Math.cos(t) + v[1] * Math.sin(t)),
        c.centre[2] + c.radius * (u[2] * Math.cos(t) + v[2] * Math.sin(t))
      ]);
    }
  });
  return out;
}

/**
 * A face, turned back into triangles using only what the file says it is. A
 * flat face is triangulated in its own plane; a cylinder or cone closed all the
 * way round is stitched between the two rings that bound it; anything else is
 * flattened into the surface's own two parameters and triangulated there.
 */
function tessellate(face) {
  var s = face.surface;
  var rings = face.loops.map(function (loop) { return walkLoop(loop.steps); });

  if (s.type === 'plane') {
    var u = unit(cross(s.axis, Math.abs(s.axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
    var v = cross(s.axis, u);
    return flatten(rings, function (p) { return [dot(p, u), dot(p, v)]; }, function (xy) {
      var base = dot(s.at, s.axis);
      return [
        u[0] * xy[0] + v[0] * xy[1] + s.axis[0] * base,
        u[1] * xy[0] + v[1] * xy[1] + s.axis[1] * base,
        u[2] * xy[0] + v[2] * xy[1] + s.axis[2] * base
      ];
    });
  }

  // A ball is cut in half by a seam it invents, so a face bounded by one ring
  // that closes on itself is a cap: the ring, and everything between it and
  // whichever pole the ring's direction says.
  if (s.type === 'sphere' && face.loops.length === 1 && face.loops[0].steps.length === 1 &&
      face.loops[0].steps[0].geometry.type === 'circle') {
    var step = face.loops[0].steps[0];
    var c = step.geometry;
    var walk = step.forward ? c.axis : [-c.axis[0], -c.axis[1], -c.axis[2]];
    return cap(s, c, dot(walk, s.axis) > 0);
  }

  if ((s.type === 'cylinder' || s.type === 'cone') && rings.length === 2 &&
      face.loops.every(function (l) { return l.steps.length === 1 && l.steps[0].geometry.type === 'circle'; })) {
    return tube(s, face.loops[0].steps[0].geometry, face.loops[1].steps[0].geometry);
  }

  // A doughnut is cut in half at both of its equators, so half of one arrives
  // as a face bounded by two whole circles about the doughnut's own axis. Which
  // half is which is in the wider circle's direction: the upper half keeps the
  // surface on its left by going round the outer equator the way the axis says.
  if (s.type === 'torus' && rings.length === 2 &&
      face.loops.every(function (l) { return l.steps.length === 1 && l.steps[0].geometry.type === 'circle'; })) {
    var first = face.loops[0].steps[0], second = face.loops[1].steps[0];
    var outer = first.geometry.radius >= second.geometry.radius ? first : second;
    var round = outer.forward ? outer.geometry.axis
      : [-outer.geometry.axis[0], -outer.geometry.axis[1], -outer.geometry.axis[2]];
    return donut(s, dot(round, s.axis) > 0);
  }

  // Everything else: a fan from the middle of the patch out to its boundary,
  // with every point of it put back onto the surface.
  //
  // A fan rather than the surface's own two parameters, because those have a
  // pole in them — on a sphere every meridian meets there and a cap sitting on
  // one flattens into nonsense. A fan has no such place. It can overlap itself
  // on a patch that is not star-shaped, and it does not matter: what overlaps
  // is signed, so it cancels, and the volume comes out right anyway.
  if (rings.length === 1) return fan(s, rings[0]);

  // A patch with a hole in it cannot be fanned — a fan has one boundary — so it
  // goes back to the surface's own two parameters and is triangulated there,
  // unwrapped where it crosses the seam of them.
  var par = parameters(s);
  if (!par) return null;
  return flatten(rings, par.of, par.back, true);
}

/** A patch, from the middle of its boundary outwards, subdivided onto the surface. */
function fan(s, ring) {
  var mid = [0, 0, 0];
  ring.forEach(function (p) { mid[0] += p[0] / ring.length; mid[1] += p[1] / ring.length; mid[2] += p[2] / ring.length; });
  var centre = onSurface(s, mid);
  if (!centre) return null;
  var out = [];
  var depth = 4;
  for (var i = 0; i < ring.length; i++) {
    var a = ring[i], b = ring[(i + 1) % ring.length];
    for (var u = 0; u < depth; u++) {
      for (var v = 0; v + u < depth; v++) {
        var p00 = onSurface(s, blend(centre, a, b, u / depth, v / depth));
        var p10 = onSurface(s, blend(centre, a, b, (u + 1) / depth, v / depth));
        var p01 = onSurface(s, blend(centre, a, b, u / depth, (v + 1) / depth));
        if (!p00 || !p10 || !p01) return null;
        out.push([p00, p10, p01]);
        if (v + u + 2 <= depth) {
          var p11 = onSurface(s, blend(centre, a, b, (u + 1) / depth, (v + 1) / depth));
          if (!p11) return null;
          out.push([p10, p11, p01]);
        }
      }
    }
  }
  return out;
}

function blend(c, a, b, u, v) {
  var w = 1 - u - v;
  return [c[0] * w + a[0] * u + b[0] * v, c[1] * w + a[1] * u + b[1] * v, c[2] * w + a[2] * u + b[2] * v];
}

/** The nearest point of the surface to this one. */
function onSurface(s, p) {
  if (s.type === 'plane') {
    var off = dot(sub(p, s.at), s.axis);
    return add(p, s.axis, -off);
  }
  if (s.type === 'sphere') {
    var out = unit(sub(p, s.at));
    return add(s.at, out, s.radius);
  }
  var w = sub(p, s.at);
  var along = dot(w, s.axis);
  var radial = sub(w, [s.axis[0] * along, s.axis[1] * along, s.axis[2] * along]);
  var len = Math.hypot(radial[0], radial[1], radial[2]);
  if (!(len > 1e-12)) return null;
  var out2 = [radial[0] / len, radial[1] / len, radial[2] / len];
  if (s.type === 'cylinder') {
    return add(add(s.at, s.axis, along), out2, s.radius);
  }
  if (s.type === 'cone') {
    // Nearest point of the generating line, turned to this side of the axis.
    var t = (len - s.radius) * Math.sin(s.half) + along * Math.cos(s.half);
    var r = s.radius + t * Math.sin(s.half);
    return add(add(s.at, s.axis, t * Math.cos(s.half)), out2, r);
  }
  if (s.type === 'torus') {
    var spine = add(s.at, out2, s.major);
    var away = unit(sub(p, spine));
    return add(spine, away, s.minor);
  }
  return null;
}

/** Everything on a sphere between one ring and a pole. */
function cap(s, ring, north) {
  var z = s.axis;
  var x = unit(cross(z, Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
  var y = cross(z, x);
  var height = dot(sub(ring.centre, s.at), z);
  var from = Math.asin(Math.max(-1, Math.min(1, height / s.radius)));
  var to = north ? Math.PI / 2 : -Math.PI / 2;
  var rows = 90;      // fine enough that the cap's own tessellation is not what is measured
  function on(u, v) {
    var cv = Math.cos(v), sv = Math.sin(v);
    return [
      s.at[0] + s.radius * (x[0] * cv * Math.cos(u) + y[0] * cv * Math.sin(u) + z[0] * sv),
      s.at[1] + s.radius * (x[1] * cv * Math.cos(u) + y[1] * cv * Math.sin(u) + z[1] * sv),
      s.at[2] + s.radius * (x[2] * cv * Math.cos(u) + y[2] * cv * Math.sin(u) + z[2] * sv)
    ];
  }
  var out = [];
  for (var j = 0; j < rows; j++) {
    var v0 = from + (to - from) * j / rows, v1 = from + (to - from) * (j + 1) / rows;
    for (var i = 0; i < ROUND; i++) {
      var u0 = 2 * Math.PI * i / ROUND, u1 = 2 * Math.PI * (i + 1) / ROUND;
      out.push([on(u0, v0), on(u1, v0), on(u1, v1)], [on(u0, v0), on(u1, v1), on(u0, v1)]);
    }
  }
  return out;
}

/** Half a doughnut: everything between the outer equator and the inner one. */
function donut(s, upper) {
  var z = s.axis;
  var x = unit(cross(z, Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
  var y = cross(z, x);
  function on(u, v) {
    var out = s.major + s.minor * Math.cos(v), high = s.minor * Math.sin(v);
    return [
      s.at[0] + out * (x[0] * Math.cos(u) + y[0] * Math.sin(u)) + z[0] * high,
      s.at[1] + out * (x[1] * Math.cos(u) + y[1] * Math.sin(u)) + z[1] * high,
      s.at[2] + out * (x[2] * Math.cos(u) + y[2] * Math.sin(u)) + z[2] * high
    ];
  }
  var to = upper ? Math.PI : -Math.PI;
  var rows = 90;      // fine enough that the half's own tessellation is not what is measured
  var out = [];
  for (var j = 0; j < rows; j++) {
    var v0 = to * j / rows, v1 = to * (j + 1) / rows;
    for (var i = 0; i < ROUND; i++) {
      var u0 = 2 * Math.PI * i / ROUND, u1 = 2 * Math.PI * (i + 1) / ROUND;
      out.push([on(u0, v0), on(u1, v0), on(u1, v1)], [on(u0, v0), on(u1, v1), on(u0, v1)]);
    }
  }
  return out;
}

/** Two rings about the same axis, stitched together. */
function tube(s, first, second) {
  var axis = s.axis;
  var u = unit(cross(axis, Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
  var v = cross(axis, u);
  var out = [];
  function on(circle, t) {
    return [
      circle.centre[0] + circle.radius * (u[0] * Math.cos(t) + v[0] * Math.sin(t)),
      circle.centre[1] + circle.radius * (u[1] * Math.cos(t) + v[1] * Math.sin(t)),
      circle.centre[2] + circle.radius * (u[2] * Math.cos(t) + v[2] * Math.sin(t))
    ];
  }
  for (var i = 0; i < ROUND; i++) {
    var t0 = 2 * Math.PI * i / ROUND, t1 = 2 * Math.PI * (i + 1) / ROUND;
    var a = on(first, t0), b = on(first, t1), c = on(second, t1), d = on(second, t0);
    out.push([a, b, c], [a, c, d]);
  }
  return out;
}

function parameters(s) {
  if (s.type === 'cylinder' || s.type === 'cone') {
    var axis = s.axis;
    var u = unit(cross(axis, Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
    var v = cross(axis, u);
    return {
      of: function (p) {
        var w = sub(p, s.at);
        var along = dot(w, axis);
        return [Math.atan2(dot(w, v), dot(w, u)), along];
      },
      back: function (xy) {
        var radius = s.type === 'cylinder' ? s.radius : s.radius + xy[1] * Math.tan(s.half);
        return [
          s.at[0] + radius * (u[0] * Math.cos(xy[0]) + v[0] * Math.sin(xy[0])) + axis[0] * xy[1],
          s.at[1] + radius * (u[1] * Math.cos(xy[0]) + v[1] * Math.sin(xy[0])) + axis[1] * xy[1],
          s.at[2] + radius * (u[2] * Math.cos(xy[0]) + v[2] * Math.sin(xy[0])) + axis[2] * xy[1]
        ];
      }
    };
  }
  if (s.type === 'sphere') {
    var z = s.axis;
    var x = unit(cross(z, Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
    var y = cross(z, x);
    return {
      of: function (p) {
        var w = unit(sub(p, s.at));
        return [Math.atan2(dot(w, y), dot(w, x)), Math.asin(Math.max(-1, Math.min(1, dot(w, z))))];
      },
      back: function (xy) {
        var c = Math.cos(xy[1]), h = Math.sin(xy[1]);
        return [
          s.at[0] + s.radius * (x[0] * c * Math.cos(xy[0]) + y[0] * c * Math.sin(xy[0]) + z[0] * h),
          s.at[1] + s.radius * (x[1] * c * Math.cos(xy[0]) + y[1] * c * Math.sin(xy[0]) + z[1] * h),
          s.at[2] + s.radius * (x[2] * c * Math.cos(xy[0]) + y[2] * c * Math.sin(xy[0]) + z[2] * h)
        ];
      }
    };
  }
  if (s.type === 'torus') {
    var tz = s.axis;
    var tx = unit(cross(tz, Math.abs(tz[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
    var ty = cross(tz, tx);
    return {
      of: function (p) {
        var w = sub(p, s.at);
        var high = dot(w, tz);
        var flatw = sub(w, [tz[0] * high, tz[1] * high, tz[2] * high]);
        var out = Math.hypot(flatw[0], flatw[1], flatw[2]);
        return [Math.atan2(dot(w, ty), dot(w, tx)), Math.atan2(high, out - s.major)];
      },
      back: function (xy) {
        var out = s.major + s.minor * Math.cos(xy[1]), high = s.minor * Math.sin(xy[1]);
        return [
          s.at[0] + out * (tx[0] * Math.cos(xy[0]) + ty[0] * Math.sin(xy[0])) + tz[0] * high,
          s.at[1] + out * (tx[1] * Math.cos(xy[0]) + ty[1] * Math.sin(xy[0])) + tz[1] * high,
          s.at[2] + out * (tx[2] * Math.cos(xy[0]) + ty[2] * Math.sin(xy[0])) + tz[2] * high
        ];
      }
    };
  }
  return null;
}

/**
 * Rings flattened into two parameters, triangulated there, and mapped back.
 *
 * The angle around a cylinder or a sphere comes back between -pi and pi, so a
 * patch lying across where those meet reads as a ring that leaps the width of
 * the domain and back. Unwrapped as it is walked — each step taken as the short
 * way round — it lies flat again.
 */
function flatten(rings, of, back, angular) {
  var wrapped = false;
  var flatRings = rings.map(function (ring) {
    var out = ring.map(of);
    if (!angular) return out;
    for (var i = 1; i < out.length; i++) {
      var step = out[i][0] - out[i - 1][0];
      while (step > Math.PI) { out[i][0] -= 2 * Math.PI; step = out[i][0] - out[i - 1][0]; }
      while (step < -Math.PI) { out[i][0] += 2 * Math.PI; step = out[i][0] - out[i - 1][0]; }
    }
    // A ring that comes back to where it started a whole turn away has gone all
    // the way round the surface, and unwrapping it lays it out as a spiral
    // rather than as a ring. Nothing sound comes of triangulating that, so it
    // is refused rather than answered wrongly.
    if (Math.abs(out[out.length - 1][0] - out[0][0]) > Math.PI) wrapped = true;
    return out;
  });
  if (wrapped) return null;
  var areas = flatRings.map(ringArea);
  var outer = 0;
  for (var i = 1; i < areas.length; i++) if (Math.abs(areas[i]) > Math.abs(areas[outer])) outer = i;
  var order = [outer];
  for (var j = 0; j < flatRings.length; j++) if (j !== outer) order.push(j);

  var flat = [], holes = [];
  order.forEach(function (which, index) {
    if (index > 0) holes.push(flat.length / 2);
    flatRings[which].forEach(function (p) { flat.push(p[0], p[1]); });
  });
  var index = earcut(flat, holes.length ? holes : null, 2);
  var out = [];
  for (var k = 0; k < index.length; k += 3) {
    out.push([
      back([flat[index[k] * 2], flat[index[k] * 2 + 1]]),
      back([flat[index[k + 1] * 2], flat[index[k + 1] * 2 + 1]]),
      back([flat[index[k + 2] * 2], flat[index[k + 2] * 2 + 1]])
    ]);
  }
  return out;
}

function ringArea(ring) {
  var sum = 0;
  for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return sum / 2;
}

/**
 * What the file describes, measured: how far its corners stray from the
 * surfaces they are on, and what the whole of it encloses.
 *
 * Every triangle is turned to face the way its own surface says it should
 * before the volume is added up, so a face written inside out shows in the
 * answer rather than being quietly corrected.
 */
function measure(solid) {
  var volume = 0, off = 0, untessellated = 0;
  solid.faces.forEach(function (face) {
    // Every point of every boundary, not only the corners: an edge written as a
    // circle has to lie on the face it bounds all the way round, and a circle
    // of the wrong radius on a cylinder of the right one is exactly the kind of
    // thing that only shows between the corners.
    face.loops.forEach(function (loop) {
      walkLoop(loop.steps).forEach(function (p) {
        var gap = offSurface(face.surface, p);
        if (gap > off) off = gap;
      });
    });

    var triangles = tessellate(face);
    if (!triangles || !triangles.length) { untessellated++; return; }

    // One sign for the whole face, taken from its biggest triangle. Turning
    // each triangle to face outward on its own would undo the cancellation a
    // fan depends on, and a face written inside out would stop showing.
    var widest = null, widestArea = -1, sum = 0;
    triangles.forEach(function (t) {
      var n = cross(sub(t[1], t[0]), sub(t[2], t[0]));
      var size = Math.hypot(n[0], n[1], n[2]);
      if (size > widestArea) { widestArea = size; widest = { t: t, n: n }; }
      sum += (t[0][0] * (t[1][1] * t[2][2] - t[1][2] * t[2][1]) -
              t[0][1] * (t[1][0] * t[2][2] - t[1][2] * t[2][0]) +
              t[0][2] * (t[1][0] * t[2][1] - t[1][1] * t[2][0])) / 6;
    });
    if (widest) {
      var at = [(widest.t[0][0] + widest.t[1][0] + widest.t[2][0]) / 3,
                (widest.t[0][1] + widest.t[1][1] + widest.t[2][1]) / 3,
                (widest.t[0][2] + widest.t[1][2] + widest.t[2][2]) / 3];
      var want = normalOf(face.surface, face.sameSense, at);
      if (dot(widest.n, want) < 0) sum = -sum;
    }
    volume += sum;
  });
  return { volume: volume, offPlane: off, untessellated: untessellated, backwards: 0 };
}

/** Everything above, on one shape. */
function check(label, positions, expect, options, exact) {
  console.log('\n=== ' + label + ' ===');
  var rebuilt = P.toSolid(positions, options);
  ok('it converts', rebuilt.ok, rebuilt.reason);
  var body = Solid.build(rebuilt.brep, { tolerance: (options && options.deviation) || 0.05 });
  var file = S.write(body, { name: label });
  var text = file.text;
  if (body.counts.cylinder + body.counts.cone + body.counts.sphere) {
    console.log('  found ' + JSON.stringify(body.counts) + ', ' + file.circles + ' circular edges');
  }

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
  ok('and ' + solid.faces.length + ' faces, each on a surface, each loop closed',
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
    declared >= 1e-7 && declared <= 1e-3, declared);
  ok('and every corner is on its surface to within it (' + found.offPlane.toExponential(1) + ' mm out)',
    found.offPlane <= declared, found.offPlane + ' vs ' + declared);
  ok('every face could be built back into triangles', found.untessellated === 0,
    found.untessellated + ' could not be');
  // A curved surface put back where a ring of flat facets was does not enclose
  // quite the same volume — the facets were chords, and lay inside it — so a
  // file with any curve in it is held to a part in a thousand. A file of flat
  // faces is exact and held to it.
  var curved = file.circles > 0 || file.surfaces.cylinder + file.surfaces.cone +
    file.surfaces.sphere + file.surfaces.torus > 0;
  var slack = Math.max(Math.abs(expect) * (curved ? 1e-3 : 1e-6), 1e-4);
  ok('and the faces enclose ' + found.volume.toFixed(3) + ' mm3, which is the part',
    near(found.volume, expect, slack), found.volume + ' vs ' + expect);
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

// ---------------------------------------------------------------------------

/** A frustum: a cone with its point cut off, which is what a chamfer is. */
function frustum(sides, bottom, top, height) {
  var out = [];
  function ring(i, r, z) {
    var a = 2 * Math.PI * i / sides;
    return [r * Math.cos(a), r * Math.sin(a), z];
  }
  for (var i = 0; i < sides; i++) {
    var j = (i + 1) % sides;
    var b0 = ring(i, bottom, 0), b1 = ring(j, bottom, 0);
    var t0 = ring(i, top, height), t1 = ring(j, top, height);
    out.push(b0[0], b0[1], b0[2], b1[0], b1[1], b1[2], t1[0], t1[1], t1[2]);
    out.push(b0[0], b0[1], b0[2], t1[0], t1[1], t1[2], t0[0], t0[1], t0[2]);
  }
  for (var k = 1; k < sides - 1; k++) {
    var a = ring(0, top, height), b = ring(k, top, height), c = ring(k + 1, top, height);
    out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    var d = ring(0, bottom, 0), e = ring(k + 1, bottom, 0), f = ring(k, bottom, 0);
    out.push(d[0], d[1], d[2], e[0], e[1], e[2], f[0], f[1], f[2]);
  }
  return new Float32Array(out);
}

function recognised(positions, options) {
  return Solid.build(P.toSolid(positions, options).brep,
    { tolerance: (options && options.deviation) || 0.05 });
}
function circlesIn(body) {
  return body.edges.filter(function (e) { return e.curve.type === 'circle'; }).length;
}

console.log('\n=== what it recognises, and what it refuses to ===');
{
  var bore = recognised(drilled(40, 30, 5, 6, 32));
  ok('a bore is one cylinder, not thirty-two planes',
    bore.counts.cylinder === 1 && bore.faces.length === 7, JSON.stringify(bore.counts));
  var wall = bore.faces.filter(function (f) { return f.surface.type === 'cylinder'; })[0];
  ok('of the diameter it was drilled at (' + (wall.surface.radius * 2).toFixed(5) + ' mm)',
    near(wall.surface.radius, 6, 1e-5), wall.surface.radius);
  ok('and it knows the material is outside it', wall.surface.outward === false);
  ok('with a circle at each end, not sixty-four little lines', circlesIn(bore) === 2, circlesIn(bore));
  ok('which is ' + bore.edges.length + ' edges where there were 108', bore.edges.length === 14);

  var shaft = recognised(prism(64, 10, 20));
  ok('a plain cylinder is three faces: the round and the two ends',
    shaft.faces.length === 3 && shaft.counts.cylinder === 1, JSON.stringify(shaft.counts));
  ok('and two edges, both circles', shaft.edges.length === 2 && circlesIn(shaft) === 2);
  var round = shaft.faces.filter(function (f) { return f.surface.type === 'cylinder'; })[0];
  ok('the material being inside this one', round.surface.outward === true);

  // The one that has to be refused. A twelve sided hole is a twelve sided hole,
  // and its faces are tangent to a circle that its corners are nowhere near.
  var coarse = recognised(prism(12, 10, 20));
  ok('a twelve sided prism stays a twelve sided prism',
    coarse.counts.cylinder === 0 && coarse.faces.length === 14, JSON.stringify(coarse.counts));
  ok('unless the tolerance is opened up far enough to allow it',
    recognised(prism(12, 10, 20), { deviation: 0.5 }).counts.cylinder === 1);

  // And the trap: the four sides of a square post are all tangent to the
  // cylinder that fits inside it.
  var post = recognised(subdivide(box(20, 20, 60), 2));
  ok('a square post is not the cylinder its faces are tangent to',
    post.counts.cylinder === 0 && post.faces.length === 6, JSON.stringify(post.counts));

  var taper = recognised(frustum(64, 12, 4, 20));
  ok('a taper comes back a cone', taper.counts.cone === 1, JSON.stringify(taper.counts));
  var cone = taper.faces.filter(function (f) { return f.surface.type === 'cone'; })[0];
  var wanted = Math.atan((12 - 4) / 20);
  ok('at the angle it was turned at (' + (cone.surface.halfAngle * 180 / Math.PI).toFixed(3) + ' deg)',
    near(cone.surface.halfAngle, wanted, 1e-4), cone.surface.halfAngle + ' vs ' + wanted);
  ok('bounded by two circles', taper.faces.length === 3 && circlesIn(taper) === 2);

  var plain = recognised(subdivide(box(20, 30, 10), 3));
  ok('a box has nothing to recognise and gains nothing',
    plain.faces.length === 6 && plain.edges.length === 12, plain.faces.length + '/' + plain.edges.length);

  var off = Solid.build(P.toSolid(drilled(40, 30, 5, 6, 32)).brep,
    { tolerance: 0.05, recognise: false });
  ok('and it can be told not to look at all',
    off.counts.cylinder === 0 && off.faces.length === 38, JSON.stringify(off.counts));
  ok('in which case the edges are still shared and simplified',
    off.edges.length === 108, off.edges.length);
}

check('bore-as-cylinder', drilled(40, 30, 5, 6, 32),
  (40 * 30 - Math.PI * 36) * 5);
check('taper', frustum(64, 12, 4, 20), Math.PI * 20 * (144 + 48 + 16) / 3);

console.log('\n=== a ball, which nothing bounds ===');
{
  var ball = recognised(sphere(64, 10), { deviation: 0.05 });
  ok('comes back one sphere, cut in half so each half has an edge',
    ball.counts.sphere === 1 && ball.faces.length === 2, JSON.stringify(ball.counts));
  ok('sharing the one circle between them',
    ball.edges.length === 1 && ball.edges[0].closed, ball.edges.length);
  var radius = ball.faces[0].surface.radius;
  ok('of the radius it was drawn at (' + radius.toFixed(4) + ')', near(radius, 10, 0.02), radius);
  // A 32-segment ball is 0.048 mm from being a ball, so at 0.05 mm parts of it
  // honestly are one and it says so in pieces; opened past its own facets it
  // is one ball again.
  var coarse = recognised(sphere(32, 10), { deviation: 0.05 });
  ok('a coarser one is only partly a ball at a tolerance that tight',
    coarse.counts.sphere >= 1 && coarse.faces.length > 2, JSON.stringify(coarse.counts));
  var opened = recognised(sphere(32, 10), { deviation: 0.3 });
  ok('and one whole ball once the tolerance is opened past its facets',
    opened.counts.sphere === 1 && opened.faces.length === 2, JSON.stringify(opened.counts));
}

check('ball', sphere(64, 10), 4 * Math.PI * 1000 / 3);

/** A doughnut: a circle of radius r carried round an axis at radius R. */
function torus(R, r, round, tube) {
  var out = [];
  function at(i, j) {
    var u = 2 * Math.PI * i / round, v = 2 * Math.PI * j / tube;
    return [(R + r * Math.cos(v)) * Math.cos(u), (R + r * Math.cos(v)) * Math.sin(u), r * Math.sin(v)];
  }
  for (var i = 0; i < round; i++) {
    for (var j = 0; j < tube; j++) {
      var a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
      out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
      out.push(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2]);
    }
  }
  return new Float32Array(out);
}

console.log('\n=== a doughnut, which nothing bounds either ===');
{
  var ring = recognised(torus(12, 3, 96, 48), { deviation: 0.05 });
  ok('comes back one torus, cut in half at both its equators',
    ring.counts.torus === 1 && ring.faces.length === 2, JSON.stringify(ring.counts));
  ok('sharing two closed circles between them',
    ring.edges.length === 2 && ring.edges.every(function (e) { return e.closed; }), ring.edges.length);
  var s = ring.faces[0].surface;
  ok('of the radii it was drawn at (' + s.major.toFixed(3) + ' and ' + s.minor.toFixed(3) + ')',
    near(s.major, 12, 0.02) && near(s.minor, 3, 0.02), s.major + ' / ' + s.minor);
  // The crest of the tube is where the rebuild folds: the tangent plane barely
  // turns from one facet to the next, so putting the corners back where those
  // nearly parallel planes cross leaves slivers facing backwards. They are on
  // the surface and they belong to it, and if they are left out the doughnut
  // comes back with a hundred holes punched round its top and bottom.
  ok('with nothing left over round the crest of the tube',
    ring.counts.plane === 0, ring.counts.plane + ' planes left');
}

check('torus', torus(12, 3, 96, 48), 2 * Math.PI * Math.PI * 12 * 3 * 3);

console.log('\n=== two parts in one file ===');
var one = box(10, 10, 10);
var other = box(10, 10, 10);
for (var i = 0; i < other.length; i += 3) other[i] += 40;
var both = new Float32Array(one.length * 2);
both.set(one, 0); both.set(other, one.length);
var pair = S.write(Solid.build(P.toSolid(both).brep, { tolerance: 0.05 }), { name: 'pair' });
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
var surface = S.write(Solid.build(P.toSolid(holed).brep, { tolerance: 0.05 }), { name: 'broken' });
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
