/**
 * The advisor, against shapes whose numbers can be worked out by hand.
 *
 *   node test-advisor.js
 */
globalThis.OrcaPresets = require('./js/slicer/presets.js');
var A = require('./js/slicer/advisor.js');
var P = globalThis.OrcaPresets;

var pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); }
}
function near(label, got, want, tol) {
  ok(label + ' (' + got.toFixed(2) + ' vs ' + want.toFixed(2) + ')',
    Math.abs(got - want) <= tol, 'off by ' + Math.abs(got - want).toFixed(3));
}

function get(o, path) {
  return path.split('.').reduce(function (v, k) { return v == null ? v : v[k]; }, o);
}

// --- shapes ----------------------------------------------------------------

function mesh() {
  var t = [];
  return {
    tri: function (a, b, c) { t.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); return this; },
    quad: function (a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); return this; },
    done: function () { return new Float32Array(t); }
  };
}

/** An axis-aligned box with its bottom on the plate, wound outward. */
function box(x0, y0, z0, sx, sy, sz) {
  var m = mesh();
  var x1 = x0 + sx, y1 = y0 + sy, z1 = z0 + sz;
  m.quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]);          // bottom, normal down
  m.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);          // top, normal up
  m.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);          // -Y
  m.quad([x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]);          // +Y
  m.quad([x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]);          // -X
  m.quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);          // +X
  return m.done();
}

function join() {
  var parts = Array.prototype.slice.call(arguments);
  var n = parts.reduce(function (a, p) { return a + p.length; }, 0);
  var out = new Float32Array(n), at = 0;
  parts.forEach(function (p) { out.set(p, at); at += p.length; });
  return out;
}

function settings(printer, filament, quality, tweak) {
  var s = P.buildSettings(printer || 'artillery_x2', filament || 'pla', quality || 'q020');
  if (tweak) tweak(s);
  return s;
}
function keys(list) { return list.map(function (a) { return a.key; }); }
function find(list, key) { return list.filter(function (a) { return a.key === key; })[0]; }

// --- 1. the measurements themselves ----------------------------------------

console.log('=== 1. a 20 mm cube, worked out by hand ===');
var cube = A.measure(box(10, 10, 0, 20, 20, 20));
near('volume is 8000 mm³', cube.volume, 8000, 1);
near('surface is 2400 mm²', cube.area, 2400, 1);
near('the bottom face is 400 mm²', cube.bedArea, 400, 1);
near('the top face is 400 mm²', cube.flatTopArea, 400, 1);
near('the four walls are 1600 mm²', cube.verticalArea, 1600, 1);
ok('nothing overhangs', cube.overhangArea === 0);
near('thickness reads as 2V/A', cube.thickness, 2 * 8000 / 2400, 0.01);
near('a layer averages 400 mm²', cube.layerArea, 400, 1);
near('tallness is 1', cube.tallness, 1, 0.01);
ok('12 triangles', cube.triangles === 12, String(cube.triangles));

console.log('\n=== 2. a table: a top slab held up on one leg ===');
// A 40x40x4 slab at z=20 on a 8x8 leg. The slab's underside is 1600 mm² minus
// the 64 the leg covers — but the mesh is two separate boxes, so the whole
// 1600 reads as ceiling, which is what a slicer sees too.
var table = A.measure(join(box(0, 0, 0, 8, 8, 20), box(-16, -16, 20, 40, 40, 4)));
near('the slab underside is unsupported ceiling', table.ceilingArea, 1600, 1);
ok('and counts as overhang', table.overhangArea >= 1600 - 1);
near('only the leg touches the plate', table.bedArea, 64, 1);

// --- 2. the rules ----------------------------------------------------------

console.log('\n=== 3. what it proposes ===');
var plain = A.advise(cube, settings());
ok('a plain cube needs no support', keys(plain).indexOf('supportEnable') < 0, keys(plain).join(','));

var tableAdvice = A.advise(table, settings());
var sup = find(tableAdvice, 'supportEnable');
ok('the table does', !!sup && sup.value === true);
ok('and says how much is hanging', !!sup && /mm²|cm²/.test(sup.why), sup && sup.why);

// A tower: 15x15 on the plate, 120 mm up. Leverage is 120²/225 = 64.
var tower = A.measure(box(0, 0, 0, 15, 15, 120));
var towerAdvice = A.advise(tower, settings());
var brim = find(towerAdvice, 'adhesion');
ok('a tower is proposed a brim', !!brim && brim.value === 'brim');
// The X2 is already held to 1500, so it is asked for nothing. A fast slinger is.
ok('a machine already slow enough is left alone', !find(towerAdvice, 'maxAccel'));
var fast = find(A.advise(tower, settings('prusa_mk4')), 'maxAccel');
ok('a fast bed slinger is asked to come down', !!fast && fast.value === 2000,
  JSON.stringify(fast));
ok('a corexy machine is not, however fast',
  !find(A.advise(tower, settings('creality_k2_plus')), 'maxAccel'));

