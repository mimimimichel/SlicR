/**
 * The app as a finger and a screen reader find it.
 *
 * This is a tablet app that lives next to a printer, so the questions are not
 * abstract: is every control big enough to hit, does every control say what it
 * is, can the text be read against what is behind it, and does anything run
 * off the side of the screen. Measured on a real viewport with the panel both
 * shut and open, because half the controls only exist in one of those.
 *
 *   python3 -m http.server 8099   (from the repo root)
 *   node test-ui-touch.js
 */
const { chromium } = require('playwright');
const APP = process.env.APP || 'http://localhost:8099/index.html';

// A finger is about 9 mm across. 44 px is the usual floor; 40×34 is the point
// below which a control is genuinely hard to hit rather than merely small.
const MIN_W = 40, MIN_H = 34;

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 1280 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  let pass = 0, fail = 0;
  const ok = (label, cond, detail) => {
    if (cond) { pass++; console.log('  ok    ' + label); }
    else { fail++; console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); }
  };

  const audit = () => page.evaluate(([minW, minH]) => {
    const out = { small: [], unnamed: [], poor: [], dupIds: [], overflow: null };

    document.querySelectorAll('button, [role=button], input, select, summary, a[href]')
      .forEach(el => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        if (!r.width && !r.height) return;
        if (s.display === 'none' || s.visibility === 'hidden') return;
        const name = (el.getAttribute('aria-label') || el.textContent || el.title ||
                      el.getAttribute('placeholder') || '').trim();
        if (r.width < minW || r.height < minH) {
          out.small.push((el.id || el.className || el.tagName) + ' ' +
            Math.round(r.width) + '×' + Math.round(r.height) + ' “' + name.slice(0, 18) + '”');
        }
        if (!name) out.unnamed.push(el.tagName + '#' + (el.id || '') + '.' + (el.className || ''));
      });

    // A translucent background is not the colour it names: it is that colour
    // laid over what is behind it. Reading the name alone makes a highlighted
    // control look far worse than it is.
    function parse(c) {
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/.exec(c || '');
      return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
    }
    function lum(c) {
      const p = parse(c);
      if (!p) return null;
      const f = [p.r, p.g, p.b].map(v => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
    }
    function bgOf(el) {
      const stack = [];
      let n = el;
      while (n && n !== document.documentElement) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; }
        n = n.parentElement;
      }
      const root = parse(getComputedStyle(document.body).backgroundColor) ||
                   { r: 255, g: 255, b: 255, a: 1 };
      let outc = stack.length && stack[stack.length - 1].a >= 1 ? stack.pop() : root;
      for (let i = stack.length - 1; i >= 0; i--) {
        const t = stack[i];
        outc = { r: t.r * t.a + outc.r * (1 - t.a),
                 g: t.g * t.a + outc.g * (1 - t.a),
                 b: t.b * t.a + outc.b * (1 - t.a), a: 1 };
      }
      return 'rgb(' + Math.round(outc.r) + ', ' + Math.round(outc.g) + ', ' + Math.round(outc.b) + ')';
    }
    document.querySelectorAll('label, .sl-hint, .msg, .why, button, .dim, summary, b')
      .forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return;
        const s = getComputedStyle(el);
        if (s.visibility === 'hidden' || s.display === 'none') return;
        if (!(el.textContent || '').trim()) return;
        const a = lum(s.color), bg = lum(bgOf(el));
        if (a === null || bg === null) return;
        const ratio = (Math.max(a, bg) + 0.05) / (Math.min(a, bg) + 0.05);
        const size = parseFloat(s.fontSize), bold = +s.fontWeight >= 600;
        const floor = (size >= 24 || (size >= 18.66 && bold)) ? 3 : 4.5;
        if (ratio < floor) {
          out.poor.push(el.textContent.trim().slice(0, 24) + ' ' + ratio.toFixed(1) + ':1');
        }
      });

    const seen = {};
    document.querySelectorAll('[id]').forEach(el => {
      if (seen[el.id]) out.dupIds.push(el.id); else seen[el.id] = 1;
    });
    if (document.documentElement.scrollWidth > window.innerWidth + 1) {
      out.overflow = document.documentElement.scrollWidth + ' wide in ' + window.innerWidth;
    }
    return out;
  }, [MIN_W, MIN_H]);

  await page.goto(APP);
  await page.waitForSelector('#btn-slice');
  await page.click('[data-demo="cube"]');
  await page.waitForFunction(() => !document.getElementById('btn-slice').disabled);
  await page.waitForTimeout(300);

  console.log('=== 1. the plate, with the panel shut ===');
  let a = await audit();
  ok('every control is big enough to hit (' + a.small.length + ' too small)',
    a.small.length === 0, a.small.slice(0, 5).join(' | '));
  ok('every control says what it is', a.unnamed.length === 0, a.unnamed.slice(0, 4).join(' | '));
  ok('every piece of text can be read against what is behind it',
    a.poor.length === 0, a.poor.slice(0, 5).join(' | '));
  ok('nothing runs off the side of the screen', !a.overflow, a.overflow);
  ok('no two things answer to the same name', a.dupIds.length === 0, a.dupIds.join(', '));

  console.log('\n=== 2. and with the settings open, where most of them are ===');
  await page.click('#btn-panel').catch(() => {});
  await page.waitForTimeout(400);
  a = await audit();
  const switches = await page.locator('.sl-switch').count();
  console.log('  ' + switches + ' switches on this tab');
  ok('every control is big enough to hit (' + a.small.length + ' too small)',
    a.small.length === 0, a.small.slice(0, 6).join(' | '));
  ok('every control says what it is', a.unnamed.length === 0, a.unnamed.slice(0, 4).join(' | '));
  ok('every piece of text can be read', a.poor.length === 0, a.poor.slice(0, 5).join(' | '));
  ok('nothing runs off the side', !a.overflow, a.overflow);
  ok('no two things answer to the same name', a.dupIds.length === 0, a.dupIds.join(', '));

  // The switches are drawn small on purpose and caught by a bigger target; the
  // target must not have stopped them switching.
  const toggles = await page.evaluate(async () => {
    const sw = document.querySelector('.sl-switch input');
    if (!sw) return null;
    const was = sw.checked;
    sw.click();
    await new Promise(r => setTimeout(r, 200));
    return was !== document.querySelector('.sl-switch input').checked;
  });
  ok('and a switch still switches', toggles === true, String(toggles));

  console.log('\n=== 3. and it can be driven from the keyboard ===');
  const reachable = await page.evaluate(() => {
    const focusable = Array.from(document.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), summary, a[href]'))
      .filter(el => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' &&
               el.tabIndex >= 0;
      });
    return focusable.length;
  });
  ok('the controls are in the tab order (' + reachable + ' of them)', reachable > 20,
    String(reachable));
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => {
    const el = document.activeElement;
    return el && el !== document.body
      ? (el.getAttribute('aria-label') || el.textContent || el.id || el.tagName).trim().slice(0, 30)
      : null;
  });
  ok('and tab lands on one of them (' + focused + ')', !!focused, String(focused));

  ok('nothing unexpected in the console', errors.length === 0, errors.slice(0, 2).join(' | '));
  await browser.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
