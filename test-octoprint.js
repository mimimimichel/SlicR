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

/**
 * Read a multipart body the way a server does. The upload builds its own body
 * rather than handing a FormData to the browser — it has to cross a native
 * bridge inside the app, where FormData does not exist — so what is checked
 * here is the bytes that go on the wire.
 */
function parseMultipart(body, contentType) {
  var b = /boundary=(.+)$/.exec(contentType || '');
  if (!b) return null;
  var boundary = '--' + b[1];
  var chunks = String(body).split(boundary);
  var parts = [];
  for (var i = 1; i < chunks.length; i++) {
    var chunk = chunks[i];
    if (/^--/.test(chunk)) break;                       // the closing boundary
    var split = chunk.indexOf('\r\n\r\n');
    if (split < 0) continue;
    var head = chunk.slice(0, split);
    var value = chunk.slice(split + 4);
    if (/\r\n$/.test(value)) value = value.slice(0, -2);
    var name = /name="([^"]*)"/.exec(head);
    var filename = /filename="([^"]*)"/.exec(head);
    var type = /Content-Type:\s*(\S+)/i.exec(head);
    parts.push({ name: name && name[1], filename: filename && filename[1],
                 type: type && type[1], value: value });
  }
  return parts;
}
function formOf(call) {
  return parseMultipart(call.init.body, (call.init.headers || {})['Content-Type']);
}
function fieldNames(parts) {
  return parts.map(function (p) { return p.name; }).join(',');
}

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
      var form = formOf(f3.calls[0]);
      ok('as a POST carrying a multipart body', f3.calls[0].init.method === 'POST' &&
        /^multipart\/form-data; boundary=/.test((f3.calls[0].init.headers || {})['Content-Type']),
        JSON.stringify(f3.calls[0].init.headers));
      var filePart = form.filter(function (p) { return p.name === 'file'; })[0];
      ok('with the G-code attached under the sanitised name, byte for byte',
        filePart && filePart.filename === 'mon_part.gcode' && filePart.value === 'G28\n',
        JSON.stringify(form));
      ok('and the boundary does not appear inside the file',
        f3.calls[0].init.body.indexOf('G28') > 0, 'boundary clash');
      ok('and reports where it landed', res.location === 'mon_part.gcode' && res.started === true,
        JSON.stringify(res));
    });
}).then(function () {
  // Printing is never implied: without it, neither flag is set.
  var f4 = stub({ status: 201, body: '{}' });
  return O.upload(cfg, 'p', 'G28\n', { fetch: f4 })
    .then(function (res) {
      ok('an upload with nothing asked for starts nothing',
        fieldNames(formOf(f4.calls[0])) === 'file' && res.started === false,
        fieldNames(formOf(f4.calls[0])));
    });
}).then(function () {
  var f5 = stub({ status: 201, body: '{}' });
  return O.upload(cfg, 'p', 'G28\n', { fetch: f5, select: true })
    .then(function () {
      ok('selecting loads the job without starting it',
        fieldNames(formOf(f5.calls[0])) === 'select,file', fieldNames(formOf(f5.calls[0])));
    });
}).then(function () {
  var f6 = stub({ status: 201, body: '{}' });
  return O.upload(cfg, 'p', 'G28\n', { fetch: f6, print: true })
    .then(function () {
      ok('and printing implies selecting',
        fieldNames(formOf(f6.calls[0])) === 'select,print,file', fieldNames(formOf(f6.calls[0])));
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
}).then(function () {
  console.log('\n=== 7. the files already on the machine ===');
  var library = JSON.stringify({
    files: [
      { name: 'benchy.gcode', path: 'benchy.gcode', type: 'machinecode', origin: 'local',
        size: 1048576, date: 1760000000,
        gcodeAnalysis: { estimatedPrintTime: 5400, filament: { tool0: { length: 3210.5 } } } },
      { name: 'brackets', path: 'brackets', type: 'folder', children: [
        { name: 'bracket v2.gcode', display: 'bracket v2.gcode',
          path: 'brackets/bracket v2.gcode', type: 'machinecode', origin: 'local',
          size: 262144, date: 1770000000, gcodeAnalysis: { estimatedPrintTime: 1230 } }
      ] },
      { name: 'notes.txt', path: 'notes.txt', type: 'text', origin: 'local', size: 12, date: 1 }
    ],
    free: '3.2GB'
  });
  var f = stub({ status: 200, body: library });
  return O.files(cfg, { fetch: f }).then(function (res) {
    ok('asks for the whole tree', /\/api\/files\?recursive=true$/.test(f.calls[0].url),
      f.calls[0].url);
    ok('flattens the folders away (' + res.files.length + ' printable files)',
      res.files.length === 2, JSON.stringify(res.files.map(function (x) { return x.path; })));
    ok('leaving out what is not printable',
      !res.files.some(function (x) { return /notes/.test(x.path); }));
    ok('newest first', res.files[0].path === 'brackets/bracket v2.gcode', res.files[0].path);
    ok('carrying what the machine worked out about them',
      res.files[0].seconds === 1230 && res.files[1].seconds === 5400 &&
      Math.round(res.files[1].filamentMm) === 3211, JSON.stringify(res.files[1]));
    ok('and how much room is left', res.free === '3.2GB');
  });
}).then(function () {
  var f = stub({ status: 204, body: '' });
  return O.selectFile(cfg, { path: 'brackets/bracket v2.gcode', origin: 'local' }, false,
    { fetch: f }).then(function (res) {
    ok('loading a file names it a segment at a time, spaces and all',
      f.calls[0].url === 'http://octopi.local/api/files/local/brackets/bracket%20v2.gcode',
      f.calls[0].url);
    ok('and asks only to select it',
      JSON.parse(f.calls[0].init.body).command === 'select' &&
      JSON.parse(f.calls[0].init.body).print === false, f.calls[0].init.body);
    ok('reporting that nothing was started', res.started === false);
  });
}).then(function () {
  var f = stub({ status: 204, body: '' });
  return O.selectFile(cfg, { path: 'benchy.gcode' }, true, { fetch: f }).then(function (res) {
    ok('printing one says so outright, and never by implication',
      JSON.parse(f.calls[0].init.body).print === true && res.started === true,
      f.calls[0].init.body);
  });
}).then(function () {
  var f = stub({ status: 204, body: '' });
  return O.deleteFile(cfg, { path: 'benchy.gcode' }, { fetch: f }).then(function () {
    ok('deleting one is a DELETE at its own address',
      f.calls[0].init.method === 'DELETE' &&
      f.calls[0].url === 'http://octopi.local/api/files/local/benchy.gcode',
      f.calls[0].init.method + ' ' + f.calls[0].url);
  });
}).then(function () {
  // A file that is printing cannot be deleted, and OctoPrint says so with 409.
  return O.deleteFile(cfg, { path: 'benchy.gcode' },
    { fetch: stub({ status: 409, body: 'currently printing' }) }).then(function () {
    fail++; console.log('  FAIL  deleting a printing file resolved');
  }, function (err) {
    ok('and a file that is busy says why it cannot go (' + err.message.slice(0, 38) + '…)',
      /not ready|printing/i.test(err.message), err.message);
  });
}).then(function () {
  console.log('\n=== 8. the camera ===');
  // OctoPrint 1.9 moved the webcam under its plugin; older builds kept it in
  // webcam.streamUrl. Both are read, and a relative address is made absolute.
  return O.webcam(cfg, { fetch: stub({ status: 200, body: JSON.stringify({
    plugins: { classicwebcam: { stream: '/webcam/?action=stream',
                                snapshot: '/webcam/?action=snapshot', flipV: true } } }) }) });
}).then(function (w) {
  ok('a 1.9 install is read from its plugin',
    w.stream === 'http://octopi.local/webcam/?action=stream' && w.declared === true, w.stream);
  ok('and the picture is turned the way the printer says it should be', w.flipV === true);
  return O.webcam(cfg, { fetch: stub({ status: 200, body: JSON.stringify({
    webcam: { streamUrl: 'http://cam.lan:8080/?action=stream' } }) }) });
}).then(function (w) {
  ok('an older one is read from where it used to be, absolute address and all',
    w.stream === 'http://cam.lan:8080/?action=stream', w.stream);
  return O.webcam(cfg, { fetch: stub({ status: 404, body: '' }) });
}).then(function (w) {
  ok('and a machine that will not say still gets the usual address tried',
    w.stream === 'http://octopi.local/webcam/?action=stream' && w.declared === false, w.stream);
}).then(done, function (err) {
  fail++;
  console.log('  FAIL  the chain threw: ' + (err && err.stack || err));
  done();
});