// The same tower, with the brim already chosen, is not asked twice.
ok('a setting already at the proposed value is not proposed',
  !find(A.advise(tower, settings('artillery_x2', 'pla', 'q020', function (s) {
    s.adhesion = 'brim';
  })), 'adhesion'));

// A wide flat lid: 100x100x3. Top face is 10000 mm² of 26800 total.
var lid = A.measure(box(0, 0, 0, 100, 100, 3));
var iron = find(A.advise(lid, settings()), 'ironing');
ok('a flat lid is proposed ironing', !!iron && iron.value === 'top');
ok('a cube is not', !find(A.advise(cube, settings()), 'ironing'));

// Warping filament on a wide footprint.
var abs = find(A.advise(lid, settings('artillery_x2', 'abs')), 'adhesion');
ok('ABS on a wide footprint is proposed a brim', !!abs && abs.value === 'brim');
ok('PLA on the same part is not', !find(A.advise(lid, settings()), 'adhesion'));

// Chamber advice only where there is a chamber to heat and nothing set already.
// The ABS and ASA presets carry their own chamber temperature; polypropylene
// warps as badly and does not, which is the case this rule is left for.
var tallWarp = A.measure(box(0, 0, 0, 40, 40, 80));
ok('PP in a machine with a chamber is proposed one',
  !!find(A.advise(tallWarp, settings('centauri_carbon', 'pp')), 'chamberTemp'));
ok('ABS, which already sets one, is not asked twice',
  !find(A.advise(tallWarp, settings('centauri_carbon', 'abs')), 'chamberTemp'));
ok('and PLA in the same machine is not',
  !find(A.advise(tallWarp, settings('centauri_carbon', 'pla')), 'chamberTemp'));

// A small part cooling too fast: a 6 mm cube averages 36 mm² a layer.
var small = A.measure(box(0, 0, 0, 6, 6, 6));
ok('a small part is given longer layers',
  !!find(A.advise(small, settings()), 'minLayerTime'));
ok('a big one is not', !find(A.advise(lid, settings()), 'minLayerTime'));

// Bulk, drawn coarsely: 100 mm cube, 1000 cm³, triangles tens of mm across.
var bulk = A.measure(box(0, 0, 0, 100, 100, 100));
var thicker = find(A.advise(bulk, settings()), 'layerHeight');
ok('a large plain part is offered thicker layers', !!thicker && thicker.value === 0.28);

console.log('\n=== 4. what it refuses to print at all ===');
// A 0.2 mm sheet against a 0.4 nozzle.
var sheet = A.measure(box(0, 0, 0, 40, 40, 0.2));
var warn = A.advise(sheet, settings()).filter(function (a) { return a.kind === 'warning'; });
ok('a sheet thinner than the nozzle is called out',
  warn.some(function (a) { return /nozzle/i.test(a.label); }),
  JSON.stringify(warn.map(function (a) { return a.label; })));

var tall = A.measure(box(0, 0, 0, 20, 20, 500));
ok('a part taller than the machine is called out',
  A.advise(tall, settings()).some(function (a) { return /taller/i.test(a.label); }));

console.log('\n=== 5. an empty plate says nothing ===');
ok('no triangles, no advice', A.advise(A.measure(new Float32Array(0)), settings()).length === 0);
ok('and no settings, no advice', A.advise(cube, null).length === 0);

console.log('\n=== 6. every proposal names a real setting ===');
var real = P.buildSettings('artillery_x2', 'abs', 'q020');
var all = [];
[cube, table, tower, lid, small, bulk, sheet, tall].forEach(function (sh) {
  ['artillery_x2', 'centauri_carbon', 'flsun_v400'].forEach(function (pk) {
    ['pla', 'abs', 'petg'].forEach(function (fk) {
      all = all.concat(A.advise(sh, P.buildSettings(pk, fk, 'q020')));
    });
  });
});
var unknown = all.filter(function (a) {
  return a.key !== null && !(a.key.split('.')[0] in real);
});
ok(all.length + ' proposals across the sweep, all naming a known setting',
  unknown.length === 0, JSON.stringify(unknown.map(function (a) { return a.key; })));
var unexplained = all.filter(function (a) { return !a.why || a.why.length < 20; });
ok('and every one of them explains itself', unexplained.length === 0,
  JSON.stringify(unexplained.map(function (a) { return a.label; })));

console.log('\n=== 7. the profile, before any model is loaded ===');
// Every rule here is a ratio the printer cannot argue with, so the first thing
// to hold it to is our own presets: if the shipped profiles trip these rules,
// either the rule is wrong or the profile is.
var swept = 0, tripped = {};
Object.keys(P.PRINTERS).forEach(function (pk) {
  Object.keys(P.FILAMENTS).forEach(function (fk) {
    Object.keys(P.qualityFor(P.PRINTERS[pk].nozzle)).forEach(function (qk) {
      var s = P.buildSettings(pk, fk, qk);
      swept++;
      A.review(s).forEach(function (a) {
        (tripped[a.label] = tripped[a.label] || []).push(pk + '/' + fk + '/' + qk);
      });
    });
  });
});
ok('every profile this app offers passes its own review (' + swept + ' of them)',
  Object.keys(tripped).length === 0,
  Object.keys(tripped).map(function (k) {
    return k + ' ×' + tripped[k].length + ' e.g. ' + tripped[k][0];
  }).join(' | '));

