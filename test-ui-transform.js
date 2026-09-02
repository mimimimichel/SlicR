/**
 * A transform is only real if it reaches the file.
 *
 * Moving, scaling and rotating happen in a 3D view three stages away from the
 * G-code, and the only thing that matters is what comes out at the far end. So
 * this drives the panel the way a person does and then reads the answer off
 * the app's own "read back from the file" figures, which are parsed out of the
 * finished text rather than taken from the slicer's own model.
 *
 *   python3 -m http.server 8099   (from the repo root)
 *   node test-ui-transform.js
 */
const { chromium } = require('playwright');
const APP = process.env.APP || 'http://localhost:8099/index.html';

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

  async function openTab(name) {
    // The panel button is a toggle: pressing it when the panel is already open
    // shuts it, and every field the test is about goes with it.
    const open = await page.evaluate(() =>
      document.getElementById('panel').classList.contains('open'));
    if (!open) {
      await page.click('#btn-panel').catch(() => {});
      await page.waitForTimeout(250);
    }
    await page.click('[data-tab="' + name + '"]').catch(() => {});
    await page.waitForTimeout(300);
    // The transform fields belong to the selected model, and nothing is
    // selected until somebody picks it out of the list.
    if (name === 'object') {
      const hasFields = await page.locator('.sl-field label').count();
      if (hasFields < 3) {
        await page.locator('.dim').first().click().catch(() => {});
        await page.waitForTimeout(300);
      }
    }
  }
  async function closePanel() {
    await page.click('#backdrop').catch(() => {});
    await page.waitForTimeout(200);
  }
  /** Set one numeric field of the object panel by its label, inside a section. */
  async function setField(section, label, value) {
    const done = await page.evaluate(([sec, lab, val]) => {
      const groups = Array.from(document.querySelectorAll('details'));
      const group = groups.find(g => {
        const s = g.querySelector('summary');
        return s && s.textContent.trim().toLowerCase().startsWith(sec.toLowerCase());
      });
      const rows = Array.from((group || document).querySelectorAll('.sl-field'));
      for (const r of rows) {
        const l = r.querySelector('label');
        if (!l || l.textContent.trim() !== lab) continue;
        const inp = r.querySelector('input[type=number]') || r.querySelector('input[type=range]');
        if (!inp) continue;
        inp.value = String(val);
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      return false;
    }, [section, label, value]);
    await page.waitForTimeout(300);
    return done;
  }
  /**
   * What the app reads back out of the file it just wrote. The extents in that
   * panel cover the whole file, prime line included, so the part's own size is
   * taken from its tallest point and from how much filament it needed — both
   * of which come from the finished text rather than from the slicer's model.
   */
  async function readBack() {
    await closePanel();
    await page.click('#btn-slice');
    await page.waitForFunction(() => !document.getElementById('btn-export').disabled,
      { timeout: 300000 });
    await openTab('check');
    const text = (await page.locator('#readback').textContent()).replace(/\s+/g, ' ');
    const tall = /([\d.]+) mm ?tallest point/.exec(text);
    const fil = /([\d,]+) mm ?filament/.exec(text);
    const across = /(-?\d+)–(-?\d+) × (-?\d+)–(-?\d+) mm/.exec(text);
    return {
      z: tall ? parseFloat(tall[1]) : null,
      filament: fil ? parseInt(fil[1].replace(/,/g, ''), 10) : null,
      maxX: across ? +across[2] : null,
      text: text.slice(0, 130)
    };
  }
  /** The size the object panel reports, which is the viewer's own measurement. */
  async function panelSize() {
    await openTab('object');
    return (await page.locator('.dim').first().textContent()).trim();
  }

  await page.goto(APP);
  await page.waitForSelector('#btn-slice');
  await page.click('[data-demo="cube"]');
  await page.waitForFunction(() => !document.getElementById('btn-slice').disabled);
  await page.waitForTimeout(300);

  console.log('=== 1. what is loaded is what is printed ===');
  // The panel reports the part's own footprint first, and the whole file
  // second when the two differ — which they do whenever a start script primes.

  ok('the panel measures the demo cube at 20 mm (' + await panelSize() + ')',
    /^20(\.0)?×20/.test(await panelSize()), await panelSize());
  const plain = await readBack();
  console.log('  read back: ' + plain.text);
  ok('and the file stands 20 mm tall (' + plain.z + ')', Math.abs(plain.z - 20) <= 0.3,
    String(plain.z));
  ok('the footprint reported is the part’s, not the priming line’s (' +
     plain.maxX + ' mm)', plain.maxX > 100 && plain.maxX < 160, String(plain.maxX));
  ok('and the file’s own reach is given separately',
    /priming included/.test(plain.text), plain.text.slice(0, 80));

  console.log('\n=== 2. scaling reaches the file ===');
  await openTab('object');
  await setField('Scale', 'X', 150);
  const bigSize = await panelSize();
  ok('the panel measures it at 30 mm (' + bigSize + ')', /^30(\.0)?×30/.test(bigSize), bigSize);
  const scaled = await readBack();
  ok('and the file stands 30 mm tall (' + scaled.z + ')', Math.abs(scaled.z - 30) <= 0.4,
    String(scaled.z));
  // Half again in every direction is a shade over three times the material,
  // less than 3.375 because the walls do not scale with the volume.
  ok('and takes about three times the filament (' + plain.filament + ' → ' +
     scaled.filament + ' mm)',
    scaled.filament > plain.filament * 2 && scaled.filament < plain.filament * 4,
    plain.filament + ' → ' + scaled.filament);

  console.log('\n=== 3. and so does moving it ===');
  await openTab('object');
  await setField('Scale', 'X', 100);
  await page.waitForTimeout(200);
  const home = await readBack();
  await openTab('object');
  await setField('Position', 'X', 210);
  const moved = await readBack();
  // The figure read back is the part's own footprint, not the file's: a start
  // script draws a priming line down the edge of the plate, and that does not
  // move when the model does.
  ok('a part moved to the right takes its right edge with it (' +
     home.maxX + ' → ' + moved.maxX + ')',
    moved.maxX > home.maxX + 60, home.maxX + ' → ' + moved.maxX);
  ok('and is the same size where it lands (' + await panelSize() + ')',
    /^20(\.0)?×20/.test(await panelSize()), await panelSize());

  console.log('\n=== 4. and rotating it ===');
  await openTab('object');
  await setField('Position', 'X', 128);
  await page.waitForTimeout(200);
  await openTab('object');
  await setField('Rotation', 'Z', 45);
  const turned = await panelSize();
  // A 20 mm square turned 45° measures its diagonal, 28.3 mm, across the plate.
  ok('a square turned 45° measures its diagonal (' + turned + ')',
    /^28(\.\d)?×28/.test(turned), turned);
  const turnedFile = await readBack();
  ok('and is no taller for it (' + turnedFile.z + ')', Math.abs(turnedFile.z - 20) <= 0.4,
    String(turnedFile.z));

  ok('nothing unexpected in the console', errors.length === 0, errors.slice(0, 2).join(' | '));
  await browser.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
