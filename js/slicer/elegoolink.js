/**
 * Orca Web Slicer — Elegoo, over the network.
 *
 * Two machines, two protocols, and they share nothing. Both are taken from
 * Elegoo's own Link SDK (github.com/elegooofficial/elegoo-link, Apache 2.0)
 * rather than guessed: every header name, chunk size and default below is what
 * their adapter sends.
 *
 *   Centauri Carbon 2   PUT /upload, one megabyte at a time, with a
 *                       Content-Range, the file's MD5, and an X-Token that
 *                       defaults to 123456. Control — starting a print — is
 *                       MQTT on port 1883, which a browser cannot open.
 *
 *   Centauri Carbon 1   A different protocol entirely (SDCP): one multipart
 *                       POST to /uploadFile/upload on port 3030, and commands
 *                       over a WebSocket on the same port.
 *
 * So on a CC2 this puts the file on the machine and you press print on its
 * screen; on a CC1 it can also start the print. That asymmetry is the
 * printers', not a shortcut taken here.
 *
 * Loaded as a plain script (browser) or required under Node for tests.
 */
(function (root) {
  'use strict';

  // What Elegoo's own SDK uses when the printer has no access code set.
  var DEFAULT_TOKEN = '123456';
  // Their chunk size, and the printer holds it as a hard limit.
  var CHUNK = 1024 * 1024;
  // The SDCP port of the first Centauri Carbon.
  var SDCP_PORT = 3030;

  function md5lib() {
    if (root.OrcaMd5) return root.OrcaMd5;
    if (typeof require === 'function') {
      try { return require('./md5.js'); } catch (e) { /* browser */ }
    }
    return null;
  }

  /** Split a typed address into host and port, with a default. */
  function parseAddress(address, defaultPort) {
    var s = String(address || '').trim().replace(/^\w+:\/\//, '').replace(/\/.*$/, '');
    if (!s) return null;
    var port = defaultPort;
    var host = s;
    var m = /^(.*):(\d+)$/.exec(s);
    if (m) { host = m[1]; port = parseInt(m[2], 10); }
    return host ? { host: host, port: port } : null;
  }

  /** The CC2 answers on the ordinary web port unless told otherwise. */
  function httpBase(address, defaultPort) {
    var a = parseAddress(address, defaultPort || 0);
    if (!a) return '';
    return 'http://' + a.host + (a.port ? ':' + a.port : '');
  }

  function wsBase(address) {
    var a = parseAddress(address, SDCP_PORT);
    return a ? 'ws://' + a.host + ':' + a.port + '/websocket' : '';
  }

  function uuid() {
    var hex = '';
    for (var i = 0; i < 32; i++) hex += Math.floor(Math.random() * 16).toString(16);
    return hex;
  }

  function fileName(name) {
    var n = String(name || 'print').replace(/[^A-Za-z0-9._-]+/g, '_');
    if (!/\.gcode$/i.test(n)) n += '.gcode';
    return n;
  }

  function fetcher(opts) {
    if (opts && opts.fetch) return opts.fetch;
    if (typeof fetch === 'function') return fetch;
    return null;
  }

  function bytesOf(text) {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(text);
    var out = [];
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }

  function explainNetwork(url) {
    var https = typeof location !== 'undefined' && location.protocol === 'https:';
    return 'No answer from ' + url + '. ' + (https
      ? 'This page is on https and the printer is on http, which the browser ' +
        'blocks outright. The app version reaches it directly; in a browser, ' +
        'open the slicer over http.'
      : 'Check the address, and that the printer is on this network and awake.');
  }

  // ---------------------------------------------------------------------------
  // Centauri Carbon 2
  // ---------------------------------------------------------------------------

  function cc2Explain(status, errorCode, url) {
    if (status === 401) return 'The printer refused the access code. It is on its screen ' +
      'under the network settings; leave this blank if you have not set one.';
    if (status === 403) return 'The printer refused access.';
    if (status === 429) return 'The printer is busy and asked to be left alone for a moment.';
    if (status === 404) return 'Nothing answered at ' + url + '. Check the address.';
    if (errorCode === 1000) return 'The printer rejected the access code while receiving the file.';
    if (errorCode !== undefined && errorCode !== 0) {
      return 'The printer refused the upload (code ' + errorCode + ').';
    }
    if (status >= 500) return 'The printer failed on its side (' + status + ').';
    return 'The printer answered ' + status + '.';
  }

  /**
   * Ask the machine who it is. Doubles as the access-code check, since this is
   * the call that answers 401 when the code is wrong.
   */
  function cc2Info(cfg, opts) {
    var base = httpBase(cfg && cfg.url);
    if (!base) return Promise.reject(new Error('No printer address set.'));
    var f = fetcher(opts);
    if (!f) return Promise.reject(new Error('This browser has no fetch.'));
    var token = (cfg && cfg.key) || DEFAULT_TOKEN;
    var url = base + '/system/info?X-Token=' + encodeURIComponent(token);

    return f(url, { method: 'GET', headers: { 'X-Token': token } }).then(function (res) {
      return res.text().then(function (text) {
        if (!res.ok) throw new Error(cc2Explain(res.status, undefined, url));
        var body = {};
        try { body = JSON.parse(text); } catch (e) { throw new Error('The printer answered something that was not JSON.'); }
        if (body.error_code) throw new Error(cc2Explain(200, body.error_code, url));
        var info = body.system_info || {};
        return {
          serial: info.sn || '',
          name: info.host_name || info.machine_model || 'Centauri Carbon 2',
          model: info.machine_model || '',
          raw: info
        };
      });
    }, function () { throw new Error(explainNetwork(url)); });
  }

  /**
   * Send the file up in one-megabyte pieces, each carrying the range it covers
   * and the digest of the whole. The printer assembles them and checks the MD5
   * at the end; a chunk out of order is refused rather than written.
   */
  function cc2Upload(cfg, name, gcode, opts) {
    opts = opts || {};
    var base = httpBase(cfg && cfg.url);
    if (!base) return Promise.reject(new Error('No printer address set.'));
    var f = fetcher(opts);
    if (!f) return Promise.reject(new Error('This browser has no fetch.'));
    var md5 = md5lib();
    if (!md5) return Promise.reject(new Error('The checksum code did not load.'));

    var token = (cfg && cfg.key) || DEFAULT_TOKEN;
    var file = fileName(name);
    var bytes = bytesOf(gcode);
    var total = bytes.length;
    var digest = md5.md5Bytes(bytes);
    var url = base + '/upload';
    var chunkSize = opts.chunkSize || CHUNK;

    function sendChunk(offset) {
      if (offset >= total) {
        return Promise.resolve({ name: file, md5: digest, size: total, chunks: Math.ceil(total / chunkSize) });
      }
      var end = Math.min(offset + chunkSize, total);
      var piece = bytes.subarray(offset, end);
      var headers = {
        'Content-Type': 'application/octet-stream',
        'Content-Range': 'bytes ' + offset + '-' + (end - 1) + '/' + total,
        'X-File-Name': file,
        'X-File-MD5': digest,
        'X-Token': token
      };
      if (opts.onProgress) opts.onProgress(offset / total);

      return f(url, { method: 'PUT', headers: headers, body: piece }).then(function (res) {
        return res.text().then(function (text) {
          if (!res.ok) throw new Error(cc2Explain(res.status, undefined, url));
          var body = {};
          try { body = JSON.parse(text); } catch (e) { /* some builds answer nothing */ }
          if (body && body.error_code) throw new Error(cc2Explain(200, body.error_code, url));
          return sendChunk(end);
        });
      }, function () { throw new Error(explainNetwork(url)); });
    }

    return sendChunk(0);
  }

  // ---------------------------------------------------------------------------
  // Centauri Carbon, the first one (SDCP)
  // ---------------------------------------------------------------------------

  function sdcpExplainUpload(body) {
    var field = body.messages && body.messages[0] && body.messages[0].message;
    switch (field) {
      case -1: return 'The printer rejected the upload: offset error.';
      case -2: return 'The printer rejected the upload: the offset did not match what it expected.';
      case -3: return 'The printer could not open the file for writing. Its storage may be full.';
      case -4: return 'The printer refused the upload and did not say why.';
      default: return 'The printer refused the upload (code ' + (body.code || '?') + ').';
    }
  }

  function sdcpUpload(cfg, name, gcode, opts) {
    opts = opts || {};
    var base = httpBase(cfg && cfg.url, SDCP_PORT);
    if (!base) return Promise.reject(new Error('No printer address set.'));
    var f = fetcher(opts);
    if (!f) return Promise.reject(new Error('This browser has no fetch.'));
    if (typeof FormData !== 'function' || typeof Blob !== 'function') {
      return Promise.reject(new Error('This browser cannot build a file upload.'));
    }
    var md5 = md5lib();
    if (!md5) return Promise.reject(new Error('The checksum code did not load.'));

    var file = fileName(name);
    var bytes = bytesOf(gcode);
    var digest = md5.md5Bytes(bytes);

    var form = new FormData();
    form.append('S-File-MD5', digest);
    form.append('Check', '1');
    form.append('Offset', '0');
    form.append('Uuid', opts.uuid || uuid());
    form.append('TotalSize', String(bytes.length));
    form.append('File', new Blob([gcode], { type: 'application/octet-stream' }), file);

    var url = base + '/uploadFile/upload';
    return f(url, { method: 'POST', body: form }).then(function (res) {
      return res.text().then(function (text) {
        if (!res.ok) throw new Error('The printer answered ' + res.status + '.');
        var body = {};
        try { body = JSON.parse(text); } catch (e) { /* some builds answer nothing */ }
        if (body && body.success === false) throw new Error(sdcpExplainUpload(body));
        return { name: file, md5: digest, size: bytes.length, path: '/local/' + file };
      });
    }, function () { throw new Error(explainNetwork(url)); });
  }

  /** One SDCP command, and the printer's answer to it. */
  function sdcpCommand(cfg, cmd, data, opts) {
    opts = opts || {};
    var url = wsBase(cfg && cfg.url);
    if (!url) return Promise.reject(new Error('No printer address set.'));
    var WS = opts.WebSocket || (typeof WebSocket === 'function' ? WebSocket : null);
    if (!WS) return Promise.reject(new Error('This browser has no WebSocket.'));

    return new Promise(function (resolve, reject) {
      var socket;
      try { socket = new WS(url); } catch (e) { reject(new Error(explainNetwork(url))); return; }
      var settled = false;
      var timer = setTimeout(function () {
        finish(new Error('The printer did not answer within ten seconds. Elegoo Link ' +
          'has to be closed — it takes the one connection the printer offers.'));
      }, opts.timeout || 10000);

      function finish(err, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { socket.close(); } catch (e) { /* already gone */ }
        if (err) reject(err); else resolve(value);
      }

      socket.onopen = function () {
        socket.send(JSON.stringify({
          Id: '',
          Data: {
            Cmd: cmd, Data: data || {}, RequestID: uuid(),
            MainboardID: '', TimeStamp: Date.now(), From: 1
          }
        }));
      };
      socket.onmessage = function (event) {
        var msg;
        try { msg = JSON.parse(event.data); } catch (e) { return; }
        // Status broadcasts arrive unprompted; the answer is the one that
        // carries this command's number back.
        if (!msg || !msg.Data || msg.Data.Cmd !== cmd) return;
        var ack = msg.Data.Data && msg.Data.Data.Ack;
        if (ack === 0 || ack === undefined) finish(null, msg.Data);
        else finish(new Error(sdcpExplainAck(ack, cmd)));
      };
      socket.onerror = function () { finish(new Error(explainNetwork(url))); };
      socket.onclose = function () {
        finish(new Error('The printer closed the connection without answering.'));
      };
    });
  }

  function sdcpExplainAck(ack, cmd) {
    if (ack === 2 && cmd === 128) {
      return 'The printer says that file is not there. The upload did not land, ' +
        'or it is stored under another name.';
    }
    if (ack === 1) return 'The printer refused the command.';
    return 'The printer answered with code ' + ack + '.';
  }

  /**
   * What the first Carbon is doing. Its status arrives unprompted on the
   * websocket as well; command 0 asks for it now.
   */
  function sdcpStatus(cfg, opts) {
    return sdcpCommand(cfg, 0, {}, opts).then(function (res) {
      return readSdcpStatus(res);
    }, function (err) {
      // Command 0 is answered by a status broadcast rather than an Ack on some
      // firmwares, which sdcpCommand reads as silence.
      throw err;
    });
  }

  /** The status message's shape, which is the same however it arrives. */
  function readSdcpStatus(msg) {
    var st = (msg && (msg.Status || (msg.Data && msg.Data.Status))) || {};
    var p = st.PrintInfo || {};
    var STATES = {
      0: 'Idle', 5: 'Pausing', 8: 'Preparing', 9: 'Starting',
      10: 'Paused', 13: 'Printing', 20: 'Resuming'
    };
    return {
      text: STATES[p.Status] || 'Unknown',
      code: p.Status,
      nozzle: { now: st.TempOfNozzle, target: st.TempTargetNozzle },
      bed: { now: st.TempOfHotbed, target: st.TempTargetHotbed },
      chamber: { now: st.TempOfBox, target: st.TempTargetBox },
      job: {
        file: p.Filename || null,
        layer: p.CurrentLayer,
        layers: p.TotalLayer,
        percent: typeof p.Progress === 'number' ? Math.round(p.Progress) : null,
        secondsLeft: (typeof p.TotalTicks === 'number' && typeof p.CurrentTicks === 'number')
          ? Math.max(0, Math.round((p.TotalTicks - p.CurrentTicks)))
          : null
      }
    };
  }

  var SDCP_JOB = { pause: 129, cancel: 130, resume: 131 };

  function sdcpJob(cfg, what, opts) {
    var cmd = SDCP_JOB[what];
    if (!cmd) return Promise.reject(new Error('Unknown job command: ' + what));
    return sdcpCommand(cfg, cmd, {}, opts).then(function () { return { done: what }; });
  }

  /** The chamber light. RGB is in the protocol but the machine ignores it. */
  function sdcpLight(cfg, on, opts) {
    return sdcpCommand(cfg, 403, {
      LightStatus: { SecondLight: !!on, RgbLight: [0, 0, 0] }
    }, opts).then(function () { return { on: !!on }; });
  }

  function sdcpStartPrint(cfg, filename, opts) {
    var path = filename.charAt(0) === '/' ? filename : '/local/' + fileName(filename);
    return sdcpCommand(cfg, 128, {
      Filename: path, StartLayer: 0, Calibration_switch: 0,
      PrintPlatformType: 0, Tlp_Switch: 0
    }, opts).then(function () { return { started: true, path: path }; });
  }

  // ---------------------------------------------------------------------------

  /** Which machine this address belongs to. 'cc2' unless told otherwise. */
  function modelOf(cfg) { return (cfg && cfg.model) === 'cc1' ? 'cc1' : 'cc2'; }

  function upload(cfg, name, gcode, opts) {
    return modelOf(cfg) === 'cc1'
      ? sdcpUpload(cfg, name, gcode, opts)
      : cc2Upload(cfg, name, gcode, opts);
  }

  function test(cfg, opts) {
    if (modelOf(cfg) === 'cc1') {
      return sdcpCommand(cfg, 1, {}, opts).then(function (res) {
        var a = (res && res.Data) || {};
        return { name: a.Name || a.MachineName || 'Centauri Carbon', serial: res.MainboardID || '' };
      });
    }
    return cc2Info(cfg, opts);
  }

  /**
   * Whether this machine can be told to print from here at all. The CC2's
   * control channel is MQTT on port 1883, which no browser can open — the file
   * goes up, and the print is started at the machine.
   */
  function canStartPrint(cfg) { return modelOf(cfg) === 'cc1'; }

  function startPrint(cfg, filename, opts) {
    if (!canStartPrint(cfg)) {
      return Promise.reject(new Error(
        'The Centauri Carbon 2 only takes print commands over MQTT, which a ' +
        'browser cannot speak. The file is on the printer — start it from its screen.'));
    }
    return sdcpStartPrint(cfg, filename, opts);
  }

  var api = {
    DEFAULT_TOKEN: DEFAULT_TOKEN,
    CHUNK: CHUNK,
    SDCP_PORT: SDCP_PORT,
    parseAddress: parseAddress,
    httpBase: httpBase,
    wsBase: wsBase,
    fileName: fileName,
    modelOf: modelOf,
    canStartPrint: canStartPrint,
    upload: upload,
    test: test,
    startPrint: startPrint,
    sdcpStatus: sdcpStatus,
    sdcpJob: sdcpJob,
    sdcpLight: sdcpLight,
    readSdcpStatus: readSdcpStatus,
    cc2Info: cc2Info,
    cc2Upload: cc2Upload,
    sdcpUpload: sdcpUpload,
    sdcpCommand: sdcpCommand
  };
  root.OrcaElegooLink = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
