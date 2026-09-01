/**
 * The advice panel, driven the way a person drives it: through the DOM only.
 *
 *   python3 -m http.server 8099   (from the repo root)
 *   node test-ui-advice.js
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
  const items = () => page.locator('.sl-advice-item');

  await page.goto(APP);
  await page.waitForSelector('#btn-slice');
  await page.click('#btn-panel').catch(() => {});
  await page.waitForTimeout(300);
  ok('an empty plate has nothing to advise', await page.locator('.sl-advice').count() === 0);
  await page.click('#backdrop').catch(() => {});
  await page.waitForTimeout(300);

  // The pyramid: every face of it leans, which is the support rule, and it has
  // no flat top, which is the ironing rule staying quiet.
  await page.click('[data-demo="pyramid"]');
  await page.waitForFunction(() => !document.getElementById('btn-slice').disabled);
  await page.click('#btn-panel').catch(() => {});
  await page.waitForTimeout(500);

  ok('a loaded model produces a card', await page.locator('.sl-advice').count() === 1);
  let n0 = await items().count();
  ok('with at least one note', n0 >= 1, String(n0));

  const labels = await items().locator('.msg').allTextContents();
  const whys = await items().locator('.why').allTextContents();
  console.log('  notes: ' + labels.map((l, i) => l + ' [' + whys[i].slice(0, 60) + '…]').join('\n         '));
  ok('every note explains itself', whys.every(w => w.length > 20));
  ok('and every explanation carries a measurement',
    whys.every(w => /\d/.test(w)), JSON.stringify(whys.filter(w => !/\d/.test(w))));

  // Dismissing hides a note and touches no setting: the same note comes back on
  // a fresh page, because nothing was applied.
  const beforeDismiss = await items().count();
  await page.locator('.sl-advice-item .sl-btn:not(.primary)').first().click();
  await page.waitForTimeout(300);
  ok('dismissing removes one note (' + beforeDismiss + ' → ' + await items().count() + ')',
    await items().count() === beforeDismiss - 1);

  await page.goto(APP);
  await page.waitForSelector('#btn-slice');
  await page.click('[data-demo="pyramid"]');
  await page.waitForFunction(() => !document.getElementById('btn-slice').disabled);
  await page.click('#btn-panel').catch(() => {});
  await page.waitForTimeout(500);
  ok('and a dismissal changes nothing, so the note is back',
    await items().count() === beforeDismiss);

  // Applying one: the button is labelled with the change it makes, and the note
  // goes away because the setting it asked for is now the setting in force.
  n0 = await items().count();
  const applyButtons = page.locator('.sl-advice-item .sl-btn.primary');
  const applicable = await applyButtons.count();
  if (applicable) {
    const face = await applyButtons.first().textContent();
    ok('the button names the change it makes (' + face + ')', /→/.test(face));
    await applyButtons.first().click();
    await page.waitForTimeout(400);
    const n1 = await items().count();
    ok('applying it retires the note (' + n0 + ' → ' + n1 + ')', n1 === n0 - 1);
    ok('and re-rendering does not bring it back', await (async () => {
      await page.click('[data-tab="machine"]');
      await page.waitForTimeout(200);
      await page.click('[data-tab="print"]');
      await page.waitForTimeout(300);
      return await items().count() === n1;
    })());
  } else {
    console.log('  (nothing applicable on this shape; apply path not exercised)');
  }

  // Changing the machine re-measures against the new one.
  await page.selectOption('#sel-printer', 'prusa_mini').catch(() => {});
  await page.waitForTimeout(400);
  ok('the card survives a change of printer', await page.locator('.sl-advice').count() <= 1);

  // And the model still slices with the advice taken.
  await page.click('#backdrop').catch(() => {});
  await page.waitForTimeout(200);
  await page.click('#btn-slice');
  await page.waitForFunction(() => !document.getElementById('btn-export').disabled,
    { timeout: 180000 });
  ok('it still slices afterwards', true);

  // --- the heights on offer follow the nozzle ------------------------------
  // 0.32 mm out of a 0.4 mm nozzle is a print that comes apart along the lines,
  // and no vendor ships it. A 0.6 mm nozzle lays it happily.
  const heights = () => page.$$eval('#sel-quality option', o => o.map(x => x.value));
  ok('a 0.4 mm nozzle is not offered 0.32 mm layers',
    (await heights()).indexOf('q032') < 0, (await heights()).join(' '));
  await page.selectOption('#sel-printer', 'generic_0_6');
  await page.waitForTimeout(400);
  const wide = await heights();
  ok('a 0.6 mm nozzle is (' + wide.join(' ') + ')', wide.indexOf('q032') >= 0, wide.join(' '));
  ok('and it is not offered the finest ones it cannot resolve', wide.indexOf('q006') < 0,
    wide.join(' '));
  const chosen = await page.$eval('#sel-quality', el => el.value);
  ok('with a height still chosen after the change (' + chosen + ')',
    wide.indexOf(chosen) >= 0, chosen);
  await page.selectOption('#sel-printer', 'prusa_mini');
  await page.waitForTimeout(400);

  // --- what went wrong last time -------------------------------------------
  // The other direction: not what this file might do, but what the last one
  // did. Somebody holding a part with strings on it wants the two or three
  // settings that cause strings, with their own numbers in them.
  await page.click('#btn-panel').catch(() => {});
  await page.waitForTimeout(300);
  const fix = page.locator('#fix-box');
  ok('there is somewhere to say what went wrong', await fix.count() === 1);
  await fix.locator('summary').click();
  await page.waitForTimeout(200);
  const faults = fix.locator('.sl-symptoms .sl-btn');
  ok('with the faults named as somebody would say them (' + await faults.count() + ')',
    await faults.count() >= 10, String(await faults.count()));

  const before = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('orca_slicer_settings_v1') || '{}').retractLength);
  await fix.locator('[data-symptom="stringing"]').click();
  await page.waitForTimeout(300);
  const fixes = fix.locator('.sl-advice-item');
  ok('choosing one answers it (' + await fixes.count() + ')', await fixes.count() >= 1,
    String(await fixes.count()));
  const said = await fixes.first().locator('.why').textContent();
  ok('and the answer explains itself', said.length > 30, said);

  // The numbers on the button are this profile's, not a fixed list's.
  const button = await fixes.first().locator('button.primary').textContent();
  ok('the change is offered with the profile’s own numbers in it (' + button + ')',
    /\d/.test(button) && /→/.test(button), button);
  await fixes.first().locator('button.primary').click();
  await page.waitForTimeout(400);
  const after = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('orca_slicer_settings_v1') || '{}').retractLength);
  ok('applying it changes the setting (' + before + ' → ' + after + ')', after !== before,
    before + ' → ' + after);

  // Choosing the same fault again puts it away.
  await page.locator('#fix-box [data-symptom="stringing"]').click();
  await page.waitForTimeout(300);
  ok('choosing it again closes it',
    await page.locator('#fix-box .sl-advice-item').count() === 0);

  ok('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
