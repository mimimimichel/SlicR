/**
 * Orca Web Slicer — OctoPrint.
 *
 * Enough of OctoPrint's HTTP API to put a sliced file on the machine and, if
 * asked, start it. Three calls: check who we are talking to, upload, and read
 * back what the printer is doing.
 *
 * Two things about this API decide most of what follows. It authenticates with
 * a single header, X-Api-Key, which is a standing password for the printer —
 * so it is stored on the device and sent to that host and nowhere else. And a
 * browser will refuse the request outright in two situations that look
 * identical from JavaScript (a network error with no status): OctoPrint has not
 * been told to allow cross-origin requests, or the page is on https and the
 * printer is on http. The error messages below name both, because "failed to
 * fetch" tells a person nothing.
 *
 * Loaded as a plain script (browser) or required under Node for tests.
 */
(function (root) {
  'use strict';

  /** Trim a user-typed address into an origin with no trailing slash. */
  function normaliseUrl(url) {
    var s = String(url || '').trim();
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    return s.replace(/\/+$/, '');
  }

  function fileName(name) {
    var n = String(name || 'print').replace(/[^A-Za-z0-9._-]+/g, '_');
    if (!/\.gcode$/i.test(n)) n += '.gcode';
    return n;
  }

  /**
   * What a status code means to someone standing at the printer. OctoPrint's
   * own bodies are terse and sometimes empty, so each of these says what is
   * wrong and what to do about it rather than repeating the number.
   */
  function explain(status, body, url) {
    switch (status) {
      case 401:
      case 403:
        return 'OctoPrint refused the API key. Copy it again from Settings → ' +
          'API, or from an application key under your user account.';
      case 404:
        return 'Nothing answered at ' + url + '. Check the address, and that it ' +
          'includes any path OctoPrint is served under.';
      case 409:
        return 'The printer is not ready for this: OctoPrint says it is not ' +
          'connected, or a print is already running. ' + (body || '');
      case 413:
        return 'OctoPrint rejected the file as too large.';
      case 415:
        return 'OctoPrint would not take this as a G-code file.';
      default:
        if (status >= 500) return 'OctoPrint failed on its side (' + status + '). ' + (body || '');
        return 'OctoPrint answered ' + status + '. ' + (body || '');
    }
  }

  /** A thrown network error, which in a browser carries no status at all. */
  function explainNetwork(url) {
    if (root.OrcaNet && root.OrcaNet.explainBlocked) {
      return root.OrcaNet.explainBlocked(url, 'octoprint');
    }
    var https = typeof location !== 'undefined' && location.protocol === 'https:';
    return 'No answer from ' + url + '. ' + (https
      ? 'This page is on https and the printer is almost certainly on http, ' +
        'which the browser blocks outright. The app version reaches it directly; ' +
        'in a browser, open the slicer over http, or put OctoPrint behind https.'
      : 'Either the address is wrong, the machine is off, or OctoPrint has not ' +
        'been told to allow requests from other pages — Settings → API → Allow ' +
        'Cross Origin Resource Sharing (CORS), then restart it.');
  }

  /** The multipart builder, however this file was loaded. */
  function multipart() {
    if (root.OrcaMultipart) return root.OrcaMultipart;
    if (typeof require === 'function') {
      try { return require('./multipart.js'); } catch (e) { return null; }
    }
    return null;
  }

  function headers(key, extra) {
    var h = { 'X-Api-Key': String(key || '') };
    for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) h[k] = extra[k];
    return h;
  }

  /**
   * The fetch to use. Injectable so the tests can drive every branch without a
   * printer, and so the Android build can hand over a native one.
   */
  function fetcher(opts) {
    if (opts && opts.fetch) return opts.fetch;
    // Inside the app every printer request goes out through Java: a browser is
    // not allowed to talk to a machine that does not invite it, and printers
    // do not. See net.js.
    if (typeof root.OrcaFetch === 'function') return root.OrcaFetch;
    if (typeof fetch === 'function') return fetch;
    return null;
  }

  function request(method, path, cfg, opts, init) {
    var url = normaliseUrl(cfg.url);
    if (!url) return Promise.reject(new Error('No OctoPrint address set.'));
    if (!cfg.key) return Promise.reject(new Error('No OctoPrint API key set.'));
    var f = fetcher(opts);
    if (!f) return Promise.reject(new Error('This browser has no fetch.'));

    var full = url + path;
    var send = init || {};
    send.method = method;
    send.headers = headers(cfg.key, send.headers);

    return f(full, send).then(function (res) {
      return res.text().then(function (text) {
        if (!res.ok) {
          var err = new Error(explain(res.status, (text || '').slice(0, 200), full));
          err.status = res.status;
          throw err;
        }
        if (!text) return {};
        try { return JSON.parse(text); } catch (e) { return { text: text }; }
      });
    }, function () {
      var err = new Error(explainNetwork(full));
      err.status = 0;
      throw err;
    });
  }

  /**
   * Who is at that address. Returns the OctoPrint version and what the printer
   * is doing, so the settings panel can say something true after "Test".
   */
  function test(cfg, opts) {
    return request('GET', '/api/version', cfg, opts).then(function (version) {
      return request('GET', '/api/connection', cfg, opts).then(function (conn) {
        var state = conn && conn.current && conn.current.state;
        return {
          server: version.server || version.text || 'OctoPrint',
          api: version.api,
          state: state || 'unknown',
          ready: /operational|printing|paused/i.test(state || '')
        };
      }, function () {
        // The version call answered, so the address and key are right; the
        // connection endpoint is allowed to be unavailable on older builds.
        return { server: version.server || 'OctoPrint', api: version.api, state: 'unknown', ready: false };
      });
    });
  }

  /**
   * Put a file on the machine. `select` makes it the loaded job, `print` starts
   * it — which is the one irreversible thing this file can do, so it is never
   * implied by anything else.
   */
  function upload(cfg, name, gcode, opts) {
    opts = opts || {};
    var target = opts.target === 'sdcard' ? 'sdcard' : 'local';
    var file = fileName(name);

    var mp = multipart();
    if (!mp) return Promise.reject(new Error('The upload code did not load.'));

    // Printing is the one irreversible thing here, so it is only ever done when
    // asked for outright — and a file that is going to print has to be the
    // selected job first, which is the only place select is implied.
    var parts = [];
    if (opts.select || opts.print) parts.push({ name: 'select', value: 'true' });
    if (opts.print) parts.push({ name: 'print', value: 'true' });
    parts.push({ name: 'file', value: gcode, filename: file, type: 'text/x.gcode' });
    var form = mp.build(parts);

    return request('POST', '/api/files/' + target, cfg, opts,
      { body: form.body, headers: { 'Content-Type': form.contentType } })
      .then(function (res) {
        return {
          name: file,
          started: !!opts.print,
          location: (res && res.files && res.files[target] && res.files[target].path) || file
        };
      });
  }

  /** What the machine is doing now: state, temperatures, progress. */
  function status(cfg, opts) {
    return request('GET', '/api/job', cfg, opts).then(function (job) {
      var p = (job && job.progress) || {};
      return {
        state: (job && job.state) || 'unknown',
        file: (job && job.job && job.job.file && job.job.file.name) || null,
        percent: typeof p.completion === 'number' ? Math.round(p.completion) : null,
        secondsLeft: typeof p.printTimeLeft === 'number' ? p.printTimeLeft : null
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Driving the machine
  // ---------------------------------------------------------------------------

  /** Temperatures and what the printer is doing, in one call. */
  function printerState(cfg, opts) {
    return request('GET', '/api/printer', cfg, opts).then(function (p) {
      var t = (p && p.temperature) || {};
      function reading(x) {
        return x ? { now: x.actual, target: x.target } : { now: null, target: null };
      }
      return {
        text: (p && p.state && p.state.text) || 'unknown',
        flags: (p && p.state && p.state.flags) || {},
        nozzle: reading(t.tool0),
        bed: reading(t.bed),
        chamber: reading(t.chamber)
      };
    });
  }

  /**
   * Start, pause, resume or cancel the job that is loaded. OctoPrint spells
   * pause and resume as one command with an action.
   */
  function job(cfg, what, opts) {
    var body;
    if (what === 'pause' || what === 'resume' || what === 'toggle') {
      body = { command: 'pause', action: what === 'toggle' ? 'toggle' : what };
    } else if (what === 'start' || what === 'cancel' || what === 'restart') {
      body = { command: what };
    } else {
      return Promise.reject(new Error('Unknown job command: ' + what));
    }
    return request('POST', '/api/job', cfg, opts, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  /** Move the head by a relative amount, in millimetres. */
  function jog(cfg, delta, opts) {
    var body = { command: 'jog', absolute: false };
    if (delta.x) body.x = delta.x;
    if (delta.y) body.y = delta.y;
    if (delta.z) body.z = delta.z;
    if (delta.speed) body.speed = delta.speed;
    return request('POST', '/api/printer/printhead', cfg, opts, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  function home(cfg, axes, opts) {
    return request('POST', '/api/printer/printhead', cfg, opts, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'home', axes: axes || ['x', 'y', 'z'] })
    });
  }

  /** Set a heater's target. The caller is responsible for the number. */
  function setTemp(cfg, which, celsius, opts) {
    var path = which === 'bed' ? '/api/printer/bed' : '/api/printer/tool';
    var body = which === 'bed'
      ? { command: 'target', target: celsius }
      : { command: 'target', targets: { tool0: celsius } };
    return request('POST', path, cfg, opts, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  /** Push or pull filament by a length in millimetres. */
  function extrude(cfg, mm, opts) {
    return request('POST', '/api/printer/tool', cfg, opts, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'extrude', amount: mm })
    });
  }

  // ---------------------------------------------------------------------------
  // What is already on the machine
  // ---------------------------------------------------------------------------

  /**
   * Every printable file OctoPrint holds, flattened out of the folder tree it
   * answers with and newest first — which is the order somebody looking for
   * the thing they just sent wants them in.
   */
  function files(cfg, opts) {
    return request('GET', '/api/files?recursive=true', cfg, opts).then(function (res) {
      var out = [];
      (function walk(list) {
        for (var i = 0; list && i < list.length; i++) {
          var f = list[i];
          if (f.type === 'folder' || f.children) { walk(f.children); continue; }
          if (f.type && f.type !== 'machinecode') continue;
          var analysis = f.gcodeAnalysis || {};
          out.push({
            name: f.display || f.name || f.path,
            path: f.path || f.name,
            origin: f.origin || 'local',
            size: f.size || 0,
            date: f.date || 0,
            seconds: analysis.estimatedPrintTime || 0,
            filamentMm: analysis.filament && analysis.filament.tool0
              ? analysis.filament.tool0.length : 0
          });
        }
      })(res && res.files);
      out.sort(function (a, b) { return (b.date || 0) - (a.date || 0); });
      return { files: out, free: res && res.free };
    });
  }

  /**
   * Load a file as the current job, and optionally start it. Printing is the
   * one irreversible thing here and is never implied — the caller says so.
   */
  function selectFile(cfg, file, print, opts) {
    var origin = (file && file.origin) || 'local';
    var path = encodePath((file && file.path) || file);
    return request('POST', '/api/files/' + origin + '/' + path, cfg, opts, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'select', print: !!print })
    }).then(function () {
      return { path: (file && file.path) || file, started: !!print };
    });
  }

  /** Remove a file from the machine. */
  function deleteFile(cfg, file, opts) {
    var origin = (file && file.origin) || 'local';
    var path = encodePath((file && file.path) || file);
    return request('DELETE', '/api/files/' + origin + '/' + path, cfg, opts)
      .then(function () { return { path: (file && file.path) || file, deleted: true }; });
  }

  /** A path goes in the URL a segment at a time; the slashes are structure. */
  function encodePath(path) {
    return String(path || '').split('/').map(encodeURIComponent).join('/');
  }

  /**
   * Where the camera is, if there is one.
   *
   * OctoPrint moved this in 1.9: what used to be webcam.streamUrl now lives
   * under the Classic Webcam plugin. Both are read, and if the machine says
   * nothing the conventional addresses are tried — that is where a stock
   * install puts them.
   */
  function webcam(cfg, opts) {
    return request('GET', '/api/settings', cfg, opts).then(function (s) {
      var classic = (s && s.plugins && s.plugins.classicwebcam) || {};
      var legacy = (s && s.webcam) || {};
      var stream = classic.stream || legacy.streamUrl || '/webcam/?action=stream';
      var snapshot = classic.snapshot || legacy.snapshotUrl || '/webcam/?action=snapshot';
      var where = {
        stream: absolute(cfg, stream),
        snapshot: absolute(cfg, snapshot),
        flipH: !!(classic.flipH || legacy.flipH),
        flipV: !!(classic.flipV || legacy.flipV),
        rotate90: !!(classic.rotate90 || legacy.rotate90),
        declared: !!(classic.stream || legacy.streamUrl)
      };
      // A declared address can simply be wrong — a camera moved, a plugin
      // configured for a machine that is no longer there. The usual one is
      // worth a second try before giving up on the picture entirely.
      var usual = {
        stream: absolute(cfg, '/webcam/?action=stream'),
        snapshot: absolute(cfg, '/webcam/?action=snapshot')
      };
      if (where.snapshot !== usual.snapshot) where.fallback = usual;
      return where;
    }, function () {
      // An older or locked-down build may not hand over its settings at all;
      // the usual addresses are still worth a try.
      return {
        stream: absolute(cfg, '/webcam/?action=stream'),
        snapshot: absolute(cfg, '/webcam/?action=snapshot'),
        flipH: false, flipV: false, rotate90: false, declared: false
      };
    });
  }

  /** Hosts that mean "this machine" — and never the same machine twice. */
  function isLoopback(host) {
    var h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
    return h === 'localhost' || h === '::1' || h === '0.0.0.0' ||
      /^127\./.test(h) || /\.localhost$/.test(h);
  }

  /** The host part of an address, port and scheme stripped off. */
  function hostOf(url) {
    var m = /^https?:\/\/([^\/?#]+)/i.exec(String(url || ''));
    if (!m) return '';
    var authority = m[1].replace(/^[^@]*@/, '');
    var bracket = /^(\[[^\]]+\])/.exec(authority);
    if (bracket) return bracket[1];
    return authority.split(':')[0];
  }

  /**
   * A URL from the settings may be relative to the printer, or absolute.
   *
   * An absolute one is not necessarily reachable, though. OctoPrint reports the
   * camera address as its own machine sees it, and on a stock OctoPi that is
   * `http://localhost:8080/?action=stream` or similar — localhost being the Pi.
   * Read here, on a tablet, that address points at the tablet, which has no
   * camera and nothing listening, so the request fails before it leaves. The
   * host is the only part that is wrong: the port, path and scheme are the
   * printer's own and stay exactly as they were, and only the machine they are
   * asked of changes, from the printer's idea of "here" to ours of "there".
   */
  function absolute(cfg, url) {
    var u = String(url || '');
    var base = normaliseUrl(cfg && cfg.url);
    if (!/^https?:\/\//i.test(u)) {
      return base + (u.charAt(0) === '/' ? '' : '/') + u;
    }
    var printer = hostOf(base);
    if (!printer || !isLoopback(hostOf(u))) return u;
    return u.replace(/^(https?:\/\/)(?:[^@\/?#]*@)?(\[[^\]]+\]|[^:\/?#]+)/i,
      function (all, scheme) { return scheme + printer; });
  }

  var api = {
    normaliseUrl: normaliseUrl,
    files: files,
    selectFile: selectFile,
    deleteFile: deleteFile,
    webcam: webcam,
    printerState: printerState,
    job: job,
    jog: jog,
    home: home,
    setTemp: setTemp,
    extrude: extrude,
    fileName: fileName,
    explain: explain,
    test: test,
    upload: upload,
    status: status
  };
  root.OrcaOctoPrint = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
