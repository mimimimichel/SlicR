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
   * @param {object} shape   from measure()
   * @param {object} s       the full settings object
   * @returns {Array<{key,value,from,label,why,kind}>}
   */
  function advise(shape, s) {
    var out = [];
    if (!shape || shape.empty || !s) return out;

    function propose(key, value, label, why, kind) {
      var from = get(s, key);
      if (from === value) return;
      if (typeof from === 'number' && typeof value === 'number' &&
          Math.abs(from - value) < 1e-9) return;
      out.push({ key: key, value: value, from: from, label: label, why: why,
        kind: kind || 'quality' });
    }

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

  var api = { measure: measure, advise: advise };
  root.OrcaAdvisor = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
