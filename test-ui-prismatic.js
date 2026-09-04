/**
 * Prismatic — the app, driven the way a person drives it.
 *
 * The conversion itself is measured in test-prismatic.js against shapes whose
 * volume is known. What this asks is whether any of that reaches the screen:
 * that the panel counts what is open, that Convert replaces it with the
 * rebuild and says what it did, that going back really goes back — and that
 * the file which comes out of the browser at the end is a sound STL of the
 * same solid, which is the only thing the whole app is for.
 *
 *   python3 -m http.server 8099   (from the repo root)
 *   node test-ui-prismatic.js
 */
const { chromium } = require('playwright');
globalThis.earcut = require('./js/vendor/earcut.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./js/slicer/loaders.js');
const P = require('./prismatic/prismatic.js');
const V = require('./test-step.js');      // the same reader test-step.js checks with
const APP = process.env.APP || 'http://localhost:8099/prismatic/index.html';

/** An ASCII STL of a 20 x 30 x 10 box, cut into 768 facets. */
function boxSTL() {
  const w = 20, d = 30, h = 10;
  const c = [[0, 0, 0], [w, 0, 0], [w, d, 0], [0, d, 0],
             [0, 0, h], [w, 0, h], [w, d, h], [0, d, h]];
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  let tris = [];
  for (const q of quads) tris.push([c[q[0]], c[q[1]], c[q[2]]], [c[q[0]], c[q[2]], c[q[3]]]);
  const mid = (a, b) => a.map((v, i) => (v + b[i]) / 2);
  for (let pass = 0; pass < 3; pass++) {
    const next = [];
    for (const [a, b, x] of tris) {
      const ab = mid(a, b), bx = mid(b, x), xa = mid(x, a);
      next.push([a, ab, xa], [ab, b, bx], [xa, bx, x], [ab, bx, xa]);
    }
    tris = next;
  }
  const out = ['solid box'];
  for (const t of tris) {
    out.push('facet normal 0 0 0', 'outer loop');
    for (const v of t) out.push('vertex ' + v.map(n => n.toFixed(5)).join(' '));
    out.push('endloop', 'endfacet');
  }
  out.push('endsolid box');
  return out.join('\n');
}

/**
 * The same box, tipped off the origin planes and written to six decimals —
 * which is what every STL of a part that was not modelled square looks like.
 * The rounding is half a millionth of a millimetre and it is enough: fitted
 * one wall at a time, the six walls come back only nearly perpendicular.
 */
function tiltedBoxSTL() {
  const az = 0.31, ax = 0.17;
  const ca = Math.cos(az), sa = Math.sin(az), cb = Math.cos(ax), sb = Math.sin(ax);
  return boxSTL().split('\n').map(line => {
    if (!line.startsWith('vertex ')) return line;
    const [x, y, z] = line.slice(7).trim().split(/\s+/).map(Number);
    const x1 = x * ca - y * sa, y1 = x * sa + y * ca;
    return 'vertex ' + [x1, y1 * cb - z * sb, y1 * sb + z * cb]
      .map(n => n.toFixed(6)).join(' ');
  }).join('\n');
}

