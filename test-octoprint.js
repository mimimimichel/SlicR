/**
 * The OctoPrint client, against a stub that answers the way OctoPrint does.
 *
 *   node test-octoprint.js
 */
var O = require('./js/slicer/octoprint.js');

var pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); }
}
function done() {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

/** A stub fetch that records what it was given and replies as told. */
function stub(reply) {
  var calls = [];
  function f(url, init) {
    calls.push({ url: url, init: init || {} });
    var r = typeof reply === 'function' ? reply(url, init) : reply;
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: function () { return Promise.resolve(r.body || ''); }
    });
  }
  f.calls = calls;
  return f;
}

var cfg = { url: 'octopi.local', key: 'ABC123' };

// Stand-ins for the two browser globals the upload is built from, so the real
// code path runs here rather than a test-only one beside it.
var lastForm = null;
globalThis.Blob = function (parts, o) { this.parts = parts; this.type = o && o.type; };
globalThis.FormData = function () {
  this.parts = [];
  lastForm = this;
  this.append = function (k, v, n) {
    this.parts.push([k, v instanceof globalThis.Blob ? 'blob:' + n : String(v)]);
  };
};

console.log('=== 1. addresses ===');
ok('a bare host becomes an http origin', O.normaliseUrl('octopi.local') === 'http://octopi.local');
ok('an https address is left alone', O.normaliseUrl('https://printer.lan/') === 'https://printer.lan');
ok('trailing slashes go', O.normaliseUrl('http://1.2.3.4:5000///') === 'http://1.2.3.4:5000');
ok('a path is kept', O.normaliseUrl('http://nas/octoprint/') === 'http://nas/octoprint');
ok('nothing in, nothing out', O.normaliseUrl('  ') === '');

console.log('\n=== 2. file names ===');
ok('spaces and accents are replaced', O.fileName('mon modèle v2') === 'mon_mod_le_v2.gcode');
ok('an extension is added once', O.fileName('part.gcode') === 'part.gcode');
ok('and something is always named', O.fileName('') === 'print.gcode');

console.log('\n=== 3. what each failure says ===');
[[401, /API key/i], [403, /API key/i], [404, /address/i], [409, /not ready|already running/i],
 [413, /too large/i], [415, /G-code/i], [500, /its side/i]].forEach(function (c) {
  var text = O.explain(c[0], '', 'http://octopi.local/api/files/local');
  ok(c[0] + ' is explained in words (' + text.slice(0, 46) + '…)', c[1].test(text), text);
});

console.log('\n=== 4. the calls themselves ===');
var seq = [];
var f1 = stub(function (url) {
  seq.push(url);
  if (/\/api\/version$/.test(url)) return { status: 200, body: '{"server":"1.10.2","api":"0.1"}' };
  if (/\/api\/connection$/.test(url)) return { status: 200, body: '{"current":{"state":"Operational"}}' };
  return { status: 404, body: '' };
});

