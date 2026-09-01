/**
 * What is already on the printer, and what it can see.
 *
 * Drives the two new sections of the Device tab against a stand-in OctoPrint
 * that holds real files and serves a real picture: the list is read from the
 * machine, printing one is asked for before it happens, deleting one is asked
 * for too, and the camera shows something.
 *
 *   python3 -m http.server 8099                                   (repo root)
 *   python3 test-octoprint-server.py 5099 TESTKEY 127.0.0.2 cors
 *   node test-ui-files.js
 */
const { chromium } = require('playwright');

const APP = process.env.APP || 'http://localhost:8099/index.html';
const OCTO = process.env.OCTO || '127.0.0.2:5099';
const KEY = process.env.OCTO_KEY || 'TESTKEY';

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
  const commands = async () =>
    (await fetch('http://' + OCTO + '/_commands', { headers: { 'X-Api-Key': KEY } })).json();

  await page.goto(APP);
  await page.waitForSelector('#btn-slice');

  // Connect to the stand-in. Set and reloaded rather than typed: the typing
  // has its own test, and this one is about what comes after.
  await page.evaluate(([url, key]) => {
    localStorage.setItem('orca_slicer_octoprint_v1',
      JSON.stringify({ kind: 'octoprint', url, key, autoStart: false }));
  }, [OCTO, KEY]);
  await page.reload();
  await page.waitForSelector('#btn-slice');
  await page.click('#btn-panel').catch(() => {});
  await page.waitForTimeout(250);
  await page.click('[data-tab="device"]');
  await page.waitForTimeout(400);

  // --- the files -----------------------------------------------------------
  const files = page.locator('#files-box');
  ok('a connected printer offers what is on it', await files.count() === 1);
  await files.locator('summary').click();
  await page.waitForFunction(() => {
    const n = document.getElementById('files-note');
    return n && !/Asking|Open this/.test(n.textContent);
  }, { timeout: 20000 });

  const rows = page.locator('#files-box .sl-file');
  ok('the list comes from the machine (' + await rows.count() + ' files)',
    await rows.count() === 2, String(await rows.count()));
  const names = await rows.locator('.msg').allTextContents();
  ok('newest first, and folders flattened away (' + names.join(', ') + ')',
    names[0] === 'bracket v2.gcode' && names[1] === 'benchy.gcode', JSON.stringify(names));
  const facts = await rows.first().locator('.why').textContent();
  ok('each one says how big it is and how long it takes (' + facts + ')',
    /KB|MB/.test(facts) && /min|h /.test(facts), facts);
  const note = await page.locator('#files-note').textContent();
  ok('and the section says how much room is left (' + note.trim() + ')',
    /free/.test(note), note);

  // Loading one is not printing it.
  const before = (await commands()).length;
  await rows.nth(1).locator('button', { hasText: 'Load' }).click();
  await page.waitForTimeout(1200);
  const afterLoad = await commands();
  const loaded = afterLoad[afterLoad.length - 1];
  ok('loading a file selects it and starts nothing (' + (loaded && loaded.path) + ')',
    afterLoad.length === before + 1 && loaded.body.command === 'select' &&
    loaded.body.print === false, JSON.stringify(loaded));

  // Printing one asks first — and a refusal sends nothing.
  let asked = null;
  const refuse = d => { asked = d.message(); d.dismiss(); };
  page.on('dialog', refuse);
  await rows.nth(0).locator('button', { hasText: 'Print' }).click();
  await page.waitForTimeout(800);
  page.off('dialog', refuse);
  ok('printing one asks first, naming the file (' + (asked || '').split('\n')[0] + ')',
    !!asked && /bracket v2\.gcode/.test(asked) && /heat up/.test(asked), asked);
  ok('and a no sends nothing', (await commands()).length === before + 1);

  const accept = d => d.accept();
  page.on('dialog', accept);
  await rows.nth(0).locator('button', { hasText: 'Print' }).click();
  await page.waitForTimeout(1500);
  const afterPrint = await commands();
  const printed = afterPrint[afterPrint.length - 1];
  ok('a yes starts it', printed && printed.body.print === true, JSON.stringify(printed));
  // The label is the display name with its space; the address is the path,
  // which is not the same string and is what has to go on the wire.
  ok('at the file that was chosen, by its path rather than its label',
    /brackets\/bracket_v2\.gcode$/.test(printed.path), printed.path);

  // Deleting asks too.
  await page.waitForTimeout(500);
  const rowsNow = page.locator('#files-box .sl-file');
  await rowsNow.nth(0).locator('button', { hasText: 'Delete' }).click();
  await page.waitForTimeout(1500);
  const afterDelete = await commands();
  const deleted = afterDelete[afterDelete.length - 1];
  ok('deleting one goes through as a delete', deleted && deleted.body.command === 'delete',
    JSON.stringify(deleted));
  page.off('dialog', accept);

  // --- the camera ----------------------------------------------------------
  const camera = page.locator('#camera-box');
  ok('a connected printer offers its camera', await camera.count() === 1);
  await camera.locator('summary').click();
  await page.waitForTimeout(1500);
  const shown = await page.evaluate(() => {
    const img = document.getElementById('camera-view');
    if (!img) return null;
    return { src: img.src.slice(0, 60), w: img.naturalWidth, h: img.naturalHeight,
             flipped: img.className };
  });
  ok('and the picture arrives (' + (shown && shown.w) + '×' + (shown && shown.h) + ')',
    shown && shown.w > 0 && shown.h > 0, JSON.stringify(shown));
  // The stand-in reports its camera at localhost, as a stock OctoPi does. That
  // is where the camera is from where the printer stands; from here it is the
  // tablet, which has no camera on it. The picture has to be asked of the
  // printer, and the address on screen is the proof of it.
  ok('asked of the printer rather than of ourselves (' + (shown && shown.src) + ')',
    shown && shown.src.indexOf(OCTO) >= 0 && !/localhost|127\.0\.0\.1/.test(shown.src),
    JSON.stringify(shown && shown.src));
  ok('turned the way the printer says it should be',
    shown && /flip-v/.test(shown.flipped), JSON.stringify(shown && shown.flipped));

  // Closing it stops the asking: a camera polled into the background is a
  // tablet with a flat battery.
  await camera.locator('summary').click();
  await page.waitForTimeout(400);
  ok('and closing it stops the polling',
    await page.evaluate(() => !document.querySelector('#camera-box').open));

  ok('nothing unexpected in the console', errors.length === 0,
    JSON.stringify(errors.slice(0, 3)));
  await browser.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