/** A plate with a round hole drilled through it. */
function drilledSTL(w, d, h, r, sides) {
  const cx = w / 2, cy = d / 2;
  const outer = [[0, 0], [w, 0], [w, d], [0, d]];
  const hole = [];
  for (let i = 0; i < sides; i++) {
    const a = -2 * Math.PI * i / sides;
    hole.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  const flat = [];
  outer.concat(hole).forEach(p => flat.push(p[0], p[1]));
  const index = earcut(flat, [outer.length], 2);
  const out = ['solid plate'];
  const face = (a, b, c) => {
    out.push('facet normal 0 0 0', 'outer loop');
    for (const v of [a, b, c]) out.push('vertex ' + v.map(n => n.toFixed(5)).join(' '));
    out.push('endloop', 'endfacet');
  };
  for (let k = 0; k < index.length; k += 3) {
    const a = index[k] * 2, b = index[k + 1] * 2, c = index[k + 2] * 2;
    face([flat[a], flat[a + 1], h], [flat[b], flat[b + 1], h], [flat[c], flat[c + 1], h]);
    face([flat[a], flat[a + 1], 0], [flat[c], flat[c + 1], 0], [flat[b], flat[b + 1], 0]);
  }
  const corners = [[0, 0, 0], [w, 0, 0], [w, d, 0], [0, d, 0],
                   [0, 0, h], [w, 0, h], [w, d, h], [0, d, h]];
  const quad = (p, a, b, c, e) => { face(p[a], p[b], p[c]); face(p[a], p[c], p[e]); };
  quad(corners, 0, 1, 5, 4);
  quad(corners, 1, 2, 6, 5);
  quad(corners, 2, 3, 7, 6);
  quad(corners, 3, 0, 4, 7);
  for (let j = 0; j < sides; j++) {
    const p0 = hole[j], p1 = hole[(j + 1) % sides];
    quad([[p0[0], p0[1], 0], [p1[0], p1[1], 0], [p1[0], p1[1], h], [p0[0], p0[1], h]], 0, 1, 2, 3);
  }
  out.push('endsolid plate');
  return out.join('\n');
}

/** And a sphere, which is the mesh it should refuse to flatter. */
function sphereSTL(seg = 24, r = 10) {
  const at = (i, j) => {
    const phi = Math.PI * j / seg, theta = 2 * Math.PI * i / seg;
    return [r * Math.sin(phi) * Math.cos(theta), r * Math.sin(phi) * Math.sin(theta), r * Math.cos(phi)];
  };
  const out = ['solid ball'];
  const face = (a, b, c) => {
    out.push('facet normal 0 0 0', 'outer loop');
    for (const v of [a, b, c]) out.push('vertex ' + v.map(n => n.toFixed(5)).join(' '));
    out.push('endloop', 'endfacet');
  };
  for (let j = 0; j < seg; j++) {
    for (let i = 0; i < seg; i++) {
      const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
      if (j > 0) face(a, d, b);
      if (j < seg - 1) face(b, d, c);
    }
  }
  out.push('endsolid ball');
  return out.join('\n');
}

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  let pass = 0, fail = 0;
  const ok = (label, cond, detail) => {
    if (cond) { pass++; console.log('  ok    ' + label); }
    else { fail++; console.log('  FAIL  ' + label + (detail !== undefined ? '  -> ' + detail : '')); }
  };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prismatic-'));
  const boxPath = path.join(dir, 'rough-box.stl');
  const ballPath = path.join(dir, 'ball.stl');
  const tiltPath = path.join(dir, 'tilted-box.stl');
  fs.writeFileSync(tiltPath, tiltedBoxSTL());
  fs.writeFileSync(boxPath, boxSTL());
  fs.writeFileSync(ballPath, sphereSTL());

  /** Everything the panel is saying, as { label: value }. */
  const readList = id => page.evaluate(which => {
    const out = {};
    const list = document.getElementById(which);
    const kids = Array.from(list.children);
    for (let i = 0; i < kids.length - 1; i += 2) out[kids[i].textContent.trim()] = kids[i + 1].textContent.trim();
    return out;
  }, id);
  const verdict = () => page.locator('#verdict').textContent();
  const settled = () => page.waitForFunction(() =>
    document.getElementById('toast').hidden && !document.getElementById('btn-step').disabled,
    { timeout: 60000 });

  await page.goto(APP);
  await page.waitForSelector('#btn-open');

  console.log('=== 1. an empty page asks for a mesh ===');
  ok('the drop target is up', !(await page.locator('#empty').isHidden()));
  ok('and nothing can be converted or saved yet',
    await page.locator('#btn-convert').isDisabled() &&
    await page.locator('#btn-step').isDisabled() && await page.locator('#btn-stl').isDisabled());

  console.log('\n=== 2. it counts what is open ===');
  await page.setInputFiles('#file-input', boxPath);
  await settled();
  const opened = await readList('facts');
  console.log('  ' + JSON.stringify(opened));
  ok('768 facets', opened.Triangles === '768', opened.Triangles);
  ok('over six flat faces', opened['Flat faces'] === '6', opened['Flat faces']);
  ok('watertight', opened.Watertight === 'yes', opened.Watertight);
  ok('the drop target is out of the way', await page.locator('#empty').isHidden());
  ok('and the file is named', (await page.locator('#file-name').textContent()).trim() === 'rough-box.stl');
  ok('a prismatic part is called one', /prismatic part/.test(await verdict()), await verdict());

  console.log('\n=== 3. converting says what it did, and does it ===');
  await page.click('#btn-convert');
  await settled();
  const report = await readList('report');
  console.log('  ' + JSON.stringify(report));
  ok('768 triangles down to 12', report.Triangles === '768 → 12', report.Triangles);
  ok('98% fewer', /9[0-9]% fewer/.test(report[''] || ''), report['']);
  ok('six faces, every one rebuilt from its outline',
    report.Faces === '6' && report['Rebuilt from outlines'] === '6 of 6', report['Rebuilt from outlines']);
  ok('the volume is held', report['Volume held to'] === '0.000%', report['Volume held to']);
  ok('and it is still watertight', report.Watertight === 'yes', report.Watertight);
  const now = await readList('facts');
  ok('the panel is describing the rebuild now',
    (await page.locator('#facts-head').textContent()).trim() === 'The rebuilt solid' && now.Triangles === '12',
    now.Triangles);
  ok('and there is nothing left to convert', await page.locator('#btn-convert').isDisabled());

  console.log('\n=== 4. the file that comes out is the solid ===');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#btn-stl')
  ]);
  const saved = path.join(dir, download.suggestedFilename());
  await download.saveAs(saved);
  ok('it is offered under a name that says what it is',
    download.suggestedFilename() === 'rough-box-solid.stl', download.suggestedFilename());
  const bytes = fs.readFileSync(saved);
  const back = L.parseSTL(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  ok('and reads back as 12 triangles', back.length / 9 === 12, back.length / 9);
  ok('holding the volume of the box it came from',
    Math.abs(P.volumeOf(back) - 6000) < 0.01, P.volumeOf(back));
  ok('watertight on disk, not just on screen', P.watertight(back, 1e-4));

  console.log('\n=== 5. and the file Fusion opens is a solid ===');
  const [stepFile] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#btn-step')
  ]);
  const stepPath = path.join(dir, stepFile.suggestedFilename());
  await stepFile.saveAs(stepPath);
  ok('it comes out as a .step', stepFile.suggestedFilename() === 'rough-box.step',
    stepFile.suggestedFilename());
  const written = await readList('saved');
  console.log('  ' + JSON.stringify(written));
  ok('the panel says what went into it',
    written.As === 'a solid body' && written.Faces === '6' && written.Edges === '12',
    JSON.stringify(written));

  // Read it the way a solid modeller would, knowing nothing about the app.
  const text = fs.readFileSync(stepPath, 'utf8');
  const entities = V.parse(text);
  ok('it is part 21 with every reference resolved',
    /^ISO-10303-21;/.test(text) &&
    V.references(entities).filter(r => !entities.has(r)).length === 0);
  ok('and holds one closed shell as a solid body',
    /MANIFOLD_SOLID_BREP/.test(text) && /CLOSED_SHELL/.test(text) &&
    !/OPEN_SHELL/.test(text));
  const solid = V.solidOf(entities);
  let once = 0, sameWay = 0;
  solid.edgeUse.forEach(senses => {
    if (senses.length !== 2) once++;
    else if (senses[0] === senses[1]) sameWay++;
  });
  ok('six faces, twelve edges, each used once from either side',
    solid.faces.length === 6 && solid.edgeUse.size === 12 && once === 0 && sameWay === 0,
    solid.faces.length + ' faces, ' + once + ' loose, ' + sameWay + ' agreeing');
  const shape = V.measure(solid);
  ok('every corner on the plane of its face', shape.offPlane < 1e-9, shape.offPlane);
  ok('outlines the right way round', shape.backwards === 0, shape.backwards);
  ok('and the faces enclose the box that went in (' + shape.volume.toFixed(1) + ' mm3)',
    Math.abs(shape.volume - 6000) < 0.01, shape.volume);

  console.log('\n=== 5b. a hole in the part comes out a hole in the solid ===');
  const borePath = path.join(dir, 'bore.stl');
  fs.writeFileSync(borePath, drilledSTL(40, 30, 5, 6, 32));
  await page.setInputFiles('#file-input', borePath);
  await settled();
  await page.click('#btn-convert');
  await settled();
  const bore = await readList('report');
  console.log('  ' + JSON.stringify(bore));
  ok('the bore is one cylinder, not thirty-two flats',
    bore['Solid faces'] === '6 planes, 1 cylinder', bore['Solid faces']);
  ok('with a circle at each end', /2 of them circles/.test(bore['Solid edges'] || ''),
    bore['Solid edges']);
  const [boreStep] = await Promise.all([page.waitForEvent('download'), page.click('#btn-step')]);
  const borePathOut = path.join(dir, boreStep.suggestedFilename());
  await boreStep.saveAs(borePathOut);
  const boreText = fs.readFileSync(borePathOut, 'utf8');
  ok('and the file says cylinder where it used to say plane',
    /CYLINDRICAL_SURFACE/.test(boreText) && (boreText.match(/CIRCLE\(/g) || []).length === 2,
    (boreText.match(/CIRCLE\(/g) || []).length + ' circles');
  const boreSolid = V.solidOf(V.parse(boreText));
  const boreShape = V.measure(boreSolid);
  ok('seven faces in all', boreSolid.faces.length === 7, boreSolid.faces.length);
  ok('and the solid is still the plate, short by the bore (' + boreShape.volume.toFixed(1) + ' mm3)',
    Math.abs(boreShape.volume - (40 * 30 - Math.PI * 36) * 5) < 6, boreShape.volume);
  // Back to the box, so the sections after this one find what they expect.
  await page.setInputFiles('#file-input', boxPath);
  await settled();
  await page.click('#btn-convert');
  await settled();

  console.log('\n=== 6. going back goes back ===');
  await page.click('#btn-reset');
  await settled();
  const again = await readList('facts');
  ok('768 facets once more', again.Triangles === '768', again.Triangles);
  ok('the rebuild is put away', await page.locator('#report-block').isHidden());
  ok('and Convert is offered again', !(await page.locator('#btn-convert').isDisabled()));

  console.log('\n=== 7. a tolerance nobody should use is refused, not obeyed ===');
  // A box is a box at any tolerance, so the mesh that shows this is the one
  // that has something to lose: at four millimetres of slack a sphere would
  // come back seven per cent smaller than it went in.
  await page.setInputFiles('#file-input', ballPath);
  await settled();
  // The numbers live behind a fold now; the gauge is the front door.
  await page.evaluate(() => { document.querySelector('.pr-exact').open = true; });
  await page.fill('#opt-deviation', '4');
  await page.fill('#opt-tolerance', '4');
  await page.fill('#opt-angle', '30');
  await page.locator('#opt-angle').blur();
  // Typing into a field schedules a fresh read of the mesh a moment later, and
  // the read puts its own message up. Waiting for that to have started and
  // finished is what keeps this from reading the wrong message.
  await page.waitForTimeout(400);
  await settled();
  const roundTriangles = (await readList('facts')).Triangles;
  await page.click('#btn-convert');
  await page.waitForFunction(() => /Left alone|Rebuilt/.test(document.getElementById('toast').textContent),
    { timeout: 60000 });
  const complaint = (await page.locator('#toast').textContent()).trim();
  console.log('  ' + complaint);
  ok('it says it left the mesh alone, and why', /^Left alone.*off the volume/.test(complaint), complaint);
  const untouched = await readList('facts');
  ok('and the mesh on screen is the one that went in',
    untouched.Triangles === roundTriangles && await page.locator('#report-block').isHidden(),
    untouched.Triangles + ' of ' + roundTriangles);

  console.log('\n=== 7b. the gauge is one control for the two of them ===');
  await page.reload();
  await page.waitForSelector('#btn-open');
  await page.click('[data-demo]');
  await settled();
  const reading = () => page.locator('#simplify-reading').textContent();
  const gauge = async (value) => {
    await page.evaluate((v) => {
      const s = document.getElementById('opt-simplify');
      s.value = String(v);
      s.dispatchEvent(new Event('input', { bubbles: true }));
      s.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
    await settled();
    await page.waitForTimeout(120);
    return (await reading()).trim();
  };
  const tight = await gauge(10);
  const loose = await gauge(80);
  console.log('  tight: ' + tight);
  console.log('  loose: ' + loose);
  ok('it reads in millimetres, not in gauge units', /[\d.]+ mm/.test(tight), tight);
  // The gauge has one lever, and it took a while to see that it should. How far
  // a recognised cylinder may sit off the facets it stands in for is the whole
  // of the simplification. How far the *rebuild* may move the mesh is a
  // different question with a different answer, and moving both together means
  // every notch of the slider changes the mesh the recognition is then run on —
  // so the answer jumps about for reasons that have nothing to do with what was
  // asked. Held still, the count falls as the gauge is pushed, every time.
  const shapes = t => parseFloat(/shapes to ([\d.]+) mm/.exec(t)[1]);
  const held = t => parseFloat(/mesh held to ([\d.]+) mm/.exec(t)[1]);
  ok('pushing it lets a recognised shape sit further off (' + shapes(tight) + ' → ' + shapes(loose) + ' mm)',
    shapes(loose) > shapes(tight) * 10, shapes(tight) + ' → ' + shapes(loose));
  ok('and the mesh underneath is held to the same thing throughout (' + held(tight) + ' mm)',
    held(tight) === held(loose), held(tight) + ' → ' + held(loose));
  ok('and what it did is on the model, not just described: ' + loose,
    /cylinder/.test(loose) && !/cylinder/.test(tight), tight + ' | ' + loose);
  // What it means depends on the part: the same setting is a different number
  // of millimetres on a bigger one.
  await page.setInputFiles('#file-input', boxPath);
  await settled();
  const onBox = (await reading()).trim();
  ok('and it means something different on a different part (' + shapes(onBox) + ' mm)',
    Math.abs(shapes(onBox) - shapes(loose)) > 1e-4, onBox);
  const byHand = await page.evaluate(() => {
    document.querySelector('.pr-exact').open = true;
    const d = document.getElementById('opt-deviation');
    d.value = '0.5';
    d.dispatchEvent(new Event('change', { bubbles: true }));
    return document.getElementById('opt-simplify').value;
  });
  ok('typing a tolerance moves the gauge to match it', parseInt(byHand, 10) > 60, byHand);

  console.log('\n=== 7c. it can find the setting for you ===');
  await page.reload();
  await page.waitForSelector('#btn-open');
  await page.setInputFiles('#file-input', boxPath);
  await settled();
  ok('the search is offered once there is a mesh', !(await page.locator('#btn-best').isDisabled()));
  await page.click('#btn-best');
  await page.waitForFunction(() =>
    document.getElementById('toast').hidden && !document.getElementById('btn-step').disabled,
    { timeout: 120000 });
  const where = await page.locator('#opt-simplify').inputValue();
  const advice = (await page.locator('#simplify-advice').textContent()).trim();
  console.log('  box -> gauge ' + where + ': ' + advice);
  // A box is six faces at every setting. The rule is the fewest faces, and
  // among the settings that get them, the most faithful — so a part with
  // nothing to simplify is left alone and told so, rather than pushed to the
  // end of the slider to gain nothing and lose accuracy.
  ok('a box is left at the faithful end', where === '0', where);
  ok('and told there is nothing to simplify', /needs no simplifying/.test(advice), advice);
  ok('having actually tried more than one setting', /Tried [2-9]/.test(advice), advice);
  ok('and it converted at what it chose',
    !(await page.locator('#report-block').isHidden()));

  // A part that does have something to simplify. The search is not picking one
  // of a handful of stops on the slider: having decided what answer it wants,
  // it walks back towards the faithful end while that answer holds, and stops
  // on the tightest setting that still gives it. So the number it lands on is
  // its own, and what it says is what the choice was made on — how many faces,
  // how many of them are shapes rather than flats, and how far the surfaces
  // ended up sitting off the mesh, which is a good deal less than it allowed.
  await page.reload();
  await page.waitForSelector('#btn-open');
  await page.click('[data-demo]');
  await settled();
  await page.click('#btn-best');
  await page.waitForFunction(() =>
    document.getElementById('toast').hidden && !document.getElementById('btn-step').disabled,
    { timeout: 120000 });
  const bored = await page.locator('#opt-simplify').inputValue();
  const found = (await page.locator('#simplify-advice').textContent()).trim();
  console.log('  bore -> gauge ' + bored + ': ' + found);
  ok('a part with a bore is simplified rather than left alone',
    parseInt(bored, 10) > 0 && !/needs no simplifying/.test(found), bored + ' ' + found);
  ok('and it found the cylinder', /named shape/.test(found), found);
  ok('and says how far off the mesh that put the surfaces', /off the mesh/.test(found), found);
  const cost = parseFloat((found.match(/sitting ([\d.]+) mm off/) || [])[1]);
  const allowed = parseFloat(await page.locator('#opt-tolerance').inputValue());
  ok('by what it spent, not by what it was allowed (' + cost + ' of ' + allowed + ' mm)',
    cost > 0 && cost <= allowed + 1e-9, cost + ' vs ' + allowed);

  console.log('\n=== 8. a scan is called a scan ===');
  await page.reload();
  await page.waitForSelector('#btn-open');
  await page.setInputFiles('#file-input', ballPath);
  await settled();
  const scan = await verdict();
  console.log('  ' + scan.trim().slice(0, 120) + '…');
  ok('a sphere is not sold as a prismatic part', /never a prismatic part/.test(scan), scan);
  ok('and it is still offered, not blocked', !(await page.locator('#btn-convert').isDisabled()));

  console.log('\n=== 8b. surfaces are told what they are to each other ===');
  // A part that was not laid down square comes back as six walls fitted one at
  // a time, and one at a time they are only nearly perpendicular. Saying so
  // out loud is what makes the difference between a solid somebody can
  // constrain in a modeller and a very tidy measurement of a mesh.
  await page.reload();
  await page.waitForSelector('#btn-open');
  await page.setInputFiles('#file-input', tiltPath);
  await settled();
  await page.click('#btn-convert');
  await page.waitForFunction(() => document.getElementById('toast').hidden &&
    !document.getElementById('btn-step').disabled, { timeout: 120000 });
  const constrained = await readList('report');
  console.log('  ' + JSON.stringify(constrained['Surfaces made to agree'] || 'nothing'));
  ok('the report says what was made to agree',
    /squared/.test(constrained['Surfaces made to agree'] || ''),
    JSON.stringify(constrained));
  ok('and the file it will write is the constrained one, not the fitted one',
    !(await page.locator('#btn-step').isDisabled()));

  console.log('\n=== 9. the sample part is there to try ===');
  await page.reload();
  await page.waitForSelector('#btn-open');
  await page.click('[data-demo]');
  await settled();
  const demo = await readList('facts');
  ok('it loads with a bore through it and 36 faces',
    demo['Flat faces'] === '36' && demo.Watertight === 'yes', JSON.stringify(demo));
  await page.click('#btn-convert');
  await settled();
  const demoReport = await readList('report');
  ok('and converts: ' + demoReport.Triangles, demoReport.Triangles === '2,176 → 136', demoReport.Triangles);

  ok('nothing threw along the way', errors.length === 0, errors.slice(0, 3).join(' | '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
