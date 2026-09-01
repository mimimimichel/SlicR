/**
 * MD5 against RFC 1321, and the SDCP client against a stub that answers the
 * way a Centauri Carbon does.
 *
 *   node test-elegoolink.js
 */
var M = require('./js/slicer/md5.js');
var E = require('./js/slicer/elegoolink.js');
var crypto = require('crypto');

var pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); }
}
function done() {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

console.log('=== 1. MD5, against the vectors in RFC 1321 ===');
[['', 'd41d8cd98f00b204e9800998ecf8427e'],
 ['a', '0cc175b9c0f1b6a831c399e269772661'],
 ['abc', '900150983cd24fb0d6963f7d28e17f72'],
 ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
 ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
 ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  'd174ab98d277d9f5a5611c2c9f419d9f'],
 ['123456789012345678901234567890123456789012345678901234567890' +
  '12345678901234567890', '57edf4a22be3c955ac49da2e2107b67a']
].forEach(function (c) {
  ok('"' + c[0].slice(0, 22) + (c[0].length > 22 ? '…' : '') + '"', M.md5(c[0]) === c[1],
    M.md5(c[0]) + ' vs ' + c[1]);
});

// The lengths where the padding rules change, and one past a megabyte, against
// an implementation that is not this one.
console.log('\n=== 2. and against Node\'s own, at the awkward lengths ===');
[0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 1000, 1024 * 1024 + 7].forEach(function (n) {
  var b = crypto.randomBytes(n);
  var mine = M.md5Bytes(new Uint8Array(b));
  var theirs = crypto.createHash('md5').update(b).digest('hex');
  ok(n + ' bytes', mine === theirs, mine + ' vs ' + theirs);
});
// Multi-byte characters have to be counted in bytes, not characters.
var accented = 'pièce à imprimer — 20 mm';
ok('a string with accents digests as UTF-8',
  M.md5(accented) === crypto.createHash('md5').update(accented, 'utf8').digest('hex'));

console.log('\n=== 3. addresses ===');
ok('a bare IP takes the ordinary web port',
  E.httpBase('192.168.1.42') === 'http://192.168.1.42');
ok('a typed port is kept', E.httpBase('192.168.1.42:8080') === 'http://192.168.1.42:8080');
ok('a scheme is ignored', E.httpBase('http://centauri.local/') === 'http://centauri.local');
ok('the first Carbon\'s websocket has its own port',
  E.wsBase('192.168.1.42') === 'ws://192.168.1.42:3030/websocket');
ok('nothing in, nothing out', E.httpBase('  ') === '');

