/**
 * Sending to OctoPrint, through the real UI and over a real socket.
 *
 * Nothing is stubbed inside the page: the browser makes the request, a
 * stand-in OctoPrint answers it, and the test reads back the bytes that
 * arrived.
 *
 *   python3 -m http.server 8099                             (from the repo root)
 *   python3 test-octoprint-server.py 5099 TESTKEY 127.0.0.2 cors  (in another shell)
 *   python3 test-octoprint-server.py 5097 TESTKEY 127.0.0.2        (and one without)
 *
 * The first stand-in has cross-origin requests switched on, because that is the
 * only configuration a browser can reach at all: OctoPrint ships with them off,
 * and until its owner turns them on the request never leaves the page. The
 * second is left as OctoPrint ships, to check the app says so. What the app
 * does about it — talk to printers natively, where those rules do not apply —
 * is test-ui-native-send.js.
 *   node test-ui-octoprint.js
 */
const { chromium } = require('playwright');

const APP = process.env.APP || 'http://localhost:8099/slicer.html';
// The stand-ins sit on two loopback addresses so the Device tab's sweep can
// tell them apart the way it would tell apart two machines on a real network.
const OCTO = process.env.OCTO || '127.0.0.2:5099';
const KEY = process.env.OCTO_KEY || 'TESTKEY';
/** The same stand-in, left as OctoPrint ships it: no cross-origin headers. */
const NOCORS = process.env.OCTO_NOCORS || '127.0.0.2:5097';

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
  const received = async () => (await fetch('http://' + OCTO + '/_received')).json();

  const openMachineTab = async () => {
    await page.click('#btn-panel').catch(() => {});
    await page.waitForTimeout(250);
    await page.click('[data-tab="device"]');
    await page.waitForTimeout(250);
  };
  const closePanel = async () => {
    await page.click('#backdrop').catch(() => {});
    await page.waitForTimeout(200);
  };

  await page.goto(APP);
  await page.waitForSelector('#btn-slice');

  // With nothing configured the button is not even offered.
  ok('the send button is hidden until a printer is configured',
    await page.locator('#btn-send').isHidden());

  await openMachineTab();
  const section = page.locator('.sl-section', { hasText: 'Connection' }).first();
  ok('the Device tab has a connection section', await section.count() === 1);
  await section.locator('summary').click();
  await page.waitForTimeout(200);
  await page.selectOption('#link-kind', 'octoprint');
  await page.waitForTimeout(300);

  await section.locator('input[type="text"]').first().fill(OCTO);
  await section.locator('input[type="text"]').first().dispatchEvent('change');
  await section.locator('input[type="password"]').first().fill('WRONGKEY');
  await section.locator('input[type="password"]').first().dispatchEvent('change');

  // A wrong key has to say so, in words.
  await page.click('#btn-octo-test');
  await page.waitForFunction(() => {
    const r = document.getElementById('octo-result');
    return r && r.textContent && !/Asking/.test(r.textContent);
  }, { timeout: 15000 });
  const wrong = await page.locator('#octo-result').textContent();
  ok('a wrong key is reported as a wrong key (' + wrong.slice(0, 40) + '…)',
    /API key/i.test(wrong), wrong);

  await section.locator('input[type="password"]').first().fill(KEY);
  await section.locator('input[type="password"]').first().dispatchEvent('change');
  await page.click('#btn-octo-test');
  await page.waitForFunction(() => {
    const r = document.getElementById('octo-result');
    return r && /answered|refused|No answer/.test(r.textContent);
  }, { timeout: 15000 });
  const good = await page.locator('#octo-result').textContent();
  ok('the right key gets the version and the printer state back (' + good.slice(0, 46) + '…)',
    /OctoPrint 1\.10\.2 answered/.test(good) && /Operational/.test(good), good);

  await closePanel();
  ok('and the send button appears once there is somewhere to send to',
    await page.locator('#btn-send').isVisible());
  ok('but stays disabled until something has been sliced',
    await page.locator('#btn-send').isDisabled());

  // Slice something and send it.
  await page.click('[data-demo="cube"]');
  await page.waitForFunction(() => !document.getElementById('btn-slice').disabled);
  await page.click('#btn-slice');
  await page.waitForFunction(() => !document.getElementById('btn-export').disabled,
    { timeout: 180000 });
  ok('the send button wakes up with the export button',
    await page.locator('#btn-send').isEnabled());

  const before = (await received()).length;
  page.once('dialog', d => d.accept());
  await page.click('#btn-send');
  await page.waitForFunction((n) => true, {}, before);
  await page.waitForTimeout(2500);

  const got = await received();
  ok('the printer received a file (' + before + ' → ' + got.length + ')', got.length === before + 1);
  const last = got[got.length - 1];
  if (last) {
    ok('named after the model and the layer height (' + last.name + ')',
      /cube_0p20mm\.gcode$/.test(last.name || ''), last.name);
    ok('carrying real G-code (' + last.lines + ' lines, first: ' + last.firstLine.trim() + ')',
      last.lines > 100 && /generated by/.test(last.firstLine), JSON.stringify(last).slice(0, 200));
    ok('selected as the job', last.flags.select === 'true', JSON.stringify(last.flags));
    ok('and NOT printing, because that was never asked for',
      last.flags.print === undefined, JSON.stringify(last.flags));
  }

  // Now ask for it to print, and confirm the warning it puts up first.
  await openMachineTab();
  await page.locator('.sl-section', { hasText: 'Connection' }).first()
    .locator('input[type="checkbox"]').first().check({ force: true });
  await page.waitForTimeout(200);
  await closePanel();

  let asked = null;
  page.once('dialog', async d => { asked = d.message(); await d.dismiss(); });
  await page.click('#btn-send');
  await page.waitForTimeout(1500);
  ok('starting a print asks first, and says what will happen',
    !!asked && /start/i.test(asked) && /heat up/i.test(asked), asked);
  ok('and sends nothing when the answer is no',
    (await received()).length === got.length, 'a file arrived after a dismissed dialog');

  // Two dialogs this time: the confirmation, then the report that it landed.
  // One handler for both — a pair of once() listeners would race on the first.
  const before2 = (await received()).length;
  const acceptAll = async d => { await d.accept(); };
  page.on('dialog', acceptAll);
  await page.click('#btn-send');
  await page.waitForTimeout(2500);
  page.off('dialog', acceptAll);
  const after2 = await received();
  ok('answering yes sends it (' + before2 + ' → ' + after2.length + ')',
    after2.length === before2 + 1);
  if (after2.length > before2) {
    ok('with the print flag set this time',
      after2[after2.length - 1].flags.print === 'true',
      JSON.stringify(after2[after2.length - 1].flags));
  }

  // The address survives a change of printer profile: it belongs to the device.
  await page.selectOption('#sel-printer', 'prusa_mini');
  await page.waitForTimeout(400);
  await openMachineTab();
  const kept = await page.locator('.sl-section', { hasText: 'Connection' }).first()
    .locator('input[type="text"]').first().inputValue();
  ok('the address survives changing the printer profile (' + kept + ')', kept === OCTO);

  // And it is not written into an exported profile.
  const exported = await page.evaluate(() => {
    const raw = localStorage.getItem('orca_slicer_settings_v1');
    return raw || '';
  });
  ok('the API key is not in the saved print settings',
    exported.indexOf(KEY) < 0 && exported.indexOf('octo') < 0,
    exported.slice(0, 120));

  // And the same printer as OctoPrint ships it, with cross-origin requests off:
  // the request never leaves the page, and the app has to say why rather than
  // shrug at it.
  // The panel may already be open here, and openMachineTab toggles it.
  await page.evaluate(() => {
    if (!document.getElementById('panel').classList.contains('open')) {
      document.getElementById('btn-panel').click();
    }
  });
  await page.click('[data-tab="device"]');
  await page.waitForTimeout(300);
  await section.locator('summary').click().catch(() => {});
  await page.waitForTimeout(200);
  await section.locator('input[type="text"]').first().fill(NOCORS);
  await section.locator('input[type="text"]').first().dispatchEvent('change');
  await page.click('#btn-octo-test');
  await page.waitForFunction(() => {
    const r = document.getElementById('octo-result');
    return r && r.textContent && !/Asking/.test(r.textContent);
  }, { timeout: 20000 });
  const blocked = await page.locator('#octo-result').textContent();
  ok('a printer that has not been told to accept web pages is named as such',
    /Cross Origin|CORS/i.test(blocked) && /Android app/i.test(blocked), blocked);

  // The wrong-key step provokes one 403, and the step above is refused by the
  // browser before it leaves — both are the test asking for them. Anything else
  // is a real fault.
  const unexpected = errors.filter(e =>
    !/403 \(Forbidden\)/.test(e) && !/CORS policy|ERR_FAILED|Failed to load resource/.test(e));
  ok('nothing in the console but the refusals this test asked for',
    unexpected.length === 0, JSON.stringify(unexpected.slice(0, 3)));
  await browser.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