O.test(cfg, { fetch: f1 }).then(function (info) {
  ok('test() reports the server version', info.server === '1.10.2', JSON.stringify(info));
  ok('and the printer state', info.state === 'Operational' && info.ready === true);
  ok('having asked the two documented endpoints',
    seq.join(' ') === 'http://octopi.local/api/version http://octopi.local/api/connection', seq.join(' '));
  ok('with the key in the header, not the URL',
    f1.calls[0].init.headers['X-Api-Key'] === 'ABC123' && !/ABC123/.test(f1.calls[0].url));

  // An older build with no /api/connection still counts as reachable.
  var f2 = stub(function (url) {
    return /version/.test(url) ? { status: 200, body: '{"server":"1.3.0"}' } : { status: 404, body: '' };
  });
  return O.test(cfg, { fetch: f2 });
}).then(function (info) {
  ok('a server without /api/connection is still reported', info.server === '1.3.0' && info.ready === false);

  var f3 = stub({ status: 201, body: '{"files":{"local":{"path":"mon_part.gcode"}}}' });
  return O.upload(cfg, 'mon part', 'G28\n', { fetch: f3, print: true })
    .then(function (res) {
      ok('upload posts to /api/files/local',
        f3.calls[0].url === 'http://octopi.local/api/files/local', f3.calls[0].url);
      ok('as a POST carrying the form', f3.calls[0].init.method === 'POST' &&
        f3.calls[0].init.body === lastForm);
      ok('with the G-code attached under the sanitised name',
        JSON.stringify(lastForm.parts[0]) === '["file","blob:mon_part.gcode"]',
        JSON.stringify(lastForm.parts));
      ok('and reports where it landed', res.location === 'mon_part.gcode' && res.started === true,
        JSON.stringify(res));
    });
}).then(function () {
  // Printing is never implied: without it, neither flag is set.
  return O.upload(cfg, 'p', 'G28\n', { fetch: stub({ status: 201, body: '{}' }) })
    .then(function (res) {
      ok('an upload with nothing asked for starts nothing',
        lastForm.parts.length === 1 && res.started === false, JSON.stringify(lastForm.parts));
    });
}).then(function () {
  return O.upload(cfg, 'p', 'G28\n', { fetch: stub({ status: 201, body: '{}' }), select: true })
    .then(function () {
      ok('selecting loads the job without starting it',
        JSON.stringify(lastForm.parts.slice(1)) === '[["select","true"]]',
        JSON.stringify(lastForm.parts));
    });
}).then(function () {
  return O.upload(cfg, 'p', 'G28\n', { fetch: stub({ status: 201, body: '{}' }), print: true })
    .then(function () {
      ok('and printing implies selecting',
        JSON.stringify(lastForm.parts.slice(1)) === '[["select","true"],["print","true"]]',
        JSON.stringify(lastForm.parts));
    });
}).then(function () {
  console.log('\n=== 5. failures reach the caller as sentences ===');
  return O.upload(cfg, 'p', 'G28\n', { fetch: stub({ status: 401, body: '' }) }).then(function () {
    fail++; console.log('  FAIL  a 401 resolved instead of throwing');
  }, function (err) {
    ok('a bad key throws with the remedy in it', /API key/i.test(err.message) && err.status === 401,
      err.message);
  });
}).then(function () {
  return O.upload(cfg, 'p', 'G28\n', { fetch: stub(new TypeError('Failed to fetch')) }).then(function () {
    fail++; console.log('  FAIL  a network error resolved instead of throwing');
  }, function (err) {
    ok('and an unreachable printer names CORS and https, not "failed to fetch"',
      /CORS/i.test(err.message) && err.status === 0, err.message);
  });
}).then(function () {
  return O.test({ url: '', key: 'k' }, { fetch: stub({ status: 200 }) }).then(function () {
    fail++; console.log('  FAIL  an empty address resolved');
  }, function (err) { ok('an empty address is refused before any request', /address/i.test(err.message)); });
}).then(function () {
  return O.test({ url: 'octopi.local', key: '' }, { fetch: stub({ status: 200 }) }).then(function () {
    fail++; console.log('  FAIL  a missing key resolved');
  }, function (err) { ok('and so is a missing key', /key/i.test(err.message)); });
}).then(function () {
  console.log('\n=== 6. reading the job back ===');
  var f = stub({ status: 200, body: JSON.stringify({
    state: 'Printing',
    job: { file: { name: 'part.gcode' } },
    progress: { completion: 42.7, printTimeLeft: 1800 }
  }) });
  return O.status(cfg, { fetch: f }).then(function (s) {
    ok('status reports state, file, percent and time left',
      s.state === 'Printing' && s.file === 'part.gcode' && s.percent === 43 && s.secondsLeft === 1800,
      JSON.stringify(s));
  });
}).then(done, function (err) {
  fail++;
  console.log('  FAIL  the chain threw: ' + (err && err.stack || err));
  done();
});
