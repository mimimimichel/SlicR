/**
 * Orca Web Slicer — finding the printer.
 *
 * Elegoo and OctoPrint both announce themselves by UDP broadcast — the Centauri
 * Carbon 2 answers {"id":0,"method":7000} on port 52700, the first Carbon
 * answers "M99999" on 3000 — and a browser cannot send a UDP packet at all. So
 * this does the only thing a page can: it knocks on every address in one subnet
 * and listens for who answers.
 *
 * Two passes, because they answer different questions:
 *
 *   presence    A request in no-cors mode resolves when the host answered
 *               anything and rejects when nothing was there. It says something
 *               is listening; it cannot say what.
 *
 *   identity    An ordinary request, whose body can be read only if the device
 *               allows this page to read it. Where that works the device names
 *               itself; where it does not, the address is still offered — with
 *               the machine's own Test button to settle it.
 *
 * That second case is normal rather than exceptional: a printer has no reason to
 * publish CORS headers for a stranger's web page. Reporting an unidentified
 * host as "something answered here" is more use than dropping it.
 *
 * Loaded as a plain script (browser) or required under Node for tests.
 */
(function (root) {
  'use strict';

  // Where each thing listens. Port 80 covers the Centauri Carbon 2 and an
  // OctoPrint behind a web server; 5000 is OctoPrint's own; 3030 is the first
  // Centauri Carbon's SDCP service.
  var PORTS = [80, 5000, 3030];

  var PROBES = [
    {
      kind: 'elegoo_cc2',
      label: 'Elegoo Centauri Carbon 2',
      ports: [80],
      path: '/system/info?X-Token=123456',
      read: function (body) {
        if (!body || !body.system_info) return null;
        var i = body.system_info;
        return { name: i.host_name || i.machine_model || 'Centauri Carbon 2', serial: i.sn || '' };
      }
    },
    {
      kind: 'octoprint',
      label: 'OctoPrint',
      ports: [5000, 80],
      path: '/api/version',
      // OctoPrint answers nothing without its API key, so a machine that has
      // never been connected to shows up as an address and not a name. Once a
      // key has been entered the sweep can use it, and then it names itself.
      headers: function (opts) {
        return opts && opts.key ? { 'X-Api-Key': opts.key } : null;
      },
      read: function (body) {
        if (!body || (!body.server && !body.api)) return null;
        return { name: 'OctoPrint ' + (body.server || ''), serial: '' };
      }
    },
    {
      kind: 'elegoo_cc1',
      label: 'Elegoo Centauri Carbon',
      ports: [3030],
      path: '/',
      read: function () { return null; }   // it identifies over its websocket, not here
    }
  ];

  /** The /24 this page is being served from, when that is knowable. */
  function guessBase(hostname) {
    var h = String(hostname || (typeof location !== 'undefined' ? location.hostname : ''));
    var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
    if (!m) return '';
    var a = +m[1], b = +m[2];
    // Only the private ranges: a public address is not a subnet to sweep.
    var private_ = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
    return private_ ? m[1] + '.' + m[2] + '.' + m[3] : '';
  }

  function fetcher(opts) {
    if (opts && opts.fetch) return opts.fetch;
    if (typeof fetch === 'function') return fetch;
    return null;
  }

  /** A promise that rejects if the given one has not settled in time. */
  function withTimeout(promise, ms, timers) {
    var setT = (timers && timers.setTimeout) || setTimeout;
    var clearT = (timers && timers.clearTimeout) || clearTimeout;
    return new Promise(function (resolve, reject) {
      var timer = setT(function () { reject(new Error('timeout')); }, ms);
      promise.then(function (v) { clearT(timer); resolve(v); },
        function (e) { clearT(timer); reject(e); });
    });
  }

  /** Run tasks a few at a time rather than opening 254 sockets at once. */
  function pool(items, width, worker) {
    var results = [];
    var next = 0;
    function run() {
      if (next >= items.length) return Promise.resolve();
      var i = next++;
      return Promise.resolve(worker(items[i], i)).then(function (r) {
        results[i] = r;
        return run();
      });
    }
    var lanes = [];
    for (var w = 0; w < Math.min(width, items.length); w++) lanes.push(run());
    return Promise.all(lanes).then(function () { return results; });
  }

  /**
   * Sweep one /24 and report what answered.
   *
   * @param {{base:string, from?:number, to?:number, ports?:number[],
   *          timeout?:number, width?:number, fetch?:Function, key?:string,
   *          onFound?:Function, cancelled?:Function}} opts
   */
  function scan(opts) {
    opts = opts || {};
    var base = String(opts.base || '').replace(/\.+$/, '');
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(base)) {
      return Promise.reject(new Error('That is not a subnet to scan. It looks like 192.168.1.'));
    }
    var f = fetcher(opts);
    if (!f) return Promise.reject(new Error('This browser has no fetch.'));

    var from = opts.from || 1;
    var to = opts.to || 254;
    var ports = opts.ports || PORTS;
    var timeout = opts.timeout || 900;
    var width = opts.width || 24;
    var found = [];

    var targets = [];
    for (var n = from; n <= to; n++) {
      for (var p = 0; p < ports.length; p++) targets.push({ host: base + '.' + n, port: ports[p] });
    }

    // Pass one: who is there at all.
    return pool(targets, width, function (t) {
      if (opts.cancelled && opts.cancelled()) return null;
      var url = 'http://' + t.host + (t.port === 80 ? '' : ':' + t.port) + '/';
      return withTimeout(f(url, { mode: 'no-cors', cache: 'no-store' }), timeout, opts)
        .then(function () { return t; }, function () { return null; });
    }).then(function (live) {
      var hosts = live.filter(Boolean);
      if (opts.onProgress) opts.onProgress(1, hosts.length);
      // Pass two: ask each of them what it is.
      return pool(hosts, Math.min(width, 8), function (t) {
        if (opts.cancelled && opts.cancelled()) return null;
        return identify(t, f, timeout * 2, opts).then(function (device) {
          found.push(device);
          if (opts.onFound) opts.onFound(device);
          return device;
        });
      });
    }).then(function () {
      // One address answering on two ports is one machine, named by whichever
      // probe actually recognised it.
      var byHost = {};
      found.forEach(function (d) {
        var seen = byHost[d.host];
        if (!seen || (seen.kind === 'unknown' && d.kind !== 'unknown')) byHost[d.host] = d;
      });
      return Object.keys(byHost).map(function (k) { return byHost[k]; })
        .sort(function (a, b) {
          var an = +a.host.split('.')[3], bn = +b.host.split('.')[3];
          return an - bn;
        });
    });
  }

  /**
   * Ask one host that answered which of the things we know it is. Every probe
   * is tried, whatever port answered: a printer moved off its usual port is
   * still that printer, and the port list only says which to ask first.
   */
  function identify(target, f, timeout, opts) {
    var candidates = PROBES.slice().sort(function (a, b) {
      var an = a.ports.indexOf(target.port) >= 0 ? 0 : 1;
      var bn = b.ports.indexOf(target.port) >= 0 ? 0 : 1;
      return an - bn;
    });
    var i = 0;

    function attempt() {
      if (i >= candidates.length) {
        return Promise.resolve({
          host: target.host, port: target.port, kind: 'unknown',
          label: 'Something answered', name: '', serial: '', identified: false
        });
      }
      var probe = candidates[i++];
      var url = 'http://' + target.host + (target.port === 80 ? '' : ':' + target.port) + probe.path;
      var init = { cache: 'no-store' };
      var extra = probe.headers && probe.headers(opts);
      if (extra) init.headers = extra;
      return withTimeout(f(url, init), timeout, opts).then(function (res) {
        if (!res || !res.ok) return attempt();
        return res.text().then(function (text) {
          var body = null;
          try { body = JSON.parse(text); } catch (e) { return attempt(); }
          var named = probe.read(body);
          if (!named) return attempt();
          return {
            host: target.host, port: target.port, kind: probe.kind, label: probe.label,
            name: named.name, serial: named.serial, identified: true
          };
        });
      }, function () { return attempt(); });
    }
    return attempt();
  }

  /** The address to hand the printer client for a device that was found. */
  function addressOf(device) {
    if (!device) return '';
    return device.port === 80 ? device.host : device.host + ':' + device.port;
  }

  var api = {
    PORTS: PORTS,
    PROBES: PROBES,
    guessBase: guessBase,
    addressOf: addressOf,
    scan: scan
  };
  root.OrcaDiscover = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