// And each rule fires when it is broken, with a proposal that fixes it.
function broken(over) {
  var s = P.buildSettings('artillery_x2', 'pla', 'q020');
  for (var k in over) s[k] = over[k];
  return s;
}
function fires(label, s, match) {
  var hit = A.review(s).filter(function (a) { return match.test(a.label); })[0];
  ok(label, !!hit, JSON.stringify(A.review(s).map(function (a) { return a.label; })));
  return hit;
}
var thick = fires('a layer past three quarters of the nozzle is caught',
  broken({ layerHeight: 0.34 }), /too thick/i);
ok('and the height it proposes is one the nozzle can lay',
  thick && thick.value <= 0.4 * 0.75 + 1e-9, thick && String(thick.value));
var thinTop = fires('a roof under 0.8 mm is caught',
  broken({ topLayers: 2 }), /on top/i);
ok('and it proposes enough layers to get there',
  thinTop && thinTop.value * 0.2 >= 0.8 - 1e-9, thinTop && String(thinTop.value));
fires('a first layer thicker than the nozzle is caught',
  broken({ firstLayerHeight: 0.45 }), /first layer/i);
fires('lines narrower than the nozzle are caught',
  broken({ lineWidth: 0.3 }), /narrower/i);
fires('a single wall is caught', broken({ wallLoops: 1 }), /walls too thin/i);
fires('solid tops over no infill are caught',
  broken({ infillDensity: 0 }), /over nothing/i);
fires('support printed onto the part is caught',
  broken({ supportEnable: true, supportZGap: 0 }), /welded/i);
fires('a speed the machine will not do is caught',
  broken({ speeds: { infill: 900 } }), /past what the machine/i);
ok('and a spiral vase is not told it has no roof',
  A.review(broken({ spiralVase: true, topLayers: 0, infillDensity: 0 }))
    .every(function (a) { return !/on top|over nothing/i.test(a.label); }));

console.log('\n=== 8. what went wrong last time ===');
var profile = P.buildSettings('artillery_x2', 'pla', 'q020');
ok('there are faults to choose from', A.SYMPTOMS.length >= 10);
var everyFix = [];
A.SYMPTOMS.forEach(function (sym) {
  var fixes = A.remedies(sym.key, profile);
  everyFix = everyFix.concat(fixes);
  ok('“' + sym.label + '” is answered (' + fixes.length + ')', fixes.length > 0,
    'nothing proposed');
});
ok('an unknown fault proposes nothing', A.remedies('nonsense', profile).length === 0);
ok('and no settings, nothing at all', A.remedies('stringing', null).length === 0);

var strayKey = everyFix.filter(function (a) {
  return a.key !== null && get(profile, a.key) === undefined;
});
ok(everyFix.length + ' remedies across every fault, all naming a real setting',
  strayKey.length === 0, JSON.stringify(strayKey.map(function (a) { return a.key; })));
var notANumber = everyFix.filter(function (a) {
  return typeof a.value === 'number' && !isFinite(a.value);
});
ok('and none of them proposes a value that is not one', notANumber.length === 0,
  JSON.stringify(notANumber.map(function (a) { return a.key; })));

// Bounded: a troubleshooter that walks a setting off the end of its range over
// a few prints is worse than none at all.
var walked = P.buildSettings('artillery_x2', 'pla', 'q020');
for (var round = 0; round < 12; round++) {
  A.remedies('stringing', walked).forEach(function (a) {
    if (a.key) walked[a.key] = a.value;
  });
}
ok('twelve rounds of the stringing advice stays inside the sane range (' +
   walked.retractLength + ' mm, ' + walked.nozzleTemp + ' °C)',
  walked.retractLength <= 6 && walked.nozzleTemp >= 195 && walked.nozzleTemp <= 225,
  walked.retractLength + '/' + walked.nozzleTemp);
var hotter = P.buildSettings('artillery_x2', 'pla', 'q020');
for (round = 0; round < 12; round++) {
  A.remedies('weak', hotter).forEach(function (a) { if (a.key) hotter[a.key] = a.value; });
}
ok('and twelve rounds of the strength advice does too (' + hotter.nozzleTemp + ' °C, ' +
   hotter.wallLoops + ' walls)',
  hotter.nozzleTemp <= 225 && hotter.wallLoops <= 6, hotter.nozzleTemp + '/' + hotter.wallLoops);

// The remedy has to know the machine it is talking about.
var withK = A.remedies('blobs', P.buildSettings('artillery_x2', 'pla', 'q020'));
var withoutK = A.remedies('blobs', P.buildSettings('artillery_x1', 'pla', 'q020'));
ok('a machine already sending its linear advance is not told to set it',
  withK.every(function (a) { return !/linear advance/i.test(a.label); }));
ok('and one that has none is', withoutK.some(function (a) { return /linear advance/i.test(a.label); }));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
