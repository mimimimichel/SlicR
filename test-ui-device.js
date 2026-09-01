/**
 * The Device tab, sweeping a real range with real sockets.
 *
 * The two stand-in printers sit on two loopback addresses, so the sweep sees
 * them the way it would see two machines on a real network. Nothing here is
 * stubbed inside the page: the browser opens every connection itself.
 *
 *   python3 -m http.server 8099                             (from the repo root)
 *   python3 test-elegoo-server.py 5098 123456 127.0.0.1
 *   python3 test-octoprint-server.py 5099 TESTKEY 127.0.0.2
 *   node test-ui-device.js
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

  await page.goto(APP);
  await page.waitForSelector('#btn-slice');

  await page.click('#btn-panel').catch(() => {});
  await page.waitForTimeout(250);
  ok('there is a Device tab', await page.locator('[data-tab="device"]').count() === 1);
  await page.click('[data-tab="device"]');
  await page.waitForTimeout(300);

  const banner = await page.locator('.sl-check-banner').first().textContent();
  ok('it says outright that nothing is connected yet',
    /No printer connected/.test(banner), banner);
  ok('and offers a subnet to sweep', await page.locator('#scan-base').count() === 1);
  ok('with a scan button', await page.locator('#btn-scan').count() === 1);

  // Point the sweep at the loopback range the stand-in printers are on, and at
  // their ports. This is the shipped scanner, over real sockets.
  const found = await page.evaluate(async () => {
    const out = [];
    const devices = await window.OrcaDiscover.scan({
      base: '127.0.0', from: 1, to: 3,
      ports: [5098, 5099],
      timeout: 800,
      onFound: d => out.push(d.host + ':' + d.port)
    });
    return { devices, announced: out };
  });

  ok('the sweep finds both stand-in printers and nothing at .3',
    found.devices.length === 2, JSON.stringify(found.devices.map(d => d.host + ':' + d.port)));
  ok('and announces each one as it goes', found.announced.length === 2,
    JSON.stringify(found.announced));

  const elegoo = found.devices.filter(d => d.port === 5098)[0];
  const octo = found.devices.filter(d => d.port === 5099)[0];
  ok('naming the Centauri Carbon 2 by its own answer',
    elegoo && elegoo.kind === 'elegoo_cc2' && /CC2FAKESERIAL/.test(elegoo.serial || ''),
    JSON.stringify(elegoo));
  // OctoPrint answers nothing without its key, so an unconfigured sweep finds
  // the address and cannot name it. That is the honest result, not a failure.
  ok('finding OctoPrint but not naming it, having no key for it',
    octo && octo.kind === 'unknown' && octo.identified === false, JSON.stringify(octo));

  const named = await page.evaluate(async () => {
    const devices = await window.OrcaDiscover.scan({
      base: '127.0.0', from: 2, to: 2, ports: [5099], timeout: 800, key: 'TESTKEY'
    });
    return devices;
  });
  ok('and naming it once the key is known',
    named.length === 1 && named[0].kind === 'octoprint' && /1\.10\.2/.test(named[0].name),
    JSON.stringify(named));

  // Now drive it through the panel rather than the module: run the real scan
  // over a range that contains one of them, and press "Use this one".
  await page.evaluate(() => {
    // The panel sweeps ports 80, 5000 and 3030 by default; the stand-ins are
    // elsewhere, so this narrows the scan the way a user would not have to.
    const orig = window.OrcaDiscover.scan;
    window.OrcaDiscover.scan = function (opts) {
      opts.ports = [5098, 5099];
      opts.from = 1; opts.to = 3;
      opts.timeout = 800;
      return orig.call(this, opts);
    };
  });
  await page.fill('#scan-base', '127.0.0');
  await page.dispatchEvent('#scan-base', 'change');
  await page.click('#btn-scan');
  await page.waitForFunction(() => {
    const s = document.getElementById('scan-status');
    return s && /answered|Nothing/.test(s.textContent);
  }, { timeout: 60000 });

  const status = await page.locator('#scan-status').textContent();
  ok('the panel reports what it found (' + status.trim() + ')', /2 devices answered/.test(status), status);
  const cards = page.locator('.sl-advice-item');
  ok('one card per device', await cards.count() === 2, String(await cards.count()));
  const labels = await cards.locator('.msg').allTextContents();
  ok('the one that names itself is named, the other is offered by address',
    labels.some(l => /Centauri Carbon 2/.test(l)) &&
    labels.some(l => /Something answered at 127\.0\.0\.2:5099/.test(l)), JSON.stringify(labels));

  // Pick the Centauri and check the connection was filled in for us.
  const cc2Card = page.locator('.sl-advice-item', { hasText: 'Centauri Carbon 2' }).first();
  await cc2Card.locator('button', { hasText: 'Use this one' }).click();
  await page.waitForTimeout(400);

  const kind = await page.locator('#link-kind').inputValue();
  const address = await page.locator('.sl-section', { hasText: 'Connection' }).first()
    .locator('input[type="text"]').first().inputValue();
  ok('choosing a device sets the kind (' + kind + ')', kind === 'elegoo_cc2', kind);
  ok('and its address (' + address + ')', address === '127.0.0.1:5098', address);

  const banner2 = await page.locator('.sl-check-banner').first().textContent();
  ok('the tab now says what it is connected to',
    /Connected to Elegoo Centauri Carbon 2/.test(banner2), banner2);
  ok('and that this one cannot be started from here',
    /uploads only/.test(banner2), banner2);

  // The connection survives a reload: it is the device's, not the session's.
  await page.reload();
  await page.waitForSelector('#btn-slice');
  await page.click('#btn-panel').catch(() => {});
  await page.waitForTimeout(250);
  await page.click('[data-tab="device"]');
  await page.waitForTimeout(300);
  const after = await page.locator('.sl-check-banner').first().textContent();
  ok('and is still there after a reload', /Connected to Elegoo Centauri Carbon 2/.test(after), after);

  // Knocking on empty addresses is what a sweep is, and the browser logs every
  // refused connection. Those are the sweep working; anything else is not.
  // The 404s are the identity probes asking a device about an endpoint it does
  // not have, which is how the sweep tells one machine from another.
  const unexpected = errors.filter(e =>
    !/ERR_CONNECTION_REFUSED|ERR_ADDRESS_UNREACHABLE|net::ERR_FAILED|40[34] \(/.test(e));
  ok('nothing in the console but refused connections from the sweep itself',
    unexpected.length === 0, JSON.stringify(unexpected.slice(0, 3)));
  await browser.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
