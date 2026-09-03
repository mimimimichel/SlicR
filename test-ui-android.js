/**
 * Prismatic on Android — the bridge, without a device.
 *
 * Two things in the app do not happen in a browser at all, and so are the two
 * that ship untested unless something like this exists. A file leaves the page
 * in base64 pieces because a WebView download is a dead end; a mesh arrives the
 * same way when somebody opens one with the app. Both are exactly the kind of
 * plumbing that quietly loses the second half of a file — and a STEP file that
 * stops in the middle of a face is worse than one that never arrived, because
 * it opens.
 *
 * So: a stand-in for the native side that reassembles what it is handed, and
 * one that drops a piece on purpose. What comes out the far end has to be the
 * same solid that went in, and a loss has to be said out loud rather than
 * saved.
 *
 *   python3 -m http.server 8099   (from the repo root)
 *   node test-ui-android.js
 */
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const V = require('./test-step.js');
const APP = process.env.APP || 'http://localhost:8099/prismatic/index.html';

/** A 20 x 30 x 10 box in 768 facets, as an ASCII STL. */
function boxSTL() {
  const w = 20, d = 30, h = 10;
  const c = [[0, 0, 0], [w, 0, 0], [w, d, 0], [0, d, 0],
             [0, 0, h], [w, 0, h], [w, d, h], [0, d, h]];
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  let tris = [];
  for (const q of quads) tris.push([c[q[0]], c[q[1]], c[q[2]]], [c[q[0]], c[q[2]], c[q[3]]]);
  const mid = (a, b) => a.map((v, i) => (v + b[i]) / 2);
  for (let pass = 0; pass < 3; pass++) {
    const next = [];
    for (const [a, b, x] of tris) {
      const ab = mid(a, b), bx = mid(b, x), xa = mid(x, a);
      next.push([a, ab, xa], [ab, b, bx], [xa, bx, x], [ab, bx, xa]);
    }
    tris = next;
  }
  const out = ['solid box'];
  for (const t of tris) {
    out.push('facet normal 0 0 0', 'outer loop');
    for (const v of t) out.push('vertex ' + v.map(n => n.toFixed(5)).join(' '));
    out.push('endloop', 'endfacet');
  }
  out.push('endsolid box');
  return out.join('\n');
}

/**
 * A sphere, which is a poor part and a good test: it converts into hundreds of
 * faces, so the STEP file runs to megabytes and has to cross the bridge in many
 * pieces rather than one.
 */
