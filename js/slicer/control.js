/**
 * Orca Web Slicer — driving the printer.
 *
 * One face over machines that do very different amounts. What a panel may show
 * comes from `capabilities`, so a button is never drawn for something the
 * machine at the other end cannot do:
 *
 *   OctoPrint            everything — state, job, heaters, jogging, extruding
 *   Centauri Carbon 1    state, pause, resume, cancel, the light
 *   Centauri Carbon 2    nothing live. Its control channel is MQTT over raw
 *                        TCP, and no browser opens that socket.
 *
 * The heater is the one thing here that can start a fire, so a target is
 * checked against the machine's own ceiling before it is sent, and a command
 * that would move the head while a print is running is refused. Those two
 * guards are in this file rather than in the panel, so they hold whoever calls.
 *
 * Loaded as a plain script (browser) or required under Node for tests.
 */
(function (root) {
  'use strict';

  function octo() {
    if (root.OrcaOctoPrint) return root.OrcaOctoPrint;
    if (typeof require === 'function') { try { return require('./octoprint.js'); } catch (e) { } }
    return null;
  }
  function elegoo() {
    if (root.OrcaElegooLink) return root.OrcaElegooLink;
    if (typeof require === 'function') { try { return require('./elegoolink.js'); } catch (e) { } }
    return null;
  }

  var NOTHING = {
    status: false, job: false, temps: false, jog: false, extrude: false, light: false
  };

  /**
   * What can be done with this connection, and — when the answer is not much —
   * why, in a sentence the panel can show instead of a row of dead buttons.
   */
  function capabilities(link) {
    var kind = link && link.kind;
    if (kind === 'octoprint') {
      return {
        status: true, job: true, temps: true, jog: true, extrude: true, light: false,
        reason: ''
      };
    }
    if (kind === 'elegoo_cc1') {
      return {
        status: true, job: true, temps: false, jog: false, extrude: false, light: true,
        reason: 'This machine takes job commands and little else: no jogging, and its ' +
          'heaters are set by the file it is printing.'
      };
    }
    if (kind === 'elegoo_cc2') {
      var none = Object.assign({}, NOTHING);
      none.reason = 'The Centauri Carbon 2 is driven over MQTT on port 1883, and a browser ' +
        'cannot open that kind of socket. Files can be sent to it; the machine is ' +
        'controlled from its own screen.';
      return none;
    }
    var off = Object.assign({}, NOTHING);
    off.reason = 'No printer connected.';
    return off;
  }

  function refuse(message) { return Promise.reject(new Error(message)); }

  /**
   * Say no to something this machine does not do. A connection may have a
   * reason of its own — the CC2's MQTT, the CC1's fixed heaters — and where it
   * does not, the missing thing is named rather than refused blankly.
   */
  var NAMES = {
    status: 'live status', job: 'job control', temps: 'setting its heaters',
    jog: 'moving its head from here', extrude: 'pushing filament from here',
    light: 'a light this can switch'
  };
  function deny(can, what) {
    return refuse(can.reason || ('This printer does not offer ' + (NAMES[what] || what) + '.'));
  }

  function cfgOf(link) {
    return {
      url: link.url, key: link.key,
      model: link.kind === 'elegoo_cc1' ? 'cc1' : 'cc2'
    };
  }

  /** State, temperatures and progress, in the same shape for every machine. */
  function status(link, opts) {
    var can = capabilities(link);
    if (!can.status) return deny(can, 'status');

    if (link.kind === 'octoprint') {
      var O = octo();
      if (!O) return refuse('The OctoPrint client did not load.');
      var cfg = cfgOf(link);
      return O.printerState(cfg, opts).then(function (p) {
        return O.status(cfg, opts).then(function (j) {
          return {
            text: p.text,
            nozzle: p.nozzle, bed: p.bed, chamber: p.chamber,
            printing: /printing/i.test(p.text),
            paused: /pause/i.test(p.text),
            job: { file: j.file, percent: j.percent, secondsLeft: j.secondsLeft }
          };
        }, function () {
          // The heaters answered; a job endpoint that did not is not a failure
          // worth throwing away the temperatures for.
          return {
            text: p.text, nozzle: p.nozzle, bed: p.bed, chamber: p.chamber,
            printing: /printing/i.test(p.text), paused: /pause/i.test(p.text),
            job: { file: null, percent: null, secondsLeft: null }
          };
        });
      });
    }

    var E = elegoo();
    if (!E) return refuse('The Elegoo client did not load.');
    return E.sdcpStatus(cfgOf(link), opts).then(function (s) {
      return {
        text: s.text,
        nozzle: s.nozzle, bed: s.bed, chamber: s.chamber,
        printing: s.code === 13 || s.code === 9,
        paused: s.code === 10,
        job: s.job
      };
    });
  }

  /**
   * Pause, resume or cancel. Cancelling throws away a print that may have been
   * running for hours, so the caller has to have meant it — this refuses
   * anything it was not asked for by name.
   */
  function job(link, what, opts) {
    var can = capabilities(link);
    if (!can.job) return deny(can, 'job');
    if (['pause', 'resume', 'cancel'].indexOf(what) < 0) {
      return refuse('Unknown job command: ' + what);
    }
    if (link.kind === 'octoprint') {
      var O = octo();
      if (!O) return refuse('The OctoPrint client did not load.');
      return O.job(cfgOf(link), what, opts).then(function () { return { done: what }; });
    }
    var E = elegoo();
    if (!E) return refuse('The Elegoo client did not load.');
    return E.sdcpJob(cfgOf(link), what, opts);
  }

  /**
   * Set a heater. The number is checked against what the machine was declared
   * able to survive — a mistyped 2000 is the difference between a warm nozzle
   * and a fire, and the profile already knows the ceiling.
   */
  function setTemp(link, which, celsius, limits, opts) {
    var can = capabilities(link);
    if (!can.temps) return deny(can, 'temps');
    if (which !== 'nozzle' && which !== 'bed') return refuse('Unknown heater: ' + which);

    var value = Number(celsius);
    if (!isFinite(value)) return refuse('That is not a temperature.');
    value = Math.round(value);
    if (value < 0) return refuse('A heater cannot be set below zero.');

    var ceiling = which === 'bed'
      ? ((limits && limits.maxBedTemp) || 120)
      : ((limits && limits.maxNozzleTemp) || 300);
    if (value > ceiling) {
      return refuse('This machine is set to a ceiling of ' + ceiling + ' °C for the ' +
        (which === 'bed' ? 'bed' : 'nozzle') + ', and ' + value + ' is past it. ' +
        'Raise the ceiling in the Machine tab if the hardware really was changed.');
    }

    var O = octo();
    if (!O) return refuse('The OctoPrint client did not load.');
    return O.setTemp(cfgOf(link), which, value, opts).then(function () {
      return { which: which, target: value };
    });
  }

  /**
   * Move the head. Refused while a print is running, because a jog then is a
   * gouge through the part — OctoPrint would accept it.
   */
  function jog(link, delta, state, opts) {
    var can = capabilities(link);
    if (!can.jog) return deny(can, 'jog');
    if (state && state.printing) {
      return refuse('Not while it is printing: moving the head now would drag it ' +
        'through the part. Pause first.');
    }
    var O = octo();
    if (!O) return refuse('The OctoPrint client did not load.');
    return O.jog(cfgOf(link), delta, opts).then(function () { return { moved: delta }; });
  }

  function home(link, axes, state, opts) {
    var can = capabilities(link);
    if (!can.jog) return deny(can, 'jog');
    if (state && state.printing) {
      return refuse('Not while it is printing: homing now would sweep the head ' +
        'across the part. Pause first.');
    }
    var O = octo();
    if (!O) return refuse('The OctoPrint client did not load.');
    return O.home(cfgOf(link), axes, opts).then(function () { return { homed: axes }; });
  }

  /** Push or pull filament, which needs a hot nozzle to be anything but damage. */
  function extrude(link, mm, state, opts) {
    var can = capabilities(link);
    if (!can.extrude) return deny(can, 'extrude');
    var amount = Number(mm);
    if (!isFinite(amount) || amount === 0) return refuse('That is not a length.');
    if (Math.abs(amount) > 100) return refuse('That is more than the extruder should be ' +
      'asked for in one go.');
    if (state && state.nozzle && typeof state.nozzle.now === 'number' && state.nozzle.now < 170) {
      return refuse('The nozzle is at ' + Math.round(state.nozzle.now) + ' °C. Pushing ' +
        'filament through it cold strips the gear or jams the tube.');
    }
    var O = octo();
    if (!O) return refuse('The OctoPrint client did not load.');
    return O.extrude(cfgOf(link), amount, opts).then(function () { return { extruded: amount }; });
  }

  function light(link, on, opts) {
    var can = capabilities(link);
    if (!can.light) return deny(can, 'light');
    var E = elegoo();
    if (!E) return refuse('The Elegoo client did not load.');
    return E.sdcpLight(cfgOf(link), on, opts);
  }

  var api = {
    capabilities: capabilities,
    status: status,
    job: job,
    setTemp: setTemp,
    jog: jog,
    home: home,
    extrude: extrude,
    light: light
  };
  root.OrcaControl = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
