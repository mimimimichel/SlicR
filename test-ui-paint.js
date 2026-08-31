const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto('http://localhost:8099/index.html');
  await page.waitForSelector('#btn-slice');
  await page.click('[data-demo="cube"]');
  await page.waitForFunction(() => !document.getElementById('btn-slice').disabled);

  // Paint mode
  await page.click('#tool-paint');
  const visible = await page.isVisible('#paint-palette');
  console.log('palette visible:', visible);

  const box = await page.locator('#sl-canvas').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(200);
  let count = await page.textContent('#paint-count');
  console.log('after one tap:', count);

  await page.click('[data-paint="seam"]');
  await page.mouse.click(cx + 90, cy - 70);
  await page.waitForTimeout(200);
  console.log('after two taps:', await page.textContent('#paint-count'));

  const kinds = await page.evaluate(() => window.__viewer ? null :
    (document.querySelectorAll('#paint-palette .on').length));
  console.log('selected brushes:', kinds);

  // Erase brush removes any mark
  await page.click('[data-paint="erase"]');
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(200);
  console.log('after removing one:', await page.textContent('#paint-count'));

  // Dragging must lay a stroke, not a single dab.
  await page.click('[data-paint="enforce"]');
  await page.mouse.move(cx - 60, cy - 40);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(cx - 60 + i * 10, cy - 40 + i * 4);
  await page.mouse.up();
  await page.waitForTimeout(200);
  const afterStroke = await page.textContent('#paint-count');
  const strokeMarks = parseInt(afterStroke, 10) || 0;
  console.log('after a drag:', afterStroke);
  if (strokeMarks < 4) { console.log('FAIL: dragging did not paint a stroke'); process.exit(1); }

  // Dragging with the eraser must rub the stroke back out.
  await page.click('[data-paint="erase"]');
  await page.mouse.move(cx - 60, cy - 40);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(cx - 60 + i * 10, cy - 40 + i * 4);
  await page.mouse.up();
  await page.waitForTimeout(200);
  const afterErase = await page.textContent('#paint-count');
  console.log('after erasing along it:', afterErase);
  if ((parseInt(afterErase, 10) || 0) >= strokeMarks) {
    console.log('FAIL: dragging the eraser did not remove the stroke');
    process.exit(1);
  }
  await page.click('[data-paint="enforce"]');

  // Slice with paint on
  await page.click('#btn-slice');
  await page.waitForFunction(() => !document.getElementById('btn-export').disabled, { timeout: 120000 });
  console.log('sliced with paint ok');

  await page.click('#tool-preview');          // back from the sliced preview
  await page.waitForTimeout(300);
  await page.mouse.click(cx, cy);            // something left to clear
  await page.waitForTimeout(200);
  await page.click('#paint-clear');
  console.log('after clear:', await page.textContent('#paint-count'));

  console.log(errors.length ? 'ERRORS: ' + errors.join(' | ') : 'no console errors');
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})();
