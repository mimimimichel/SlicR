/**
 * Driving the printer: what each machine is allowed to be asked, and what is
 * refused before it ever reaches the wire.
 *
 *   node test-control.js
 */
globalThis.OrcaOctoPrint = require('./js/slicer/octoprint.js');
globalThis.OrcaElegooLink = require('./js/slicer/elegoolink.js');
var C = require('./js/slicer/control.js');

var pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); }
}
function done() {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
function refused(promise, pattern, label) {
  return promise.then(function () {
    fail++; console.log('  FAIL  ' + label + ' — it went through');
  }, function (err) {
    ok(label + ' (' + err.message.slice(0, 44) + '…)', pattern.test(err.message), err.message);
  });
}

/** A stub OctoPrint that records what it was asked and answers plausibly. */
function octoStub(state) {
  var calls = [];
  function f(url, init) {
    init = init || {};
    calls.push({ url: url, method: init.method, body: init.body });
    var body = '{}';
    if (/\/api\/printer$/.test(url)) {
      body = JSON.stringify({
        state: { text: (state && state.text) || 'Operational', flags: {} },
        temperature: {
          tool0: { actual: (state && state.nozzle) != null ? state.nozzle : 24.1, target: 0 },
          bed: { actual: 23.5, target: 0 }
        }
      });
    } else if (/\/api\/job$/.test(url) && init.method === 'GET') {
      body = JSON.stringify({ state: 'Operational', job: { file: { name: 'part.gcode' } },
        progress: { completion: 12.4, printTimeLeft: 900 } });
    }
    return Promise.resolve({ ok: true, status: 200,
      text: function () { return Promise.resolve(body); } });
  }
  f.calls = calls;
  return f;
}

var OCTO = { kind: 'octoprint', url: '192.168.1.20:5000', key: 'K' };
var CC1 = { kind: 'elegoo_cc1', url: '192.168.1.50' };
var CC2 = { kind: 'elegoo_cc2', url: '192.168.1.10' };
var NONE = { kind: 'none', url: '' };

console.log('=== 1. what each machine will answer for ===');
var o = C.capabilities(OCTO);
ok('OctoPrint does everything', o.status && o.job && o.temps && o.jog && o.extrude);
var c1 = C.capabilities(CC1);
ok('the first Carbon takes job commands and its light',
  c1.status && c1.job && c1.light && !c1.temps && !c1.jog, JSON.stringify(c1));
ok('and says what it will not do', /heaters are set by the file/.test(c1.reason), c1.reason);
var c2 = C.capabilities(CC2);
ok('the Centauri Carbon 2 does nothing live',
  !c2.status && !c2.job && !c2.temps && !c2.jog && !c2.light, JSON.stringify(c2));
ok('and says why, naming MQTT and its own screen',
  /MQTT/.test(c2.reason) && /its own screen/.test(c2.reason), c2.reason);
ok('nothing connected is its own answer', /No printer connected/.test(C.capabilities(NONE).reason));

console.log('\n=== 2. reading the machine ===');
var f = octoStub();
C.status(OCTO, { fetch: f }).then(function (s) {
  ok('temperatures and job come back together',
    s.text === 'Operational' && s.nozzle.now === 24.1 && s.job.file === 'part.gcode' &&
    s.job.percent === 12, JSON.stringify(s));
  ok('asking the two documented endpoints',
    /\/api\/printer$/.test(f.calls[0].url) && /\/api\/job$/.test(f.calls[1].url),
    f.calls.map(function (c) { return c.url; }).join(' '));
}).then(function () {
  // A machine that answers about its heaters but not its job is still readable.
  var partial = function (url, init) {
    if (/\/api\/job$/.test(url)) return Promise.reject(new TypeError('Failed to fetch'));
    return octoStub()(url, init);
  };
  return C.status(OCTO, { fetch: partial }).then(function (s) {
    ok('a missing job endpoint does not throw the temperatures away',
      s.nozzle.now === 24.1 && s.job.file === null, JSON.stringify(s));
  });
}).then(function () {
  console.log('\n=== 3. the job ===');
  var g = octoStub();
  return C.job(OCTO, 'pause', { fetch: g }).then(function () {
    var sent = JSON.parse(g.calls[0].body);
    ok('pause is OctoPrint\'s pause command with an action',
      sent.command === 'pause' && sent.action === 'pause', g.calls[0].body);
    return C.job(OCTO, 'cancel', { fetch: g }).then(function () {
      ok('and cancel is its own command', JSON.parse(g.calls[1].body).command === 'cancel');
    });
  });
}).then(function () {
  var sent = null;
  var fakeWs = function (url) {
    var self = this;
    self.close = function () { };
    self.send = function (t) {
      sent = JSON.parse(t);
      setTimeout(function () {
        self.onmessage({ data: JSON.stringify({ Data: { Cmd: sent.Data.Cmd, Data: { Ack: 0 } } }) });
      }, 0);
    };
    setTimeout(function () { self.onopen(); }, 0);
  };
  return C.job(CC1, 'cancel', { WebSocket: fakeWs }).then(function () {
    ok('the first Carbon cancels with command 130', sent.Data.Cmd === 130, JSON.stringify(sent.Data.Cmd));
    return C.job(CC1, 'pause', { WebSocket: fakeWs }).then(function () {
      ok('pauses with 129', sent.Data.Cmd === 129);
      return C.job(CC1, 'resume', { WebSocket: fakeWs }).then(function () {
        ok('and resumes with 131', sent.Data.Cmd === 131);
      });
    });
  });
}).then(function () {
  return refused(C.job(OCTO, 'explode', {}), /Unknown job command/,
    'a command nobody defined is refused');
}).then(function () {
  return refused(C.job(CC2, 'pause', {}), /MQTT/, 'and the CC2 refuses the whole idea');
}).then(function () {
  console.log('\n=== 4. the heater, which is the one that can burn the house down ===');
  var h = octoStub();
  var limits = { maxNozzleTemp: 300, maxBedTemp: 110 };
  return C.setTemp(OCTO, 'nozzle', 215, limits, { fetch: h }).then(function (r) {
    ok('a sane target is sent', r.target === 215 &&
      JSON.parse(h.calls[0].body).targets.tool0 === 215, h.calls[0].body);
  }).then(function () {
    return refused(C.setTemp(OCTO, 'nozzle', 2000, limits, { fetch: h }),
      /ceiling of 300/, 'a mistyped 2000 is refused against the machine\'s ceiling');
  }).then(function () {
    return refused(C.setTemp(OCTO, 'bed', 150, limits, { fetch: h }),
      /ceiling of 110/, 'and the bed has its own ceiling');
  }).then(function () {
    return refused(C.setTemp(OCTO, 'nozzle', -5, limits, { fetch: h }),
      /below zero/, 'below zero is not a temperature');
  }).then(function () {
    return refused(C.setTemp(OCTO, 'nozzle', 'hot', limits, { fetch: h }),
      /not a temperature/, 'nor is a word');
  }).then(function () {
    ok('and none of those four reached the printer', h.calls.length === 1,
      String(h.calls.length));
    return C.setTemp(OCTO, 'bed', 110, limits, { fetch: h }).then(function (r) {
      ok('the ceiling itself is allowed', r.target === 110);
    });
  });
}).then(function () {
  console.log('\n=== 5. moving the head ===');
  var j = octoStub();
  return C.jog(OCTO, { x: 10, y: -10 }, { printing: false }, { fetch: j }).then(function () {
    var sent = JSON.parse(j.calls[0].body);
    ok('a jog is relative, and only the axes asked for',
      sent.command === 'jog' && sent.absolute === false && sent.x === 10 && sent.y === -10 &&
      sent.z === undefined, j.calls[0].body);
  }).then(function () {
    return refused(C.jog(OCTO, { x: 10 }, { printing: true }, { fetch: j }),
      /through the part/, 'jogging mid-print is refused, which OctoPrint would allow');
  }).then(function () {
    return refused(C.home(OCTO, ['x', 'y'], { printing: true }, { fetch: j }),
      /across the part/, 'and so is homing');
  }).then(function () {
    return C.home(OCTO, ['x', 'y'], { printing: false }, { fetch: j }).then(function () {
      var sent = JSON.parse(j.calls[j.calls.length - 1].body);
      ok('homing names its axes', sent.command === 'home' &&
        sent.axes.join(',') === 'x,y', JSON.stringify(sent));
    });
  }).then(function () {
    return refused(C.jog(CC1, { x: 1 }, {}, {}), /no jogging/, 'the first Carbon cannot be jogged at all');
  });
}).then(function () {
  console.log('\n=== 6. filament ===');
  var e = octoStub();
  return C.extrude(OCTO, 10, { nozzle: { now: 210 } }, { fetch: e }).then(function (r) {
    ok('ten millimetres through a hot nozzle is fine', r.extruded === 10 &&
      JSON.parse(e.calls[0].body).amount === 10);
  }).then(function () {
    return refused(C.extrude(OCTO, 10, { nozzle: { now: 24 } }, { fetch: e }),
      /cold/, 'through a cold one it is refused, with the temperature named');
  }).then(function () {
    return refused(C.extrude(OCTO, 5000, { nozzle: { now: 210 } }, { fetch: e }),
      /in one go/, 'and five metres in one go is not a request');
  }).then(function () {
    return C.extrude(OCTO, -5, { nozzle: { now: 210 } }, { fetch: e }).then(function (r) {
      ok('pulling filament back is allowed', r.extruded === -5);
    });
  });
}).then(function () {
  console.log('\n=== 7. the light ===');
  var sent = null;
  var fakeWs = function () {
    var self = this;
    self.close = function () { };
    self.send = function (t) {
      sent = JSON.parse(t);
      setTimeout(function () {
        self.onmessage({ data: JSON.stringify({ Data: { Cmd: sent.Data.Cmd, Data: { Ack: 0 } } }) });
      }, 0);
    };
    setTimeout(function () { self.onopen(); }, 0);
  };
  return C.light(CC1, true, { WebSocket: fakeWs }).then(function (r) {
    ok('the first Carbon\'s light is command 403',
      sent.Data.Cmd === 403 && sent.Data.Data.LightStatus.SecondLight === true && r.on === true,
      JSON.stringify(sent.Data));
  }).then(function () {
    return refused(C.light(OCTO, true, {}), /does not offer a light/i,
      'and OctoPrint is told it has no light, not refused blankly');
  });
}).then(function () {
  console.log('\n=== 8. reading the first Carbon\'s status message ===');
  var E = globalThis.OrcaElegooLink;
  var s = E.readSdcpStatus({
    Status: {
      TempOfNozzle: 214.6, TempTargetNozzle: 215, TempOfHotbed: 59.8, TempTargetHotbed: 60,
      PrintInfo: { Status: 13, CurrentLayer: 42, TotalLayer: 165, Progress: 25,
        CurrentTicks: 1000, TotalTicks: 9749, Filename: 'part.gcode' }
    }
  });
  ok('status 13 is printing', s.text === 'Printing' && s.code === 13);
  ok('with layers, progress and time left',
    s.job.layer === 42 && s.job.layers === 165 && s.job.percent === 25 &&
    s.job.secondsLeft === 8749, JSON.stringify(s.job));
  ok('and the temperatures', s.nozzle.now === 214.6 && s.bed.target === 60);
  ok('an unknown code is named unknown',
    E.readSdcpStatus({ Status: { PrintInfo: { Status: 99 } } }).text === 'Unknown');
  ok('and an empty message does not throw', !!E.readSdcpStatus({}).text);
}).then(done, function (err) {
  fail++;
  console.log('  FAIL  the chain threw: ' + (err && err.stack || err));
  done();
});
