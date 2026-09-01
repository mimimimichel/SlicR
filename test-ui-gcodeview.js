/**
 * The preview shows the file, not the intention.
 *
 * Slices in the browser, exports the file the user would actually get, and
 * checks that what is on screen and what the panel says both come from that
 * file — by reading it back independently here and comparing.
 *
 *   python3 -m http.server 8099   (from the repo root)
 *   node test-ui-gcodeview.js
 */
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

require('./js/slicer/gcodeview.js');
const V = globalThis.OrcaGcodeView;

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

  /** How much of the canvas is lit — the model or the preview, in pixels. */
  const lit = () => page.evaluate(() => {
    const c = document.getElementById('sl-canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    const w = c.width, h = c.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let n = 0;
    for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4;
      if (px[i] + px[i + 1] + px[i + 2] > 330) n++;
    }
    return n;
  });

  await page.goto(APP);
  await page.waitForSelector('#btn-slice');
  await page.selectOption('#sel-printer', 'artillery_x2');
  await page.waitForTimeout(400);
  await page.click('[data-demo="cube"]');
  await page.waitForFunction(() => !document.getElementById('btn-slice').disabled);
  await page.click('#btn-slice');
  await page.waitForFunction(() => !document.getElementById('btn-export').disabled,
    { timeout: 180000 });
  await page.waitForTimeout(600);

  ok('the reader is loaded in the page', await page.evaluate(() => !!window.OrcaGcodeView));

  const drawn = await lit();
  ok('the preview has something in it (' + drawn + ' lit pixels)', drawn > 500, String(drawn));

  // Export the file the user gets, and read it back here — the same reader,
  // run outside the page, over the actual downloaded bytes.
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'slicer-')), 'out.gcode');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    page.click('#btn-export')
  ]);
  await download.saveAs(out);
  const text = fs.readFileSync(out, 'utf8');
  const file = V.parse(text);

  ok('the exported file is a real file (' + Math.round(text.length / 1024) + ' KB, ' +
    file.stats.segments + ' extrusion moves)',
    file.stats.segments > 500 && file.stats.layers > 50, JSON.stringify(file.stats));

  // What the panel says has to be what is in that file.
  await page.click('#btn-panel').catch(() => {});
  await page.waitForTimeout(200);
  await page.click('[data-tab="check"]');
  await page.waitForTimeout(400);

  ok('the Check tab reports what was read back',
    await page.locator('#readback').count() === 1);
  const shown = await page.locator('#readback .sl-readback-rows > div b').allTextContents();
  console.log('  panel says: ' + shown.join(' · '));
  ok('the layer count on screen is the layer count in the file (' + shown[0] + ')',
    shown[0].replace(/[^\d]/g, '') === String(file.stats.layers),
    shown[0] + ' vs ' + file.stats.layers);
  ok('and the move count (' + shown[1] + ')',
    shown[1].replace(/[^\d]/g, '') === String(file.stats.segments),
    shown[1] + ' vs ' + file.stats.segments);
  ok('and the filament, to the millimetre (' + shown[2] + ')',
    shown[2].replace(/[^\d]/g, '') === String(Math.round(file.stats.filamentMm)),
    shown[2] + ' vs ' + Math.round(file.stats.filamentMm));

  // The preview is the file. Open one that was cut short on the way to the
  // printer — the start script and its priming line, nothing after — which is
  // exactly what a machine that levels, purges and then stops has been given.
  const accept = d => d.accept();
  page.on('dialog', accept);
  const short = text.slice(0, text.indexOf(';LAYER_CHANGE'));
  const shortPath = path.join(path.dirname(out), 'cut-short.gcode');
  fs.writeFileSync(shortPath, short);

  await page.click('#backdrop').catch(() => {});
  await page.waitForTimeout(200);
  await page.setInputFiles('#file-input', shortPath);
  await page.waitForTimeout(1500);

  const afterShort = await lit();
  ok('a file cut off after the start script draws almost nothing (' + afterShort + ' px)',
    afterShort < drawn / 4, drawn + ' → ' + afterShort);
  await page.click('#btn-panel').catch(() => {});
  await page.waitForTimeout(200);
  await page.click('[data-tab="check"]');
  await page.waitForTimeout(400);
  const cut = await page.locator('#readback .sl-readback-rows > div b').allTextContents();
  ok('and the panel counts what is really there — the priming, and nothing else (' +
    cut.slice(0, 2).join(', ') + ')',
    Number(cut[0].replace(/[^\d]/g, '')) <= 2 && Number(cut[1].replace(/[^\d]/g, '')) < 20,
    JSON.stringify(cut));

  // And one with nothing to print at all says so outright.
  const nothingPath = path.join(path.dirname(out), 'nothing.gcode');
  fs.writeFileSync(nothingPath, ['; generated by nobody', 'G90', 'M140 S60', 'M190 S60',
    'G28', 'M109 S215', 'G29', 'G1 Z5 F600', 'M84'].join('\n'));
  await page.click('#backdrop').catch(() => {});
  await page.waitForTimeout(200);
  await page.setInputFiles('#file-input', nothingPath);
  await page.waitForTimeout(1500);
  await page.click('[data-tab="check"]').catch(() => {});
  await page.waitForTimeout(400);
  const verdict = await page.locator('#readback').textContent();
  ok('a file that only heats and levels is called what it is',
    /no extrusion moves/i.test(verdict), verdict.slice(0, 140));
  ok('and it draws nothing', await lit() < 200, String(await lit()));

  // And a whole file opened from disk comes back the way it went in.
  await page.click('#backdrop').catch(() => {});
  await page.waitForTimeout(200);
  await page.setInputFiles('#file-input', out);
  await page.waitForTimeout(2000);
  const reopened = await lit();
  // The camera has to come down to the print. A file opened on its own has no
  // model behind it, and sitting back to look at the whole plate leaves a
  // 20 mm part as a speck. It frames a little wider than the sliced model did,
  // because the skirt is part of the file and the model was not.
  ok('opening the whole file again fills the screen (' + reopened + ' px)',
    reopened > drawn * 0.35, drawn + ' → ' + reopened);
  await page.click('#btn-panel').catch(() => {});
  await page.waitForTimeout(200);
  await page.click('[data-tab="check"]');
  await page.waitForTimeout(400);
  const rows = await page.locator('#readback .sl-readback-rows > div b').allTextContents();
  ok('with the same numbers as the file it was read from (' + rows[0] + ', ' + rows[1] + ')',
    rows[0].replace(/[^\d]/g, '') === String(file.stats.layers) &&
    rows[1].replace(/[^\d]/g, '') === String(file.stats.segments),
    JSON.stringify(rows));
  await page.click('#backdrop').catch(() => {});
  await page.waitForTimeout(200);

  ok('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
