const { chromium } = require('playwright');

const APP = process.env.APP || 'http://localhost:8099/index.html';
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(APP);
  await page.waitForSelector('#btn-slice');
  await page.click('[data-demo="cube"]');
  await page.waitForFunction(() => !document.getElementById('btn-slice').disabled);

  await page.click('#btn-panel').catch(()=>{});
  await page.waitForTimeout(300);
  await page.click('[data-tab="object"]');
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Duplicate', exact: true }).first().click();
  await page.waitForTimeout(500);
  console.log('objects listed:', await page.locator('.sl-object').count());

  // Turn on one-object-at-a-time
  await page.click('[data-tab="machine"]');
  await page.waitForTimeout(300);
  const ok = await page.evaluate(() => {
    const sel = [...document.querySelectorAll('select')].find(s =>
      [...s.options].some(o => o.value === 'object') &&
      [...s.options].some(o => o.value === 'layer'));
    if (!sel) return 'control not found';
    sel.value = 'object';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return 'set';
  });
  console.log('printSequence:', ok);

  await page.click('#btn-slice');
  await page.waitForFunction(() => !document.getElementById('btn-export').disabled, { timeout: 180000 });
  const report = await page.evaluate(() => {
    const t = document.body.innerText;
    return { hasError: /error/i.test(document.querySelector('#check-status') ? document.querySelector('#check-status').textContent : '') };
  });
  console.log('sliced one-at-a-time ok', JSON.stringify(report));
  await browser.close();
  console.log(errors.length ? 'ERRORS: ' + errors.join(' | ') : 'no console errors');
  process.exit(errors.length ? 1 : 0);
})();
