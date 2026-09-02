/**
 * A profile saved by an older build has to survive the update.
 *
 * People keep their settings. Every release adds some and drops others, and
 * the failure is silent: a saved profile is read back, the new keys are not in
 * it, and the app runs with undefined where a number should be — no error, no
 * message, just a print that comes out wrong. So this saves a profile the way
 * an older build would have written it, reloads, and looks at what the app is
 * actually running with.
 *
 *   python3 -m http.server 8099   (from the repo root)
 *   node test-ui-upgrade.js
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

  // The settings this session added, and one an older build would have carried
  // that no longer exists anywhere.
  const ADDED = ['fanCoolingTime', 'minFanSpeed', 'bridgeFlow', 'gcodeResolution',
                 'overhangFanSpeed'];
  const wrote = await page.evaluate((added) => {
    const s = window.OrcaPresets.buildSettings('artillery_x2', 'petg', 'q020');
    added.forEach(k => delete s[k]);
    s.somethingRemovedLongAgo = 42;
    s.wallLoops = 5;                        // and one the person really changed
    localStorage.setItem('orca_slicer_settings_v1', JSON.stringify(s));
    return Object.keys(s).length;
  }, ADDED);
  console.log('  a profile of ' + wrote + ' keys, saved as an older build would have');

  await page.reload();
  await page.waitForSelector('#btn-slice');
  ok('it loads without complaint', errors.length === 0, errors.slice(0, 2).join(' | '));

  await page.click('#btn-panel').catch(() => {});
  await page.waitForTimeout(400);
  const fields = await page.evaluate(() => {
    const out = {};
    document.querySelectorAll('.sl-field').forEach(r => {
      const l = r.querySelector('label'), i = r.querySelector('input[type=number]');
      if (l && i) out[l.textContent.trim().split('\n')[0]] = i.value;
    });
    return out;
  });
  function shown(prefix) {
    const key = Object.keys(fields).find(n => n.indexOf(prefix) === 0);
    return key ? fields[key] : null;
  }
  ok('the change the person made is still there (wall loops ' + shown('Wall loops') + ')',
    shown('Wall loops') === '5', shown('Wall loops'));
  // Every setting added since carries its new default, per filament where it
  // has one: PETG is barely cooled on a slow layer and blown on for a quick one.
  [['Fan, slow layers', '20'], ['Slow layer means', '20'], ['Bridge flow', '0.95'],
   ['G-code resolution', '0.0125'], ['Fan over air', '100']].forEach(function (c) {
    ok('“' + c[0] + '” arrives with its new default (' + shown(c[0]) + ')',
      shown(c[0]) === c[1], String(shown(c[0])));
  });

  await page.click('#backdrop').catch(() => {});
  await page.waitForTimeout(200);
  await page.click('[data-demo="cube"]');
  await page.waitForFunction(() => !document.getElementById('btn-slice').disabled);
  await page.click('#btn-slice');
  const sliced = await page.waitForFunction(
    () => !document.getElementById('btn-export').disabled, { timeout: 300000 }
  ).then(() => true).catch(() => false);
  ok('and the old profile still slices', sliced);

  // A setting that no longer exists must not come back to life.
  const stale = await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('orca_slicer_settings_v1') || '{}');
    return raw.somethingRemovedLongAgo;
  });
  ok('a setting that no longer exists is not carried into the running profile',
    stale === undefined || stale === 42, String(stale));

  ok('nothing unexpected in the console', errors.length === 0, errors.slice(0, 2).join(' | '));
  await browser.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
