/**
 * The subnet sweep, against a stand-in network.
 *
 *   node test-discover.js
 */
var D = require('./js/slicer/discover.js');

var pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); }
}
function done() {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

/**
 * A network: a map of "host:port" to what lives there. `cors` says whether the
 * device lets this page read the answer, which is the difference between
 * naming it and merely finding it.
 */
function network(devices) {
  var calls = [];
  function f(url, init) {
    calls.push({ url: url, mode: (init || {}).mode });
    var m = /^http:\/\/([\d.]+)(?::(\d+))?(\/.*)$/.exec(url);
    if (!m) return Promise.reject(new Error('bad url'));
    var key = m[1] + ':' + (m[2] || '80');
    var path = m[3];
    var dev = devices[key];
    if (!dev) return Promise.reject(new TypeError('Failed to fetch'));

    // no-cors: the browser resolves opaquely for anything that answered.
    if ((init || {}).mode === 'no-cors') {
      return Promise.resolve({ ok: false, status: 0, type: 'opaque',
        text: function () { return Promise.resolve(''); } });
    }
    if (!dev.cors) return Promise.reject(new TypeError('Failed to fetch'));
    if (dev.key && (!init || !init.headers || init.headers['X-Api-Key'] !== dev.key)) {
      return Promise.resolve({ ok: false, status: 403,
        text: function () { return Promise.resolve(''); } });
    }
    var body = dev.paths && dev.paths[path.split('?')[0]];
    if (body === undefined) {
      return Promise.resolve({ ok: false, status: 404, text: function () { return Promise.resolve(''); } });
    }
    return Promise.resolve({ ok: true, status: 200,
      text: function () { return Promise.resolve(JSON.stringify(body)); } });
  }
  f.calls = calls;
  return f;
}

console.log('=== 1. which subnet to sweep ===');
ok('a private address gives its own /24', D.guessBase('192.168.1.57') === '192.168.1');
ok('so does a 10-net', D.guessBase('10.0.0.4') === '10.0.0');
ok('and a 172.16-31 one', D.guessBase('172.20.5.9') === '172.20.5');
ok('but not 172.15, which is public', D.guessBase('172.15.5.9') === '');
ok('nor a public address', D.guessBase('93.184.216.34') === '');
ok('nor a host name', D.guessBase('printer.local') === '');

console.log('\n=== 2. a subnet with three things on it ===');
var net = network({
  '192.168.1.10:80': {
    cors: true,
    paths: { '/system/info': { error_code: 0,
      system_info: { sn: 'CC2ABC', host_name: 'Atelier', machine_model: 'Centauri Carbon 2' } } }
  },
  // OctoPrint answers nothing without its key, which is why an unconfigured
  // sweep can find it but not name it.
  '192.168.1.20:5000': {
    cors: true, key: 'SECRET',
    paths: { '/api/version': { server: '1.10.2', api: '0.1' } }
  },
  // A printer that answers but will not let a stranger's page read it — the
  // ordinary case, and the one worth getting right.
  '192.168.1.30:80': { cors: false, paths: {} },
  // And something that is not a printer at all.
  '192.168.1.40:80': { cors: true, paths: { '/nothing': {} } }
});

D.scan({ base: '192.168.1', from: 1, to: 60, fetch: net, timeout: 50, width: 40 })
  .then(function (found) {
    ok('finds all four addresses that answered', found.length === 4,
      JSON.stringify(found.map(function (d) { return d.host; })));

    var cc2 = found.filter(function (d) { return d.host === '192.168.1.10'; })[0];
    ok('names the Centauri Carbon 2 and its serial',
      cc2 && cc2.kind === 'elegoo_cc2' && cc2.name === 'Atelier' && cc2.serial === 'CC2ABC',
      JSON.stringify(cc2));

    var octo = found.filter(function (d) { return d.host === '192.168.1.20'; })[0];
    ok('finds OctoPrint but cannot name it without its key',
      octo && octo.kind === 'unknown' && octo.port === 5000, JSON.stringify(octo));
    ok('and the address it hands over carries that port',
      D.addressOf(octo) === '192.168.1.20:5000', D.addressOf(octo));
    ok('while port 80 is left off an address', D.addressOf(cc2) === '192.168.1.10');

    var quiet = found.filter(function (d) { return d.host === '192.168.1.30'; })[0];
    ok('a device that refuses to be read is still reported',
      quiet && quiet.kind === 'unknown' && quiet.identified === false, JSON.stringify(quiet));

    var other = found.filter(function (d) { return d.host === '192.168.1.40'; })[0];
    ok('and so is something that is not a printer, unnamed',
      other && other.kind === 'unknown', JSON.stringify(other));

    ok('in address order',
      found.map(function (d) { return d.host; }).join(',') ===
      '192.168.1.10,192.168.1.20,192.168.1.30,192.168.1.40',
      found.map(function (d) { return d.host; }).join(','));
  })
  .then(function () {
    // With the key in hand, the same sweep names it.
    return D.scan({ base: '192.168.1', from: 20, to: 20, fetch: net, timeout: 50, key: 'SECRET' })
      .then(function (found) {
        var octo = found[0];
        ok('given the key, the same sweep names it',
          octo && octo.kind === 'octoprint' && /1\.10\.2/.test(octo.name), JSON.stringify(octo));
      });
  })
  .then(function () {
    console.log('\n=== 3. one machine, not one per port ===');
    var both = network({
      '192.168.1.10:80': { cors: true, paths: { '/system/info': { error_code: 0,
        system_info: { sn: 'X', host_name: 'Twice', machine_model: 'CC2' } } } },
      '192.168.1.10:5000': { cors: false, paths: {} }
    });
    return D.scan({ base: '192.168.1', from: 10, to: 10, fetch: both, timeout: 50 })
      .then(function (found) {
        ok('an address answering on two ports is reported once', found.length === 1,
          JSON.stringify(found));
        ok('and named by the probe that recognised it', found[0].kind === 'elegoo_cc2',
          JSON.stringify(found[0]));
      });
  })
  .then(function () {
    console.log('\n=== 4. an empty network, and a bad request ===');
    return D.scan({ base: '10.1.2', from: 1, to: 20, fetch: network({}), timeout: 20 })
      .then(function (found) { ok('nothing found is an empty list, not an error', found.length === 0); });
  })
  .then(function () {
    return D.scan({ base: 'not a subnet', fetch: network({}) }).then(function () {
      fail++; console.log('  FAIL  a bad subnet resolved');
    }, function (err) { ok('a bad subnet is refused with an example', /192\.168\.1/.test(err.message), err.message); });
  })
  .then(function () {
    console.log('\n=== 5. it reports as it goes, and stops when told ===');
    var seen = [];
    return D.scan({
      base: '192.168.1', from: 1, to: 60, fetch: net, timeout: 50,
      onFound: function (d) { seen.push(d.host); }
    }).then(function (found) {
      ok('every device is announced while the sweep runs, not only at the end',
        seen.length === found.length && seen.length === 4, JSON.stringify(seen));
    });
  })
  .then(function () {
    // Cancelled after the fiftieth probe rather than after a delay, so this
    // measures the check and not the machine it runs on.
    var probed = 0;
    var empty = network({});
    var counting = function (url, init) { probed++; return empty(url, init); };
    return D.scan({
      base: '192.168.1', from: 1, to: 254, fetch: counting, timeout: 10, width: 4,
      cancelled: function () { return probed >= 50; }
    }).then(function (found) {
      ok('cancelling stops the probing (' + probed + ' of 762) and still answers',
        probed < 100 && found.length === 0, String(probed));
    });
  })
  .then(done, function (err) {
    fail++;
    console.log('  FAIL  the chain threw: ' + (err && err.stack || err));
    done();
  });