function sphereSTL(seg, r) {
  const at = (i, j) => {
    const phi = Math.PI * j / seg, theta = 2 * Math.PI * i / seg;
    return [r * Math.sin(phi) * Math.cos(theta), r * Math.sin(phi) * Math.sin(theta), r * Math.cos(phi)];
  };
  const out = ['solid ball'];
  const face = (a, b, c) => {
    out.push('facet normal 0 0 0', 'outer loop');
    for (const v of [a, b, c]) out.push('vertex ' + v.map(n => n.toFixed(5)).join(' '));
    out.push('endloop', 'endfacet');
  };
  for (let j = 0; j < seg; j++) {
    for (let i = 0; i < seg; i++) {
      const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
      if (j > 0) face(a, d, b);
      if (j < seg - 1) face(b, d, c);
    }
  }
  out.push('endsolid ball');
  return out.join('\n');
}

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
  });

  let pass = 0, fail = 0;
  const ok = (label, cond, detail) => {
    if (cond) { pass++; console.log('  ok    ' + label); }
    else { fail++; console.log('  FAIL  ' + label + (detail !== undefined ? '  -> ' + detail : '')); }
  };

  /**
   * A page with a stand-in for the native side already installed — before the
   * app boots, because that is when it looks for one.
   *
   * `lose` drops the nth piece on the floor while reporting success, which is
   * the failure that matters: the page has to notice from the byte count.
   * `mesh` is a file the app was opened with, waiting to be pulled across.
   */
  async function open({ lose = -1, mesh = null } = {}) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

    await page.addInitScript(({ lose, mesh }) => {
      const state = { name: null, mime: null, parts: [], bytes: 0, calls: 0,
                      ended: false, discarded: false, toasts: [] };
      window.__android = state;
      const incoming = mesh ? { name: mesh.name, text: mesh.text } : null;
      window.AndroidPrismatic = {
        beginSave(name, mime) {
          state.name = name; state.mime = mime;
          state.parts = []; state.bytes = 0; state.calls = 0;
          state.ended = false; state.discarded = false;
          return true;
        },
        appendSave(chunk) {
          state.calls++;
          // A piece dropped in the bridge: success reported, nothing written.
          if (lose >= 0 && state.calls === lose) return true;
          const raw = atob(chunk);
          state.parts.push(raw);
          state.bytes += raw.length;
          return true;
        },
        pendingBytes() { return String(state.bytes); },
        discardSave() { state.discarded = true; state.parts = []; state.bytes = 0; },
        endSave() { state.ended = true; },
        incomingName() { return incoming ? incoming.name : ''; },
        incomingSize() { return incoming ? String(incoming.text.length) : '0'; },
        incomingChunk(offset, length) {
          if (!incoming) return '';
          const from = parseInt(offset, 10), take = parseInt(length, 10);
          return btoa(incoming.text.slice(from, from + take));
        },
        incomingDone() { state.incomingDone = true; },
        toast(message) { state.toasts.push(message); }
      };
    }, { lose, mesh });

    await page.goto(APP);
    await page.waitForSelector('#btn-open');
    return { page, errors };
  }

  const settled = page => page.waitForFunction(() =>
    document.getElementById('toast').hidden && !document.getElementById('btn-step').disabled,
    { timeout: 60000 });
  const native = page => page.evaluate(() => ({
    name: window.__android.name,
    mime: window.__android.mime,
    text: window.__android.parts.join(''),
    bytes: window.__android.bytes,
    calls: window.__android.calls,
    ended: window.__android.ended,
    discarded: window.__android.discarded,
    toasts: window.__android.toasts
  }));

  console.log('=== 1. the page finds the bridge and uses it ===');
  {
    const { page, errors } = await open();
    await page.click('[data-demo]');
    await settled(page);
    await page.click('#btn-step');
    await page.waitForFunction(() => window.__android.ended, { timeout: 60000 });
    const got = await native(page);

    ok('nothing was downloaded — it went to Android', got.ended && !got.discarded);
    ok('under the name and type the system picker needs',
      got.name === 'bracket.step' && got.mime === 'model/step', got.name + ' / ' + got.mime);
    ok('in ' + got.calls + ' piece' + (got.calls === 1 ? '' : 's') + ', ' + got.bytes + ' bytes',
      got.bytes > 1000 && got.text.length === got.bytes, got.bytes + ' vs ' + got.text.length);

    // The part that matters: what came out the far end is the same solid.
    const entities = V.parse(got.text);
    ok('what arrived is a part 21 file',
      /^ISO-10303-21;/.test(got.text) && /END-ISO-10303-21;\s*$/.test(got.text));
    ok('with every reference resolved',
      V.references(entities).filter(r => !entities.has(r)).length === 0);
    const solid = V.solidOf(entities);
    let loose = 0, sameWay = 0;
    solid.edgeUse.forEach(senses => {
      if (senses.length !== 2) loose++;
      else if (senses[0] === senses[1]) sameWay++;
    });
    // Eight flat faces and the bore, which the recognition turned back into the
    // one cylinder it was drilled as.
    ok('and it is still a closed shell: ' + solid.faces.length + ' faces, ' +
       solid.edgeUse.size + ' edges', loose === 0 && sameWay === 0 && solid.faces.length === 9,
      loose + ' loose, ' + sameWay + ' agreeing');
    const shape = V.measure(solid);
    // The bracket, less a round hole rather than the twenty-eight sided one the
    // mesh had: a circle takes out a little more than the polygon inside it.
    const expect = (30 * 6 + 6 * 18 - Math.PI * 2.6 * 2.6) * 40;
    ok('enclosing the bracket it started as (' + shape.volume.toFixed(2) + ' mm3)',
      Math.abs(shape.volume - expect) < 1, shape.volume + ' vs ' + expect.toFixed(2));

    const toast = (await page.locator('#toast').textContent()).trim();
    ok('and the page says it is ready rather than saved, which is the truth',
      /is ready — choose where it goes/.test(toast), toast);
    ok('nothing threw', errors.length === 0, errors.slice(0, 2).join(' | '));
    await page.close();
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prismatic-android-'));
  const ballPath = path.join(dir, 'ball.stl');
  fs.writeFileSync(ballPath, sphereSTL(40, 10));

  console.log('\n=== 2. a file too big for one piece still arrives whole ===');
  {
    const { page, errors } = await open();
    await page.setInputFiles('#file-input', ballPath);
    await settled(page);
    await page.click('#btn-step');
    await page.waitForFunction(() => window.__android.ended, { timeout: 120000 });
    const got = await native(page);
    ok('it crossed in ' + got.calls + ' pieces, not one', got.calls > 3, got.calls);
    ok('and all ' + (got.bytes / 1024 | 0) + ' kB of it arrived',
      got.text.length === got.bytes && got.ended && !got.discarded, got.bytes);
    const entities = V.parse(got.text);
    ok('the reassembled file has every reference resolved',
      V.references(entities).filter(r => !entities.has(r)).length === 0);
    const solid = V.solidOf(entities);
    let loose = 0;
    solid.edgeUse.forEach(senses => { if (senses.length !== 2) loose++; });
    ok('and is a closed shell of ' + solid.faces.length + ' faces', loose === 0 && solid.faces.length > 300,
      solid.faces.length + ' faces, ' + loose + ' loose edges');
    ok('nothing threw', errors.length === 0, errors.slice(0, 2).join(' | '));
    await page.close();
  }

  console.log('\n=== 3. a piece lost in the middle is not a saved file ===');
  {
    const { page } = await open({ lose: 2 });
    await page.setInputFiles('#file-input', ballPath);
    await settled(page);
    await page.click('#btn-step');
    await page.waitForFunction(() => window.__android.discarded || window.__android.ended,
      { timeout: 120000 });
    const got = await native(page);
    ok('the transfer is thrown away rather than finished',
      got.discarded && !got.ended, JSON.stringify({ ended: got.ended, discarded: got.discarded }));
    const toast = (await page.locator('#toast').textContent()).trim();
    ok('and the page says so out loud', /did not reach Android/.test(toast), toast);
    await page.close();
  }

  console.log('\n=== 4. an STL goes out the same road ===');
  {
    const { page } = await open();
    await page.click('[data-demo]');
    await settled(page);
    await page.click('#btn-stl');
    await page.waitForFunction(() => window.__android.ended, { timeout: 60000 });
    const got = await native(page);
    ok('named and typed as a mesh', got.name === 'bracket.stl' && got.mime === 'model/stl',
      got.name + ' / ' + got.mime);
    // A binary STL is 84 bytes of header plus fifty per facet, and it has to
    // survive base64 exactly: this is the file that would print.
    ok('and every byte of the binary arrived (' + got.bytes + ')',
      got.bytes === 84 + 2176 * 50, got.bytes + ' vs ' + (84 + 2176 * 50));
    await page.close();
  }

  console.log('\n=== 5. a mesh opened with the app comes across ===');
  {
    const { page, errors } = await open({ mesh: { name: 'from-elsewhere.stl', text: boxSTL() } });
    await settled(page);
    const facts = await page.evaluate(() => {
      const out = {};
      const kids = Array.from(document.getElementById('facts').children);
      for (let i = 0; i < kids.length - 1; i += 2) out[kids[i].textContent.trim()] = kids[i + 1].textContent.trim();
      return out;
    });
    ok('it is open without anybody pressing anything',
      (await page.locator('#file-name').textContent()).trim() === 'from-elsewhere.stl',
      await page.locator('#file-name').textContent());
    ok('all 768 facets of it', facts.Triangles === '768', JSON.stringify(facts));
    ok('read as six flat faces', facts['Flat faces'] === '6', facts['Flat faces']);
    ok('and Android was told it can let go of the file',
      await page.evaluate(() => !!window.__android.incomingDone));
    ok('nothing threw', errors.length === 0, errors.slice(0, 2).join(' | '));
    await page.close();
  }

  console.log('\n=== 6. and in a browser none of this happens ===');
  {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.goto(APP);
    await page.waitForSelector('#btn-open');
    ok('no bridge, no stand-in for one',
      await page.evaluate(() => !window.AndroidPrismatic && !window.PrismaticNative));
    await page.close();
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
