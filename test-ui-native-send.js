/**
 * Talking to a printer the only way that actually works.
 *
 * A browser will not let a page talk to a machine that has not invited it, and
 * no printer invites anyone: OctoPrint ships with cross-origin requests off,
 * and a printer's own web server has never heard of them. Inside the Android
 * app it is worse — the page is https and the printer is http, blocked before
 * CORS is even considered. So those requests go out through Java instead.
 *
 * This drives that path for real. The stand-in printers send no CORS headers,
 * exactly like the machines they stand in for, and the page is given a native
 * bridge whose requests are made from Node — which is what Java does. Anything
 * that works here works because it went around the browser, not because a test
 * server was being generous.
 *
 *   python3 -m http.server 8099                             (from the repo root)
 *   python3 test-elegoo-server.py 5098 123456 127.0.0.1
 *   python3 test-octoprint-server.py 5099 TESTKEY 127.0.0.2
 *   node test-ui-native-send.js
 */
const { chromium } = require('playwright');
const http = require('http');

const APP = process.env.APP || 'http://localhost:8099/index.html';

/** One request, made from here — the same job the Java side has. */
function request(method, url, headers, body) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request({
      method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', d => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: text, error: null }));
    });
    req.on('error', e => resolve({ status: 0, body: '', error: e.message }));
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  const alerts = [];
  page.on('dialog', d => { alerts.push(d.message()); d.accept(); });

  let pass = 0, fail = 0;
  const ok = (label, cond, detail) => {
    if (cond) { pass++; console.log('  ok    ' + label); }
    else { fail++; console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); }
  };

  // The native side, in Node: it takes requests from the page, makes them
  // itself, and calls the answer back in. Staged bodies arrive in pieces first,
  // exactly as a G-code upload does.
  // A picture is bytes, so it crosses the bridge already encoded — which is
  // what Java does with it.
  await page.exposeFunction('__nativeImage', async (url) => {
    const u = new URL(url);
    return new Promise((resolve) => {
      const req = http.request({ method: 'GET', hostname: u.hostname, port: u.port,
                                 path: u.pathname + u.search }, (res) => {
        const chunks = [];
        res.on('data', d => chunks.push(d));
        res.on('end', () => resolve({
          status: res.statusCode,
          body: 'data:' + (res.headers['content-type'] || 'image/jpeg') + ';base64,' +
                Buffer.concat(chunks).toString('base64')
        }));
      });
      req.on('error', e => resolve({ status: 0, body: '', error: e.message }));
      req.end();
    });
  });

  await page.exposeFunction('__nativeRequest', async (method, url, headersJson, body) => {
    const headers = JSON.parse(headersJson || '{}');
    if (body && body.length) headers['Content-Length'] = Buffer.byteLength(body);
    return request(method, url, headers, body);
  });

  // The bridge, as Java implements it: the page hands over a large body in
  // pieces and the native side keeps count, then sends what it was given.
  // Here the pieces are kept in the page and travel in one call, so the test
  // is measuring the app's chunking rather than Playwright's.
  await page.addInitScript(() => {
    window.__staged = { text: '', bytes: 0 };
    window.AndroidSlicer = {
      httpRequest(id, method, url, headersJson, body) {
        window.__nativeRequest(method, url, headersJson, body).then(r => {
          window.OrcaNetResult(id, r.status, r.body, r.error);
        });
      },
      httpRequestStaged(id, method, url, headersJson) {
        const body = window.__staged.text;
        window.__lastStagedBytes = window.__staged.bytes;
        window.__nativeRequest(method, url, headersJson, body).then(r => {
          window.OrcaNetResult(id, r.status, r.body, r.error);
        });
      },
      beginSave() { window.__staged = { text: '', bytes: 0, pieces: 0 }; return true; },
      appendSave(chunk) {
        window.__staged.text += chunk;
        window.__staged.bytes += new TextEncoder().encode(chunk).length;
        window.__staged.pieces++;
        return true;
      },
      httpRequestImage(id, url) {
        window.__nativeImage(url).then(r => {
          window.OrcaNetResult(id, r.status, r.body, r.error);
        });
      },
      pendingBytes() { return String(window.__staged.bytes); },
      discardSave() { window.__staged = { text: '', bytes: 0, pieces: 0 }; },
      toast() {}
    };
  });

  await page.goto(APP);
  await page.waitForSelector('#btn-slice');

  ok('the page sees a native transport', await page.evaluate(() =>
    !!window.OrcaFetch && window.OrcaNet.isNative()));

  // --- Finding the printer, without being told where it is -----------------
  // The app broadcasts first, which only Elegoo's firmware answers; an
  // OctoPrint is a computer with no such protocol. So a silent broadcast has
  // to be followed by a sweep, and inside the app that sweep can only work
  // through the same native transport.
  await page.evaluate(() => {
    // A broadcast nobody answers, exactly as a network with an OctoPrint on it
    // would behave.
    window.AndroidSlicer.discover = function () {
      setTimeout(function () { window.OrcaDiscoverResult('[]'); }, 10);
    };
    window.OrcaDiscover.COMMON.length = 0;
    window.OrcaDiscover.COMMON.push('127.0.0');
    window.OrcaDiscover.PORTS.length = 0;
    window.OrcaDiscover.PORTS.push(5098, 5099);
    window.OrcaDiscover.LANDMARKS.length = 0;
    window.OrcaDiscover.LANDMARKS.push(1, 2);
  });
  const found = await page.evaluate(async () => {
    const list = await window.OrcaDiscover.auto({ timeout: 1500, key: 'TESTKEY' });
    return list.map(d => ({ host: d.host, port: d.port, kind: d.kind, name: d.name }));
  });
  ok('both printers are found without anyone typing an address (' +
    found.map(d => d.host + ':' + d.port).join(', ') + ')',
    found.length === 2, JSON.stringify(found));
  ok('and each is named by its own answer',
    found.some(d => d.kind === 'elegoo_cc2') && found.some(d => d.kind === 'octoprint'),
    JSON.stringify(found.map(d => d.kind + ':' + d.name)));

  // --- OctoPrint, whose CORS is off, as it ships ---------------------------
  await page.click('#btn-panel').catch(() => {});
  await page.waitForTimeout(200);
  await page.click('[data-tab="device"]');
  await page.waitForTimeout(300);

  const section = page.locator('.sl-section', { hasText: 'Connection' }).first();
  await section.locator('summary').click();
  await page.waitForTimeout(200);
  await page.selectOption('#link-kind', 'octoprint');
  await page.waitForTimeout(300);
  await section.locator('input[type="text"]').first().fill('127.0.0.2:5099');
  await section.locator('input[type="text"]').first().dispatchEvent('change');
  await section.locator('input[type="password"]').first().fill('TESTKEY');
  await section.locator('input[type="password"]').first().dispatchEvent('change');

  await page.click('#btn-octo-test');
  await page.waitForFunction(() => {
    const r = document.getElementById('octo-result');
    return r && r.textContent && !/Asking/.test(r.textContent);
  }, { timeout: 30000 });
  const verdict = await page.locator('#octo-result').textContent();
  ok('a printer with cross-origin requests off answers anyway (' +
    verdict.trim().slice(0, 56) + '…)', /1\.10\.2|OctoPrint \d/.test(verdict), verdict);

  // Slice something and send it, through the same transport.
  await page.click('#backdrop').catch(() => {});
  await page.waitForTimeout(200);
  await page.click('[data-demo="cube"]');
  await page.waitForFunction(() => !document.getElementById('btn-slice').disabled);
  await page.click('#btn-slice');
  await page.waitForFunction(() => !document.getElementById('btn-export').disabled, { timeout: 180000 });
  await page.waitForTimeout(500);

  const before = JSON.parse((await request('GET', 'http://127.0.0.2:5099/_received',
    { 'X-Api-Key': 'TESTKEY' })).body || '[]');
  await page.click('#btn-send');
  await page.waitForFunction(() => !document.getElementById('btn-send').disabled ||
    document.getElementById('btn-send').hidden, { timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const after = JSON.parse((await request('GET', 'http://127.0.0.2:5099/_received',
    { 'X-Api-Key': 'TESTKEY' })).body || '[]');

  ok('the file reached OctoPrint (' + before.length + ' → ' + after.length + ')',
    after.length === before.length + 1, JSON.stringify(alerts.slice(-1)));
  const got = after[after.length - 1];
  ok('named after the model, carrying real G-code (' + (got && got.name) + ', ' +
    (got && got.lines) + ' lines)',
    got && /cube/.test(got.name) && got.lines > 1000, JSON.stringify(got && got.name));
  ok('and it was told which job to select, without being told to print',
    got && got.flags && got.flags.select === 'true' && got.flags.print !== 'true',
    JSON.stringify(got && got.flags));

  // --- The Centauri Carbon 2, which has no such setting to turn on ---------
  await page.click('#btn-panel').catch(() => {});
  await page.waitForTimeout(200);
  await page.click('[data-tab="device"]');
  await page.waitForTimeout(300);
  await section.locator('summary').click().catch(() => {});
  await page.waitForTimeout(200);
  await page.selectOption('#link-kind', 'elegoo_cc2');
  await page.waitForTimeout(300);
  await section.locator('input[type="text"]').first().fill('127.0.0.1:5098');
  await section.locator('input[type="text"]').first().dispatchEvent('change');
  await section.locator('input[type="password"]').first().fill('123456');
  await section.locator('input[type="password"]').first().dispatchEvent('change');
  await page.click('#btn-octo-test');
  await page.waitForFunction(() => {
    const r = document.getElementById('octo-result');
    return r && r.textContent && !/Asking/.test(r.textContent);
  }, { timeout: 30000 });
  const cc2Verdict = await page.locator('#octo-result').textContent();
  ok('the Centauri answers too, which it cannot do through a browser (' +
    cc2Verdict.trim().slice(0, 46) + '…)', /Centauri answered/.test(cc2Verdict), cc2Verdict);

  await page.click('#backdrop').catch(() => {});
  await page.waitForTimeout(200);
  const cc2Before = JSON.parse((await request('GET', 'http://127.0.0.1:5098/_received', {})).body || '[]');
  await page.click('#btn-send');
  await page.waitForTimeout(5000);
  const cc2After = JSON.parse((await request('GET', 'http://127.0.0.1:5098/_received', {})).body || '[]');
  ok('the file reached the Centauri (' + cc2Before.length + ' → ' + cc2After.length + ')',
    cc2After.length === cc2Before.length + 1, JSON.stringify(alerts.slice(-1)));
  const cc2Got = cc2After[cc2After.length - 1];
  ok('whole, and with the checksum it announced (' +
    (cc2Got && cc2Got.size) + ' bytes, ' + (cc2Got && cc2Got.lines) + ' lines)',
    cc2Got && cc2Got.intact === true && cc2Got.lines > 1000,
    JSON.stringify(cc2Got && { name: cc2Got.name, intact: cc2Got.intact, size: cc2Got.size }));

  // --- and the camera, which a page cannot fetch natively either -----------
  await page.evaluate(([url, key]) => {
    localStorage.setItem('orca_slicer_octoprint_v1',
      JSON.stringify({ kind: 'octoprint', url, key, autoStart: false }));
  }, ['127.0.0.2:5099', 'TESTKEY']);
  await page.reload();
  await page.waitForSelector('#btn-slice');
  await page.click('#btn-panel').catch(() => {});
  await page.waitForTimeout(250);
  await page.click('[data-tab="device"]');
  await page.waitForTimeout(400);
  await page.locator('#camera-box summary').click();
  await page.waitForFunction(() => {
    const img = document.getElementById('camera-view');
    return img && img.naturalWidth > 0;
  }, { timeout: 20000 }).catch(() => {});
  const frame = await page.evaluate(() => {
    const img = document.getElementById('camera-view');
    return img ? { scheme: img.src.slice(0, 22), w: img.naturalWidth } : null;
  });
  ok('a frame from the camera arrives as bytes, not as a page request (' +
    (frame && frame.scheme) + ')',
    frame && /^data:image\//.test(frame.scheme) && frame.w > 0, JSON.stringify(frame));

  // And the file list, which is an ordinary request through the same door.
  await page.locator('#files-box summary').click();
  await page.waitForFunction(() => {
    const n = document.getElementById('files-note');
    return n && /file/.test(n.textContent) && !/Asking/.test(n.textContent);
  }, { timeout: 20000 }).catch(() => {});
  ok('and the files on the machine are listed too (' +
    await page.locator('#files-box .sl-file').count() + ')',
    await page.locator('#files-box .sl-file').count() === 2,
    await page.locator('#files-note').textContent());

  ok('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
