/**
 * Web Slicer — rebuilding a solid, from the panel.
 *
 * The conversion itself is measured in test-prismatic.js. What this asks is
 * whether a person can reach it: that the panel says what the mesh is before
 * anything happens to it, that pressing Convert replaces the model rather than
 * adding one, that the part is still the size it was afterwards — and that the
 * rebuilt mesh goes on to slice, which is the only reason to have done it.
 *
 *   python3 -m http.server 8099   (from the repo root)
 *   node test-ui-solid.js
 */
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const APP = process.env.APP || 'http://localhost:8099/index.html';

/** A 20 x 30 x 10 box in a great many facets, none of them quite flat. */
function roughBox() {
  const w = 20, d = 30, h = 10;
  const corners = [
    [0, 0, 0], [w, 0, 0], [w, d, 0], [0, d, 0],
    [0, 0, h], [w, 0, h], [w, d, h], [0, d, h]
  ];
  const faces = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  let tris = [];
  for (const f of faces) {
    tris.push([corners[f[0]], corners[f[1]], corners[f[2]]]);
    tris.push([corners[f[0]], corners[f[2]], corners[f[3]]]);
  }
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  for (let pass = 0; pass < 3; pass++) {
    const next = [];
    for (const [a, b, c] of tris) {
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      next.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
    }
    tris = next;
  }
  // Nudge the vertices that sit in the middle of a face off it, and leave the
  // edges and corners alone: the box is still exactly 20 x 30 x 10, but not one
  // of its facets is flat any more.
  let seed = 11;
  const noise = new Map();
  const jitter = p => {
    const on = [Math.abs(p[0]) < 1e-6 || Math.abs(p[0] - w) < 1e-6,
                Math.abs(p[1]) < 1e-6 || Math.abs(p[1] - d) < 1e-6,
                Math.abs(p[2]) < 1e-6 || Math.abs(p[2] - h) < 1e-6];
    if (on.filter(Boolean).length !== 1) return p;
    const key = p.map(v => v.toFixed(4)).join(',');
    if (!noise.has(key)) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      noise.set(key, (seed / 0x7fffffff - 0.5) * 0.02);
    }
    const out = p.slice();
    out[on.indexOf(true)] += noise.get(key);
    return out;
  };

  const lines = ['solid rough'];
  for (const t of tris) {
    lines.push('facet normal 0 0 0', 'outer loop');
    for (const v of t.map(jitter)) lines.push('vertex ' + v.map(n => n.toFixed(5)).join(' '));
    lines.push('endloop', 'endfacet');
  }
  lines.push('endsolid rough');
  return lines.join('\n');
}

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  let pass = 0, fail = 0;
  const ok = (label, cond, detail) => {
    if (cond) { pass++; console.log('  ok    ' + label); }
    else { fail++; console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); }
  };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slicer-solid-'));
  const model = path.join(dir, 'rough-box.stl');
  fs.writeFileSync(model, roughBox());

  async function openPanel() {
    const open = await page.evaluate(() => document.getElementById('panel').classList.contains('open'));
    if (!open) { await page.click('#btn-panel').catch(() => {}); await page.waitForTimeout(250); }
    await page.click('[data-tab="object"]').catch(() => {});
    await page.waitForTimeout(300);
    const fields = await page.locator('.sl-field label').count();
    if (fields < 3) {
      await page.locator('.dim').first().click().catch(() => {});
      await page.waitForTimeout(300);
    }
  }
  /** Open the Convert to solid section and wait for it to have looked. */
  async function openSolid() {
    await openPanel();
    await page.evaluate(() => {
      const d = Array.from(document.querySelectorAll('details.sl-section'))
        .find(x => x.querySelector('summary') &&
          x.querySelector('summary').textContent.trim() === 'Convert to solid');
      if (d && !d.open) { d.open = true; d.dispatchEvent(new Event('toggle')); }
    });
    await page.waitForFunction(() => {
      const v = document.getElementById('solid-verdict');
      return v && v.textContent && !/Looking at the mesh/.test(v.textContent);
    }, { timeout: 60000 });
    return (await page.locator('#solid-verdict').textContent()).trim();
  }
  // The app keeps its viewer to itself, so everything here is read off the
  // panel, the way a person would.
  const models = () => page.locator('.sl-object').count();
  const size = async () => (await page.locator('.dim').first().textContent()).trim();

  await page.goto(APP);
  await page.waitForSelector('#btn-slice');
  await page.setInputFiles('#file-input', model);
  await page.waitForFunction(() => !document.getElementById('btn-slice').disabled, { timeout: 30000 });
  await page.waitForTimeout(400);

  console.log('=== 1. the panel says what the mesh is before it touches it ===');
  const before = await openSolid();
  console.log('  ' + before);
  ok('it counts the facets and the flat faces they belong to',
    /6 flat faces/.test(before) && /768 triangles/.test(before), before);
  ok('and says how far off flat they sit', /mm off those faces/.test(before), before);

  const wasSize = await size();
  ok('the box loads at 20 x 30 x 10 (' + wasSize + ')', /^20(\.0)?×30(\.0)?×10/.test(wasSize), wasSize);

  console.log('\n=== 2. converting rebuilds the model in place ===');
  ok('one model on the plate to begin with', await models() === 1, String(await models()));
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button.sl-btn'))
      .find(b => b.textContent.trim() === 'Convert');
    btn.click();
  });
  await page.waitForFunction(() => {
    const v = document.getElementById('solid-verdict');
    return v && /rebuilt as|Left alone/.test(v.textContent);
  }, { timeout: 60000 });
  const after = (await page.locator('#solid-verdict').textContent()).trim();
  console.log('  ' + after);
  ok('it reports what it did', /rebuilt as 12 across 6 faces/.test(after), after);
  ok('and that the part kept its volume', /Volume held to 0\.0/.test(after), after);
  ok('and that it is watertight', /watertight/.test(after), after);
  ok('still one model, not two', await models() === 1, String(await models()));
  ok('and still 20 x 30 x 10 (' + await size() + ')', (await size()) === wasSize, await size());

  console.log('\n=== 3. the rebuilt mesh is still something the slicer can print ===');
  await page.click('#backdrop').catch(() => {});
  await page.waitForTimeout(200);
  await page.click('#btn-slice');
  await page.waitForFunction(() => !document.getElementById('btn-export').disabled, { timeout: 300000 });
  await page.click('#btn-panel').catch(() => {});
  await page.waitForTimeout(200);
  await page.click('[data-tab="check"]').catch(() => {});
  await page.waitForTimeout(400);
  const readback = (await page.locator('#readback').textContent()).replace(/\s+/g, ' ');
  console.log('  read back: ' + readback.slice(0, 120));
  const tall = /([\d.]+) mm ?tallest point/.exec(readback);
  ok('it slices, and the file stands 10 mm tall (' + (tall && tall[1]) + ')',
    tall && Math.abs(parseFloat(tall[1]) - 10) <= 0.3, tall && tall[1]);

  console.log('\n=== 4. a mesh it should not touch, it says so about ===');
  await page.reload();
  await page.waitForSelector('#btn-slice');
  await page.click('[data-demo="cylinder"]');
  await page.waitForFunction(() => !document.getElementById('btn-slice').disabled);
  await page.waitForTimeout(400);
  const tube = await openSolid();
  console.log('  ' + tube);
  ok('a round tube is not called a prismatic part',
    /curved|never a prismatic part/.test(tube), tube);

  ok('nothing threw along the way', errors.length === 0, errors.slice(0, 3).join(' | '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
