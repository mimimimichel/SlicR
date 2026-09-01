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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
