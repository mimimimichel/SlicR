/**
 * Driving the printer from the panel, over real sockets.
 *
 * The stand-in OctoPrint changes state when it is driven — pausing really makes
 * it paused, a heater target really lands — so this test reads the machine back
 * rather than trusting the button.
 *
 *   python3 -m http.server 8099                             (from the repo root)
 *   python3 test-octoprint-server.py 5099 TESTKEY 127.0.0.2 cors
 *   node test-ui-control.js
 */
const { chromium } = require('playwright');

const APP = process.env.APP || 'http://localhost:8099/index.html';
const OCTO = process.env.OCTO || '127.0.0.2:5099';
const KEY = process.env.OCTO_KEY || 'TESTKEY';

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
  const printerSays = async () => (await fetch('http://' + OCTO + '/api/printer',
    { headers: { 'X-Api-Key': KEY } })).json();
  const commands = async () => (await fetch('http://' + OCTO + '/_commands')).json();

  const openDevice = async () => {
    await page.click('#btn-panel').catch(() => {});
    await page.waitForTimeout(250);
    await page.click('[data-tab="device"]');
    await page.waitForTimeout(300);
  };

  // Put the machine into a printing state before connecting to it.
  await fetch('http://' + OCTO + '/_printing');

  await page.goto(APP);
  await page.waitForSelector('#btn-slice');

  // Connect by hand — the scan has its own test.
  await page.evaluate(([url, key]) => {
    localStorage.setItem('orca_slicer_octoprint_v1',
      JSON.stringify({ kind: 'octoprint', url, key, autoStart: false }));
  }, [OCTO, KEY]);
  await page.reload();
  await page.waitForSelector('#btn-slice');
  await openDevice();

  await page.waitForFunction(() => {
    const s = document.getElementById('control-state');
    return s && !/Reading/.test(s.textContent);
  }, { timeout: 20000 });

  const line = await page.locator('#control-state').textContent();
  ok('the panel reads the machine: ' + line.trim().slice(0, 80),
    /Printing/.test(line) && /Nozzle 215 °C/.test(line) && /Bed 60 °C/.test(line), line);
  ok('and shows the job and how far along it is',
    /part\.gcode/.test(line) && /42%/.test(line) && /30 min left/.test(line), line);

  // Pause it, and check the machine itself changed rather than the label.
  await page.click('#btn-job-pause');
  await page.waitForFunction(() => {
    const s = document.getElementById('control-state');
    return s && /Paused/.test(s.textContent);
  }, { timeout: 20000 });
  const paused = await printerSays();
  ok('pausing actually pauses the printer', paused.state.text === 'Paused',
    JSON.stringify(paused.state));
  const cmds = await commands();
  ok('by sending the documented command',
    cmds.some(c => c.path === '/api/job' && c.body.command === 'pause' && c.body.action === 'pause'),
    JSON.stringify(cmds.slice(-1)));

  // The button now offers the opposite.
  const resumeLabel = await page.locator('#btn-job-pause').textContent();
  ok('and the button becomes Resume', resumeLabel.trim() === 'Resume', resumeLabel);
  await page.click('#btn-job-pause');
  await page.waitForFunction(() => {
    const s = document.getElementById('control-state');
    return s && /Printing/.test(s.textContent);
  }, { timeout: 20000 });
  ok('resuming puts it back to printing', (await printerSays()).state.text === 'Printing');

  // A heater target has to reach the machine.
  await page.fill('#temp-bed', '65');
  await page.locator('button', { hasText: 'Heat bed' }).first().click();
  await page.waitForTimeout(1500);
  const heated = await printerSays();
  ok('setting the bed reaches the printer (' + heated.temperature.bed.target + ')',
    heated.temperature.bed.target === 65, JSON.stringify(heated.temperature.bed));

  // And an absurd one does not, with the ceiling named.
  await page.fill('#temp-nozzle', '2000');
  await page.locator('button', { hasText: 'Heat nozzle' }).first().click();
  await page.waitForTimeout(1200);
  const notHeated = await printerSays();
  ok('a 2000 °C nozzle never leaves the app',
    notHeated.temperature.tool0.target !== 2000, JSON.stringify(notHeated.temperature.tool0));
  const shown = await page.locator('#control-notice').textContent();
  ok('and the panel says which ceiling stopped it', /ceiling of/.test(shown), shown.slice(0, 120));

  // Jogging mid-print is refused before it reaches the wire.
  const before = (await commands()).length;
  await page.locator('button', { hasText: 'X +10' }).first().click();
  await page.waitForTimeout(800);
  ok('jogging while printing sends nothing', (await commands()).length === before);
  const jogMsg = await page.locator('#control-notice').textContent();
  ok('and says why', /through the part/.test(jogMsg), jogMsg.slice(0, 120));
  await page.waitForTimeout(5000);
  ok('and the refusal is still readable after the next poll',
    /through the part/.test(await page.locator('#control-notice').textContent()));

  // Cancelling asks first, and a refusal changes nothing.
  let asked = null;
  page.once('dialog', async d => { asked = d.message(); await d.dismiss(); });
  await page.click('#btn-job-cancel');
  await page.waitForTimeout(800);
  ok('cancelling asks first, and says what is lost',
    !!asked && /thrown away/.test(asked), asked);
  ok('and a no leaves it printing', (await printerSays()).state.text === 'Printing');

  page.once('dialog', async d => { await d.accept(); });
  await page.click('#btn-job-cancel');
  await page.waitForFunction(() => {
    const s = document.getElementById('control-state');
    return s && /Operational/.test(s.textContent);
  }, { timeout: 20000 });
  ok('and a yes stops the print', (await printerSays()).state.text === 'Operational');

  // Nothing is asked of the printer once the panel is closed.
  await page.click('#backdrop').catch(() => {});
  await page.waitForTimeout(500);
  const quiet = (await commands()).length;
  await page.waitForTimeout(6000);
  ok('the panel stops polling when it is closed', (await commands()).length === quiet);

  // A Centauri Carbon 2 is told plainly that none of this applies to it.
  await page.evaluate(() => {
    localStorage.setItem('orca_slicer_octoprint_v1',
      JSON.stringify({ kind: 'elegoo_cc2', url: '192.168.9.9', key: '', autoStart: false }));
  });
  await page.reload();
  await page.waitForSelector('#btn-slice');
  await openDevice();
  const cc2 = await page.locator('#control-reason').textContent().catch(() => '');
  ok('the CC2 gets a reason instead of dead buttons',
    /MQTT/.test(cc2) && /its own screen/.test(cc2), cc2);
  ok('and no job buttons at all', await page.locator('#btn-job-pause').count() === 0);

  const unexpected = errors.filter(e => !/40[13] \(|ERR_CONNECTION_REFUSED|net::ERR_FAILED/.test(e));
  ok('nothing unexpected in the console', unexpected.length === 0,
    JSON.stringify(unexpected.slice(0, 3)));

  await browser.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
