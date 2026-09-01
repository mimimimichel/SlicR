/**
 * The native transport.
 *
 * A browser will not let a page talk to a printer that has not invited it, and
 * no printer does. Inside the app those requests leave through Java instead;
 * this is the piece that hands them over — what it passes on, what it refuses,
 * and what it says when there is nothing behind it.
 *
 *   node test-net.js
 */
var pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); }
}

/** A stand-in for the Java side: records what it was asked, answers on demand. */
function bridge(behaviour) {
  var calls = [], staged = { text: '', bytes: 0, pieces: 0 };
  behaviour = behaviour || {};
  return {
    calls: calls,
    staged: staged,
    httpRequest: function (id, method, url, headersJson, body) {
      calls.push({ kind: 'inline', id: id, method: method, url: url,
                   headers: JSON.parse(headersJson), body: body });
      setTimeout(function () {
        globalThis.OrcaNetResult(id, behaviour.status || 200,
          behaviour.body || '{"ok":true}', behaviour.error || null);
      }, 0);
    },
    httpRequestStaged: function (id, method, url, headersJson) {
      calls.push({ kind: 'staged', id: id, method: method, url: url,
                   headers: JSON.parse(headersJson), body: staged.text });
      setTimeout(function () {
        globalThis.OrcaNetResult(id, behaviour.status || 201, behaviour.body || '{}', null);
      }, 0);
    },
    beginSave: function () { staged.text = ''; staged.bytes = 0; staged.pieces = 0; return true; },
    appendSave: function (chunk) {
      if (behaviour.dropPiece === staged.pieces) { staged.pieces++; return true; }
      staged.text += chunk;
      staged.bytes += Buffer.byteLength(chunk, 'utf8');
      staged.pieces++;
      return true;
    },
    pendingBytes: function () { return String(staged.bytes); },
    discardSave: function () { staged.text = ''; staged.bytes = 0; }
  };
}

function load() {
  delete require.cache[require.resolve('./js/slicer/net.js')];
  return require('./js/slicer/net.js');
}

// --- with nothing behind it ------------------------------------------------
delete globalThis.AndroidSlicer;
var N = load();
ok('with no app around it, nothing is installed',
  !globalThis.OrcaFetch && N.isNative() === false);
ok('and a browser is told what actually refused it, and by whom',
  /Cross Origin|CORS/i.test(N.explainBlocked('http://octopi.lan', 'octoprint')) &&
  /Android app/.test(N.explainBlocked('http://octopi.lan', 'octoprint')));
ok('a printer, which has no such setting, is described as it is',
  /no setting on the printer/i.test(N.explainBlocked('http://192.168.1.9', 'elegoo')));

// --- with the app around it ------------------------------------------------
var b = bridge();
globalThis.AndroidSlicer = b;
N = load();
ok('the app installs a transport', typeof globalThis.OrcaFetch === 'function' && N.isNative());

globalThis.OrcaFetch('http://192.168.1.9/system/info', {
  headers: { 'X-Token': '123456' }
}).then(function (res) {
  ok('a small request crosses in one piece',
    b.calls.length === 1 && b.calls[0].kind === 'inline' && b.calls[0].method === 'GET');
  ok('carrying its headers', b.calls[0].headers['X-Token'] === '123456',
    JSON.stringify(b.calls[0].headers));
  ok('and comes back as something the clients can read',
    res.ok === true && res.status === 200);
  return res.text();
}).then(function (text) {
  ok('with the body intact', text === '{"ok":true}', text);

  // A megabyte of G-code cannot cross in one call; it is staged first.
  var big = 'G1 X1 Y1 E0.1\n'.repeat(20000);          // ~280 KB
  return globalThis.OrcaFetch('http://192.168.1.9/upload', {
    method: 'PUT', body: big, headers: { 'X-File-Name': 'a.gcode' }
  }).then(function (res) {
    var staged = b.calls[b.calls.length - 1];
    ok('a large body is staged in pieces rather than passed whole',
      staged.kind === 'staged' && b.staged.pieces > 3, JSON.stringify(b.staged.pieces));
    ok('and arrives byte for byte', staged.body === big,
      staged.body.length + ' vs ' + big.length);
    ok('with the method and headers it was given',
      staged.method === 'PUT' && staged.headers['X-File-Name'] === 'a.gcode');
    ok('answering with the printer’s reply', res.status === 201);
  });
}).then(function () {
  // A piece lost between the page and the native side must not be sent as a file.
  var lost = bridge({ dropPiece: 1 });
  globalThis.AndroidSlicer = lost;
  load();
  return globalThis.OrcaFetch('http://192.168.1.9/upload', {
    method: 'PUT', body: 'G1 X1\n'.repeat(20000)
  }).then(function () {
    fail++; console.log('  FAIL  a lost piece was sent anyway');
  }, function (err) {
    ok('a piece lost on the way is refused, not sent (' + err.message.slice(0, 44) + '…)',
      /bytes arrived/.test(err.message), err.message);
    ok('and what was staged is thrown away', lost.staged.text === '');
  });
}).then(function () {
  // Anything that is not text cannot cross, and saying so beats sending
  // something that silently is not what was meant.
  globalThis.AndroidSlicer = bridge();
  load();
  return globalThis.OrcaFetch('http://x/y', { method: 'POST', body: new Uint8Array([1, 2, 3]) })
    .then(function () {
      fail++; console.log('  FAIL  a binary body was accepted');
    }, function (err) {
      ok('a body that is not text is refused with a reason',
        /not text/.test(err.message), err.message);
    });
}).then(function () {
  // An error from the far side reaches the caller as an error.
  globalThis.AndroidSlicer = bridge({ error: 'connect timed out' });
  load();
  return globalThis.OrcaFetch('http://192.168.1.9/system/info').then(function () {
    fail++; console.log('  FAIL  a failed request resolved');
  }, function (err) {
    ok('a request that failed out there fails in here too (' + err.message + ')',
      /timed out/.test(err.message), err.message);
  });
}).then(function () {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}).catch(function (err) {
  console.log('  THREW ' + (err && err.stack || err));
  process.exit(1);
});
