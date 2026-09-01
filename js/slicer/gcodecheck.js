/**
 * Orca Web Slicer — G-code safety verification.
 *
 * Bad G-code is not a cosmetic problem. A nozzle told to reach 400 °C, heaters
 * left running at the end of a file, a prime line off the edge of the bed, an
 * extruder driven cold, a stepper-current command in a start script: these
 * start fires and break machines.
 *
 * So this does not inspect the slicer's internal model — that would share every
 * bug the generator has. It parses the finished text and walks it as the printer
 * would, one line at a time, tracking position, homing, coordinate mode,
 * extruder mode and heater state, and reports what it finds.
 *
 * It is deliberately conservative in one direction only: when a firmware macro
 * (START_PRINT, END_PRINT…) makes a fact unverifiable, the finding is reported
 * as a warning that says so, rather than a false alarm or a silent pass.
 */
(function (root) {
  'use strict';

  var ERROR = 'error', WARN = 'warning', INFO = 'info';

  // M-codes that have no business appearing in a print file. Several of these
  // permanently change machine configuration or defeat safety interlocks.
  var DANGEROUS = {
    M302: [ERROR, 'Cold extrusion is being enabled — the extruder can be driven with a cold nozzle, which grinds filament and strips gears'],
    M92:  [ERROR, 'Steps-per-millimetre are being changed — every later move would be the wrong distance'],
    M500: [ERROR, 'Settings are being written to EEPROM — this permanently overwrites the machine configuration'],
    M502: [ERROR, 'Factory reset of machine settings'],
    M501: [WARN,  'Settings are being reloaded from EEPROM mid-file'],
    M303: [ERROR, 'PID autotune is being started — this heats the nozzle unattended and must never run inside a print'],
    M301: [WARN,  'PID tuning values are being changed'],
    M304: [WARN,  'Bed PID values are being changed'],
    M906: [ERROR, 'Stepper motor current is being changed — too high burns drivers and motors'],
    M907: [ERROR, 'Stepper motor current is being changed — too high burns drivers and motors'],
    M908: [ERROR, 'Stepper driver current is being set directly'],
    M143: [WARN,  'The maximum heater temperature limit is being changed'],
    M562: [WARN,  'A heater fault is being cleared — this defeats a safety interlock'],
    M112: [ERROR, 'Emergency stop in the middle of the file'],
    M997: [ERROR, 'Firmware update command'],
    M999: [WARN,  'Firmware restart-after-error command'],
    M42:  [WARN,  'A pin is being set directly']
  };

  var MIN_EXTRUDE_TEMP = 160;   // below this, filament does not melt, it jams

  /**
   * Ceilings no printer profile may raise. The per-printer limits are editable —
   * people do fit hotter hotends — but an edited profile must not be able to talk
   * this check into allowing a temperature no consumer machine survives.
   */
  var ABSOLUTE = { nozzle: 500, bed: 150, chamber: 120 };

  var TEMP_STEP_NEEDING_WAIT = 25;   // °C of change worth waiting out before extruding

  function finding(severity, code, message, line, text, detail) {
    return {
      severity: severity, code: code, message: message,
      line: line, text: (text || '').slice(0, 120), detail: detail || ''
    };
  }

  // ---------------------------------------------------------------------------
  // Parsing
  // ---------------------------------------------------------------------------

  // One source of truth for what a parameter looks like. A fresh literal is used
  // at each call site: a shared /g regex carries lastIndex between them, which is
  // exactly the kind of subtle state bug this module exists to catch elsewhere.
  function wordRegex() { return /([A-Za-z])\s*(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g; }

  /**
   * Split one line into a command and its words. Returns null for blanks and
   * comments, and flags anything it cannot make sense of rather than skipping it:
   * a parameter this cannot read is a parameter the printer might read wrongly.
   */
  function parseLine(raw) {
    var line = raw;
    var semi = line.indexOf(';');
    if (semi >= 0) line = line.slice(0, semi);
    line = line.replace(/\([^)]*\)/g, ' ').trim();
    if (!line) return null;

    if (/\b(NaN|Infinity|undefined|null)\b/i.test(line)) {
      return { bad: 'contains a value that is not a number' };
    }

    var head = /^([A-Za-z])\s*(\d+)/.exec(line);
    if (!head) {
      // A bare word is a firmware macro (Klipper START_PRINT, RepRap meta…).
      var macro = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(line);
      if (macro) {
        // Klipper-style macros carry KEY=VALUE arguments; the temperatures a
        // START_PRINT is handed are checkable even though its body is not.
        var params = {}, kv = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(-?[\d.]+)/g, kvm;
        while ((kvm = kv.exec(line)) !== null) params[kvm[1].toUpperCase()] = parseFloat(kvm[2]);
        return { macro: macro[0], params: params };
      }
      return { bad: 'is not a recognisable command' };
    }

    var cmd = head[1].toUpperCase() + parseInt(head[2], 10);
    var rest = line.slice(head[0].length);
    var words = {};
    var re = wordRegex();
    var m;
    while ((m = re.exec(rest)) !== null) words[m[1].toUpperCase()] = parseFloat(m[2]);

    // Whatever the tokeniser could not account for is a parameter we failed to read.
    var leftover = rest.replace(wordRegex(), '').replace(/\s+/g, '');
    // Except on the handful of commands that name axes without a value —
    // 'G28 Z' homes Z alone, 'M84 X Y E' releases three motors. Those bare
    // letters are the parameter, not a value that went missing.
    if (leftover && /^(G28|M18|M84)$/.test(cmd) && /^[XYZEABCUVW]+$/i.test(leftover)) {
      var flags = leftover.toUpperCase().split('');
      for (var fi = 0; fi < flags.length; fi++) words[flags[fi]] = 0;
      leftover = '';
    }
    if (leftover) return { cmd: cmd, words: words, junk: leftover };
    return { cmd: cmd, words: words };
  }

  // ---------------------------------------------------------------------------
  // Verification
  // ---------------------------------------------------------------------------

  function verify(gcode, settings) {
    var out = [];
    var s = settings || {};
    var maxNozzle = Math.min(s.maxNozzleTemp || 300, ABSOLUTE.nozzle);
    var maxBed = Math.min(s.maxBedTemp || 120, ABSOLUTE.bed);
    var maxChamber = Math.min(s.maxChamberTemp || 60, ABSOLUTE.chamber);
    var maxZSpeed = s.maxZSpeed || 12;
    var bedX = s.bedX || 0, bedY = s.bedY || 0, bedZ = s.bedZ || 0;
    var centre = !!s.originCenter;
    var circular = s.bedShape === 'circle';
    var radius = Math.min(bedX, bedY) / 2;
    var filamentArea = Math.PI * Math.pow((s.filamentDiameter || 1.75) / 2, 2);
    var maxVolumetric = s.maxVolumetric || 0;
    var maxFeed = (s.maxSpeed || 0) * 60;
    var MARGIN = 1.0;          // mm of slack before a coordinate counts as off-bed
    var VENDOR_MARGIN = 15;    // how far a machine's own script may reach past it
    // What the head can physically reach, when the profile knows. It is wider
    // than the print area on most machines — there is plate in front of the
    // printable square to purge on, and room behind it to present the part.
    var reach = s.bedReach && s.bedReach.length === 4 ? s.bedReach : null;
    var reachZ = s.bedReachZ || 0;   // how far below the plate those scripts go

    // X/Y limits in the coordinate system the file actually uses.
    var minX = centre ? -bedX / 2 : 0, maxX = centre ? bedX / 2 : bedX;
    var minY = centre ? -bedY / 2 : 0, maxY = centre ? bedY / 2 : bedY;

    var st = {
      x: null, y: null, z: null, e: 0,
      absXYZ: true, absE: true, sawG90: false, sawEMode: false, modeWarned: false,
      homed: false, positionKnown: false,
      feed: 0,
      nozzleTarget: 0, bedTarget: 0, chamberTarget: 0,
      hotendReady: false, bedReady: false,
      extruded: false, lastExtrudeZ: -Infinity,
      inBody: false, inEnd: false, lastLayerZ: -Infinity,
      macroSeen: false, endMacroSeen: false,
      heaterOffNozzle: false, heaterOffBed: false,
      lastExtrudeLine: 0, totalE: 0, bodyE: 0,
      peakNozzle: 0, peakBed: 0,
      // Footprint and height of everything laid down so far, for the check that
      // the head is lifted clear before it sweeps back across the finished part.
      printedBox: null, printedTopZ: -Infinity,
      currentObject: null, finishedObjects: [], collisionsReported: 0,
      tool: 0, toolsSeen: {}, pendingPurge: null, purgeWarned: false, featureType: '',
      pendingSweeps: [],
      pendingTempChange: null, tempChangeWarned: false
    };

    var counts = { moves: 0, extrusions: 0 };
    var seen = {};              // report each dangerous code once
    var capped = {};            // and cap repetitive geometry findings
    var CAP = 5;

    function add(severity, code, message, lineNo, text, detail) {
      if (capped[code] === undefined) capped[code] = 0;
      capped[code]++;
      if (capped[code] === CAP + 1) {
        out.push(finding(severity, code + '.more', message + ' — and more occurrences beyond this point', lineNo, '', 'Only the first ' + CAP + ' are listed.'));
        return;
      }
      if (capped[code] > CAP) return;
      out.push(finding(severity, code, message, lineNo, text, detail));
    }

    // Say plainly when the machine profile has been edited to allow more than the
    // printer shipped with: the check is only ever as strict as its limits.
    if (s.factoryMaxNozzleTemp && s.maxNozzleTemp > s.factoryMaxNozzleTemp) {
      add(WARN, 'limit.raised.nozzle',
        'The nozzle limit in this profile has been raised from ' + s.factoryMaxNozzleTemp + ' °C to ' + s.maxNozzleTemp + ' °C',
        0, '', 'Temperatures up to the new figure will now pass this check. Only correct if the hotend has actually been changed.');
    }
    if (s.factoryMaxBedTemp && s.maxBedTemp > s.factoryMaxBedTemp) {
      add(WARN, 'limit.raised.bed',
        'The bed limit in this profile has been raised from ' + s.factoryMaxBedTemp + ' °C to ' + s.maxBedTemp + ' °C',
        0, '', 'Temperatures up to the new figure will now pass this check.');
    }

    var lines = String(gcode).split('\n');

    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var lineNo = i + 1;

      // Structural comments carry information worth checking on their own.
      if (raw.charCodeAt(0) === 59) {
        if (!st.inBody && /^;LAYER(_CHANGE|:)/.test(raw)) {
          // The priming line in the start script sits at its own height, at the
          // edge of the bed. Only compare heights once the part itself starts.
          st.inBody = true;
          st.lastExtrudeZ = -Infinity;
        }
        // Past this the file is running the machine's own end script again.
        if (/^;\s*END[_ ]?GCODE\b/i.test(raw)) st.inEnd = true;
        // Printing one object at a time: the previous object is now a fixed
        // obstacle standing on the plate, and Z legitimately goes back to the
        // bed for the next one.
        var objMark = /^;OBJECT:(.*)$/.exec(raw);
        if (objMark) {
          if (st.currentObject && st.currentObject.box) st.finishedObjects.push(st.currentObject);
          st.currentObject = { name: objMark[1].trim() || 'object', box: null, topZ: -Infinity };
          st.lastLayerZ = -Infinity;
          st.lastExtrudeZ = -Infinity;
        }
        var typeMark = /^;TYPE:(.*)$/.exec(raw);
        if (typeMark) st.featureType = typeMark[1].trim().toLowerCase();
        var zMark = /^;Z:(-?[\d.]+)/.exec(raw);
        if (zMark) {
          var layerZ = parseFloat(zMark[1]);
          if (layerZ < st.lastLayerZ - 0.001) {
            add(WARN, 'layer.z.backwards',
              'Layer height goes backwards: Z' + layerZ + ' after Z' + st.lastLayerZ,
              lineNo, raw, 'Layers should only ever climb; this points at a fault in the generator.');
          }
          st.lastLayerZ = layerZ;
        }
        continue;
      }

      // A tool change is a whole-machine event: the new hotend arrives with the
      // previous colour still in it, and the extruder position is its own.
      var toolCmd = /^T(\d+)\b/.exec(raw.trim());
      if (toolCmd) {
        var picked = parseInt(toolCmd[1], 10);
        var have = s.extruderCount || 1;
        if (picked >= have) {
          add(ERROR, 'tool.missing',
            'Tool T' + picked + ' is selected, but this printer has ' + have +
            (have === 1 ? ' extruder' : ' extruders'),
            lineNo, raw,
            'Selecting a tool the machine does not have is undefined behaviour: ' +
            'most firmware ignores it and keeps printing with the wrong one.');
        }
        if (picked !== st.tool) {
          // Anything laid down before the new tool has purged carries the old
          // colour, and on a cold or wet nozzle it carries nothing at all.
          st.pendingPurge = { line: lineNo, tool: picked, extruded: 0 };
        }
        st.tool = picked;
        st.toolsSeen[picked] = true;
        counts.toolChanges = (counts.toolChanges || 0) + 1;
        continue;
      }

      var p;
      try {
        p = parseLine(raw);
      } catch (err) {
        add(ERROR, 'parse', 'This line could not be parsed', lineNo, raw, String(err));
        continue;
      }
      if (!p) continue;

      if (p.bad) {
        add(ERROR, 'malformed', 'Malformed command: it ' + p.bad, lineNo, raw);
        continue;
      }
      if (p.macro) {
        st.macroSeen = true;
        // Klipper's SET_KINEMATIC_POSITION moves the coordinate system rather
        // than the head: the machine is told it is somewhere else, and stays
        // exactly where it was. Follow it, or every later move in that script
        // reads as a leap across the bed. Machines use it to reach a wiper
        // that sits outside the space their coordinates can name.
        if (/^SET_KINEMATIC_POSITION$/i.test(p.macro)) {
          var kin = p.params || {};
          if (kin.X !== undefined) st.x = kin.X;
          if (kin.Y !== undefined) st.y = kin.Y;
          if (kin.Z !== undefined) st.z = kin.Z;
          st.homed = true;
          st.positionKnown = true;
          continue;
        }
        if (/END|FINISH|COMPLETE/i.test(p.macro)) st.endMacroSeen = true;
        if (/START|PRINT_START|BEGIN/i.test(p.macro)) { st.hotendReady = true; st.homed = true; st.positionKnown = true; }
        var args = p.params || {};
        for (var key in args) {
          if (!/TEMP/.test(key)) continue;
          if (/BED/.test(key)) { st.bedTarget = args[key]; st.peakBed = Math.max(st.peakBed, args[key]); checkBed(args[key], lineNo, raw); }
          else if (/CHAMBER/.test(key)) checkChamber(args[key], lineNo, raw);
          else if (/EXTRUDER|HOTEND|NOZZLE|TOOL/.test(key)) { st.nozzleTarget = args[key]; st.peakNozzle = Math.max(st.peakNozzle, args[key]); checkNozzle(args[key], lineNo, raw); }
        }
        continue;
      }
      if (p.junk) {
        // A stray letter means a parameter with no readable value — the printer
        // may interpret it differently than we do, so treat that as an error.
        var junkIsParameter = /[A-Za-z]/.test(p.junk);
        add(junkIsParameter ? ERROR : WARN, junkIsParameter ? 'malformed' : 'junk',
          junkIsParameter
            ? 'Malformed command: a parameter has no readable value (' + p.junk + ')'
            : 'Unexpected characters after the command',
          lineNo, raw, 'Leftover: ' + p.junk);
        if (junkIsParameter) continue;
      }

      var w = p.words;
      var cmd = p.cmd;

      if (DANGEROUS[cmd] && !seen[cmd]) {
        seen[cmd] = true;
        add(DANGEROUS[cmd][0], 'dangerous.' + cmd, cmd + ': ' + DANGEROUS[cmd][1], lineNo, raw);
      }

      switch (cmd) {
        case 'G0': case 'G1': case 'G2': case 'G3':
          handleMove(cmd, w, lineNo, raw);
          break;

        case 'G28':
          st.homed = true;
          st.positionKnown = true;
          if (w.X === undefined && w.Y === undefined && w.Z === undefined) {
            st.x = centre ? 0 : 0; st.y = centre ? 0 : 0; st.z = 0;
          } else {
            if (w.X !== undefined) st.x = centre ? 0 : 0;
            if (w.Y !== undefined) st.y = centre ? 0 : 0;
            if (w.Z !== undefined) st.z = 0;
          }
          if (st.extruded) add(WARN, 'homing.mid', 'Homing in the middle of the print — the head will sweep across whatever is already printed', lineNo, raw);
          break;

        case 'G29':
          if (st.extruded) add(WARN, 'levelling.mid', 'Bed levelling in the middle of the print', lineNo, raw);
          break;

        case 'G90': st.absXYZ = true; st.sawG90 = true; break;
        case 'G91': st.absXYZ = false; st.sawG90 = true; break;
        case 'M82': st.absE = true; st.sawEMode = true; break;
        case 'M83': st.absE = false; st.sawEMode = true; break;

        case 'G92':
          if (w.E !== undefined) st.e = w.E;
          if (w.X !== undefined) { st.x = w.X; st.positionKnown = true; }
          if (w.Y !== undefined) { st.y = w.Y; st.positionKnown = true; }
          if (w.Z !== undefined) { st.z = w.Z; st.positionKnown = true; }
          break;

        case 'M104': case 'M109': case 'M568':
          if (w.S !== undefined) {
            // A big step with no wait means printing through the ramp.
            if (cmd === 'M104' && st.extruded && w.S > 0 &&
                Math.abs(w.S - st.nozzleTarget) > TEMP_STEP_NEEDING_WAIT) {
              st.pendingTempChange = { from: st.nozzleTarget, to: w.S, line: lineNo, text: raw };
            }
            st.nozzleTarget = w.S;
            if (w.S > st.peakNozzle) st.peakNozzle = w.S;
            checkNozzle(w.S, lineNo, raw);
            st.heaterOffNozzle = w.S <= 0;
          }
          if (cmd === 'M109' && (w.S > 0 || w.R > 0)) { st.hotendReady = true; st.pendingTempChange = null; }
          break;

        case 'M140': case 'M190':
          if (w.S !== undefined) {
            st.bedTarget = w.S;
            if (w.S > st.peakBed) st.peakBed = w.S;
            checkBed(w.S, lineNo, raw);
            st.heaterOffBed = w.S <= 0;
          }
          if (cmd === 'M190') st.bedReady = true;
          break;

        case 'M141': case 'M191':
          if (w.S !== undefined) checkChamber(w.S, lineNo, raw);
          break;

        case 'M116': st.hotendReady = true; st.pendingTempChange = null; break;

        case 'M201': case 'M203': case 'M204': case 'M205':
          for (var k in w) {
            if (Math.abs(w[k]) > 100000) {
              add(WARN, 'motion.absurd', cmd + ' sets ' + k + '=' + w[k] + ', which is not a plausible machine limit', lineNo, raw);
              break;
            }
          }
          break;
      }
    }

    // ----- end-of-file checks ------------------------------------------------

    if (!counts.moves) {
      add(ERROR, 'empty', 'The file contains no movement commands at all', 0, '');
    }
    if (!st.homed && counts.moves) {
      add(ERROR, 'home.missing', 'The file never homes the machine', 0, '',
        'Without G28 the printer has no idea where the head is and will drive it into the frame.');
    }

    if (!st.heaterOffNozzle) {
      add(st.endMacroSeen ? WARN : ERROR, 'heater.nozzle.on',
        'The file never turns the nozzle heater off',
        0, '', st.endMacroSeen
          ? 'An end macro was called, which may do it — this could not be verified from the file.'
          : 'The hotend would stay at temperature indefinitely after the print finishes.');
    }
    if (!st.heaterOffBed) {
      add(st.endMacroSeen ? WARN : ERROR, 'heater.bed.on',
        'The file never turns the bed heater off',
        0, '', st.endMacroSeen
          ? 'An end macro was called, which may do it — this could not be verified from the file.'
          : 'The bed would stay at temperature indefinitely after the print finishes.');
    }
    if (!st.absXYZ) {
      add(WARN, 'mode.relative', 'The file ends in relative positioning mode (G91)', 0, '',
        'Anything run afterwards will move by the wrong amounts.');
    }

    for (var sw = 0; sw < st.pendingSweeps.length; sw++) {
      var move = st.pendingSweeps[sw];
      add(ERROR, 'collision.sweep',
        'After the last layer, the head crosses the finished print without being lifted clear',
        move.line, move.text,
        'The print reaches Z' + Math.round(st.printedTopZ * 100) / 100 + ' and this move is at Z' +
        (move.z === null ? '?' : Math.round(move.z * 100) / 100) +
        '. Raise Z before moving away in the end G-code.');
    }

    // Cross-check the footer against what the moves actually extrude. Only the
    // print body counts: priming lines in the start script are real filament the
    // slicer never accounted for, and comparing against them is not a fault.
    var reported = /;\s*filament used \[mm\]\s*=\s*([\d.]+)/.exec(gcode);
    if (reported && st.bodyE > 0) {
      var claimed = parseFloat(reported[1]);
      if (claimed > 0 && Math.abs(claimed - st.bodyE) / st.bodyE > 0.05) {
        add(WARN, 'filament.mismatch',
          'The filament figure in the file (' + Math.round(claimed) + ' mm) does not match what the printed moves extrude (' + Math.round(st.bodyE) + ' mm)',
          0, '', 'A gap this size usually means the generator and its output disagree.');
      }
    }

    var errors = 0, warnings = 0;
    for (var f = 0; f < out.length; f++) {
      if (out[f].severity === ERROR) errors++;
      else if (out[f].severity === WARN) warnings++;
    }

    return {
      ok: errors === 0,
      errors: errors,
      warnings: warnings,
      findings: out,
      summary: {
        lines: lines.length,
        moves: counts.moves,
        extrusions: counts.extrusions,
        filamentMm: Math.round(st.totalE),
        nozzleTemp: st.peakNozzle,
        bedTemp: st.peakBed,
        usedMacros: st.macroSeen
      }
    };

    // ----- move handling -----------------------------------------------------

    function handleMove(cmd, w, lineNo, raw) {
      counts.moves++;

      if (w.F !== undefined) {
        if (!(w.F > 0)) {
          add(ERROR, 'feed.zero', 'Feedrate of ' + w.F + ' — the machine would stall or reject the move', lineNo, raw);
        } else {
          st.feed = w.F;
          if (maxFeed && w.F > maxFeed * 2) {
            add(WARN, 'feed.high', 'Feedrate ' + Math.round(w.F / 60) + ' mm/s is far above this printer’s ' + Math.round(maxFeed / 60) + ' mm/s', lineNo, raw);
          }
        }
      }

      var hasAxis = w.X !== undefined || w.Y !== undefined || w.Z !== undefined;

      // Nothing may move before the file has said which way coordinates are
      // read. A machine holds G90/G91 and M82/M83 across jobs, so a file that
      // starts moving without setting them inherits whatever the last one left:
      // the same lines mean absolute positions to one printer and offsets to
      // the next, and the second lays the whole print at the wrong height.
      if ((hasAxis || w.E !== undefined) && !st.modeWarned &&
          (!st.sawG90 || (w.E !== undefined && !st.sawEMode))) {
        st.modeWarned = true;
        add(ERROR, 'mode.unset',
          'The file moves before it says whether coordinates are absolute or relative',
          lineNo, raw,
          'G90/G91 and M82/M83 survive between prints, so this file does whatever ' +
          'the last one left behind. Send them before the first move.');
      }
      // One move is not only allowed before homing but wanted: lifting Z. A bed
      // slinger homes X and Y first, and drags the nozzle across the plate from
      // wherever the last print left it — so the machine's own script raises Z
      // first, from a position the controller reads as zero. Going up from an
      // unknown height is the safe direction; anything else is not.
      var safeLift = !st.inBody && w.X === undefined && w.Y === undefined &&
        w.E === undefined && w.Z !== undefined && w.Z > 0 && st.absXYZ;
      if (hasAxis && !st.positionKnown && !safeLift) {
        add(ERROR, 'move.unhomed', 'The machine is moved before it has been homed', lineNo, raw,
          'The controller assumes it is at the origin, so this move can drive the head into the frame or the bed.');
        st.positionKnown = true;    // report once, then carry on simulating
      }

      var nx = st.x, ny = st.y, nz = st.z;
      if (st.absXYZ) {
        if (w.X !== undefined) nx = w.X;
        if (w.Y !== undefined) ny = w.Y;
        if (w.Z !== undefined) nz = w.Z;
      } else {
        if (w.X !== undefined) nx = (st.x || 0) + w.X;
        if (w.Y !== undefined) ny = (st.y || 0) + w.Y;
        if (w.Z !== undefined) nz = (st.z || 0) + w.Z;
      }

      // --- arcs ---
      // An arc is longer than its chord, and it can bulge outside the bed while
      // both of its endpoints sit comfortably inside it. Both matter.
      var isArc = (cmd === 'G2' || cmd === 'G3') && st.x !== null && st.y !== null &&
                  (w.I !== undefined || w.J !== undefined);
      var arcLen = 0, arcExtremes = null;
      if (isArc) {
        var arc = describeArc(cmd, w, st.x, st.y, nx, ny);
        arcLen = arc.length;
        arcExtremes = arc.extremes;
      }

      // G2/G3 is optional in both firmware families — a compile-time flag in
      // Marlin, the [gcode_arcs] section in Klipper — and a machine without it
      // does not ignore the command, it stops the print on the spot. Where the
      // machine's own vendor never sends one, neither may this file. Its own
      // start and end scripts are its business.
      if ((cmd === 'G2' || cmd === 'G3') && s.machineArcs === false &&
          st.inBody && !st.inEnd) {
        add(ERROR, 'arc.unsupported',
          'This machine is not sent arc moves by its own vendor, and ' + cmd +
          ' stops a printer whose firmware was built without them',
          lineNo, raw, 'Turn arc fitting off for this printer.');
      }

      // --- build volume ---
      if (arcExtremes) {
        for (var ae = 0; ae < arcExtremes.length; ae++) {
          checkPointInBed(arcExtremes[ae][0], arcExtremes[ae][1], lineNo, raw, true);
        }
      }
      // Only where the head actually goes somewhere: a Z-only or feed-only move
      // holds the last X/Y, and reporting it again says nothing new.
      if (nx !== null && ny !== null && bedX && bedY && (nx !== st.x || ny !== st.y)) {
        checkPointInBed(nx, ny, lineNo, raw, false);
      }
      if (nz !== null && bedZ) {
        // A wiper pad sits below the print surface on some machines, and their
        // own scripts go down to it. Only what the profile says it can reach.
        var zFloor = (!st.inBody || st.inEnd) ? Math.min(0, reachZ) : 0;
        if (nz < zFloor - 0.02) {
          add(ERROR, 'bounds.z.low', 'Move to Z' + round(nz) + ' is below the bed', lineNo, raw,
            'The nozzle would be pushed into the build surface.');
        } else if (nz > bedZ + MARGIN) {
          add(ERROR, 'bounds.z.high', 'Move to Z' + round(nz) + ' is above the ' + bedZ + ' mm maximum height', lineNo, raw);
        }
      }

      // --- Z axis speed ---
      // A layer change sent at XY travel speed asks a leadscrew for something it
      // cannot deliver. Firmware usually clamps it; where it does not, the axis
      // loses steps and every later layer is printed at the wrong height.
      // Not inside the machine's own start and end scripts: those park and
      // present at feedrates the firmware clamps to the axis, and the numbers
      // are the machine maker's to choose. Inside the print they are ours.
      if (nz !== null && st.z !== null && st.feed > 0 && st.inBody && !st.inEnd) {
        var dz = Math.abs(nz - st.z);
        if (dz > 0.001) {
          var dxy = Math.hypot((nx || 0) - (st.x || 0), (ny || 0) - (st.y || 0));
          var moveLen = Math.hypot(dxy, dz);
          var zSpeed = (st.feed / 60) * (dz / moveLen);
          if (zSpeed > maxZSpeed * 3) {
            add(ERROR, 'z.speed.high',
              'The Z axis is commanded at ' + zSpeed.toFixed(0) + ' mm/s, against a ' + maxZSpeed + ' mm/s limit',
              lineNo, raw, 'Far beyond what the axis can follow; it will lose steps and the print shifts.');
          } else if (zSpeed > maxZSpeed * 1.2) {
            add(WARN, 'z.speed.warn',
              'The Z axis is commanded at ' + zSpeed.toFixed(0) + ' mm/s, above its ' + maxZSpeed + ' mm/s limit',
              lineNo, raw);
          }
        }
      }

      // --- sweeping across the finished print ---
      // Collected as we go and cleared on every extrusion, so what is left at the
      // end of the file is exactly the moves made after the last one.
      if (st.extruded && w.E === undefined && st.printedBox && nx !== null && ny !== null) {
        var travel = Math.hypot(nx - (st.x || 0), ny - (st.y || 0));
        var clear = nz !== null && nz > st.printedTopZ + 0.5;
        if (travel > 5 && !clear && segmentHitsBox(st.x, st.y, nx, ny, st.printedBox)) {
          if (st.pendingSweeps.length < 20) {
            st.pendingSweeps.push({ line: lineNo, text: raw, z: nz });
          }
        }
      }

      // --- driving into something already printed ---
      // With one object printed at a time, everything finished earlier is a
      // solid obstacle. Any move that crosses one at or below its own height
      // ends with the head in the part, so this is an error, not a warning.
      if (st.finishedObjects.length && nx !== null && ny !== null && st.x !== null) {
        for (var fo = 0; fo < st.finishedObjects.length; fo++) {
          var obst = st.finishedObjects[fo];
          if (nz !== null && nz > obst.topZ + 0.2) continue;
          if (st.z !== null && st.z > obst.topZ + 0.2 && (nz === null || nz > obst.topZ + 0.2)) continue;
          if (!segmentHitsBox(st.x, st.y, nx, ny, obst.box)) continue;
          if (st.collisionsReported++ < 5) {
            add(ERROR, 'sequence.collision',
              'The head crosses ' + obst.name + ' at Z' +
              (nz === null ? st.z : nz) + ', below its finished height of ' +
              obst.topZ.toFixed(2) + ' mm',
              lineNo, raw,
              'That object is already printed and standing on the plate. This move ' +
              'drives the nozzle straight into it. Move the objects further apart, ' +
              'or print by layer instead of one at a time.');
          }
          break;
        }
      }

      // --- extrusion ---
      var deltaE = 0;
      if (w.E !== undefined) {
        deltaE = st.absE ? w.E - st.e : w.E;
        st.e = st.absE ? w.E : st.e + w.E;

        // Filament only counts as laid down when the head also moved. An E-only
        // advance is a de-retraction putting back what a retraction pulled out;
        // counting those as extrusion inflates the total by 0.8 mm every travel.
        var laysMaterial = Math.hypot((nx || 0) - (st.x || 0), (ny || 0) - (st.y || 0)) > 1e-6;

        if (deltaE > 0) {
          counts.extrusions++;
          if (laysMaterial) {
            st.totalE += deltaE;
            if (st.inBody) st.bodyE += deltaE;
          }
          st.pendingSweeps.length = 0;   // anything before this is not the end

          // A freshly swapped-in tool is full of the previous colour, so the
          // first thing it lays has to be the purge — anywhere but the model.
          // A de-retraction is not printing: it only puts back what a retraction
          // pulled out, and the head has not moved.
          if (st.pendingPurge && laysMaterial) {
            var need = Math.max(0, (s.purgeVolume || 0)) /
                       (Math.PI * Math.pow((s.filamentDiameter || 1.75) / 2, 2));
            if (need <= 0) {
              st.pendingPurge = null;
            } else if (st.featureType === 'prime tower') {
              st.pendingPurge.extruded += deltaE;
              if (st.pendingPurge.extruded >= need * 0.5) st.pendingPurge = null;
            } else if (!st.purgeWarned) {
              st.purgeWarned = true;
              add(WARN, 'tool.purge.missing',
                'T' + st.pendingPurge.tool + ' starts printing on the model after only ' +
                (st.pendingPurge.extruded * Math.PI * Math.pow((s.filamentDiameter || 1.75) / 2, 2))
                  .toFixed(1) + ' mm\u00b3 of purge',
                lineNo, raw,
                'The hotend still holds the previous colour. Expect it to bleed into the ' +
                'first part of this feature. A prime tower large enough for ' +
                (s.purgeVolume || 0) + ' mm\u00b3 per change fixes it.');
              st.pendingPurge = null;
            }
          }

          if (nx !== null && ny !== null) {
            if (!st.printedBox) st.printedBox = { minX: nx, maxX: nx, minY: ny, maxY: ny };
            st.printedBox.minX = Math.min(st.printedBox.minX, nx, st.x === null ? nx : st.x);
            st.printedBox.maxX = Math.max(st.printedBox.maxX, nx, st.x === null ? nx : st.x);
            st.printedBox.minY = Math.min(st.printedBox.minY, ny, st.y === null ? ny : st.y);
            st.printedBox.maxY = Math.max(st.printedBox.maxY, ny, st.y === null ? ny : st.y);
          }
          if (nz !== null) st.printedTopZ = Math.max(st.printedTopZ, nz);

          if (st.currentObject && nx !== null && ny !== null) {
            var ob = st.currentObject;
            var px = st.x === null ? nx : st.x, py = st.y === null ? ny : st.y;
            if (!ob.box) ob.box = { minX: nx, maxX: nx, minY: ny, maxY: ny };
            ob.box.minX = Math.min(ob.box.minX, nx, px);
            ob.box.maxX = Math.max(ob.box.maxX, nx, px);
            ob.box.minY = Math.min(ob.box.minY, ny, py);
            ob.box.maxY = Math.max(ob.box.maxY, ny, py);
            if (nz !== null) ob.topZ = Math.max(ob.topZ, nz);
          }

          if (st.pendingTempChange && !st.tempChangeWarned) {
            var tc = st.pendingTempChange;
            add(WARN, 'temp.step.nowait',
              'The nozzle target jumps from ' + tc.from + ' °C to ' + tc.to + ' °C and printing carries on without waiting',
              tc.line, tc.text,
              'The next layers are printed somewhere on the ramp between the two temperatures. Use M109 to wait.');
            st.tempChangeWarned = true;
            st.pendingTempChange = null;
          }

          if (!st.hotendReady) {
            add(st.macroSeen ? WARN : ERROR, 'extrude.cold',
              'Filament is extruded before the nozzle is known to be at temperature',
              lineNo, raw, st.macroSeen
                ? 'A macro was called earlier which may heat the nozzle — this could not be verified from the file.'
                : 'No M109 wait-for-temperature precedes this. Driving a cold extruder strips the filament and the drive gear.');
            st.hotendReady = true;   // report once
          }
          if (st.nozzleTarget < MIN_EXTRUDE_TEMP) {
            // A macro may have set the temperature out of sight. Say so plainly
            // rather than either crying wolf or waving it through.
            var unverifiable = st.macroSeen && st.nozzleTarget === 0;
            add(unverifiable ? WARN : ERROR, unverifiable ? 'extrude.temp.unverified' : 'extrude.cold.temp',
              unverifiable
                ? 'The nozzle temperature could not be read from this file'
                : 'Filament is extruded with the nozzle set to ' + st.nozzleTarget + ' °C',
              lineNo, raw, unverifiable
                ? 'It is set inside a firmware macro, so this check cannot confirm the nozzle is hot enough to extrude.'
                : 'Below about ' + MIN_EXTRUDE_TEMP + ' °C the filament does not melt; the extruder grinds it away.');
            st.nozzleTarget = MIN_EXTRUDE_TEMP;   // report once
          }

          // A machine's own script charges the nozzle before it prints: tens of
          // millimetres pushed through standing still is what a prime is. In the
          // print it is a fault. Either way an absurd figure is one.
          var priming = !st.inBody || st.inEnd;
          if (deltaE > 50) {
            add(ERROR, 'extrude.huge', 'A single move extrudes ' + round(deltaE) + ' mm of filament', lineNo, raw,
              'This is far more than any real move needs and points at a generator fault.');
          } else if (deltaE > 20 && !priming) {
            add(WARN, 'extrude.large', 'A single move extrudes ' + round(deltaE) + ' mm of filament', lineNo, raw);
          }

          // Volumetric rate — of a printing move. A prime is deliberately not
          // one: it pushes filament out with the head barely moving.
          var dist = arcLen > 0 ? arcLen : distance(st.x, st.y, st.z, nx, ny, nz);
          if (maxVolumetric > 0 && dist > 0.1 && st.feed > 0 && !priming) {
            var rate = (deltaE * filamentArea) / (dist / (st.feed / 60));
            if (rate > maxVolumetric * 2.5) {
              add(ERROR, 'flow.high', 'This move asks for ' + rate.toFixed(1) + ' mm³/s, against a ' + maxVolumetric + ' mm³/s limit',
                lineNo, raw, 'The extruder cannot keep up; it will skip and grind.');
            } else if (rate > maxVolumetric * 1.3) {
              add(WARN, 'flow.warn', 'This move asks for ' + rate.toFixed(1) + ' mm³/s, above the ' + maxVolumetric + ' mm³/s limit', lineNo, raw);
            }
          }

          if (nz !== null) {
            if (st.inBody && st.extruded && nz < st.lastExtrudeZ - 0.02) {
              add(WARN, 'z.backwards', 'Extruding at Z' + round(nz) + ' after already printing at Z' + round(st.lastExtrudeZ), lineNo, raw,
                'The nozzle is being driven back down into material it has already laid.');
            }
            st.lastExtrudeZ = Math.max(st.lastExtrudeZ, nz);
          }
          st.extruded = true;
          st.lastExtrudeLine = lineNo;

        } else if (deltaE < -50) {
          add(ERROR, 'retract.huge', 'A single move retracts ' + round(-deltaE) + ' mm of filament', lineNo, raw,
            'This would pull filament clear out of the hotend.');
        }
      }

      st.x = nx; st.y = ny; st.z = nz;
    }

    function checkPointInBed(px, py, lineNo, raw, isArcPoint) {
      if (px === null || py === null || !bedX || !bedY) return;
      var where = isArcPoint ? 'The arc passes through X' : 'Move to X';
      // Before the first layer and after the last, the file is running the
      // machine's own start and end scripts, and plenty of machines use room
      // the print area does not have: Elegoo purges on the lip in front of the
      // plate and slides the bed out past its own front edge to present the
      // part. That is the profile doing its job — worth saying, not worth
      // refusing. A gross excursion is still a crash either way.
      var vendor = !st.inBody || st.inEnd;
      // Where the profile states the machine's reach, that is the answer inside
      // its own scripts: within it, nothing to say; outside it, a crash.
      if (vendor && reach) {
        if (px < reach[0] - MARGIN || px > reach[2] + MARGIN ||
            py < reach[1] - MARGIN || py > reach[3] + MARGIN) {
          add(ERROR, 'bounds.xy',
            where + round(px) + ' Y' + round(py) + ', outside what this machine can reach (X ' +
            round(reach[0]) + '–' + round(reach[2]) + ', Y ' + round(reach[1]) + '–' + round(reach[3]) + ')',
            lineNo, raw, 'The head would be driven into the frame or an end stop.');
        }
        return;
      }
      var slack = vendor ? VENDOR_MARGIN : MARGIN;
      var sev = vendor ? WARN : ERROR;
      var code = vendor ? 'bounds.xy.script' : 'bounds.xy';
      if (circular) {
        var cx = centre ? 0 : bedX / 2, cy = centre ? 0 : bedY / 2;
        var r = Math.hypot(px - cx, py - cy);
        if (r > radius + MARGIN) {
          if (r > radius + slack) { sev = ERROR; code = 'bounds.xy'; }
          add(sev, code,
            where + round(px) + ' Y' + round(py) + ', ' + round(r - radius) + ' mm outside the ' + round(radius * 2) + ' mm plate',
            lineNo, raw);
        }
      } else if (px < minX - MARGIN || px > maxX + MARGIN || py < minY - MARGIN || py > maxY + MARGIN) {
        if (px < minX - slack || px > maxX + slack || py < minY - slack || py > maxY + slack) {
          sev = ERROR; code = 'bounds.xy';
        }
        add(sev, code,
          where + round(px) + ' Y' + round(py) + ', outside the bed (X ' + round(minX) + '–' + round(maxX) + ', Y ' + round(minY) + '–' + round(maxY) + ')',
          lineNo, raw, sev === ERROR
            ? 'The head would be driven into the frame or an end stop.'
            : 'Normal for a machine that purges or presents off the print area; check it against yours.');
      }
    }

    /**
     * Arc length, and the cardinal points of the circle the arc actually reaches
     * — those are where it can leave the bed without either endpoint doing so.
     */
    function describeArc(cmd, w, x0, y0, x1, y1) {
      var ccx = x0 + (w.I || 0), ccy = y0 + (w.J || 0);
      var r = Math.hypot(w.I || 0, w.J || 0);
      if (!(r > 0)) return { length: Math.hypot(x1 - x0, y1 - y0), extremes: null };

      var a0 = Math.atan2(y0 - ccy, x0 - ccx);
      var a1 = Math.atan2(y1 - ccy, x1 - ccx);
      var clockwise = cmd === 'G2';
      var sweep = clockwise ? a0 - a1 : a1 - a0;
      while (sweep <= 1e-9) sweep += 2 * Math.PI;

      var extremes = [];
      for (var k = 0; k < 4; k++) {
        var angle = k * Math.PI / 2;
        var delta = clockwise ? a0 - angle : angle - a0;
        while (delta < 0) delta += 2 * Math.PI;
        if (delta <= sweep) extremes.push([ccx + Math.cos(angle) * r, ccy + Math.sin(angle) * r]);
      }
      return { length: r * sweep, extremes: extremes.length ? extremes : null };
    }

    function checkNozzle(temp, lineNo, raw) {
      if (temp > maxNozzle) {
        add(ERROR, 'temp.nozzle.high',
          'Nozzle is commanded to ' + temp + ' °C, above this printer’s ' + maxNozzle + ' °C limit',
          lineNo, raw, 'Overheating a hotend melts PTFE liners and can start a fire.');
      }
    }

    function checkBed(temp, lineNo, raw) {
      if (temp > maxBed) {
        add(ERROR, 'temp.bed.high',
          'Bed is commanded to ' + temp + ' °C, above this printer’s ' + maxBed + ' °C limit',
          lineNo, raw, 'Most beds and their adhesives are not rated above this.');
      }
    }

    function checkChamber(temp, lineNo, raw) {
      if (temp > maxChamber) {
        add(ERROR, 'temp.chamber.high',
          'Chamber is commanded to ' + temp + ' °C, above the ' + maxChamber + ' °C limit', lineNo, raw);
      }
    }

    /** Slab test: does the segment touch the axis-aligned box at all? */
    function segmentHitsBox(x0, y0, x1, y1, box) {
      if (x0 === null || y0 === null) return false;
      var dx = x1 - x0, dy = y1 - y0;
      var t0 = 0, t1 = 1;
      var slabs = [[dx, box.minX - x0, box.maxX - x0], [dy, box.minY - y0, box.maxY - y0]];
      for (var i = 0; i < 2; i++) {
        var d = slabs[i][0], lo = slabs[i][1], hi = slabs[i][2];
        if (Math.abs(d) < 1e-9) {
          if (lo > 0 || hi < 0) return false;      // parallel and outside the slab
          continue;
        }
        var a = lo / d, b = hi / d;
        if (a > b) { var tmp = a; a = b; b = tmp; }
        if (a > t0) t0 = a;
        if (b < t1) t1 = b;
        if (t0 > t1) return false;
      }
      return true;
    }

    function distance(x0, y0, z0, x1, y1, z1) {
      if (x0 === null || y0 === null) return 0;
      return Math.hypot((x1 || 0) - x0, (y1 || 0) - y0, (z1 || 0) - (z0 || 0));
    }

    function round(v) { return Math.round(v * 100) / 100; }
  }

  root.OrcaGcodeCheck = { verify: verify, parseLine: parseLine, DANGEROUS: DANGEROUS };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.OrcaGcodeCheck;
})(typeof globalThis !== 'undefined' ? globalThis : self);