console.log('\n=== 4. the Centauri Carbon 2, as Elegoo\'s own SDK talks to it ===');
function stub(reply) {
  var calls = [];
  function f(url, init) {
    calls.push({ url: url, init: init || {} });
    var r = typeof reply === 'function' ? reply(url, init, calls.length - 1) : reply;
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

var cfg = { url: '192.168.1.42', model: 'cc2' };
var gcode = 'G28\nG1 X10 Y10 E1\n';
var expectedMd5 = crypto.createHash('md5').update(gcode, 'utf8').digest('hex');

var f1 = stub({ status: 200, body: '{"error_code":0}' });
E.cc2Upload(cfg, 'ma pièce', gcode, { fetch: f1 }).then(function (res) {
  var call = f1.calls[0];
  ok('PUTs to /upload on the ordinary port',
    call.url === 'http://192.168.1.42/upload' && call.init.method === 'PUT',
    call.url + ' ' + call.init.method);
  var h = call.init.headers;
  ok('as raw bytes, not a form', h['Content-Type'] === 'application/octet-stream');
  ok('with the range this chunk covers',
    h['Content-Range'] === 'bytes 0-' + (Buffer.byteLength(gcode) - 1) + '/' + Buffer.byteLength(gcode),
    h['Content-Range']);
  ok('the file name in a header', h['X-File-Name'] === 'ma_pi_ce.gcode', h['X-File-Name']);
  ok('the whole file\'s MD5', h['X-File-MD5'] === expectedMd5, h['X-File-MD5'] + ' vs ' + expectedMd5);
  ok('and the default token when no access code is set',
    h['X-Token'] === '123456', h['X-Token']);
  ok('the body is the bytes themselves',
    call.init.body && call.init.body.length === Buffer.byteLength(gcode), typeof call.init.body);
  ok('one chunk for a small file', f1.calls.length === 1 && res.chunks === 1);
}).then(function () {
  // A file over the megabyte limit has to arrive in pieces, in order, each
  // naming its own range.
  var big = 'G1 X1 Y1 E0.1\n'.repeat(20000);       // ~280 KB
  var f2 = stub({ status: 200, body: '{"error_code":0}' });
  return E.cc2Upload({ url: 'p', model: 'cc2' }, 'big', big, { fetch: f2, chunkSize: 100000 })
    .then(function (res) {
      var total = Buffer.byteLength(big);
      var expected = Math.ceil(total / 100000);
      ok('a large file is split into ' + expected + ' chunks', f2.calls.length === expected,
        String(f2.calls.length));
      var ranges = f2.calls.map(function (c) { return c.init.headers['Content-Range']; });
      var contiguous = true, at = 0;
      ranges.forEach(function (r) {
        var m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(r);
        if (!m || +m[1] !== at || +m[3] !== total) contiguous = false;
        at = +m[2] + 1;
      });
      ok('covering the file end to end with no gap or overlap', contiguous && at === total,
        ranges.slice(0, 3).join(' | ') + ' … last ends ' + at + ' of ' + total);
      ok('every chunk carries the same digest of the whole file',
        f2.calls.every(function (c) { return c.init.headers['X-File-MD5'] === f2.calls[0].init.headers['X-File-MD5']; }));
      ok('and it is the digest of the whole file',
        f2.calls[0].init.headers['X-File-MD5'] === crypto.createHash('md5').update(big, 'utf8').digest('hex'));
    });
}).then(function () {
  // A chunk refused mid-way stops the upload rather than carrying on.
  var f3 = stub(function (url, init, n) {
    return n === 1 ? { status: 401, body: '' } : { status: 200, body: '{"error_code":0}' };
  });
  var big = 'x'.repeat(250000);
  return E.cc2Upload(cfg, 'big', big, { fetch: f3, chunkSize: 100000 }).then(function () {
    fail++; console.log('  FAIL  a refused chunk resolved');
  }, function (err) {
    ok('a refused chunk stops the upload there (' + f3.calls.length + ' sent)',
      f3.calls.length === 2 && /access code/i.test(err.message), err.message);
  });
}).then(function () {
  console.log('\n=== 5. what its refusals mean ===');
  var cases = [[401, /access code/i], [403, /refused access/i], [429, /busy/i], [404, /address/i]];
  return cases.reduce(function (chain, c) {
    return chain.then(function () {
      return E.cc2Upload(cfg, 'x', gcode, { fetch: stub({ status: c[0], body: '' }) })
        .then(function () { fail++; console.log('  FAIL  ' + c[0] + ' resolved'); },
          function (err) { ok(c[0] + ' is explained (' + err.message.slice(0, 42) + '…)',
            c[1].test(err.message), err.message); });
    });
  }, Promise.resolve()).then(function () {
    return E.cc2Upload(cfg, 'x', gcode, {
      fetch: stub({ status: 200, body: '{"error_code":1000}' })
    }).then(function () { fail++; console.log('  FAIL  error_code 1000 resolved'); },
      function (err) { ok('and a token rejected mid-transfer is named',
        /access code/i.test(err.message), err.message); });
  });
}).then(function () {
  console.log('\n=== 6. asking the machine who it is ===');
  var f = stub({ status: 200, body: JSON.stringify({
    error_code: 0,
    system_info: { sn: 'CC2SERIAL123', host_name: 'Centauri', machine_model: 'Centauri Carbon 2' }
  }) });
  return E.cc2Info(cfg, { fetch: f }).then(function (info) {
    ok('asks /system/info with the token both ways',
      /\/system\/info\?X-Token=123456$/.test(f.calls[0].url) &&
      f.calls[0].init.headers['X-Token'] === '123456', f.calls[0].url);
    ok('and reports the serial and the model',
      info.serial === 'CC2SERIAL123' && info.model === 'Centauri Carbon 2', JSON.stringify(info));
  }).then(function () {
    return E.cc2Info({ url: 'p', model: 'cc2', key: 'WRONG' }, { fetch: stub({ status: 401, body: '' }) })
      .then(function () { fail++; console.log('  FAIL  a 401 resolved'); },
        function (err) { ok('a wrong access code says where to find the right one',
          /screen/i.test(err.message), err.message); });
  });
}).then(function () {
  console.log('\n=== 7. what the CC2 cannot be asked to do ===');
  ok('starting a print is not offered for a CC2', E.canStartPrint(cfg) === false);
  ok('and is for the first Carbon', E.canStartPrint({ url: 'p', model: 'cc1' }) === true);
  return E.startPrint(cfg, 'x.gcode').then(function () {
    fail++; console.log('  FAIL  startPrint resolved on a CC2');
  }, function (err) {
    ok('with the reason given, not just a refusal',
      /MQTT/.test(err.message) && /its screen/.test(err.message), err.message);
  });
}).then(function () {
  console.log('\n=== 8. the first Centauri Carbon, which speaks SDCP ===');
  var lastForm = null;
  globalThis.Blob = function (parts, o) { this.parts = parts; this.type = o && o.type; };
  globalThis.FormData = function () {
    this.fields = {};
    lastForm = this;
    this.append = function (k, v, n) {
      this.fields[k] = (v instanceof globalThis.Blob) ? 'blob:' + n : String(v);
    };
  };
  var cc1 = { url: '192.168.1.50', model: 'cc1' };
  var f = stub({ status: 200, body: '{"code":"000000","success":true}' });
  return E.upload(cc1, 'ma pièce', gcode, { fetch: f }).then(function (res) {
    ok('POSTs multipart to /uploadFile/upload on port 3030',
      f.calls[0].url === 'http://192.168.1.50:3030/uploadFile/upload' &&
      f.calls[0].init.method === 'POST', f.calls[0].url);
    ok('with the MD5 and the size', lastForm.fields['S-File-MD5'] === expectedMd5 &&
      lastForm.fields.TotalSize === String(Buffer.byteLength(gcode)));
    ok('and reports where it landed', res.path === '/local/ma_pi_ce.gcode');
  }).then(function () {
    var lastSocket = null;
    function fakeSocket(behaviour) {
      return function (url) {
        var self = this;
        self.url = url; self.sent = [];
        self.close = function () { self.closed = true; };
        self.send = function (text) {
          self.sent.push(JSON.parse(text));
          setTimeout(function () { behaviour(self, JSON.parse(text)); }, 0);
        };
        setTimeout(function () { if (self.onopen) self.onopen(); }, 0);
        lastSocket = self;
      };
    }
    var acked = fakeSocket(function (s, msg) {
      if (s.onmessage) s.onmessage({ data: JSON.stringify({ Status: { PrintInfo: {} } }) });
      if (s.onmessage) s.onmessage({ data: JSON.stringify({
        Data: { Cmd: msg.Data.Cmd, Data: { Ack: 0 } } }) });
    });
    return E.startPrint(cc1, 'ma pièce', { WebSocket: acked }).then(function (res) {
      var sent = lastSocket.sent[0];
      ok('command 128 names the file under /local',
        sent.Data.Cmd === 128 && sent.Data.Data.Filename === '/local/ma_pi_ce.gcode',
        JSON.stringify(sent.Data.Data));
      ok('a status broadcast is not mistaken for the answer', res.started === true);
      ok('and the socket is closed afterwards', lastSocket.closed === true);
    }).then(function () {
      var missing = fakeSocket(function (s, msg) {
        if (s.onmessage) s.onmessage({ data: JSON.stringify({
          Data: { Cmd: msg.Data.Cmd, Data: { Ack: 2 } } }) });
      });
      return E.startPrint(cc1, 'gone', { WebSocket: missing }).then(function () {
        fail++; console.log('  FAIL  a missing file resolved');
      }, function (err) { ok('a file it cannot find is said plainly', /not there/i.test(err.message)); });
    }).then(function () {
      var silent = fakeSocket(function () { });
      var started = Date.now();
      return E.startPrint(cc1, 'x', { WebSocket: silent, timeout: 200 }).then(function () {
        fail++; console.log('  FAIL  a silent printer resolved');
      }, function (err) {
        ok('and a printer that never answers times out (' + (Date.now() - started) + ' ms)',
          Date.now() - started < 2000 && /Elegoo Link/.test(err.message), err.message);
      });
    });
  });
}).then(done, function (err) {
  fail++;
  console.log('  FAIL  the chain threw: ' + (err && err.stack || err));
  done();
});
