/**
 * Panning, measured the way it is complained about: by where the model ends up
 * on the screen.
 *
 * Nothing here reads the camera. It drags, screenshots, and works out where the
 * lit pixels moved to — which is the only thing a person can see.
 *
 *   python3 -m http.server 8099   (from the repo root)
 *   node test-ui-pan.js
 */
const { chromium } = require('playwright');

const APP = process.env.APP || 'http://localhost:8099/index.html';

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
  });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));

  let pass = 0, fail = 0;
  const ok = (label, cond, detail) => {
    if (cond) { pass++; console.log('  ok    ' + label); }
    else { fail++; console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); }
  };

  /**
   * Where the model is on screen, as the centre of everything that is not the
   * background. Read straight off the canvas.
   */
  const modelCentre = () => page.evaluate(() => {
    const canvas = document.getElementById('sl-canvas');
    const w = canvas.width, h = canvas.height;
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const pixels = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    // The model is drawn far brighter than the plate or the background, so a
    // simple threshold finds it without knowing any of the colours.
    let sx = 0, sy = 0, n = 0;
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        const i = (y * w + x) * 4;
        const lum = pixels[i] + pixels[i + 1] + pixels[i + 2];
        if (lum > 330) { sx += x; sy += y; n++; }
      }
    }
    // readPixels has y running up from the bottom; flip it so this reads the
    // way the screen does.
    return n ? { x: sx / n, y: h - sy / n, n, w, h } : null;
  });

  const twoFingerDrag = async (dx, dy) => {
    const box = await page.locator('#sl-canvas').boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const a = { id: 11, x: cx - 60, y: cy };
    const b = { id: 12, x: cx + 60, y: cy };
    const send = (type, p) => page.evaluate(([type, id, x, y]) => {
      const canvas = document.getElementById('sl-canvas');
      const r = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new PointerEvent(type, {
        pointerId: id, pointerType: 'touch', isPrimary: id === 11,
        clientX: x, clientY: y, bubbles: true, cancelable: true,
        buttons: type === 'pointerup' ? 0 : 1
      }));
      return r.width > 0;
    }, [type, p.id, p.x, p.y]);

    await send('pointerdown', a);
    await send('pointerdown', b);
    // In steps, the way fingers actually move.
    for (let i = 1; i <= 6; i++) {
      await send('pointermove', { id: a.id, x: a.x + dx * i / 6, y: a.y + dy * i / 6 });
      await send('pointermove', { id: b.id, x: b.x + dx * i / 6, y: b.y + dy * i / 6 });
      await page.waitForTimeout(20);
    }
    await send('pointerup', { id: a.id, x: a.x + dx, y: a.y + dy });
    await send('pointerup', { id: b.id, x: b.x + dx, y: b.y + dy });
    await page.waitForTimeout(250);
  };

  await page.goto(APP);
  await page.waitForSelector('#btn-slice');
  await page.click('[data-demo="cube"]');
  await page.waitForFunction(() => !document.getElementById('btn-slice').disabled);
  // Looking straight down: the cube is then a flat square at one depth, so its
  // pixel centre moves exactly as far as the view does. From an angle a solid's
  // visible faces change as the camera slides sideways, and the centre of the
  // lit pixels drifts by a few percent on its own — real, and not what is being
  // measured here.
  await page.click('[data-view="top"]');
  await page.waitForTimeout(400);

  // And zoomed well out. The pan tracks whatever is at the distance being
  // looked at, which is the plate; the cube's top face is twenty millimetres
  // nearer the camera and crosses more of the screen for the same drag. From
  // close up that is a fifty per cent error in the measurement and none in the
  // code — from far enough back it is a couple of per cent.
  const zoomBox = await page.locator('#sl-canvas').boundingBox();
  for (let i = 0; i < 24; i++) {
    await page.mouse.move(zoomBox.x + zoomBox.width / 2, zoomBox.y + zoomBox.height / 2);
    await page.mouse.wheel(0, 120);
  }
  await page.waitForTimeout(400);

  const start = await modelCentre();
  ok('the cube is on screen to measure (' + (start ? Math.round(start.x) + ',' + Math.round(start.y) : 'not found') + ')',
    !!start && start.n > 200, JSON.stringify(start));

  // Two fingers right. The model has to follow them, and by as far as they
  // went — a pan at any other rate slides out from under the finger holding it.
  await twoFingerDrag(160, 0);
  const right = await modelCentre();
  ok('two fingers 160 px right move the model 160 px right (' +
    Math.round(right.x - start.x) + ')',
    Math.abs((right.x - start.x) - 160) < 20, Math.round(right.x - start.x) + ' px');

  await twoFingerDrag(-160, 0);
  const back = await modelCentre();
  ok('and 160 px back left (' + Math.round(back.x - right.x) + ')',
    Math.abs((back.x - right.x) + 160) < 20, Math.round(back.x - right.x) + ' px');
  ok('landing where it started', Math.abs(back.x - start.x) < 12,
    Math.round(back.x - start.x) + ' px off');

  await twoFingerDrag(0, 140);
  const down = await modelCentre();
  ok('two fingers 140 px down move it 140 px down (' + Math.round(down.y - back.y) + ')',
    Math.abs((down.y - back.y) - 140) < 20, Math.round(down.y - back.y) + ' px');

  await twoFingerDrag(0, -140);
  const up = await modelCentre();
  ok('and 140 px back up, where it was',
    Math.abs((up.y - down.y) + 140) < 20 && Math.abs(up.y - back.y) < 12,
    Math.round(up.y - down.y) + ' px, ' + Math.round(up.y - back.y) + ' off');

  // Pinching shares the gesture with the pan, and the pan fix changed how it is
  // measured. Apart, together, and back to the same separation: the model has
  // to end the size it started.
  // Fingers start `from` apart and end `to` apart, without ever crossing —
  // which real fingers cannot do either.
  const pinch = async (from, to) => {
    const box = await page.locator('#sl-canvas').boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const send = (type, id, x, y) => page.evaluate(([type, id, x, y]) => {
      document.getElementById('sl-canvas').dispatchEvent(new PointerEvent(type, {
        pointerId: id, pointerType: 'touch', isPrimary: id === 11,
        clientX: x, clientY: y, bubbles: true, cancelable: true,
        buttons: type === 'pointerup' ? 0 : 1
      }));
    }, [type, id, x, y]);
    const half = s => s / 2;
    await send('pointerdown', 11, cx - half(from), cy);
    await send('pointerdown', 12, cx + half(from), cy);
    for (let i = 1; i <= 8; i++) {
      const s = from + (to - from) * i / 8;
      await send('pointermove', 11, cx - half(s), cy);
      await send('pointermove', 12, cx + half(s), cy);
      await page.waitForTimeout(15);
    }
    await send('pointerup', 11, cx - half(to), cy);
    await send('pointerup', 12, cx + half(to), cy);
    await page.waitForTimeout(250);
  };

  const sizeOf = () => page.evaluate(() => {
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

  const size0 = await sizeOf();
  await pinch(160, 400);
  const bigger = await sizeOf();
  ok('spreading two fingers makes the model bigger (' + size0 + ' → ' + bigger + ')',
    bigger > size0 * 1.3, size0 + ' → ' + bigger);

  await pinch(400, 160);
  const size1 = await sizeOf();
  ok('bringing them back leaves it the size it started (' + size0 + ' → ' + size1 + ')',
    Math.abs(size1 - size0) < Math.max(40, size0 * 0.08), size0 + ' → ' + size1);

  // The mouse pan shares the same code, so it has to agree.
  const box = await page.locator('#sl-canvas').boundingBox();
  const before = await modelCentre();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(box.x + box.width / 2 + 120 * i / 6, box.y + box.height / 2);
  }
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.waitForTimeout(250);
  const after = await modelCentre();
  ok('a shift-drag tracks the mouse the same way (' +
    Math.round(after.x - before.x) + ' px for 120)',
    Math.abs((after.x - before.x) - 120) < 20, Math.round(after.x - before.x) + ' px');

  ok('no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  await browser.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
