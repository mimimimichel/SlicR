/**
 * Being opened with a model.
 *
 * A tablet next to a printer gets its models from a download, a file manager
 * or a message, and "open with" is how a person expects that to work. Android
 * copies the file into the app's cache and the page fetches it across the
 * bridge a piece at a time — pulled rather than pushed, because a thirty
 * megabyte model cannot cross as one string and only the page knows when it
 * can take the next piece.
 *
 * So: a stand-in bridge holding a real STL, and one that stops halfway. The
 * model has to arrive whole and land on the plate; a truncated one has to be
 * said out loud rather than half-loaded.
 *
 *   python3 -m http.server 8099   (from the repo root)
 *   node test-ui-android-open.js
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
  const alerts = [];
  page.on('dialog', d => { alerts.push(d.message()); d.accept(); });

  let pass = 0, fail = 0;
  const ok = (label, cond, detail) => {
    if (cond) { pass++; console.log('  ok    ' + label); }
    else { fail++; console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); }
  };

  /**
   * A bridge with a file waiting in it, installed before the app loads so the
   * startup path is the one under test. `stopAfter` cuts the file off part way,
   * the way a cache file truncated by a full disk would.
   */
  async function bridgeHolding(name, text, stopAfter) {
    await page.addInitScript(([n, t, cut]) => {
      const bytes = new TextEncoder().encode(t);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      window.__pulls = [];
      window.__released = false;
      window.AndroidSlicer = {
        incomingName: () => n,
        incomingSize: () => String(bytes.length),
        incomingChunk: (offset, length) => {
          const from = parseInt(offset, 10), len = parseInt(length, 10);
          window.__pulls.push([from, len]);
          if (cut && from >= cut) return '';
          return btoa(bin.slice(from, from + len));
        },
        incomingDone: () => { window.__released = true; }
      };
    }, [name, text, stopAfter || 0]);
  }

  /** A cube as an ASCII STL. */
  function cubeStl(mm) {
    const h = mm / 2;
    const v = [[-h,-h,0],[h,-h,0],[h,h,0],[-h,h,0],[-h,-h,mm],[h,-h,mm],[h,h,mm],[-h,h,mm]];
    const faces = [[0,3,2],[0,2,1],[4,5,6],[4,6,7],[0,1,5],[0,5,4],
                   [1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
    let s = 'solid cube\n';
    for (const f of faces) {
      s += 'facet normal 0 0 0\nouter loop\n';
      for (const i of f) s += 'vertex ' + v[i].join(' ') + '\n';
      s += 'endloop\nendfacet\n';
    }
    return s + 'endsolid cube\n';
  }

  console.log('=== 1. a model opened from somewhere else lands on the plate ===');
  const stl = cubeStl(20);
  await bridgeHolding('bracket from the internet.stl', stl);
  await page.goto(APP);
  await page.waitForSelector('#btn-slice');
  await page.waitForFunction(() => !document.getElementById('btn-slice').disabled,
    { timeout: 30000 }).catch(() => {});
  const loaded = await page.evaluate(() => ({
    slice: !document.getElementById('btn-slice').disabled,
    name: (document.querySelector('.sl-object .name') ||
           document.querySelector('.sl-object') || {}).textContent || '',
    pulls: window.__pulls.length,
    released: window.__released
  }));
  ok('the app comes up with the model already on it', loaded.slice, JSON.stringify(loaded));
  ok('it was fetched across the bridge in pieces (' + loaded.pulls + ')', loaded.pulls >= 1,
    String(loaded.pulls));
  ok('and the app let go of the copy afterwards', loaded.released === true);

  // The size it measures is the size it was given: nothing lost in base64.
  await page.click('#btn-panel').catch(() => {});
  await page.waitForTimeout(300);
  await page.click('[data-tab="object"]').catch(() => {});
  await page.waitForTimeout(300);
  const dim = (await page.locator('.dim').first().textContent().catch(() => '')).trim();
  ok('at the size it really is (' + dim + ')', /^20(\.0)?×20(\.0)?×20/.test(dim), dim);
  const named = await page.evaluate(() =>
    document.body.innerText.indexOf('bracket from the internet') >= 0);
  ok('and under the name it had where it came from', named);

  console.log('\n=== 2. a second one, opened while the app is running ===');
  // Android puts a second file in the cache and nudges the page; the page is
  // supposed to come and fetch it without being restarted.
  await page.evaluate((text) => {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    window.__released = false;
    window.AndroidSlicer.incomingName = () => 'second.stl';
    window.AndroidSlicer.incomingSize = () => String(bytes.length);
    window.AndroidSlicer.incomingChunk = (o, l) =>
      btoa(bin.slice(parseInt(o, 10), parseInt(o, 10) + parseInt(l, 10)));
    return window.OrcaAndroidOpen();
  }, cubeStl(10));
  await page.waitForTimeout(1200);
  const two = await page.evaluate(() => document.querySelectorAll('.sl-object').length);
  ok('the app takes it without being restarted (' + two + ' models on the plate)', two >= 2,
    String(two));

  console.log('\n=== 3. a file that stops halfway is refused, not half-loaded ===');
  const page2 = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const cut = [];
  page2.on('dialog', d => { cut.push(d.message()); d.accept(); });
  const big = cubeStl(30);
  await page2.addInitScript(([t, stop]) => {
    const bytes = new TextEncoder().encode(t);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    window.AndroidSlicer = {
      incomingName: () => 'truncated.stl',
      incomingSize: () => String(bytes.length),
      incomingChunk: (o) => (parseInt(o, 10) >= stop ? '' : btoa(bin.slice(parseInt(o, 10), stop))),
      incomingDone: () => {}
    };
  }, [big, 200]);
  await page2.goto(APP);
  await page2.waitForSelector('#btn-slice');
  await page2.waitForTimeout(1500);
  ok('it says so rather than loading part of a model (' +
     (cut[0] || '').slice(0, 40) + ')',
    cut.length > 0 && /stopped arriving|bytes arrived|Could not open/.test(cut[0]),
    JSON.stringify(cut));
  const empty = await page2.evaluate(() => document.querySelectorAll('.sl-object').length);
  ok('and nothing is left on the plate', empty === 0, String(empty));
  await page2.close();

  console.log('\n=== 4. and a plain start is untouched ===');
  const page3 = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const quiet = [];
  page3.on('pageerror', e => quiet.push(e.message));
  await page3.addInitScript(() => {
    window.AndroidSlicer = { incomingName: () => '', incomingSize: () => '0',
                             incomingChunk: () => '', incomingDone: () => {} };
  });
  await page3.goto(APP);
  await page3.waitForSelector('#btn-slice');
  await page3.waitForTimeout(600);
  const started = await page3.evaluate(() => ({
    models: document.querySelectorAll('.sl-object').length,
    slice: document.getElementById('btn-slice').disabled
  }));
  ok('an app opened with nothing opens with nothing', started.models === 0 && started.slice === true,
    JSON.stringify(started));
  ok('and says nothing about it', quiet.length === 0, quiet.slice(0, 2).join(' | '));
  await page3.close();

  ok('nothing unexpected in the console', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
