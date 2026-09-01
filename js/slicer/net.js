/**
 * Orca Web Slicer — reaching a printer.
 *
 * A browser will not let a page talk to a printer on the local network unless
 * the printer says it may, and printers do not say it. OctoPrint ships with
 * cross-origin requests switched off; an Elegoo's own web server has never
 * heard of them. Inside the Android app it is worse still: the page is served
 * over https from the app's asset host and the printer is plain http, which
 * the browser blocks outright before CORS is even considered.
 *
 * None of that is a limit on what the machine can do — it is a limit on what a
 * page may ask for. So when the app is running natively, every request to a
 * printer goes out through Java instead, where those rules do not apply. This
 * installs a fetch-shaped function that does exactly that, and the clients use
 * it in preference to the browser's own.
 *
 * The shape is deliberately small: the printer clients only ever need `ok`,
 * `status` and `text()`, and only ever send string bodies. A body too large to
 * hand across the bridge in one piece is streamed into the same buffer the
 * G-code export already uses, and sent from there.
 */
(function (root) {
  'use strict';

  /** Bodies longer than this are streamed rather than passed in one call. */
  var INLINE_LIMIT = 32 * 1024;
  var CHUNK = 64 * 1024;

  var nextId = 1;
  var pending = Object.create(null);

  /** Java calls this back with the result of one request. */
  root.OrcaNetResult = function (id, status, body, error) {
    var waiting = pending[id];
    if (!waiting) return;
    delete pending[id];
    if (error) waiting.reject(new Error(String(error)));
    else waiting.resolve({ status: status | 0, body: body == null ? '' : String(body) });
  };

  function bridge() {
    var a = root.AndroidSlicer;
    return a && typeof a.httpRequest === 'function' ? a : null;
  }

  /** A response with only what the printer clients read from one. */
  function responseFor(result) {
    var text = result.body;
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      text: function () { return Promise.resolve(text); },
      json: function () { return Promise.resolve(JSON.parse(text)); }
    };
  }

  function headersOf(init) {
    var h = {};
    var given = init && init.headers;
    if (!given) return h;
    if (typeof given.forEach === 'function' && !Array.isArray(given)) {
      // A Headers object, if a caller ever passes one.
      given.forEach(function (v, k) { h[k] = v; });
      return h;
    }
    for (var k in given) if (Object.prototype.hasOwnProperty.call(given, k)) h[k] = String(given[k]);
    return h;
  }

  /**
   * Make one request natively. Large bodies go through the staging buffer, a
   * piece at a time, because a single bridge call cannot carry megabytes.
   */
  function nativeFetch(url, init) {
    var a = bridge();
    if (!a) return Promise.reject(new Error('No native transport.'));
    init = init || {};

    var body = init.body;
    if (body != null && typeof body !== 'string') {
      return Promise.reject(new Error(
        'This request cannot be made natively: its body is not text.'));
    }

    var method = (init.method || 'GET').toUpperCase();
    var headers = JSON.stringify(headersOf(init));
    var id = String(nextId++);
    var promise = new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
    });

    try {
      if (body != null && body.length > INLINE_LIMIT) {
        if (typeof a.beginSave !== 'function' || typeof a.httpRequestStaged !== 'function') {
          throw new Error('This version of the app cannot send a file this way.');
        }
        if (!a.beginSave('upload.bin')) throw new Error('the staging file could not be opened');
        for (var i = 0; i < body.length;) {
          var end = Math.min(i + CHUNK, body.length);
          if (end < body.length) {
            var code = body.charCodeAt(end - 1);
            if (code >= 0xd800 && code <= 0xdbff) end--;   // never split a pair
          }
          if (!a.appendSave(body.slice(i, end))) throw new Error('a piece was refused');
          i = end;
        }
        if (a.pendingBytes) {
          var expected = byteLength(body);
          var arrived = parseInt(a.pendingBytes(), 10);
          if (arrived !== expected) {
            if (a.discardSave) a.discardSave();
            throw new Error('only ' + arrived + ' of ' + expected + ' bytes arrived');
          }
        }
        a.httpRequestStaged(id, method, url, headers);
      } else {
        a.httpRequest(id, method, url, headers, body == null ? '' : body);
      }
    } catch (err) {
      delete pending[id];
      return Promise.reject(err);
    }

    return promise.then(responseFor);
  }

  function byteLength(text) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length;
    if (typeof Blob !== 'undefined') return new Blob([text]).size;
    return text.length;
  }

  /**
   * One picture from the printer's camera, as something an <img> can show.
   *
   * Natively, because a picture is bytes rather than text: Java hands it back
   * already encoded, and it becomes a data: URL here. In a browser this is not
   * needed at all — an image element can be pointed straight at the camera,
   * which is why the caller only reaches for this when there is a bridge.
   */
  function image(url) {
    var a = root.AndroidSlicer;
    if (!a || typeof a.httpRequestImage !== 'function') {
      return Promise.reject(new Error('This version of the app cannot fetch pictures.'));
    }
    var id = String(nextId++);
    var promise = new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
    });
    try {
      a.httpRequestImage(id, url, JSON.stringify({}));
    } catch (err) {
      delete pending[id];
      return Promise.reject(err);
    }
    return promise.then(function (result) {
      if (result.status < 200 || result.status >= 300) {
        throw new Error('The camera answered ' + result.status + '.');
      }
      if (!result.body) throw new Error('The camera sent nothing.');
      return /^data:/.test(result.body) ? result.body : 'data:image/jpeg;base64,' + result.body;
    });
  }

  /** Whether printer traffic is going out natively rather than through the page. */
  function isNative() { return !!bridge(); }

  /**
   * What to tell someone when a request fails, given how it was made. In a
   * browser the failure is almost never the printer's fault and almost always
   * the browser's rules, and saying "failed to fetch" helps nobody.
   */
  function explainBlocked(url, kind) {
    if (isNative()) return 'No answer from ' + url + '. The printer may be off or on another network.';
    var https = typeof location !== 'undefined' && location.protocol === 'https:';
    if (https) {
      return 'This page is on https and ' + url + ' is not, which the browser blocks ' +
        'outright — nothing was sent. The Android app reaches printers directly; in a ' +
        'browser, open the slicer over http.';
    }
    if (kind === 'octoprint') {
      return 'No answer from ' + url + '. If the address is right and OctoPrint is up, ' +
        'it has not been told to accept requests from other pages: Settings → API → ' +
        'Allow Cross Origin Resource Sharing (CORS), then restart it. The Android app ' +
        'does not need that setting.';
    }
    return 'No answer from ' + url + '. A printer’s own web server does not allow ' +
      'requests from a web page, and no setting on the printer changes that — the ' +
      'Android app talks to it directly instead.';
  }

  // Only installed when there is something behind it, so the clients' own
  // fallback to the browser's fetch stays in charge everywhere else.
  if (bridge()) root.OrcaFetch = nativeFetch;

  root.OrcaNet = {
    isNative: isNative,
    nativeFetch: nativeFetch,
    image: image,
    explainBlocked: explainBlocked,
    // Exposed for the tests, which install a bridge of their own.
    install: function () { if (bridge()) root.OrcaFetch = nativeFetch; else delete root.OrcaFetch; }
  };
  if (typeof module === 'object' && module.exports) module.exports = root.OrcaNet;
})(typeof globalThis !== 'undefined' ? globalThis : self);
