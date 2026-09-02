/**
 * The layout of the controls, checked the way it is judged: by looking.
 *
 * Nothing here reads a stylesheet. It asks the browser where each control
 * actually ended up, whether its name is on screen, and whether it is offering
 * itself for a job it cannot do — which is what "clear" and "easy to use"
 * come down to.
 *
 *   python3 -m http.server 8099   (from the repo root)
 *   node test-ui-layout.js
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
  const box = sel => page.locator(sel).first().boundingBox();
  const disabled = sel => page.locator(sel).first().isDisabled();

  await page.goto(APP);
  await page.waitForSelector('#btn-slice');

  // --- Every picker says what it picks -------------------------------------
  // Three dropdowns in a row, unlabelled, are three guesses.
  for (const [id, name] of [['sel-printer', 'Printer'], ['sel-filament', 'Filament'],
                            ['sel-quality', 'Quality']]) {
    const caption = await page.evaluate((id) => {
      const sel = document.getElementById(id);
      const label = sel.closest('.sl-preset');
      const small = label && label.querySelector('small');
      if (!small) return null;
      const a = small.getBoundingClientRect(), b = sel.getBoundingClientRect();
      const style = getComputedStyle(small);
      return {
        text: small.textContent.trim(),
        shown: style.display !== 'none' && style.visibility !== 'hidden' && a.height > 4,
        above: a.bottom <= b.top + 1,
        aligned: Math.abs(a.left - b.left) < 12
      };
    }, id);
    ok('the ' + name.toLowerCase() + ' picker wears its name (' +
      (caption ? caption.text : 'none') + ')',
      !!caption && caption.text === name && caption.shown && caption.above && caption.aligned,
      JSON.stringify(caption));
  }

  // --- The things that act are together, in the order the job happens ------
  const order = await page.evaluate(() => {
    const group = document.getElementById('topbar-actions');
    if (!group) return null;
    const ids = ['btn-panel', 'btn-slice', 'btn-export', 'btn-send'];
    // Send is not there until a printer is, so it is not in the running.
    const shown = ids.filter(id => !document.getElementById(id).hidden);
    return {
      allInside: ids.every(id => group.contains(document.getElementById(id))),
      shown: shown,
      leftToRight: shown.map(id => Math.round(document.getElementById(id).getBoundingClientRect().left)),
      afterPickers: group.getBoundingClientRect().left >=
        document.getElementById('sel-quality').getBoundingClientRect().right
    };
  });
  ok('settings, slice, download and send are one group', order && order.allInside,
    JSON.stringify(order));
  ok('in that order, left to right (' + (order ? order.leftToRight.join(' < ') : '') + ')',
    order && order.leftToRight.every((x, i, a) => i === 0 || x > a[i - 1]),
    JSON.stringify(order && order.leftToRight));
  ok('and they sit after the pickers, not among them', order && order.afterPickers);

  // --- Nothing on the plate: the tools that need one say so ----------------
  for (const id of ['tool-move', 'tool-face', 'tool-paint', 'tool-arrange', 'tool-delete']) {
    ok(id.replace('tool-', '') + ' is greyed out with an empty plate', await disabled('#' + id));
  }
  ok('but the view tool is always available', !await disabled('#tool-orbit'));
  ok('and preview waits for something to preview', await disabled('#tool-preview'));

  // --- Every tool is named on screen, not only in a tooltip ----------------
  // A title attribute is worth nothing on the tablet this is built for.
  const named = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.sl-tools .sl-btn')).map(b => {
      const word = b.querySelector('b');
      const r = word && word.getBoundingClientRect();
      return { id: b.id, word: word ? word.textContent.trim() : null,
               shown: !!r && r.height > 4 && r.width > 8 };
    });
  });
  ok('all six tools carry a word (' + named.map(n => n.word).join(', ') + ')',
    named.length === 6 && named.every(n => n.word && n.shown), JSON.stringify(named));

  // --- Load something: the same tools come alive ---------------------------
  await page.click('[data-demo="cube"]');
  await page.waitForFunction(() => !document.getElementById('btn-slice').disabled);
  await page.waitForTimeout(200);
  for (const id of ['tool-move', 'tool-face', 'tool-paint', 'tool-arrange']) {
    ok(id.replace('tool-', '') + ' wakes up once there is a model', !await disabled('#' + id));
  }

  // The brush palette opens beside the tool column, and the column is wider
  // than it was now that every tool wears its name.
  await page.click('#tool-paint');
  await page.waitForTimeout(300);
  for (const [w, h] of [[1400, 950], [700, 900]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(300);
    const clash = await page.evaluate(() => {
      const a = document.querySelector('.sl-tools').getBoundingClientRect();
      const b = document.querySelector('.sl-paint').getBoundingClientRect();
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      return ox > 2 && oy > 2 ? { over: Math.round(ox) + '×' + Math.round(oy) } : null;
    });
    ok('the brush palette opens clear of the tools at ' + w + '×' + h, !clash,
      JSON.stringify(clash));
  }
  await page.setViewportSize({ width: 1400, height: 950 });
  await page.waitForTimeout(300);
  await page.click('#tool-orbit');
  await page.waitForTimeout(200);

  // --- The camera buttons say where the camera is --------------------------
  await page.click('[data-view="front"]');
  await page.waitForTimeout(300);
  let lit = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-view]')).filter(b => b.classList.contains('on'))
      .map(b => b.dataset.view));
  ok('the angle you asked for is the one lit up (' + lit.join(',') + ')',
    lit.length === 1 && lit[0] === 'front', JSON.stringify(lit));

  // Orbit by hand and it stops claiming to be square-on, rather than lying.
  const c = await box('#sl-canvas');
  await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
  await page.mouse.down();
  await page.mouse.move(c.x + c.width / 2 + 90, c.y + c.height / 2 + 40, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  lit = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-view]')).filter(b => b.classList.contains('on')).length);
  ok('and stops once the view is dragged somewhere else', lit === 0, String(lit));

  // --- Preview belongs with the views, and turns on after a slice ----------
  ok('preview sits with the camera buttons, not among the model tools',
    await page.evaluate(() => {
      const p = document.getElementById('tool-preview');
      return !!p.closest('.sl-views') && !p.closest('.sl-tools');
    }));

  await page.click('#btn-slice');
  await page.waitForFunction(() => !document.getElementById('btn-export').disabled,
    { timeout: 180000 });
  await page.waitForTimeout(400);
  const lightsOn = () => page.evaluate(() =>
    document.getElementById('tool-preview').classList.contains('on'));
  ok('preview is offered once there is a slice', !await disabled('#tool-preview'));
  ok('and comes on by itself, the slice being what was just asked for', await lightsOn());
  await page.click('#tool-preview');
  await page.waitForTimeout(400);
  ok('pressing it goes back to the model', !await lightsOn());
  await page.click('#tool-preview');
  await page.waitForTimeout(400);
  ok('pressing it again returns to the sliced result, lit up', await lightsOn());
  ok('the layer buttons under the slider are named too', await page.evaluate(() => {
    const words = ['btn-single', 'btn-travels'].map(id => {
      const b = document.getElementById(id).querySelector('b');
      const r = b && b.getBoundingClientRect();
      return b && r.height > 4 ? b.textContent.trim() : null;
    });
    return words.every(Boolean) && words.join(',');
  }));

  // --- Nothing sits on top of anything else --------------------------------
  // Overlapping panels are the fastest way to make a screen unusable, and they
  // only show up at particular sizes.
  const overlapsAt = (w, h) => page.setViewportSize({ width: w, height: h })
    .then(() => page.waitForTimeout(400))
    .then(() => page.evaluate(() => {
      const names = ['.sl-tools', '.sl-views', '.sl-layers.show', '.sl-stats.show',
                     '.sl-legend.show', '.sl-check-status.show', '.sl-topbar'];
      const seen = names.map(s => ({ s, el: document.querySelector(s) }))
        .filter(x => x.el && x.el.getBoundingClientRect().width > 0)
        .map(x => ({ s: x.s, r: x.el.getBoundingClientRect() }));
      const hits = [];
      for (let i = 0; i < seen.length; i++) {
        for (let j = i + 1; j < seen.length; j++) {
          const a = seen[i].r, b = seen[j].r;
          const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (ox > 2 && oy > 2) hits.push(seen[i].s + ' over ' + seen[j].s);
        }
      }
      return hits;
    }));

  for (const [w, h, what] of [[1400, 950, 'a laptop'], [1024, 768, 'a landscape tablet'],
                              [820, 1180, 'a portrait tablet'], [700, 900, 'a phone']]) {
    const hits = await overlapsAt(w, h);
    ok('nothing overlaps on ' + what + ' (' + w + '×' + h + ')', hits.length === 0,
      JSON.stringify(hits));
  }

  // --- Emptying the plate puts the pointer back somewhere usable -----------
  await page.setViewportSize({ width: 1400, height: 950 });
  await page.waitForTimeout(300);
  await page.click('#tool-preview');          // back to the model
  await page.waitForTimeout(200);
  await page.click('#tool-move');
  await page.waitForTimeout(200);
  await page.click('#sl-canvas');             // pick the cube
  await page.waitForTimeout(200);
  const canDelete = !await disabled('#tool-delete');
  ok('picking a model offers delete', canDelete);
  if (canDelete) {
    await page.click('#tool-delete');
    await page.waitForTimeout(300);
    ok('and with the plate empty the pointer is back on Select, not stuck in a greyed-out mode',
      await page.evaluate(() => document.getElementById('tool-orbit').classList.contains('on') &&
        !document.getElementById('tool-move').classList.contains('on')));
    ok('with the tools that need a model greyed out again', await disabled('#tool-move'));
  }

  // --- and when the browser will not help -----------------------------------
  // Some WebViews refuse to serve a worker script at all. The app is supposed
  // to notice and slice in the page instead, and the person is not supposed to
  // be able to tell — so this is the same slice with Worker taken away before
  // the app ever loads.
  const shut = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const shutErrors = [];
  shut.on('pageerror', e => shutErrors.push(e.message));
  await shut.addInitScript(() => {
    window.Worker = function () { throw new Error('Workers are not available here'); };
  });
  await shut.goto(APP);
  await shut.waitForSelector('#btn-slice');
  await shut.click('[data-demo="cube"]');
  await shut.waitForFunction(() => !document.getElementById('btn-slice').disabled);
  await shut.click('#btn-slice');
  const inPage = await shut.waitForFunction(
    () => !document.getElementById('btn-export').disabled, { timeout: 300000 }
  ).then(() => true).catch(() => false);
  ok('a browser with no workers slices in the page instead', inPage);
  const stats = await shut.evaluate(() => {
    const el = document.getElementById('stats') || document.querySelector('.sl-stats');
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
  });
  ok('and reports the same kind of answer (' + stats.slice(0, 40) + ')',
    /Layers/.test(stats) && /Filament/.test(stats), stats.slice(0, 60));
  ok('with nothing broken on the way', shutErrors.length === 0, shutErrors.slice(0, 2).join(' | '));
  await shut.close();

  ok('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
