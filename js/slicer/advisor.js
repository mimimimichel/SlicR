/**
 * Orca Web Slicer — Advisor.
 *
 * Reads the geometry that was loaded and the machine it is going to be printed
 * on, and proposes the handful of settings that this particular combination
 * wants changed. Every proposal has to come from something measured on the
 * mesh — an area, a ratio, a height — and carries the measurement with it, so
 * the panel can say why rather than just what.
 *
 * Nothing here changes a setting. It returns a list; applying it is the user's.
 *
 * Loaded as a plain script (browser, worker) or required under Node for tests.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Measuring the mesh
  // ---------------------------------------------------------------------------

  /**
   * One pass over the triangles, collecting everything the rules below ask
   * about. Positions are a flat Float32Array of x,y,z per vertex, three
   * vertices per triangle, already in plate coordinates.
   *
   * @param {ArrayLike<number>} positions
   * @param {{overhangThreshold?: number}} [opts]
   */
  function measure(positions, opts) {
    opts = opts || {};
    // The angle a wall may lean from vertical before it is an overhang. The
    // same number the support generator uses, so the two agree about what is
    // unsupported.
    var threshold = opts.overhangThreshold != null ? opts.overhangThreshold : 55;
    var sinLimit = Math.sin(threshold * Math.PI / 180);

    var n = positions ? positions.length : 0;
    var shape = {
      triangles: 0,
      min: { x: Infinity, y: Infinity, z: Infinity },
      max: { x: -Infinity, y: -Infinity, z: -Infinity },
      size: { x: 0, y: 0, z: 0 },
      volume: 0, area: 0,
      overhangArea: 0, ceilingArea: 0, bedArea: 0, flatTopArea: 0, verticalArea: 0,
      edges: [],
      medianEdge: 0,
      empty: true
    };
    if (n < 9) return shape;

    var i;
    for (i = 0; i + 2 < n; i += 3) {
      var x = positions[i], y = positions[i + 1], z = positions[i + 2];
      if (x < shape.min.x) shape.min.x = x;
      if (y < shape.min.y) shape.min.y = y;
      if (z < shape.min.z) shape.min.z = z;
      if (x > shape.max.x) shape.max.x = x;
      if (y > shape.max.y) shape.max.y = y;
      if (z > shape.max.z) shape.max.z = z;
    }
    shape.size.x = shape.max.x - shape.min.x;
    shape.size.y = shape.max.y - shape.min.y;
    shape.size.z = shape.max.z - shape.min.z;
    shape.empty = false;

    var zFloor = shape.min.z;
    var edges = [];
    for (i = 0; i + 8 < n; i += 9) {
      var ax = positions[i], ay = positions[i + 1], az = positions[i + 2];
      var bx = positions[i + 3], by = positions[i + 4], bz = positions[i + 5];
      var cx = positions[i + 6], cy = positions[i + 7], cz = positions[i + 8];

      // Cross product of two edges: its length is twice the triangle's area and
      // its direction is the outward normal.
      var ux = bx - ax, uy = by - ay, uz = bz - az;
      var vx = cx - ax, vy = cy - ay, vz = cz - az;
      var nx = uy * vz - uz * vy;
      var ny = uz * vx - ux * vz;
      var nz = ux * vy - uy * vx;
      var twice = Math.hypot(nx, ny, nz);
      if (!(twice > 0)) continue;              // degenerate, contributes nothing
      var area = twice / 2;
      shape.triangles++;
      shape.area += area;

      // Signed volume of the tetrahedron on the origin. Summed over a closed
      // mesh these cancel to the enclosed volume.
      shape.volume += (ax * (by * cz - bz * cy) -
                       ay * (bx * cz - bz * cx) +
                       az * (bx * cy - by * cx)) / 6;

      var up = nz / twice;                     // vertical component of the unit normal
      var onPlate = az - zFloor < 0.05 && bz - zFloor < 0.05 && cz - zFloor < 0.05;

      if (up > 0.98) shape.flatTopArea += area;
      if (Math.abs(up) < 0.02) shape.verticalArea += area;
      if (up < 0) {
        if (onPlate) shape.bedArea += area;
        else {
          // Leaning past the threshold, with nothing under it.
          if (-up > sinLimit) shape.overhangArea += area;
          // And the part of that which is a flat ceiling, where a bridge has
          // nothing to anchor to at either end.
          if (-up > 0.95) shape.ceilingArea += area;
        }
      }

      edges.push(Math.hypot(ux, uy, uz), Math.hypot(vx, vy, vz),
        Math.hypot(cx - bx, cy - by, cz - bz));
    }

    shape.volume = Math.abs(shape.volume);
    if (edges.length) {
      edges.sort(function (a, b) { return a - b; });
      shape.medianEdge = edges[edges.length >> 1];
    }
    // Twice the volume over the surface is the thickness of a slab with those
    // two figures — a fair proxy for how solid the thing is. A block gives back
    // something near its smallest side; a hollow shell gives back its wall.
    shape.thickness = shape.area > 0 ? 2 * shape.volume / shape.area : 0;
    shape.footprint = Math.max(shape.size.x, shape.size.y);
    shape.tallness = shape.footprint > 0 ? shape.size.z / shape.footprint : 0;
    // What one layer of it looks like on average, which is what decides whether
    // a layer has time to cool before the next one lands on it.
    shape.layerArea = shape.size.z > 0 ? shape.volume / shape.size.z : 0;
    return shape;
  }

  // ---------------------------------------------------------------------------
  // Proposing settings
  // ---------------------------------------------------------------------------

  function get(s, path) {
    return path.split('.').reduce(function (o, k) { return o == null ? o : o[k]; }, s);
  }

  function mm2(a) {
    return a >= 10000 ? (a / 100).toFixed(0) + ' cm²' : a.toFixed(0) + ' mm²';
  }

  var WARPS = { abs: 1, abs_cf: 1, asa: 1, pa: 1, pa_cf: 1, pc: 1, pp: 1 };

  /**
   * A proposal, or nothing when the setting is already where it would put it.
   * Shared by every rule below: one shape in, one shape out, so the panel and
   * the tests only ever deal with one kind of thing.
   */
  function proposer(s, out) {
    return function (key, value, label, why, kind) {
      var from = get(s, key);
      if (from === value) return;
      if (typeof from === 'number' && typeof value === 'number' &&
          Math.abs(from - value) < 1e-9) return;
      out.push({ key: key, value: value, from: from, label: label, why: why,
        kind: kind || 'quality' });
    };
  }

  /** Two decimals, because a setting nobody can type is no use to anyone. */
  function round2(v) { return Math.round(v * 100) / 100; }

  /** The section of one extruded bead: a rounded rectangle, not a rectangle. */
  function crossSection(w, h) {
    if (w <= h) return Math.PI * (w / 2) * (h / 2);
    return h * (w - h) + Math.PI * (h / 2) * (h / 2);
  }

  /**
   * @param {object} shape   from measure()
   * @param {object} s       the full settings object
   * @returns {Array<{key,value,from,label,why,kind}>}
   */
  function advise(shape, s) {
    var out = [];
    if (!shape || shape.empty || !s) return out;

    var propose = proposer(s, out);

    var nozzle = s.nozzle || 0.4;
    var warps = !!WARPS[s.filamentKey];
    var slinger = s.kinematics === 'bedslinger';

    // --- what will not print at all -----------------------------------------

    // Detail finer than the nozzle can lay is not a setting to tune, it is a
    // fact to know about before the part comes out missing pieces.
    if (shape.thickness > 0 && shape.thickness < nozzle * 0.9) {
      out.push({ key: null, label: 'Thinner than the nozzle',
        why: 'The model averages ' + shape.thickness.toFixed(2) + ' mm thick against a ' +
          nozzle + ' mm nozzle. Whatever is thinner than one line will be dropped; a ' +
          'smaller nozzle is the only real fix.',
        kind: 'warning' });
    }
    if (shape.size.z > s.bedZ) {
      out.push({ key: null, label: 'Taller than the machine',
        why: 'The model stands ' + shape.size.z.toFixed(0) + ' mm against ' + s.bedZ +
          ' mm of travel. It has to be cut or scaled.',
        kind: 'warning' });
    }

    // --- support ------------------------------------------------------------

    // Measured against the whole surface, because a small percentage of a large
    // model is still a large unsupported area.
    var overhangShare = shape.area > 0 ? shape.overhangArea / shape.area : 0;
    if (!s.supportEnable && shape.overhangArea > 100 && overhangShare > 0.02) {
      propose('supportEnable', true, 'Turn supports on',
        mm2(shape.overhangArea) + ' of the surface leans more than ' + s.supportThreshold +
        '° from vertical with nothing underneath' +
        (shape.ceilingArea > 50 ? ', ' + mm2(shape.ceilingArea) + ' of it flat ceiling' : '') +
        '. Without support that is printed into air.', 'reliability');

      // A tall part standing on very little has more to lose from support stuck
      // to its sides than from the overhang itself.
      if (s.supportStyle !== 'tree' && shape.tallness > 2.5) {
        propose('supportStyle', 'tree', 'Tree supports rather than normal',
          'The part is ' + shape.tallness.toFixed(1) + ' times taller than it is wide. ' +
          'Branches reach the overhangs while touching far less of it.', 'quality');
      }
    }

    // --- staying on the plate ----------------------------------------------

    // Leverage: a tall part on a small footprint is a lever with the first layer
    // as its only anchor, and the head knocks it every pass.
    var leverage = shape.bedArea > 0 ? shape.size.z * shape.size.z / shape.bedArea : 0;
    if (s.adhesion === 'skirt' && (leverage > 4 || (warps && shape.bedArea > 5000))) {
      propose('adhesion', 'brim', 'A brim rather than a skirt',
        leverage > 4
          ? 'The part stands ' + shape.size.z.toFixed(0) + ' mm on ' + mm2(shape.bedArea) +
            ' of plate. A brim widens what is holding it down.'
          : (s.filamentKey || '').toUpperCase() + ' pulls its corners up as it cools, and ' +
            'this one covers ' + mm2(shape.bedArea) + ' of plate.', 'reliability');
    }

    // --- cooling ------------------------------------------------------------

    // A small part comes back round to the same spot before the last line has
    // set, and prints into something still soft.
    if (shape.layerArea > 0 && shape.layerArea < 400 && s.minLayerTime < 10) {
      propose('minLayerTime', 10, 'Give each layer longer to cool',
        'Layers average ' + mm2(shape.layerArea) + '. At full speed that is a second or two ' +
        'each, and the next one lands on plastic that has not set.', 'quality');
    }

    // --- surface ------------------------------------------------------------

    var topShare = shape.area > 0 ? shape.flatTopArea / shape.area : 0;
    if (s.ironing === 'none' && topShare > 0.15 && shape.flatTopArea > 400) {
      propose('ironing', 'top', 'Iron the top surfaces',
        mm2(shape.flatTopArea) + ' of this model is flat and facing up — ' +
        (topShare * 100).toFixed(0) + '% of its surface. Ironing is what makes that ' +
        'look finished rather than striped.', 'quality');
    }

    // --- layer height -------------------------------------------------------

    // Detail the current layer height cannot resolve. Triangle size is a fair
    // stand-in: a model tessellated in tenths of a millimetre has features that
    // small, and one drawn in centimetres does not.
    if (shape.medianEdge > 0 && shape.medianEdge < 0.6 && s.layerHeight > 0.14 &&
        shape.size.z < 60) {
      propose('layerHeight', 0.12, 'Thinner layers',
        'The mesh is drawn in ' + shape.medianEdge.toFixed(2) + ' mm triangles on a part ' +
        shape.size.z.toFixed(0) + ' mm tall. At ' + s.layerHeight + ' mm most of that ' +
        'detail falls between layers.', 'quality');
    } else if (shape.volume > 150000 && shape.medianEdge > 2 && s.layerHeight < 0.28 &&
               nozzle >= 0.4) {
      propose('layerHeight', 0.28, 'Thicker layers',
        (shape.volume / 1000).toFixed(0) + ' cm³ of plain geometry. At ' + s.layerHeight +
        ' mm this is a long print for detail the model does not have.', 'time');
    }

    // --- the machine --------------------------------------------------------

    // A bed slinger throws the plate back and forth under the head. A tall part
    // is a mass on the end of that lever, and the acceleration is what shakes
    // it — ringing on the walls, and at the extreme a part that comes off.
    if (slinger && shape.tallness > 3 && shape.size.z > 60 && s.maxAccel > 2000) {
      propose('maxAccel', 2000, 'Hold the acceleration down',
        'This machine moves the bed, and the part is ' + shape.size.z.toFixed(0) +
        ' mm tall on a ' + shape.footprint.toFixed(0) + ' mm footprint. ' + s.maxAccel +
        ' mm/s² of it swinging back and forth shows up in the walls.', 'quality');
    }

    // A heated chamber is what keeps the styrenes from splitting layer to layer,
    // and it is off by default because most machines do not have one.
    if (warps && s.maxChamberTemp > 0 && !s.chamberTemp && shape.size.z > 40) {
      propose('chamberTemp', Math.min(50, s.maxChamberTemp), 'Warm the chamber',
        (s.filamentKey || '').toUpperCase() + ' splits between layers as it cools, and this ' +
        'part is ' + shape.size.z.toFixed(0) + ' mm tall. This machine has a chamber heater.',
        'reliability');
    }

    // Room around the part, when the machine has been asked to print one object
    // at a time and the head has to come back down beside a finished one.
    if (s.printSequence === 'object' && shape.size.z > s.extruderClearanceHeight) {
      out.push({ key: null, label: 'One at a time needs the room',
        why: 'The part is ' + shape.size.z.toFixed(0) + ' mm tall, past the ' +
          s.extruderClearanceHeight + ' mm the gantry clears. Anything printed after it ' +
          'has to stay ' + s.extruderClearanceRadius + ' mm away.',
        kind: 'warning' });
    }

    return out;
  }

  // ---------------------------------------------------------------------------
  // The profile on its own
  // ---------------------------------------------------------------------------

  /**
   * What is wrong with these settings whatever the model turns out to be.
   *
   * Everything here comes from a ratio the printer cannot argue with — a layer
   * against the nozzle that laid it, a wall against the line it is made of, a
   * speed against the plastic that has to melt to reach it. None of it needs
   * the mesh, so it can be shown the moment a profile is picked, and it is the
   * same arithmetic whichever printer is chosen.
   *
   * @param {object} s   the full settings object
   * @returns {Array<{key,value,from,label,why,kind}>}
   */
  function review(s) {
    var out = [];
    if (!s) return out;
    var propose = proposer(s, out);
    var nozzle = s.nozzle || 0.4;
    var stock = (root.OrcaPresets && root.OrcaPresets.FILAMENTS &&
                 root.OrcaPresets.FILAMENTS[s.filamentKey]) || null;

    // --- what one layer can hold on to --------------------------------------

    // Three quarters of the nozzle is where every slicer puts the ceiling. Past
    // it the new bead sits on too little of the one below to key into, and the
    // part splits along the lines under any load at all.
    var ceiling = round2(nozzle * 0.75);
    if (s.layerHeight > ceiling + 1e-9) {
      propose('layerHeight', ceiling, 'Layers too thick for this nozzle',
        s.layerHeight + ' mm out of a ' + nozzle + ' mm nozzle is ' +
        Math.round(100 * s.layerHeight / nozzle) + '% of its width. Past three quarters ' +
        'there is too little of the layer below for the new one to key into, and the ' +
        'part comes apart along the lines.', 'reliability');
    }
    // A first layer thicker than the nozzle cannot be pressed into the plate:
    // there is more plastic coming out than the gap can hold.
    if (s.firstLayerHeight > nozzle + 1e-9) {
      propose('firstLayerHeight', ceiling, 'First layer thicker than the nozzle',
        s.firstLayerHeight + ' mm through a ' + nozzle + ' mm nozzle leaves the bead ' +
        'nothing to be squashed against. The first layer sticks because it is pressed ' +
        'into the plate, and this one is not.', 'reliability');
    }

    // --- what a line is made of ---------------------------------------------

    if (s.lineWidth < nozzle - 1e-9) {
      propose('lineWidth', round2(nozzle * 1.05), 'Lines narrower than the nozzle',
        'A ' + nozzle + ' mm nozzle cannot lay a ' + s.lineWidth + ' mm line. Asking for ' +
        'one gives thin walls and gaps between them, because the bead comes out its own ' +
        'width whatever the file says.', 'reliability');
    } else if (s.lineWidth > nozzle * 1.6) {
      propose('lineWidth', round2(nozzle * 1.2), 'Lines much wider than the nozzle',
        s.lineWidth + ' mm from a ' + nozzle + ' mm nozzle is ' +
        (s.lineWidth / nozzle).toFixed(1) + ' times its width. The bead has to spread ' +
        'sideways to get there, which it does unevenly.', 'quality');
    }

    // --- how much material is between the inside and the outside ------------

    var top = (s.topLayers || 0) * s.layerHeight;
    if (s.topLayers > 0 && top < 0.6 && !s.spiralVase) {
      propose('topLayers', Math.ceil(0.8 / s.layerHeight), 'Not enough on top',
        s.topLayers + ' layers of ' + s.layerHeight + ' mm is ' + round2(top) + ' mm of ' +
        'roof over the infill. Under about 0.8 mm it dips between the lines below it — ' +
        'the pillowing that makes a top look like a mattress.', 'quality');
    }
    var bottom = (s.bottomLayers || 0) * s.layerHeight;
    if (s.bottomLayers > 0 && bottom < 0.5 && !s.spiralVase) {
      propose('bottomLayers', Math.ceil(0.6 / s.layerHeight), 'Not enough underneath',
        round2(bottom) + ' mm of floor. It is what the whole part stands on while it is ' +
        'being printed, and it is thinner than a fingernail.', 'reliability');
    }
    var wall = s.wallLoops > 0
      ? (s.externalLineWidth || s.lineWidth) + (s.wallLoops - 1) * s.lineWidth : 0;
    if (s.wallLoops > 0 && wall < 0.8 && !s.spiralVase) {
      propose('wallLoops', Math.max(2, Math.ceil(0.9 / s.lineWidth)), 'Walls too thin to hold',
        s.wallLoops + ' loop' + (s.wallLoops > 1 ? 's' : '') + ' makes a ' + round2(wall) +
        ' mm wall. That is the whole strength of the part in the direction it is weakest.',
        'reliability');
    }
    // A roof needs something to be built over.
    if (s.infillDensity < 5 && s.topLayers > 0 && !s.spiralVase) {
      propose('infillDensity', 10, 'Solid tops over nothing',
        'The top is ' + s.topLayers + ' solid layers with ' + s.infillDensity + '% infill ' +
        'under them. The first of those layers is printed across open space and falls into ' +
        'it.', 'reliability');
    }

    // --- speeds nothing will honour -----------------------------------------

    // The firmware holds a move to the machine's maximum whatever the file
    // asks, so a profile above it is only a wrong estimate. Ours are capped
    // when they are built; this catches a number typed by hand.
    if (s.maxSpeed > 0 && s.speeds) {
      var over = [];
      for (var j in s.speeds) {
        if (Object.prototype.hasOwnProperty.call(s.speeds, j) && s.speeds[j] > s.maxSpeed) {
          over.push(j);
        }
      }
      if (over.length) {
        out.push({ key: null, label: 'Speeds past what the machine allows',
          why: over.length + ' of the speeds are above the ' + s.maxSpeed + ' mm/s this ' +
            'machine is set to, starting with ' + over[0].replace(/([A-Z])/g, ' $1').toLowerCase() +
            '. The firmware holds them there whatever the file asks for.',
          kind: 'time' });
      }
    }

    // --- support that cannot be taken off -----------------------------------

    if (s.supportEnable && s.supportZGap < s.layerHeight * 0.5) {
      propose('supportZGap', round2(s.layerHeight), 'Support welded to the part',
        s.supportZGap + ' mm between the support and what it holds, on ' + s.layerHeight +
        ' mm layers. Below about half a layer the two fuse and the support has to be cut ' +
        'off rather than lifted off.', 'quality');
    }

    // --- the fan, against what this plastic wants ---------------------------

    if (stock) {
      if (stock.fanSpeed >= 80 && s.fanSpeed < stock.fanSpeed - 30) {
        propose('fanSpeed', stock.fanSpeed, 'More air for this filament',
          stock.name + ' sets at ' + stock.fanSpeed + '% and this profile runs ' + s.fanSpeed +
          '%. Without the air an overhang droops and a small layer never sets before the ' +
          'next one lands on it.', 'quality');
      } else if (stock.fanSpeed <= 25 && s.fanSpeed > stock.fanSpeed + 25) {
        propose('fanSpeed', stock.fanSpeed, 'Less air for this filament',
          stock.name + ' shrinks as it cools, and cooling it fast is what splits it layer ' +
          'from layer. It sets at ' + stock.fanSpeed + '%; this profile runs ' + s.fanSpeed + '%.',
          'reliability');
      }
    }

    return out;
  }

  // ---------------------------------------------------------------------------
  // The plate, as it is arranged
  // ---------------------------------------------------------------------------

  /**
   * What is wrong with where the models are standing.
   *
   * Two solids in the same place are printed as one — every slicer unions
   * them, and that is the right answer — but a person who loaded two models
   * and got one object's worth of plastic deserves to be told which two, and
   * by how much. The same pass catches a part hanging off the plate, which the
   * G-code check will refuse later and is better said now.
   *
   * Boxes, not meshes: a bounding box is conservative, so the overlap is
   * reported as the share of the smaller box that the two have in common and
   * only when that share is large enough to be a real intersection rather than
   * two shapes standing close.
   *
   * @param {Array<{name?:string, bbox?:{min:{x,y,z}, max:{x,y,z}}}>} models
   * @param {object} s   the full settings object
   */
  function plateNotes(models, s) {
    var out = [];
    if (!models || models.length < 1 || !s) return out;

    var boxes = [];
    for (var i = 0; i < models.length; i++) {
      var m = models[i];
      if (!m || !m.bbox || !m.bbox.min || !m.bbox.max) continue;
      boxes.push({ name: m.name || ('model ' + (i + 1)), lo: m.bbox.min, hi: m.bbox.max });
    }

    // --- off the plate ------------------------------------------------------
    for (i = 0; i < boxes.length; i++) {
      var b = boxes[i];
      var off = b.lo.x < -0.01 || b.lo.y < -0.01 ||
                b.hi.x > s.bedX + 0.01 || b.hi.y > s.bedY + 0.01;
      if (off) {
        out.push({ key: null, label: 'Off the plate: ' + b.name,
          why: b.name + ' reaches ' + Math.round(b.lo.x) + '–' + Math.round(b.hi.x) + ' by ' +
            Math.round(b.lo.y) + '–' + Math.round(b.hi.y) + ' mm on a plate that is ' +
            s.bedX + ' by ' + s.bedY + '. The part of it that is outside cannot be printed, ' +
            'and the check will refuse the file rather than let the head go there.',
          kind: 'warning' });
      }
      if (b.hi.z > s.bedZ + 0.01) {
        out.push({ key: null, label: 'Taller than the machine: ' + b.name,
          why: b.name + ' stands ' + Math.round(b.hi.z) + ' mm against ' + s.bedZ +
            ' mm of travel.', kind: 'warning' });
      }
    }

    // --- in the same place --------------------------------------------------
    function span(a0, a1, b0, b1) { return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)); }
    for (i = 0; i < boxes.length; i++) {
      for (var j = i + 1; j < boxes.length; j++) {
        var a = boxes[i], c = boxes[j];
        var ox = span(a.lo.x, a.hi.x, c.lo.x, c.hi.x);
        var oy = span(a.lo.y, a.hi.y, c.lo.y, c.hi.y);
        var oz = span(a.lo.z, a.hi.z, c.lo.z, c.hi.z);
        if (ox <= 0 || oy <= 0 || oz <= 0) continue;
        var shared = ox * oy * oz;
        var volA = Math.max(1e-6, (a.hi.x - a.lo.x) * (a.hi.y - a.lo.y) * (a.hi.z - a.lo.z));
        var volC = Math.max(1e-6, (c.hi.x - c.lo.x) * (c.hi.y - c.lo.y) * (c.hi.z - c.lo.z));
        var share = shared / Math.min(volA, volC);
        if (share < 0.25) continue;
        out.push({ key: null, label: 'Two models in the same place',
          why: a.name + ' and ' + c.name + ' share ' + Math.round(share * 100) + '% of the ' +
            'space the smaller one occupies. They will be printed as one solid — which is ' +
            'what every slicer does with two shapes in the same place — so the file will ' +
            'hold less plastic than two parts, and neither will come out on its own.',
          kind: 'warning' });
      }
    }

    // Printing one at a time needs room between them, not just no overlap.
    if (s.printSequence === 'object' && boxes.length > 1) {
      for (i = 0; i < boxes.length; i++) {
        for (j = i + 1; j < boxes.length; j++) {
          var p = boxes[i], q = boxes[j];
          var gapX = Math.max(p.lo.x - q.hi.x, q.lo.x - p.hi.x);
          var gapY = Math.max(p.lo.y - q.hi.y, q.lo.y - p.hi.y);
          var gap = Math.max(gapX, gapY);
          var need = s.extruderClearanceRadius || 45;
          if (gap >= need) continue;
          out.push({ key: null, label: 'Too close to print one at a time',
            why: p.name + ' and ' + q.name + ' are ' + Math.max(0, Math.round(gap)) + ' mm ' +
              'apart, and the extruder sweeps ' + need + ' mm around whatever it is printing. ' +
              'Printing them one at a time means the head has to come back down beside a ' +
              'finished part.',
            kind: 'warning' });
        }
      }
    }

    return out;
  }

  // ---------------------------------------------------------------------------
  // What went wrong last time
  // ---------------------------------------------------------------------------

  /**
   * The faults somebody can see on a part they are holding, in their words
   * rather than a slicer's. Each one is answered by remedies() below with
   * changes worked out from the profile in front of it — never a fixed list,
   * because the right retraction for a machine already retracting 4 mm is not
   * the right retraction for one at 0.8.
   */
  var SYMPTOMS = [
    { key: 'stringing', label: 'Strings and whiskers',
      hint: 'Fine threads between the parts, or across a gap' },
    { key: 'blobs', label: 'Blobs and bumps',
      hint: 'A pimple where each loop starts or ends' },
    { key: 'firstlayer', label: 'The first layer will not stick',
      hint: 'Lines lifting, or the part coming loose' },
    { key: 'warping', label: 'Corners lifting off the plate',
      hint: 'The bottom curls up as the part gets taller' },
    { key: 'elephant', label: 'The bottom is wider than the rest',
      hint: 'A skirt of squashed plastic around the first layer' },
    { key: 'underextrusion', label: 'Gaps between the lines',
      hint: 'Thin walls, holes in the top, lines not touching' },
    { key: 'overextrusion', label: 'Too much plastic',
      hint: 'Rough walls, bulging corners, a part slightly too big' },
    { key: 'weak', label: 'The part broke along the layers',
      hint: 'It came apart where one layer meets the next' },
    { key: 'shift', label: 'The layers are offset',
      hint: 'Everything above a certain height is shifted sideways' },
    { key: 'pillowing', label: 'The top surface is rough',
      hint: 'Dips and holes over the infill, or a stripy finish' },
    { key: 'supports', label: 'The supports will not come off',
      hint: 'Welded to the part, or tearing the surface away' },
    { key: 'stutter', label: 'The head hesitates while printing',
      hint: 'It stops for a moment in the middle of a layer' }
  ];

  /** Keep a number inside a band, and to two decimals. */
  function clamp(v, lo, hi) { return round2(Math.max(lo, Math.min(hi, v))); }

  /**
   * What to change for one of those, given this profile.
   *
   * Every remedy is bounded: a temperature never moves more than 15 °C from
   * what the filament is sold as, a retraction never past 6 mm, a flow never
   * outside a tenth either way. A troubleshooter that walks a setting off the
   * end of its range over a few prints is worse than no troubleshooter.
   *
   * @param {string} key   one of SYMPTOMS
   * @param {object} s     the full settings object
   * @returns {Array<{key,value,from,label,why,kind}>}
   */
  function remedies(key, s) {
    var out = [];
    if (!s) return out;
    var propose = proposer(s, out);
    var nozzle = s.nozzle || 0.4;
    var stock = (root.OrcaPresets && root.OrcaPresets.FILAMENTS &&
                 root.OrcaPresets.FILAMENTS[s.filamentKey]) || null;
    var nominal = stock ? stock.nozzleTemp : s.nozzleTemp;
    var warps = !!WARPS[s.filamentKey];

    /** A nozzle temperature, held within 15 °C of what this filament is sold as. */
    function nozzleTemp(delta) {
      return Math.round(clamp(s.nozzleTemp + delta, nominal - 15,
        Math.min(nominal + 15, s.maxNozzleTemp || 300)));
    }

    switch (key) {

      case 'stringing':
        // Order matters: the first two cost nothing and fix most of it.
        if (s.combing) {
          propose('combing', false, 'Retract on every travel',
            'Skipping the retraction inside the part is what leaves threads across it. ' +
            'Off, the nozzle pulls back before every travel over ' + s.minTravelForRetract +
            ' mm.', 'reliability');
        }
        if (!s.wipeOnRetract) {
          propose('wipeOnRetract', true, 'Wipe as it retracts',
            'Pulling back while still moving along the line bleeds the pressure off into ' +
            'the part rather than into the air.', 'quality');
        }
        propose('retractLength', clamp(s.retractLength + 0.4, 0.4, 6),
          'Pull the filament back further',
          s.retractLength + ' mm is what is being pulled back now. Another few tenths takes ' +
          'the pressure off the melt before the nozzle leaves.', 'quality');
        if (s.retractSpeed < 35) {
          propose('retractSpeed', 40, 'Pull it back faster',
            'At ' + s.retractSpeed + ' mm/s the nozzle is already moving before the pressure ' +
            'is off.', 'quality');
        }
        if (s.nozzleTemp > nominal - 15) {
          propose('nozzleTemp', nozzleTemp(-5), 'A little cooler',
            'Hotter plastic is thinner plastic, and thin plastic runs out of the nozzle on ' +
            'its own. Five degrees at a time, watching that the layers still bond.', 'quality');
        }
        break;

      case 'blobs':
        if (!s.seamScarf) {
          propose('seamScarf', true, 'Spread the seam out',
            'A loop that starts and stops at one point leaves a pimple there. Ramping the ' +
            'flow over the first ' + s.scarfLength + ' mm and carrying past the start spreads ' +
            'it along the wall instead.', 'quality');
        }
        if (s.seamPosition === 'random') {
          propose('seamPosition', 'aligned', 'Put the seams in a line',
            'Scattered seams put a blob somewhere different on every layer, which reads as ' +
            'a rough wall. Stacked, they are one line that can be hidden or sanded.', 'quality');
        }
        if (!s.wipeOnRetract) {
          propose('wipeOnRetract', true, 'Wipe as it retracts',
            'The pressure left in the nozzle at the end of a loop has to go somewhere. ' +
            'Wiping puts it back into the line just printed.', 'quality');
        }
        propose('nozzleTemp', nozzleTemp(-5), 'A little cooler',
          'The nozzle keeps pushing after the move has stopped, and how much it pushes ' +
          'depends on how runny the plastic is.', 'quality');
        // The real cure on a Marlin machine is linear advance, and it is not a
        // slicer setting: it is a number that belongs to the printer.
        if (!/M900|SET_PRESSURE_ADVANCE/.test(s.startGcode || '')) {
          out.push({ key: null, label: 'Linear advance is not set on this machine',
            why: 'A blob at the end of every line is pressure the nozzle is still pushing as ' +
              'it slows down, and linear advance is what holds it steady. It has to be ' +
              'calibrated on the machine — print a K-factor tower, then add M900 K<value> to ' +
              'the start G-code. Where the maker publishes a value this app already sends it.',
            kind: 'quality' });
        }
        break;

      case 'firstlayer':
        // Only when it is actually the wrong thickness: a first layer already
        // in the band is not made to stick better by moving it a hundredth.
        if (s.firstLayerHeight > nozzle * 0.7 || s.firstLayerHeight < nozzle * 0.4) {
          propose('firstLayerHeight', clamp(nozzle * 0.6, 0.08, nozzle),
            'Press the first layer down',
            'The first layer sticks because it is squashed into the plate. ' +
            s.firstLayerHeight + ' mm out of a ' + nozzle + ' mm nozzle is ' +
            (s.firstLayerHeight > nozzle * 0.7 ? 'too much of the gap to fill — the bead is ' +
              'laid rather than pressed' : 'too little — the nozzle drags through what it ' +
              'has already put down') + '.', 'reliability');
        }
        if (s.speeds && s.speeds.firstLayer > 25) {
          propose('speeds.firstLayer', 20, 'Slow the first layer down',
            s.speeds.firstLayer + ' mm/s gives the plastic no time against a cold plate.',
            'reliability');
        }
        if (s.adhesion !== 'brim') {
          propose('adhesion', 'brim', 'Print a brim',
            'A skirt does not hold anything down. A brim is printed against the part and ' +
            'holds its edges while the rest goes up.', 'reliability');
        }
        propose('firstLayerBedTemp', Math.min((s.firstLayerBedTemp || 0) + 5, s.maxBedTemp || 120),
          'Five degrees more on the plate',
          'Plastic sticks to a plate it can stay soft against a moment longer.', 'reliability');
        if (s.firstLayerFanSpeed > 0) {
          propose('firstLayerFanSpeed', 0, 'No fan on the first layer',
            'Cooling the first layer is cooling the one thing that has to stay stuck.',
            'reliability');
        }
        break;

      case 'warping':
        if (s.adhesion !== 'brim') {
          propose('adhesion', 'brim', 'Print a brim',
            'The corners lift because the part shrinks as it cools and the plate only holds ' +
            'the middle. A brim widens what is holding.', 'reliability');
        }
        if (s.fanFromLayer < 3 && warps) {
          propose('fanFromLayer', 4, 'Keep the fan off for longer',
            (stock ? stock.name : 'This filament') + ' pulls its corners up when it is ' +
            'cooled quickly. Leaving the fan off for the first few layers lets the bottom set ' +
            'evenly.', 'reliability');
        }
        if (warps && s.maxChamberTemp > 0 && !s.chamberTemp) {
          propose('chamberTemp', Math.min(50, s.maxChamberTemp), 'Warm the chamber',
            'This machine has a chamber heater, and warm air around the part is what stops ' +
            'it shrinking away from the plate.', 'reliability');
        }
        propose('bedTemp', Math.min((s.bedTemp || 0) + 5, s.maxBedTemp || 120),
          'Five degrees more on the plate',
          'A warmer plate keeps the bottom of the part from setting before the top of it does.',
          'reliability');
        break;

      case 'elephant':
        propose('elephantFootCompensation', clamp((s.elephantFootCompensation || 0) + 0.15, 0.1, 0.5),
          'Pull the first layer in',
          'The first layer is squashed on purpose, and it spreads. This takes that much back ' +
          'off its outline so the part measures the same at the bottom as it does higher up.',
          'quality');
        propose('firstLayerBedTemp', Math.max((s.firstLayerBedTemp || 0) - 5, 0),
          'Five degrees less on the plate',
          'A very hot plate keeps the bottom soft while the weight of the part presses down ' +
          'on it.', 'quality');
        break;

      case 'underextrusion':
        propose('flowRatio', clamp((s.flowRatio || 1) + 0.03, 0.9, 1.1), 'A little more flow',
          'Every line is coming out thinner than it was asked for. Three percent at a time, ' +
          'measuring a wall with calipers after each.', 'quality');
        propose('nozzleTemp', nozzleTemp(+5), 'A little hotter',
          'Plastic that cannot melt fast enough comes out thin however hard it is pushed.',
          'quality');
        if (s.maxVolumetric > 8) {
          propose('maxVolumetric', round2(s.maxVolumetric * 0.85), 'Ask the hotend for less',
            'The hotend is set to melt ' + s.maxVolumetric + ' mm³/s. If it cannot really do ' +
            'that, every fast move is starved — and the fast moves are the infill that holds ' +
            'the part together.', 'quality');
        }
        if (s.infillOverlap < 0.25) {
          propose('infillOverlap', 0.25, 'Overlap the infill further into the walls',
            'The gap between the infill and the wall is where a part comes apart.', 'quality');
        }
        break;

      case 'overextrusion':
        propose('flowRatio', clamp((s.flowRatio || 1) - 0.03, 0.9, 1.1), 'A little less flow',
          'Bulging corners and a part measuring large mean more plastic is coming out than ' +
          'the shape needs.', 'quality');
        propose('xyCompensation', clamp((s.xyCompensation || 0) - 0.05, -0.3, 0.3),
          'Take the outline in',
          'This shaves the walls in by that much, which is the quick fix for a part that ' +
          'measures large while the flow is being sorted out.', 'quality');
        break;

      case 'weak':
        propose('wallLoops', Math.min((s.wallLoops || 2) + 1, 6), 'One more wall',
          'A part is as strong as its walls long before it is as strong as its infill. ' +
          (s.wallLoops || 2) + ' loops is ' + round2((s.wallLoops || 2) * s.lineWidth) +
          ' mm of it.', 'reliability');
        propose('nozzleTemp', nozzleTemp(+5), 'A little hotter',
          'Layers bond by melting into each other. Cooler plastic makes a prettier part and ' +
          'a weaker one.', 'reliability');
        if (s.infillDensity < 25) {
          propose('infillDensity', 25, 'More infill',
            s.infillDensity + '% leaves the walls holding everything on their own.',
            'reliability');
        }
        if (s.fanSpeed > 60 && warps) {
          propose('fanSpeed', 40, 'Less air',
            'This plastic splits between layers when it is cooled fast, and the fan is what ' +
            'cools it fast.', 'reliability');
        }
        break;

      case 'shift':
        propose('maxAccel', Math.max(Math.round((s.maxAccel || 3000) * 0.6 / 100) * 100, 500),
          'Accelerate more gently',
          'A layer shifts when a motor is asked for more than it can deliver and skips a step. ' +
          'Acceleration is what asks the most of it.', 'reliability');
        propose('travelSpeed', Math.max(Math.round((s.travelSpeed || 150) * 0.7), 60),
          'Travel more slowly',
          'The fastest thing the machine does is move between the places it prints, and it ' +
          'does it with no plastic to slow it down.', 'reliability');
        out.push({ key: null, label: 'And it may not be the file',
          why: 'A shift that happens at the same height every time is the file. One that ' +
            'happens somewhere different each time is the machine: a loose belt, a pulley ' +
            'grub screw, or a motor driver getting hot.',
          kind: 'warning' });
        break;

      case 'pillowing':
        propose('topLayers', Math.max((s.topLayers || 4) + 1, Math.ceil(1 / s.layerHeight)),
          'More solid layers on top',
          round2((s.topLayers || 4) * s.layerHeight) + ' mm of roof is being asked to span the ' +
          'gaps in ' + s.infillDensity + '% infill. Thicker, or denser underneath.', 'quality');
        if (s.infillDensity < 20) {
          propose('infillDensity', 20, 'Denser infill under the top',
            'The top is only as flat as what it is built on.', 'quality');
        }
        if (s.ironing === 'none') {
          propose('ironing', 'top', 'Iron the top',
            'A second pass with no plastic coming out, melting the ridges flat.', 'quality');
        }
        if (s.monotonicSurfaces === 'none') {
          propose('monotonicSurfaces', 'top', 'Lay the top in one direction',
            'Lines laid all the same way catch the light the same way. It costs a little ' +
            'travel and it is most of what makes a top look finished.', 'quality');
        }
        break;

      case 'supports':
        propose('supportZGap', clamp(Math.max(s.supportZGap || 0, s.layerHeight), 0.1, 0.4),
          'Leave a gap under the part',
          'At ' + (s.supportZGap || 0) + ' mm the support and the part are printed into each ' +
          'other. A full layer of air between them is what makes it lift off.', 'quality');
        if (s.supportStyle !== 'tree') {
          propose('supportStyle', 'tree', 'Tree supports',
            'Branches touch the part at a few points instead of holding it along a wall, so ' +
            'there is far less to break off and far less to mark.', 'quality');
        }
        if (s.supportDensity > 20) {
          propose('supportDensity', 15, 'Thinner support',
            s.supportDensity + '% is a solid block under the overhang. It only has to hold ' +
            'the first layer over it.', 'quality');
        }
        break;

      case 'stutter':
        propose('gcodeResolution', clamp(Math.max(s.gcodeResolution || 0, 0.0125) * 2, 0.0125, 0.05),
          'Fewer, longer moves',
          'A board that is asked to read more moves than it can act on runs out of planned ' +
          'motion and stops until it catches up. Joining points closer than this into one ' +
          'move is what a slicer does about it.', 'reliability');
        out.push({ key: null, label: 'And check how the file gets there',
          why: 'A pause of a second or more is usually not the file at all: it is the file ' +
            'being streamed over USB from a host that had something else to do. Copy the same ' +
            'G-code to the printer’s own card and print it from there. If the pause goes, ' +
            'nothing in these settings would have fixed it.',
          kind: 'warning' });
        break;
    }
    return out;
  }

  var api = { measure: measure, advise: advise, review: review, plateNotes: plateNotes,
              SYMPTOMS: SYMPTOMS, remedies: remedies };
  root.OrcaAdvisor = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
