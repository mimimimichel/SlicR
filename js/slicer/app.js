/**
 * Orca Web Slicer — application shell.
 * Wires the viewer, the settings panel and the slicing worker together.
 */
(function () {
  'use strict';

  var P = window.OrcaPresets;
  var STORAGE_KEY = 'orca_slicer_settings_v1';

  var el = function (id) { return document.getElementById(id); };
  var state = {
    settings: null,
    viewer: null,
    worker: null,
    result: null,
    slicing: false,
    workerBroken: false,
    pendingPositions: null,
    singleLayer: false,
    showTravels: false,
    previewOn: false,
    tab: 'print',
    search: '',
    cutZ: null,
    cutKeep: 'both',
    safetyOverride: false,
    uniformScale: true,
    // What the advisor measured, and which mesh it measured — recomputing on
    // every panel render would walk every triangle for nothing.
    shape: null,
    shapeKey: '',
    adviceDismissed: {}
  };

  // ---------------------------------------------------------------------------
  // Settings schema
  // ---------------------------------------------------------------------------

  var PATTERNS = [
    ['grid', 'Grid'], ['lines', 'Rectilinear'], ['triangles', 'Triangles'],
    ['gyroid', 'Gyroid'], ['honeycomb', 'Honeycomb'], ['cubic', 'Cubic'],
    ['lightning', 'Lightning'],
    ['concentric', 'Concentric']
  ];

  var PRINT_SECTIONS = [
    { title: 'Quality', open: true, fields: [
      { key: 'layerHeight', label: 'Layer height', unit: 'mm', min: 0.04, max: 0.8, step: 0.02 },
      { key: 'firstLayerHeight', label: 'First layer height', unit: 'mm', min: 0.08, max: 0.8, step: 0.02 },
      { key: 'adaptiveLayers', label: 'Adaptive layer height', hint: 'Thin layers on shallow curves', type: 'bool' },
      { key: 'adaptiveQuality', label: 'Adaptive quality', hint: '0 = fastest, 1 = smoothest', min: 0, max: 1, step: 0.05 },
      { key: 'lineWidth', label: 'Line width', unit: 'mm', min: 0.1, max: 1.6, step: 0.02 },
      { key: 'externalLineWidth', label: 'Outer wall width', unit: 'mm', min: 0.1, max: 1.6, step: 0.02 },
      { key: 'firstLayerLineWidth', label: 'First layer width', unit: 'mm', min: 0.1, max: 1.6, step: 0.02 }
    ]},
    { title: 'Walls & shell', open: true, fields: [
      { key: 'wallGenerator', label: 'Wall generator', hint: 'Variable width beads thin features properly',
        type: 'select', options: [['arachne', 'Variable width (Arachne-style)'], ['classic', 'Classic fixed width']] },
      { key: 'minBeadWidth', label: 'Min bead width', unit: 'mm', hint: 'Thinner features are dropped', min: 0.05, max: 1.5, step: 0.01 },
      { key: 'maxBeadWidth', label: 'Max bead width', unit: 'mm', min: 0.1, max: 3, step: 0.05 },
      { key: 'solidInfillBelowArea', label: 'Solid below', unit: 'mm²',
        hint: 'Internal pockets smaller than this are filled solid', min: 0, max: 300, step: 5 },
      { key: 'wallTransitionLength', label: 'Wall transition length', unit: 'mm',
        hint: 'How far a wall is given to change width or taper away', min: 0.1, max: 5, step: 0.05 },
      { key: 'wallLoops', label: 'Wall loops', min: 0, max: 12, step: 1 },
      { key: 'topLayers', label: 'Top layers', min: 0, max: 30, step: 1 },
      { key: 'bottomLayers', label: 'Bottom layers', min: 0, max: 30, step: 1 },
      { key: 'wallOrder', label: 'Wall order', hint: 'Which wall is laid first',
        type: 'select', options: [['inner-outer-inner', 'Inner / outer / inner'],
                                  ['inner-outer', 'Inner then outer'],
                                  ['outer-inner', 'Outer then inner']] },
      { key: 'seamPosition', label: 'Seam', type: 'select', options: [['aligned', 'Aligned'], ['nearest', 'Nearest'], ['random', 'Random']] },
      { key: 'seamScarf', label: 'Scarf the seam',
        hint: 'Spread the seam over a ramp instead of a dot', type: 'bool' },
      { key: 'scarfLength', label: 'Scarf length', unit: 'mm', min: 1, max: 50, step: 1 },
      { key: 'gapFill', label: 'Gap fill', hint: 'Fill what the walls cannot reach', type: 'bool' },
      { key: 'fuzzySkin', label: 'Fuzzy skin', type: 'select', options: [['none', 'None'], ['outer', 'Outer wall'], ['all', 'All walls']] },
      { key: 'fuzzyThickness', label: 'Fuzzy thickness', unit: 'mm', min: 0.05, max: 1.5, step: 0.05 },
      { key: 'fuzzyPointDistance', label: 'Fuzzy point distance', unit: 'mm', min: 0.1, max: 3, step: 0.1 },
      { key: 'smallPerimeterSpeed', label: 'Small perimeter speed', unit: 'mm/s',
        hint: 'Short loops cannot accelerate', min: 1, max: 200, step: 1 },
      { key: 'smallPerimeterThreshold', label: 'Small perimeter below', unit: 'mm', min: 0, max: 60, step: 1 }
    ]},
    { title: 'Overhangs & bridges', fields: [
      { key: 'overhangSlowdown', label: 'Slow down over overhangs', type: 'bool' },
      { key: 'overhangSpeeds.0', label: 'Overhang 0–25 %', unit: 'mm/s', min: 1, max: 200, step: 1 },
      { key: 'overhangSpeeds.1', label: 'Overhang 25–50 %', unit: 'mm/s', min: 1, max: 200, step: 1 },
      { key: 'overhangSpeeds.2', label: 'Overhang 50–75 %', unit: 'mm/s', min: 1, max: 200, step: 1 },
      { key: 'overhangSpeeds.3', label: 'Overhang 75–100 %', unit: 'mm/s', min: 1, max: 200, step: 1 },
      { key: 'overhangFanBoost', label: 'Full fan on overhangs', type: 'bool' },
      { key: 'bridgeAngleDetection', label: 'Find the bridge direction',
        hint: 'Cross the gap the short way', type: 'bool' },
      { key: 'internalBridges', label: 'Bridge over sparse infill',
        hint: 'The first solid layer spans the gaps below it', type: 'bool' },
      { key: 'internalBridgeFlow', label: 'Internal bridge flow', min: 0.5, max: 1.5, step: 0.05 }
    ]},
    { title: 'Arc fitting', fields: [
      { key: 'arcFitting', label: 'Emit arcs (G2/G3)',
        hint: 'Far smaller files, smoother curves', type: 'bool' },
      { key: 'arcTolerance', label: 'Arc tolerance', unit: 'mm', min: 0.005, max: 0.3, step: 0.005 }
    ]},
    { title: 'Dimensional accuracy', fields: [
      { key: 'xyCompensation', label: 'XY compensation', unit: 'mm', hint: 'Negative shrinks the part', min: -1, max: 1, step: 0.01 },
      { key: 'elephantFootCompensation', label: 'Elephant foot', unit: 'mm', hint: 'Shrinks the first layer only', min: 0, max: 1, step: 0.01 }
    ]},
    { title: 'Infill', open: true, fields: [
      { key: 'infillDensity', label: 'Density', unit: '%', min: 0, max: 100, step: 5 },
      { key: 'infillPattern', label: 'Pattern', type: 'select', options: PATTERNS },
      { key: 'solidPattern', label: 'Solid pattern', type: 'select', options: [['lines', 'Rectilinear'], ['concentric', 'Concentric']] },
      { key: 'monotonicSurfaces', label: 'Monotonic surfaces',
        hint: 'One sweep, uniform overlap — costs travel',
        type: 'select', options: [['none', 'Off'], ['top', 'Top surfaces'], ['all', 'All solid']] },
      { key: 'infillOverlap', label: 'Wall overlap', hint: 'Fraction of a line width', min: 0, max: 0.5, step: 0.05 }
    ]},
    { title: 'Ironing', fields: [
      { key: 'ironing', label: 'Iron', type: 'select', options: [['none', 'Off'], ['top', 'Top surfaces'], ['all-solid', 'All solid surfaces']] },
      { key: 'ironingFlow', label: 'Flow', hint: 'Fraction of a normal line', min: 0.01, max: 0.5, step: 0.01 },
      { key: 'ironingSpacing', label: 'Line spacing', unit: 'mm', min: 0.05, max: 0.4, step: 0.01 }
    ]},
    { title: 'Supports', fields: [
      { key: 'supportEnable', label: 'Enable supports', type: 'bool' },
      { key: 'supportStyle', label: 'Style', type: 'select', options: [
        ['normal', 'Normal — walls under every overhang'],
        ['tree', 'Tree — branches that meet and reach the plate']] },
      { key: 'supportThreshold', label: 'Overhang threshold', unit: '°', hint: 'From vertical', min: 0, max: 89, step: 1 },
      { key: 'supportDensity', label: 'Density', unit: '%', min: 3, max: 60, step: 1 },
      { key: 'supportPattern', label: 'Pattern', type: 'select', options: [['lines', 'Rectilinear'], ['grid', 'Grid'], ['honeycomb', 'Honeycomb']] },
      { key: 'supportZGap', label: 'Top Z gap', unit: 'mm', min: 0, max: 1, step: 0.05 },
      { key: 'supportXYGap', label: 'XY gap', unit: 'mm', min: 0, max: 3, step: 0.1 },
      { key: 'supportInterfaceLayers', label: 'Interface layers', hint: 'Dense layers the model rests on', min: 0, max: 8, step: 1 },
      { key: 'supportBranchAngle', label: 'Branch angle', unit: '°', hint: 'Tree only — how far a branch leans per layer', min: 0, max: 75, step: 1 },
      { key: 'supportBranchDiameter', label: 'Max branch diameter', unit: 'mm', hint: 'Tree only', min: 0.5, max: 20, step: 0.5 },
      { key: 'supportTipDiameter', label: 'Tip diameter', unit: 'mm', hint: 'Tree only — what touches the part', min: 0.2, max: 5, step: 0.1 },
      { key: 'supportTipSpacing', label: 'Tip spacing', unit: 'mm', hint: 'Tree only — how far apart the branches hold', min: 0.5, max: 20, step: 0.5 },
      { key: 'supportInterfaceDensity', label: 'Interface density', unit: '%', min: 10, max: 100, step: 5 },
      { key: 'supportOnBuildplateOnly', label: 'From build plate only', type: 'bool' }
    ]},
    { title: 'Bed adhesion', fields: [
      { key: 'adhesion', label: 'Type', type: 'select', options: [['none', 'None'], ['skirt', 'Skirt'], ['brim', 'Brim'], ['raft', 'Raft']] },
      { key: 'skirtLoops', label: 'Skirt loops', min: 0, max: 10, step: 1 },
      { key: 'skirtDistance', label: 'Skirt distance', unit: 'mm', min: 0, max: 20, step: 0.5 },
      { key: 'brimWidth', label: 'Brim width', unit: 'mm', min: 0, max: 30, step: 0.5 },
      { key: 'brimType', label: 'Brim placement', type: 'select', options: [['outer', 'Outside'], ['inner', 'Inside holes'], ['both', 'Both']] },
      { key: 'brimGap', label: 'Brim gap', unit: 'mm', hint: 'Easier to peel off', min: 0, max: 1, step: 0.05 },
      { key: 'raftLayers', label: 'Raft layers', min: 1, max: 10, step: 1 },
      { key: 'raftGap', label: 'Raft air gap', unit: 'mm', min: 0, max: 1, step: 0.05 }
    ]},
    { title: 'Speed', fields: [
      { key: 'speeds.firstLayer', label: 'First layer', unit: 'mm/s', min: 5, max: 300, step: 1 },
      { key: 'speeds.externalPerimeter', label: 'Outer wall', unit: 'mm/s', min: 5, max: 500, step: 1 },
      { key: 'speeds.perimeter', label: 'Inner wall', unit: 'mm/s', min: 5, max: 500, step: 1 },
      { key: 'speeds.solidInfill', label: 'Solid infill', unit: 'mm/s', min: 5, max: 500, step: 1 },
      { key: 'speeds.topSolid', label: 'Top surface', unit: 'mm/s', min: 5, max: 500, step: 1 },
      { key: 'speeds.infill', label: 'Sparse infill', unit: 'mm/s', min: 5, max: 800, step: 1 },
      { key: 'speeds.bridge', label: 'Bridges', unit: 'mm/s', min: 5, max: 200, step: 1 },
      { key: 'speeds.support', label: 'Supports', unit: 'mm/s', min: 5, max: 500, step: 1 },
      { key: 'speeds.gapFill', label: 'Gap fill', unit: 'mm/s', min: 5, max: 300, step: 1 },
      { key: 'speeds.ironing', label: 'Ironing', unit: 'mm/s', min: 5, max: 150, step: 1 },
      { key: 'travelSpeed', label: 'Travel', unit: 'mm/s', min: 10, max: 800, step: 5 },
      { key: 'maxSpeed', label: 'Machine speed cap', unit: 'mm/s', min: 20, max: 1000, step: 10 }
    ]},
    { title: 'Cooling', fields: [
      { key: 'minLayerTime', label: 'Minimum layer time', unit: 's', hint: 'Slow down so layers can set', min: 0, max: 60, step: 1 },
      { key: 'slowDownMinSpeed', label: 'Slow-down floor', unit: 'mm/s', min: 1, max: 60, step: 1 },
      { key: 'fanSpeed', label: 'Fan', unit: '%', min: 0, max: 100, step: 5 },
      { key: 'firstLayerFanSpeed', label: 'Fan, first layer', unit: '%', min: 0, max: 100, step: 5 },
      { key: 'fanFromLayer', label: 'Fan from layer', min: 1, max: 20, step: 1 }
    ]},
    { title: 'Extrusion & retraction', fields: [
      { key: 'flowRatio', label: 'Flow ratio', min: 0.5, max: 1.5, step: 0.01 },
      { key: 'maxVolumetric', label: 'Max volumetric', unit: 'mm³/s', min: 1, max: 60, step: 0.5 },
      { key: 'retractLength', label: 'Retraction length', unit: 'mm', min: 0, max: 10, step: 0.1 },
      { key: 'retractSpeed', label: 'Retraction speed', unit: 'mm/s', min: 5, max: 120, step: 1 },
      { key: 'deretractSpeed', label: 'Deretraction speed', unit: 'mm/s', min: 5, max: 120, step: 1 },
      { key: 'zHop', label: 'Z hop', unit: 'mm', min: 0, max: 2, step: 0.05 },
      { key: 'minTravelForRetract', label: 'Min travel to retract', unit: 'mm', min: 0, max: 20, step: 0.5 },
      { key: 'combing', label: 'Avoid retraction inside the part', type: 'bool' },
      { key: 'wipeOnRetract', label: 'Wipe on retract', type: 'bool' },
      { key: 'wipeDistance', label: 'Wipe distance', unit: 'mm', min: 0, max: 5, step: 0.5 },
      { key: 'spiralVase', label: 'Spiral vase mode', hint: 'Single wall, no top, continuous Z', type: 'bool' }
    ]}
  ];

  var MACHINE_SECTIONS = [
    { title: 'Build volume', open: true, fields: [
      { key: 'bedX', label: 'Bed width (X)', unit: 'mm', min: 20, max: 1200, step: 1 },
      { key: 'bedY', label: 'Bed depth (Y)', unit: 'mm', min: 20, max: 1200, step: 1 },
      { key: 'bedZ', label: 'Height (Z)', unit: 'mm', min: 20, max: 1200, step: 1 },
      { key: 'bedShape', label: 'Bed shape', type: 'select', options: [['rect', 'Rectangular'], ['circle', 'Circular (delta)']] },
      { key: 'nozzle', label: 'Nozzle diameter', unit: 'mm', min: 0.1, max: 1.6, step: 0.05 },
      { key: 'filamentDiameter', label: 'Filament diameter', unit: 'mm', min: 1, max: 3.2, step: 0.05 },
      { key: 'maxAccel', label: 'Acceleration', unit: 'mm/s²', min: 100, max: 30000, step: 100 }
    ]},
    { title: 'Multi-material', fields: [
      { key: 'extruderCount', label: 'Extruders', hint: 'Assign a tool per object in the Object tab', min: 1, max: 8, step: 1 },
      { key: 'purgeVolume', label: 'Purge per tool change', unit: 'mm³', min: 0, max: 400, step: 5 },
      { key: 'primeTowerWidth', label: 'Prime tower size', unit: 'mm', min: 15, max: 120, step: 1 },
      { key: 'toolChangeGcode', label: 'Tool change G-code', type: 'text',
        hint: '{next_extruder} and {previous_extruder} are in scope' }
    ]},
    { title: 'Print sequence', fields: [
      { key: 'printSequence', label: 'Print order', type: 'select', options: [
        ['layer', 'All objects, layer by layer'],
        ['object', 'One object at a time']],
        hint: 'One at a time frees the plate as it goes, but needs room around each part' },
      { key: 'extruderClearanceRadius', label: 'Extruder clearance', unit: 'mm',
        hint: 'Room the head needs around a finished part', min: 0, max: 200, step: 1 },
      { key: 'extruderClearanceHeight', label: 'Gantry clearance', unit: 'mm',
        hint: 'How tall a part has to be before it is in the way', min: 0, max: 300, step: 1 }
    ]},
    { title: 'Firmware', open: true, fields: [
      { key: 'gcodeFlavor', label: 'G-code flavour', type: 'select', options: 'FLAVORS' },
      { key: 'relativeE', label: 'Relative extrusion', hint: 'M83 instead of M82', type: 'bool' },
      { key: 'emitAcceleration', label: 'Emit acceleration command', type: 'bool' },
      { key: 'thumbnails', label: 'Embed preview thumbnail', hint: 'Shown on the printer screen', type: 'bool' }
    ]},
    { title: 'Temperatures & cooling', open: true, fields: [
      { key: 'firstLayerNozzleTemp', label: 'Nozzle, first layer', unit: '°C', min: 0, max: 400, step: 1 },
      { key: 'nozzleTemp', label: 'Nozzle, other layers', unit: '°C', min: 0, max: 400, step: 1 },
      { key: 'firstLayerBedTemp', label: 'Bed, first layer', unit: '°C', min: 0, max: 160, step: 1 },
      { key: 'bedTemp', label: 'Bed, other layers', unit: '°C', min: 0, max: 160, step: 1 },
      { key: 'firstLayerFanSpeed', label: 'Fan, first layer', unit: '%', min: 0, max: 100, step: 5 },
      { key: 'fanSpeed', label: 'Fan', unit: '%', min: 0, max: 100, step: 5 },
      { key: 'fanFromLayer', label: 'Fan from layer', min: 1, max: 20, step: 1 },
      { key: 'chamberTemp', label: 'Chamber', unit: '°C', hint: '0 disables the command', min: 0, max: 120, step: 1 }
    ]},
    { title: 'Filament', fields: [
      { key: 'filamentDensity', label: 'Density', unit: 'g/cm³', min: 0.5, max: 3, step: 0.01 },
      { key: 'filamentCost', label: 'Cost', unit: '€/kg', min: 0, max: 500, step: 1 }
    ]},
    { title: 'Safety limits', fields: [
      { key: 'maxNozzleTemp', label: 'Nozzle ceiling', unit: '°C',
        hint: 'Raise only if the hotend was actually changed', min: 150, max: 500, step: 5 },
      { key: 'maxBedTemp', label: 'Bed ceiling', unit: '°C', min: 40, max: 150, step: 5 },
      { key: 'maxChamberTemp', label: 'Chamber ceiling', unit: '°C', min: 0, max: 120, step: 5 },
      { key: 'maxZSpeed', label: 'Z axis max speed', unit: 'mm/s',
        hint: 'Leadscrews are far slower than X and Y', min: 1, max: 400, step: 1 }
    ]},
    { title: 'Custom G-code', fields: [
      { key: 'startGcode', label: 'Start G-code', type: 'text' },
      { key: 'endGcode', label: 'End G-code', type: 'text' },
      { key: 'layerGcode', label: 'Before each layer', hint: 'Placeholders: {layer} {z}', type: 'text' }
    ]}
  ];

  function getPath(obj, path) {
    return path.split('.').reduce(function (o, k) { return o == null ? o : o[k]; }, obj);
  }
  function setPath(obj, path, value) {
    var parts = path.split('.');
    var last = parts.pop();
    var target = parts.reduce(function (o, k) { return o[k]; }, obj);
    target[last] = value;
  }

  // ---------------------------------------------------------------------------
  // Panel rendering
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Advice
  //
  // What this model, on this machine, in this filament, wants changed. The
  // measurement is the expensive half and only depends on the geometry, so it
  // is kept until the geometry moves.
  // ---------------------------------------------------------------------------

  function meshSignature() {
    var v = state.viewer;
    if (!v || !v.models.length) return '';
    var parts = [state.settings.supportThreshold, state.settings.nozzle];
    for (var i = 0; i < v.models.length; i++) {
      var mesh = v.models[i].mesh;
      mesh.updateMatrixWorld(true);
      parts.push(mesh.geometry.attributes.position.count);
      var e = mesh.matrixWorld.elements;
      for (var k = 0; k < 16; k++) parts.push(Math.round(e[k] * 1000));
    }
    return parts.join(',');
  }

  function currentShape() {
    if (!window.OrcaAdvisor || !state.viewer) return null;
    var sig = meshSignature();
    if (!sig) { state.shape = null; state.shapeKey = ''; return null; }
    if (sig !== state.shapeKey) {
      state.shape = window.OrcaAdvisor.measure(state.viewer.collectTriangles(),
        { overhangThreshold: state.settings.supportThreshold });
      state.shapeKey = sig;
    }
    return state.shape;
  }

  function adviceId(a) { return (a.key || a.label) + '=' + JSON.stringify(a.value); }

  function showValue(v) {
    if (v === true) return 'on';
    if (v === false) return 'off';
    if (typeof v === 'number') return String(Math.round(v * 1000) / 1000);
    return String(v);
  }

  function renderAdvice(body) {
    var shape = currentShape();
    if (!shape) return;
    var all = window.OrcaAdvisor.advise(shape, state.settings);
    var list = all.filter(function (a) { return !state.adviceDismissed[adviceId(a)]; });
    if (!list.length) return;

    var wrap = document.createElement('details');
    wrap.className = 'sl-advice';
    wrap.open = true;
    var head = document.createElement('summary');
    var changes = list.filter(function (a) { return a.key; }).length;
    head.textContent = list.length + (list.length > 1 ? ' notes' : ' note') +
      ' on this model' + (changes ? ' — ' + changes + ' can be applied' : '');
    wrap.appendChild(head);

    list.forEach(function (a) {
      var card = document.createElement('div');
      card.className = 'sl-advice-item' + (a.kind === 'warning' ? ' warning' : '');

      var title = document.createElement('div');
      title.className = 'msg';
      title.textContent = a.label;
      card.appendChild(title);

      var why = document.createElement('div');
      why.className = 'why';
      why.textContent = a.why;
      card.appendChild(why);

      var row = document.createElement('div');
      row.className = 'sl-advice-actions';
      if (a.key) {
        var apply = document.createElement('button');
        apply.className = 'sl-btn primary';
        apply.type = 'button';
        apply.textContent = showValue(a.from) + ' → ' + showValue(a.value);
        apply.onclick = function () {
          setPath(state.settings, a.key, a.value);
          persist();
          invalidate();
          renderPanel();
        };
        row.appendChild(apply);
      }
      var hide = document.createElement('button');
      hide.className = 'sl-btn';
      hide.type = 'button';
      hide.textContent = 'Dismiss';
      hide.onclick = function () {
        state.adviceDismissed[adviceId(a)] = true;
        renderPanel();
      };
      row.appendChild(hide);
      card.appendChild(row);
      wrap.appendChild(card);
    });

    if (changes > 1) {
      var allRow = document.createElement('div');
      allRow.className = 'sl-advice-actions';
      var applyAll = document.createElement('button');
      applyAll.className = 'sl-btn primary';
      applyAll.type = 'button';
      applyAll.textContent = 'Apply all ' + changes;
      applyAll.onclick = function () {
        list.forEach(function (a) { if (a.key) setPath(state.settings, a.key, a.value); });
        persist();
        invalidate();
        renderPanel();
      };
      allRow.appendChild(applyAll);
      wrap.appendChild(allRow);
    }

    body.appendChild(wrap);
  }

  function renderPanel() {
    var body = el('panel-body');
    body.innerHTML = '';
    if (state.tab === 'object') { renderObjectTab(body); return; }
    if (state.tab === 'check') { renderCheckTab(body); return; }
    if (state.tab === 'print' && presetsBelong() === 'panel') body.appendChild(state.presetsEl);
    if (state.tab === 'print') renderAdvice(body);
    var sections = state.tab === 'machine' ? MACHINE_SECTIONS : PRINT_SECTIONS;

    body.appendChild(renderSearch());

    var query = (state.search || '').trim().toLowerCase();
    if (query) {
      // Flatten every matching field, keeping its section as the label prefix.
      var hits = 0;
      var flat = document.createElement('div');
      ALL_SECTIONS.forEach(function (section) {
        section.fields.forEach(function (field) {
          var haystack = (section.title + ' ' + field.label + ' ' + (field.hint || '') + ' ' + field.key).toLowerCase();
          if (haystack.indexOf(query) < 0) return;
          hits++;
          var row = renderField(field);
          var small = document.createElement('small');
          small.textContent = section.title;
          small.style.color = 'var(--text-dim)';
          row.querySelector('label').appendChild(small);
          flat.appendChild(row);
        });
      });
      if (!hits) {
        var none = document.createElement('div');
        none.className = 'sl-hint';
        none.textContent = 'No setting matches “' + query + '”.';
        flat.appendChild(none);
      }
      body.appendChild(flat);
      return;
    }

    sections.forEach(function (section) {
      var details = document.createElement('details');
      details.className = 'sl-section';
      if (section.open) details.open = true;
      var summary = document.createElement('summary');
      summary.textContent = section.title;
      details.appendChild(summary);
      section.fields.forEach(function (field) { details.appendChild(renderField(field)); });
      body.appendChild(details);
    });

    var row = document.createElement('div');
    row.className = 'sl-row';
    row.style.paddingTop = '14px';

    var reset = document.createElement('button');
    reset.className = 'sl-btn';
    reset.type = 'button';
    reset.textContent = 'Reset to preset';
    reset.onclick = function () {
      state.settings = P.buildSettings(el('sel-printer').value, el('sel-filament').value, el('sel-quality').value);
      persist();
      applyBed();
      renderPanel();
      invalidate();
    };

    var save = document.createElement('button');
    save.className = 'sl-btn';
    save.type = 'button';
    save.textContent = 'Export profile';
    save.onclick = exportProfile;

    var load = document.createElement('button');
    load.className = 'sl-btn';
    load.type = 'button';
    load.textContent = 'Import profile';
    load.onclick = function () { el('profile-input').click(); };

    row.appendChild(reset);
    row.appendChild(save);
    row.appendChild(load);
    body.appendChild(row);
  }

  var ALL_SECTIONS = PRINT_SECTIONS.concat(MACHINE_SECTIONS);

  function renderSearch() {
    var wrap = document.createElement('div');
    wrap.className = 'sl-search';
    var input = document.createElement('input');
    input.type = 'search';
    input.className = 'sl-num';
    input.placeholder = 'Search settings…';
    input.value = state.search || '';
    input.setAttribute('aria-label', 'Search settings');
    input.oninput = function () {
      state.search = input.value;
      renderPanel();
      var again = document.querySelector('.sl-search input');
      if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
    };
    wrap.appendChild(input);
    return wrap;
  }

  function exportProfile() {
    var payload = JSON.stringify(state.settings, null, 2);
    var blob = new Blob([payload], { type: 'application/json' });
    var name = 'web-slicer-' + state.settings.printerKey + '-' + state.settings.filamentKey + '.json';
    if (window.AndroidSlicer) {
      try {
        window.AndroidSlicer.beginSave(name);
        window.AndroidSlicer.appendSave(payload);
        window.AndroidSlicer.endSave();
      } catch (e) { alert('Could not save the profile: ' + (e.message || e)); }
      return;
    }
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function importProfile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var incoming = JSON.parse(reader.result);
        if (!incoming || !incoming.speeds) throw new Error('not a Web Slicer profile');
        var base = P.buildSettings(incoming.printerKey, incoming.filamentKey, incoming.qualityKey);
        Object.keys(base).forEach(function (k) {
          if (incoming[k] === undefined) return;
          base[k] = (k === 'speeds') ? Object.assign(base.speeds, incoming.speeds) : incoming[k];
        });
        state.settings = base;
        persist();
        syncPresetSelects();
        applyBed();
        renderPanel();
        invalidate();
      } catch (e) {
        alert('That file is not a Web Slicer profile:\n\n' + (e.message || e));
      }
    };
    reader.readAsText(file);
  }

  function renderField(field) {
    var wrap = document.createElement('div');
    wrap.className = 'sl-field';

    var label = document.createElement('label');
    label.textContent = field.label;
    if (field.hint) {
      var small = document.createElement('small');
      small.textContent = field.hint;
      label.appendChild(small);
    }
    wrap.appendChild(label);

    var control = document.createElement('div');
    control.className = 'sl-control';
    var value = getPath(state.settings, field.key);

    if (field.type === 'bool') {
      var sw = document.createElement('span');
      sw.className = 'sl-switch';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!value;
      cb.setAttribute('aria-label', field.label);
      cb.onchange = function () { setPath(state.settings, field.key, cb.checked); persist(); invalidate(); };
      sw.appendChild(cb);
      sw.appendChild(document.createElement('i'));
      control.appendChild(sw);

    } else if (field.type === 'select') {
      var sel = document.createElement('select');
      sel.className = 'sl-select';
      sel.setAttribute('aria-label', field.label);
      var options = field.options === 'FLAVORS'
        ? Object.keys(P.FLAVORS).map(function (k) { return [k, P.FLAVORS[k].name]; })
        : field.options;
      options.forEach(function (opt) {
        var o = document.createElement('option');
        o.value = opt[0]; o.textContent = opt[1];
        if (opt[0] === value) o.selected = true;
        sel.appendChild(o);
      });
      sel.onchange = function () {
        setPath(state.settings, field.key, sel.value);
        persist();
        if (field.key === 'bedShape') applyBed();
        invalidate();
      };
      control.appendChild(sel);

    } else if (field.type === 'text') {
      wrap.style.flexDirection = 'column';
      wrap.style.alignItems = 'stretch';
      var ta = document.createElement('textarea');
      ta.className = 'sl-num';
      ta.style.width = '100%';
      ta.style.height = '130px';
      ta.style.textAlign = 'left';
      ta.style.fontFamily = 'var(--font-mono, monospace)';
      ta.style.fontSize = '11px';
      ta.value = value || '';
      ta.onchange = function () { setPath(state.settings, field.key, ta.value); persist(); invalidate(); };
      control.style.width = '100%';
      control.appendChild(ta);

    } else {
      var input = document.createElement('input');
      input.type = 'number';
      input.className = 'sl-num';
      input.inputMode = 'decimal';
      input.min = field.min; input.max = field.max; input.step = field.step;
      input.value = value;
      input.setAttribute('aria-label', field.label);
      input.onchange = function () {
        var v = parseFloat(input.value);
        if (isNaN(v)) { input.value = getPath(state.settings, field.key); return; }
        v = Math.max(field.min, Math.min(field.max, v));
        input.value = v;
        setPath(state.settings, field.key, v);
        persist();
        if (field.key.indexOf('bed') === 0) applyBed();
        invalidate();
      };
      control.appendChild(input);
      var unit = document.createElement('span');
      unit.className = 'sl-unit';
      unit.textContent = field.unit || '';
      control.appendChild(unit);
    }

    wrap.appendChild(control);
    return wrap;
  }

  // --- Safety check tab --------------------------------------------------------

  function renderCheckTab(body) {
    var report = state.result && state.result.report;
    if (!report) {
      var idle = document.createElement('div');
      idle.className = 'sl-hint';
      idle.textContent = 'Slice the model and the generated G-code will be checked here, line by line, before you can export it.';
      body.appendChild(idle);
      return;
    }

    var banner = document.createElement('div');
    var level = report.errors ? 'fail' : (report.warnings ? 'warn' : 'pass');
    banner.className = 'sl-check-banner ' + level;
    var title = document.createElement('b');
    title.textContent = report.errors
      ? report.errors + (report.errors > 1 ? ' problems' : ' problem') + ' would make this file unsafe to print'
      : (report.warnings ? report.warnings + (report.warnings > 1 ? ' things worth a look' : ' thing worth a look') : 'The G-code passed every check');
    banner.appendChild(title);
    var sum = report.summary || {};
    banner.appendChild(document.createTextNode(
      report.errors
        ? 'Export is blocked. Each finding below names the line and what it would do to the printer.'
        : (sum.moves || 0).toLocaleString() + ' moves checked · nozzle ' + (sum.nozzleTemp || 0) + ' °C · bed ' +
          (sum.bedTemp || 0) + ' °C · ' + (sum.filamentMm || 0) + ' mm of filament'
    ));
    body.appendChild(banner);

    if (report.errors) {
      var row = document.createElement('div');
      row.className = 'sl-row';
      var anyway = document.createElement('button');
      anyway.className = 'sl-btn';
      anyway.type = 'button';
      anyway.textContent = 'Export anyway';
      anyway.onclick = function () {
        if (!window.confirm(
          'This G-code failed ' + report.errors + ' safety check' + (report.errors > 1 ? 's' : '') + '.\n\n' +
          'Printing it may damage the machine or start a fire. Only continue if you have read every finding and understand why each one is acceptable.\n\n' +
          'Export it anyway?')) return;
        state.safetyOverride = true;
        closePanel();
        exportGcode();
      };
      row.appendChild(anyway);
      body.appendChild(row);
    }

    var order = { error: 0, warning: 1, info: 2 };
    var findings = report.findings.slice().sort(function (a, b) {
      return (order[a.severity] - order[b.severity]) || (a.line - b.line);
    });

    findings.forEach(function (f) {
      var card = document.createElement('div');
      card.className = 'sl-finding ' + f.severity;

      var head = document.createElement('div');
      head.className = 'head';
      var sev = document.createElement('span');
      sev.className = 'sev';
      sev.textContent = f.severity;
      var msg = document.createElement('span');
      msg.className = 'msg';
      msg.textContent = f.message;
      head.appendChild(sev);
      head.appendChild(msg);
      card.appendChild(head);

      if (f.detail) {
        var why = document.createElement('div');
        why.className = 'why';
        why.textContent = f.detail;
        card.appendChild(why);
      }
      if (f.line) {
        var where = document.createElement('div');
        where.className = 'where';
        where.textContent = 'line ' + f.line;
        card.appendChild(where);
      }
      if (f.text) {
        var code = document.createElement('code');
        code.textContent = f.text;
        card.appendChild(code);
      }
      body.appendChild(card);
    });
  }

  function updateCheckStatus() {
    var el2 = el('check-status');
    var report = state.result && state.result.report;
    if (!report || !state.previewOn) { el2.classList.remove('show'); return; }
    var level = report.errors ? 'fail' : (report.warnings ? 'warn' : 'pass');
    el2.className = 'sl-check-status show ' + level;
    el2.textContent = report.errors
      ? '✕ ' + report.errors + ' safety problem' + (report.errors > 1 ? 's' : '') + ' — tap to read'
      : (report.warnings
          ? '⚠ ' + report.warnings + ' warning' + (report.warnings > 1 ? 's' : '') + ' — tap to read'
          : '✓ G-code checks passed');
  }

  // --- Object tab -------------------------------------------------------------

  /** Which tool prints this object, on a machine that has more than one. */
  function renderToolPicker(m) {
    var wrap = document.createElement('div');
    wrap.className = 'sl-field';
    var label = document.createElement('label');
    label.textContent = 'Printed with';
    var select = document.createElement('select');
    select.className = 'sl-select';
    for (var i = 0; i < state.settings.extruderCount; i++) {
      var opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = 'Extruder ' + (i + 1);
      select.appendChild(opt);
    }
    select.value = String(m.extruder | 0);
    select.onchange = function () {
      m.extruder = parseInt(select.value, 10) || 0;
      state.viewer.tintByTool(m);
    };
    wrap.appendChild(label);
    wrap.appendChild(select);
    return wrap;
  }

  function renderObjectTab(body) {
    var v = state.viewer;
    if (!v.models.length) {
      var p = document.createElement('div');
      p.className = 'sl-hint';
      p.textContent = 'No model loaded yet. Open an STL, 3MF or OBJ file to get started.';
      body.appendChild(p);
      return;
    }

    var list = document.createElement('div');
    list.className = 'sl-objects';
    v.models.forEach(function (m) {
      var row = document.createElement('div');
      row.className = 'sl-object' + (m === v.selected ? ' sel' : '');
      var nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = m.name;
      var dim = document.createElement('span');
      dim.className = 'dim';
      if (m.bbox) {
        dim.textContent = fmt(m.bbox.max.x - m.bbox.min.x) + '×' + fmt(m.bbox.max.y - m.bbox.min.y) + '×' + fmt(m.bbox.max.z - m.bbox.min.z);
      }
      row.appendChild(nm); row.appendChild(dim);
      row.onclick = function () { v.select(m); renderPanel(); };
      list.appendChild(row);
    });
    body.appendChild(list);

    var m = v.selected;
    if (!m) return;

    var sections = [
      { title: 'Position', open: true, fields: [
        { path: 'position.x', label: 'X', unit: 'mm', min: -500, max: 2000, step: 1 },
        { path: 'position.y', label: 'Y', unit: 'mm', min: -500, max: 2000, step: 1 }
      ]},
      { title: 'Scale', open: true, fields: [
        { path: 'scale.x', label: 'X', unit: '%', min: 1, max: 2000, step: 1 },
        { path: 'scale.y', label: 'Y', unit: '%', min: 1, max: 2000, step: 1 },
        { path: 'scale.z', label: 'Z', unit: '%', min: 1, max: 2000, step: 1 }
      ]},
      { title: 'Rotation', open: true, fields: [
        { path: 'rotation.x', label: 'X', unit: '°', min: -360, max: 360, step: 15 },
        { path: 'rotation.y', label: 'Y', unit: '°', min: -360, max: 360, step: 15 },
        { path: 'rotation.z', label: 'Z', unit: '°', min: -360, max: 360, step: 15 }
      ]}
    ];

    var uniformRow = document.createElement('div');
    uniformRow.className = 'sl-field';
    uniformRow.innerHTML = '<label>Uniform scale</label>';
    var usw = document.createElement('span');
    usw.className = 'sl-switch';
    var ucb = document.createElement('input');
    ucb.type = 'checkbox'; ucb.checked = state.uniformScale;
    ucb.setAttribute('aria-label', 'Uniform scale');
    ucb.onchange = function () { state.uniformScale = ucb.checked; };
    usw.appendChild(ucb); usw.appendChild(document.createElement('i'));
    uniformRow.appendChild(usw);

    sections.forEach(function (section) {
      var details = document.createElement('details');
      details.className = 'sl-section';
      if (section.open) details.open = true;
      var summary = document.createElement('summary');
      summary.textContent = section.title;
      details.appendChild(summary);
      if (section.title === 'Scale') details.appendChild(uniformRow);

      section.fields.forEach(function (f) {
        var wrap = document.createElement('div');
        wrap.className = 'sl-field';
        var lab = document.createElement('label');
        lab.textContent = f.label;
        wrap.appendChild(lab);
        var control = document.createElement('div');
        control.className = 'sl-control';
        var input = document.createElement('input');
        input.type = 'number';
        input.className = 'sl-num';
        input.inputMode = 'decimal';
        input.min = f.min; input.max = f.max; input.step = f.step;
        input.value = Math.round(getPath(m, f.path) * 100) / 100;
        input.setAttribute('aria-label', section.title + ' ' + f.label);
        input.onchange = function () {
          var val = parseFloat(input.value);
          if (isNaN(val)) { input.value = getPath(m, f.path); return; }
          val = Math.max(f.min, Math.min(f.max, val));
          if (section.title === 'Scale' && state.uniformScale) {
            m.scale.x = m.scale.y = m.scale.z = val;
          } else {
            setPath(m, f.path, val);
          }
          v.applyTransform(m);
          invalidate();
          renderPanel();
        };
        control.appendChild(input);
        var u = document.createElement('span');
        u.className = 'sl-unit';
        u.textContent = f.unit;
        control.appendChild(u);
        wrap.appendChild(control);
        details.appendChild(wrap);
      });
      body.appendChild(details);
    });

    if ((state.settings.extruderCount | 0) > 1) body.appendChild(renderToolPicker(m));
    body.appendChild(renderSizeSection(m));

    var actions = [
      ['Center', function () { v.centerOnPlate(m); }],
      ['Lay flat', function () { m.rotation.x = 0; m.rotation.y = 0; v.applyTransform(m); }],
      ['Fit to plate', function () { fitToPlate(m); }],
      ['Mirror X', function () { m.mirror.x *= -1; v.applyTransform(m); }],
      ['Mirror Y', function () { m.mirror.y *= -1; v.applyTransform(m); }],
      ['Duplicate', function () { duplicate(m); }],
      ['Split to parts', function () { splitSelected(m); }],
      ['Delete', function () { v.removeModel(m); }]
    ];
    var row2 = document.createElement('div');
    row2.className = 'sl-row';
    actions.forEach(function (a) {
      var b = document.createElement('button');
      b.className = 'sl-btn';
      b.type = 'button';
      b.textContent = a[0];
      b.onclick = function () { a[1](); invalidate(); renderPanel(); refreshEmpty(); };
      row2.appendChild(b);
    });
    body.appendChild(row2);
    body.appendChild(renderCutSection(m));

    var warn = document.createElement('div');
    warn.className = 'sl-warn';
    warn.id = 'bounds-warn';
    body.appendChild(warn);
    updateBoundsWarning();
  }

  /** Dimensions in millimetres — what you actually care about when printing. */
  function renderSizeSection(m) {
    var v = state.viewer;
    var details = document.createElement('details');
    details.className = 'sl-section';
    details.open = true;
    var summary = document.createElement('summary');
    summary.textContent = 'Size (mm)';
    details.appendChild(summary);

    v.applyTransform(m);
    var span = {
      x: m.bbox.max.x - m.bbox.min.x,
      y: m.bbox.max.y - m.bbox.min.y,
      z: m.bbox.max.z - m.bbox.min.z
    };

    ['x', 'y', 'z'].forEach(function (axis) {
      var wrap = document.createElement('div');
      wrap.className = 'sl-field';
      var label = document.createElement('label');
      label.textContent = axis.toUpperCase();
      wrap.appendChild(label);

      var control = document.createElement('div');
      control.className = 'sl-control';
      var input = document.createElement('input');
      input.type = 'number';
      input.className = 'sl-num';
      input.inputMode = 'decimal';
      input.min = 0.1; input.max = 5000; input.step = 0.5;
      input.value = Math.round(span[axis] * 100) / 100;
      input.setAttribute('aria-label', 'Size ' + axis.toUpperCase());
      input.onchange = function () {
        var target = parseFloat(input.value);
        // Read the size now rather than trusting the value captured at render
        // time: a repeated change event would otherwise scale the model twice.
        v.applyTransform(m);
        var current = m.bbox.max[axis] - m.bbox.min[axis];
        if (!(target > 0) || !(current > 0)) { renderPanel(); return; }
        var ratio = target / current;
        if (state.uniformScale) {
          m.scale.x *= ratio; m.scale.y *= ratio; m.scale.z *= ratio;
        } else {
          m.scale[axis] *= ratio;
        }
        v.applyTransform(m);
        invalidate();
        renderPanel();
      };
      control.appendChild(input);
      var unit = document.createElement('span');
      unit.className = 'sl-unit';
      unit.textContent = 'mm';
      control.appendChild(unit);
      wrap.appendChild(control);
      details.appendChild(wrap);
    });
    return details;
  }

  /** Plane cut, with a live preview of where the plane sits. */
  function renderCutSection(m) {
    var v = state.viewer;
    var details = document.createElement('details');
    details.className = 'sl-section';
    var summary = document.createElement('summary');
    summary.textContent = 'Cut';
    details.appendChild(summary);

    v.applyTransform(m);
    var top = m.bbox.max.z;
    if (state.cutZ == null || state.cutZ <= 0 || state.cutZ >= top) state.cutZ = Math.round(top / 2 * 10) / 10;

    details.ontoggle = function () {
      if (details.open) v.showCutPlane(state.cutZ);
      else v.hideCutPlane();
    };

    var zRow = document.createElement('div');
    zRow.className = 'sl-field';
    zRow.innerHTML = '<label>Height</label>';
    var control = document.createElement('div');
    control.className = 'sl-control';
    var input = document.createElement('input');
    input.type = 'number';
    input.className = 'sl-num';
    input.inputMode = 'decimal';
    input.min = 0.1; input.max = Math.max(0.2, top - 0.1); input.step = 0.5;
    input.value = state.cutZ;
    input.setAttribute('aria-label', 'Cut height');
    input.oninput = function () {
      var z = parseFloat(input.value);
      if (z > 0) { state.cutZ = z; v.showCutPlane(z); }
    };
    control.appendChild(input);
    var unit = document.createElement('span');
    unit.className = 'sl-unit';
    unit.textContent = 'mm';
    control.appendChild(unit);
    zRow.appendChild(control);
    details.appendChild(zRow);

    var keepRow = document.createElement('div');
    keepRow.className = 'sl-field';
    keepRow.innerHTML = '<label>Keep</label>';
    var keepControl = document.createElement('div');
    keepControl.className = 'sl-control';
    var keep = document.createElement('select');
    keep.className = 'sl-select';
    keep.setAttribute('aria-label', 'Keep after cut');
    [['both', 'Both halves'], ['upper', 'Upper only'], ['lower', 'Lower only']].forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o[0]; opt.textContent = o[1];
      if ((state.cutKeep || 'both') === o[0]) opt.selected = true;
      keep.appendChild(opt);
    });
    keep.onchange = function () { state.cutKeep = keep.value; };
    keepControl.appendChild(keep);
    keepRow.appendChild(keepControl);
    details.appendChild(keepRow);

    var row = document.createElement('div');
    row.className = 'sl-row';
    var apply = document.createElement('button');
    apply.className = 'sl-btn primary';
    apply.type = 'button';
    apply.textContent = 'Cut';
    apply.onclick = function () { cutSelected(m, state.cutZ, keep.value); };
    row.appendChild(apply);
    details.appendChild(row);

    var note = document.createElement('div');
    note.className = 'sl-hint';
    note.textContent = 'The cut face is closed off, so both halves stay solid.';
    details.appendChild(note);
    return details;
  }

  function splitSelected(model) {
    ensureGeometry(function (err) {
      if (err) { alert('Could not load the mesh tools: ' + err.message); return; }
      var parts = window.OrcaMeshTools.splitParts(model.source, 64);
      if (parts.length < 2) {
        alert('This model is a single connected body — there is nothing to split.');
        return;
      }
      var v = state.viewer;
      var name = model.name;
      var rotation = model.rotation, scale = model.scale, mirror = model.mirror;
      v.removeModel(model);
      for (var i = 0; i < parts.length; i++) {
        var part = v.addModel(parts[i], name + ' #' + (i + 1));
        part.rotation = { x: rotation.x, y: rotation.y, z: rotation.z };
        part.scale = { x: scale.x, y: scale.y, z: scale.z };
        part.mirror = { x: mirror.x, y: mirror.y, z: mirror.z };
        v.applyTransform(part);
      }
      v.arrange();
      v.frameObjects();
      invalidate();
      refreshEmpty();
      renderPanel();
    });
  }

  function cutSelected(model, z, keep) {
    ensureGeometry(function (err) {
      if (err) { alert('Could not load the mesh tools: ' + err.message); return; }
      var v = state.viewer;
      // The cut plane is horizontal in bed space, which it is not in model space
      // once the object is rotated — so cut the transformed geometry and let the
      // halves start life untransformed.
      v.applyTransform(model);
      var world = v.worldTriangles(model);
      var result = window.OrcaMeshTools.cutAtZ(world, z);

      var pieces = [];
      if (keep !== 'lower' && result.above.length >= 9) pieces.push(['upper', result.above]);
      if (keep !== 'upper' && result.below.length >= 9) pieces.push(['lower', result.below]);
      if (!pieces.length) {
        alert('That cut height is outside the model.');
        return;
      }

      var name = model.name;
      v.removeModel(model);
      for (var i = 0; i < pieces.length; i++) {
        v.addModel(pieces[i][1], name + ' ' + pieces[i][0]);
      }
      if (pieces.length > 1) v.arrange();
      v.hideCutPlane();
      v.frameObjects();
      invalidate();
      refreshEmpty();
      renderPanel();
    });
  }

  function fitToPlate(m) {
    var v = state.viewer;
    v.applyTransform(m);
    var w = m.bbox.max.x - m.bbox.min.x, d = m.bbox.max.y - m.bbox.min.y, h = m.bbox.max.z - m.bbox.min.z;
    var factor = Math.min((v.bed.x - 10) / w, (v.bed.y - 10) / d, (v.bed.z - 5) / h);
    var target = Math.max(1, Math.round(m.scale.x * factor));
    m.scale.x = m.scale.y = m.scale.z = target;
    v.centerOnPlate(m);
  }

  function duplicate(m) {
    var v = state.viewer;
    var copy = v.addModel(m.source, m.name);
    copy.scale = { x: m.scale.x, y: m.scale.y, z: m.scale.z };
    copy.rotation = { x: m.rotation.x, y: m.rotation.y, z: m.rotation.z };
    copy.mirror = { x: m.mirror.x, y: m.mirror.y, z: m.mirror.z };
    v.applyTransform(copy);
    v.arrange();
  }

  function fmt(n) { return (Math.round(n * 10) / 10).toFixed(1); }

  function updateBoundsWarning() {
    var warn = el('bounds-warn');
    if (!warn) return;
    warn.className = 'sl-warn';
    warn.textContent = state.viewer.outOfBounds() ? 'This model sticks out of the build volume — it will still slice, but the printer may refuse or crash into the frame.' : '';
  }

  // ---------------------------------------------------------------------------
  // Presets & persistence
  // ---------------------------------------------------------------------------

  var narrowQuery = window.matchMedia('(max-width: 900px)');

  function presetsBelong() { return narrowQuery.matches ? 'panel' : 'topbar'; }

  /** Keep the single preset row in whichever place currently has room for it. */
  function placePresets() {
    var presets = state.presetsEl;
    if (presetsBelong() === 'topbar') {
      presets.classList.remove('in-panel');
      if (presets.parentElement !== el('topbar')) el('topbar').insertBefore(presets, el('btn-panel'));
    } else {
      presets.classList.add('in-panel');
      if (state.tab === 'print' && el('panel').classList.contains('open')) renderPanel();
      else if (presets.parentElement === el('topbar')) el('topbar').removeChild(presets);
    }
  }

  function fillSelect(select, map, selected) {
    select.innerHTML = '';
    // Group by brand when the entries carry one — 36 printers in one flat list
    // is unusable, especially on a touch screen.
    var groups = {}, order = [];
    Object.keys(map).forEach(function (k) {
      var brand = map[k].brand || '';
      if (!groups[brand]) { groups[brand] = []; order.push(brand); }
      groups[brand].push(k);
    });

    order.forEach(function (brand) {
      var parent = select;
      if (brand) {
        parent = document.createElement('optgroup');
        parent.label = brand;
        select.appendChild(parent);
      }
      groups[brand].forEach(function (k) {
        var o = document.createElement('option');
        o.value = k;
        o.textContent = map[k].name;
        if (k === selected) o.selected = true;
        parent.appendChild(o);
      });
    });
  }

  function syncPresetSelects() {
    el('sel-printer').value = state.settings.printerKey;
    el('sel-filament').value = state.settings.filamentKey;
    el('sel-quality').value = state.settings.qualityKey;
  }

  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings)); } catch (e) { /* private mode */ }
  }

  function restore() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var saved = JSON.parse(raw);
      if (!saved || !saved.speeds || !saved.printerKey) return null;
      var base = P.buildSettings(saved.printerKey, saved.filamentKey, saved.qualityKey);
      Object.keys(base).forEach(function (k) {
        if (saved[k] === undefined) return;
        base[k] = (k === 'speeds') ? Object.assign(base.speeds, saved.speeds) : saved[k];
      });
      return base;
    } catch (e) { return null; }
  }

  function applyBed() {
    state.viewer.setBed(state.settings.bedX, state.settings.bedY, state.settings.bedZ, state.settings.bedShape);
    state.viewer.models.forEach(function (m) { state.viewer.applyTransform(m); });
  }

  function onPresetChange() {
    state.settings = P.buildSettings(el('sel-printer').value, el('sel-filament').value, el('sel-quality').value);
    persist();
    applyBed();
    renderPanel();
    invalidate();
  }

  // ---------------------------------------------------------------------------
  // Loading models
  // ---------------------------------------------------------------------------

  async function loadFiles(files) {
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      try {
        showProgress('Reading ' + file.name, 0.4);
        var positions = await window.OrcaLoaders.loadFile(file);
        if (!positions || positions.length < 9) throw new Error('No triangles found in ' + file.name);
        var model = state.viewer.addModel(positions, file.name.replace(/\.[^.]+$/, ''));
        if (state.viewer.models.length > 1) state.viewer.arrange();
        if (model.bbox && (model.bbox.max.x - model.bbox.min.x > state.settings.bedX ||
                           model.bbox.max.y - model.bbox.min.y > state.settings.bedY)) {
          fitToPlate(model);
        }
      } catch (err) {
        alert('Could not load ' + file.name + '\n\n' + (err.message || err));
      }
    }
    hideProgress();
    refreshEmpty();
    state.viewer.frameObjects();
    invalidate();
    renderPanel();
  }

  // Small procedurally generated models, handy when you have no files at hand
  // (which is most of the time on a tablet).
  function demoModel(kind) {
    var t = [];
    function tri(a, b, c) { t.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); }
    function quad(a, b, c, d) { tri(a, b, c); tri(a, c, d); }

    if (kind === 'cube') {
      var s = 20;
      var v = [[0,0,0],[s,0,0],[s,s,0],[0,s,0],[0,0,s],[s,0,s],[s,s,s],[0,s,s]];
      [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]]
        .forEach(function (f) { tri(v[f[0]], v[f[1]], v[f[2]]); });
    } else if (kind === 'cylinder') {
      var R = 14, r = 9, H = 24, N = 64;
      for (var i = 0; i < N; i++) {
        var a0 = i / N * Math.PI * 2, a1 = (i + 1) / N * Math.PI * 2;
        var o0 = [Math.cos(a0) * R, Math.sin(a0) * R], o1 = [Math.cos(a1) * R, Math.sin(a1) * R];
        var i0 = [Math.cos(a0) * r, Math.sin(a0) * r], i1 = [Math.cos(a1) * r, Math.sin(a1) * r];
        quad([o0[0], o0[1], 0], [o1[0], o1[1], 0], [o1[0], o1[1], H], [o0[0], o0[1], H]);
        quad([i0[0], i0[1], 0], [i0[0], i0[1], H], [i1[0], i1[1], H], [i1[0], i1[1], 0]);
        quad([o0[0], o0[1], 0], [i0[0], i0[1], 0], [i1[0], i1[1], 0], [o1[0], o1[1], 0]);
        quad([o0[0], o0[1], H], [o1[0], o1[1], H], [i1[0], i1[1], H], [i0[0], i0[1], H]);
      }
    } else {
      var b = 26, h = 22;
      var base = [[0,0,0],[b,0,0],[b,b,0],[0,b,0]];
      var apex = [b/2, b/2, h];
      tri(base[0], base[2], base[1]); tri(base[0], base[3], base[2]);
      for (var k = 0; k < 4; k++) tri(base[k], base[(k + 1) % 4], apex);
    }
    return new Float32Array(t);
  }

  // ---------------------------------------------------------------------------
  // Slicing
  // ---------------------------------------------------------------------------

  function ensureWorker() {
    if (state.worker) return state.worker;
    if (state.workerBroken) return null;
    try {
      state.worker = new Worker('js/slicer/worker.js');
    } catch (e) {
      state.workerBroken = true;
      return null;
    }
    state.worker.onmessage = function (ev) {
      var msg = ev.data;
      if (msg.type === 'progress') {
        showProgress(msg.label || 'Slicing…', msg.value);
      } else if (msg.type === 'done') {
        onSliced(msg);
      } else if (msg.type === 'error') {
        state.slicing = false;
        hideProgress();
        el('btn-slice').disabled = false;
        alert('Slicing failed:\n\n' + msg.message);
      }
    };
    // A worker that never loads (a WebView that will not serve its script, a
    // locked-down browser) must not be the end of it — slice in the page instead.
    state.worker.onerror = function () {
      state.workerBroken = true;
      try { state.worker.terminate(); } catch (e) { /* already gone */ }
      state.worker = null;
      if (state.slicing && state.pendingPositions) {
        var positions = state.pendingPositions;
        state.pendingPositions = null;
        sliceInPage(positions);
      }
    };
    return state.worker;
  }

  function slice() {
    var v = state.viewer;
    if (!v.models.length || state.slicing) return;
    var positions = v.collectTriangles();
    if (!positions.length) return;

    state.slicing = true;
    el('btn-slice').disabled = true;
    el('btn-export').disabled = true;
    showProgress('Preparing…', 0.01);

    // Painted marks belong to this plate, not to the profile, so they are added
    // on the way out rather than kept in the saved settings.
    state.pendingSettings = JSON.parse(JSON.stringify(state.settings));
    state.pendingSettings.paintMarks = v.collectPaintMarks();

    // Both printing one object at a time and printing with more than one tool
    // need each model's triangles kept apart.
    var manyTools = (state.settings.extruderCount | 0) > 1 &&
      v.models.some(function (m) { return (m.extruder | 0) !== (v.models[0].extruder | 0); });
    var objects = (state.settings.printSequence === 'object' && v.models.length > 1) || manyTools
      ? v.collectObjects() : null;
    state.pendingObjects = objects;

    var worker = ensureWorker();
    if (!worker) { sliceInPage(positions); return; }

    // Keep a copy: if the worker turns out to be unusable we still need the mesh.
    state.pendingPositions = positions.slice();
    worker.postMessage({
      cmd: 'slice',
      positions: positions,
      objects: objects,
      settings: state.pendingSettings
    }, [positions.buffer]);
  }

  /** Load the engine into the page and slice here. Blocks, but it always works. */
  function sliceInPage(positions) {
    showProgress('Loading engine…', 0.05);
    loadScripts(['js/vendor/clipper.js', 'js/slicer/engine.js', 'js/slicer/beading.js', 'js/slicer/lightning.js', 'js/slicer/treesupport.js', 'js/slicer/template.js', 'js/slicer/gcodecheck.js'], function (err) {
      if (err) {
        state.slicing = false;
        hideProgress();
        el('btn-slice').disabled = false;
        alert('Could not load the slicing engine: ' + err.message);
        return;
      }
      showProgress('Slicing…', 0.1);
      // Yield once so the progress pill actually paints before we block.
      setTimeout(function () {
        try {
          var result = window.OrcaEngine.slice({
            positions: positions,
            objects: state.pendingObjects,
            settings: state.pendingSettings || JSON.parse(JSON.stringify(state.settings))
          }, function () { /* no repaint possible on this thread */ });
          onSliced({
            layers: window.OrcaEngine.packLayers(result.layers),
            gcode: result.gcode,
            stats: result.stats,
            report: result.report,
            bounds: result.bounds
          });
        } catch (e) {
          state.slicing = false;
          hideProgress();
          el('btn-slice').disabled = false;
          alert('Slicing failed:\n\n' + (e.message || e));
        }
      }, 60);
    });
  }

  /**
   * Split and cut need the geometry helpers in the page rather than the worker.
   * They are occasional, user-driven actions, so the modules load on first use.
   */
  function ensureGeometry(done) {
    if (window.OrcaMeshTools && window.OrcaEngineGeom && window.earcut) { done(null); return; }
    showProgress('Loading tools…', 0.4);
    loadScripts([
      'js/vendor/clipper.js', 'js/vendor/earcut.js',
      'js/slicer/engine.js', 'js/slicer/meshtools.js', 'js/slicer/gcodecheck.js'
    ], function (err) {
      hideProgress();
      done(err);
    });
  }

  /** Load scripts in order, once. */
  function loadScripts(urls, done) {
    var loaded = state.loadedScripts || (state.loadedScripts = {});
    var i = 0;
    (function next() {
      if (i >= urls.length) { done(null); return; }
      var url = urls[i++];
      if (loaded[url]) { next(); return; }
      var tag = document.createElement('script');
      tag.src = url;
      tag.onload = function () { loaded[url] = true; next(); };
      tag.onerror = function () { done(new Error(url)); };
      document.head.appendChild(tag);
    })();
  }

  function onSliced(msg) {
    state.slicing = false;
    state.pendingPositions = null;
    state.result = msg;
    el('btn-slice').disabled = false;
    el('btn-export').disabled = false;
    el('tool-preview').disabled = false;

    state.viewer.buildPreview(msg.layers, state.showTravels);
    setPreview(true);

    var range = el('layer-range');
    range.max = Math.max(0, msg.layers.length - 1);
    range.value = range.max;
    updateLayerLabel();

    renderStats(msg.stats);
    renderLegend();
    updateCheckStatus();
    applyExportGate();
    hideProgress();

    // A file that would damage the machine should not wait to be discovered.
    if (msg.report && msg.report.errors > 0) openPanel('check');
  }

  /** The export button reflects the verdict of the check. */
  function applyExportGate() {
    var button = el('btn-export');
    var report = state.result && state.result.report;
    var blocked = !!(report && report.errors > 0) && !state.safetyOverride;
    button.classList.toggle('blocked', blocked);
    button.title = blocked ? 'Blocked by the G-code safety check' : 'Download G-code';
  }

  function invalidate() {
    // Settings or geometry changed — the previous G-code no longer matches.
    if (!state.result) return;
    state.result = null;
    state.safetyOverride = false;
    el('check-status').classList.remove('show');
    el('btn-export').classList.remove('blocked');
    el('btn-export').disabled = true;
    el('tool-preview').disabled = true;
    setPreview(false);
    el('stats').classList.remove('show');
    el('legend').classList.remove('show');
    el('layers').classList.remove('show');
    updateBoundsWarning();
  }

  function setPreview(on) {
    state.previewOn = !!on && !!state.result;
    state.viewer.showPreview(state.previewOn);
    el('layers').classList.toggle('show', state.previewOn);
    el('legend').classList.toggle('show', state.previewOn);
    el('stats').classList.toggle('show', state.previewOn);
    el('tool-preview').classList.toggle('on', state.previewOn);
    updateCheckStatus();
  }

  function updateLayerLabel() {
    if (!state.result) return;
    var idx = parseInt(el('layer-range').value, 10);
    var layer = state.result.layers[idx];
    el('layer-num').textContent = (idx + 1) + '/' + state.result.layers.length;
    el('layer-z').textContent = layer ? layer.z.toFixed(2) + ' mm' : '';
    state.viewer.setVisibleLayers(state.singleLayer ? idx : 0, idx);
  }

  function renderStats(stats) {
    var box = el('stats');
    box.innerHTML = '';
    var items = [
      [formatTime(stats.seconds), 'Est. time'],
      [stats.grams.toFixed(1) + ' g', 'Filament'],
      [(stats.filamentMm / 1000).toFixed(2) + ' m', 'Length'],
      [stats.cost.toFixed(2) + ' €', 'Cost'],
      [String(stats.layers), 'Layers']
    ];
    items.forEach(function (it) {
      var d = document.createElement('div');
      d.className = 'sl-stat';
      d.innerHTML = '<b></b><span></span>';
      d.querySelector('b').textContent = it[0];
      d.querySelector('span').textContent = it[1];
      box.appendChild(d);
    });
  }

  function formatTime(sec) {
    sec = Math.round(sec);
    var h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    if (h) return h + 'h ' + String(m).padStart(2, '0') + 'm';
    if (m) return m + ' min';
    return sec + ' s';
  }

  function renderLegend() {
    var box = el('legend');
    box.innerHTML = '';
    var used = {};
    state.result.layers.forEach(function (l) {
      for (var i = 0; i < l.types.length; i++) used[l.types[i]] = true;
    });
    Object.keys(used).sort(function (a, b) { return a - b; }).forEach(function (code) {
      // A feature type the viewer has no colour for must not take the page down.
      var colour = window.OrcaViewer.FEATURE_COLORS[code];
      if (colour == null) return;
      var span = document.createElement('span');
      var swatch = document.createElement('i');
      swatch.style.background = '#' + colour.toString(16).padStart(6, '0');
      span.appendChild(swatch);
      span.appendChild(document.createTextNode(window.OrcaViewer.FEATURE_LABELS[code] || 'Type ' + code));
      box.appendChild(span);
    });
  }

  function exportGcode() {
    if (!state.result) return;
    var name = (state.viewer.models[0] && state.viewer.models[0].name) || 'model';
    var quality = state.settings.layerHeight.toFixed(2).replace('.', 'p');
    var filename = name.replace(/[^\w-]+/g, '_') + '_' + quality + 'mm_' +
      (P.FILAMENTS[state.settings.filamentKey] || { name: 'PLA' }).name + '.gcode';

    var gcode = withThumbnail(state.result.gcode);

    // Check the exact bytes that are about to leave, not the ones that were
    // checked earlier — the thumbnail was spliced in since.
    var report = window.OrcaGcodeCheck
      ? window.OrcaGcodeCheck.verify(gcode, state.settings)
      : { errors: 1, warnings: 0, findings: [{ severity: 'error', code: 'checker.missing', line: 0, text: '',
          message: 'The G-code safety check could not run', detail: 'gcodecheck.js was not loaded.' }] };
    state.result.report = report;
    updateCheckStatus();
    if (report.errors > 0 && !state.safetyOverride) {
      openPanel('check');
      return;
    }

    // Inside the Android app a blob download is a dead end, so hand the G-code
    // to the native side in chunks and let the system storage picker place it.
    if (window.AndroidSlicer) { exportViaAndroid(filename, gcode); return; }

    var blob = new Blob([gcode], { type: 'text/plain' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  /**
   * Embed a preview image the way PrusaSlicer does, so printers and web
   * interfaces that read `; thumbnail begin` show the part on their screen.
   */
  function withThumbnail(gcode) {
    if (!state.settings.thumbnails || !state.previewOn) return gcode;
    var size = 300;
    var dataUrl = state.viewer.snapshot(size);
    if (!dataUrl || dataUrl.indexOf('base64,') < 0) return gcode;

    var base64 = dataUrl.slice(dataUrl.indexOf('base64,') + 7);
    var lines = ['', '; thumbnail begin ' + size + 'x' + size + ' ' + base64.length];
    for (var i = 0; i < base64.length; i += 78) lines.push('; ' + base64.substr(i, 78));
    lines.push('; thumbnail end', '');

    var head = gcode.indexOf('\n');
    return gcode.slice(0, head + 1) + lines.join('\n') + gcode.slice(head + 1);
  }

  /** Stream the G-code across the JS bridge in pieces the WebView can carry. */
  function exportViaAndroid(filename, gcode) {
    var CHUNK = 256 * 1024;
    try {
      if (!window.AndroidSlicer.beginSave(filename)) throw new Error('beginSave refused');
      for (var i = 0; i < gcode.length; i += CHUNK) {
        if (!window.AndroidSlicer.appendSave(gcode.slice(i, i + CHUNK))) throw new Error('appendSave refused');
      }
      window.AndroidSlicer.endSave();
    } catch (err) {
      alert('Could not hand the G-code to Android: ' + (err.message || err));
    }
  }

  /** Android back button: close the settings sheet before leaving the app. */
  window.OrcaAndroidBack = function () {
    if (el('panel') && el('panel').classList.contains('open')) { closePanel(); return true; }
    return false;
  };

  // ---------------------------------------------------------------------------
  // Chrome
  // ---------------------------------------------------------------------------

  function showProgress(label, value) {
    el('progress').classList.add('show');
    el('progress-label').textContent = label;
    el('progress-bar').style.width = Math.round(value * 100) + '%';
  }
  function hideProgress() { el('progress').classList.remove('show'); }

  function refreshEmpty() {
    el('empty').style.display = state.viewer.models.length ? 'none' : 'grid';
    el('btn-slice').disabled = !state.viewer.models.length || state.slicing;
  }

  function openPanel(tab) {
    if (tab) state.tab = tab;
    document.querySelectorAll('.sl-tab').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tab === state.tab);
    });
    renderPanel();
    el('panel').classList.add('open');
    el('backdrop').classList.add('show');
  }
  function closePanel() {
    el('panel').classList.remove('open');
    el('backdrop').classList.remove('show');
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  function init() {
    if (!window.THREE) { alert('3D library failed to load.'); return; }

    if (window.AndroidSlicer) {
      document.body.classList.add('is-android');
      var brand = document.querySelector('.sl-brand');
      if (brand) { brand.removeAttribute('href'); brand.removeAttribute('title'); }
    }

    state.presetsEl = el('presets');
    state.settings = restore() || P.buildSettings('centauri_carbon', 'pla', 'q020');

    state.viewer = new window.OrcaViewer(el('sl-canvas'), {
      onSelect: function () { if (state.tab === 'object') renderPanel(); },
      onMove: function () { updateBoundsWarning(); invalidate(); }
    });
    applyBed();
    state.viewer.setView('iso');

    fillSelect(el('sel-printer'), P.PRINTERS, state.settings.printerKey);
    fillSelect(el('sel-filament'), P.FILAMENTS, state.settings.filamentKey);
    fillSelect(el('sel-quality'), P.QUALITY, state.settings.qualityKey);
    ['sel-printer', 'sel-filament', 'sel-quality'].forEach(function (id) {
      el(id).addEventListener('change', onPresetChange);
    });

    el('btn-open').onclick = el('btn-open2').onclick = function () { el('file-input').click(); };
    el('profile-input').onchange = function (ev) {
      if (ev.target.files && ev.target.files[0]) importProfile(ev.target.files[0]);
      ev.target.value = '';
    };
    el('file-input').onchange = function (ev) {
      if (ev.target.files && ev.target.files.length) loadFiles(ev.target.files);
      ev.target.value = '';
    };

    document.querySelectorAll('[data-demo]').forEach(function (btn) {
      btn.onclick = function () {
        state.viewer.addModel(demoModel(btn.dataset.demo), btn.dataset.demo);
        if (state.viewer.models.length > 1) state.viewer.arrange();
        refreshEmpty();
        state.viewer.frameObjects();
        invalidate();
      };
    });

    el('btn-slice').onclick = slice;
    el('btn-export').onclick = exportGcode;
    el('btn-panel').onclick = function () {
      if (el('panel').classList.contains('open')) closePanel(); else openPanel();
    };
    el('btn-panel-close').onclick = closePanel;
    el('backdrop').onclick = closePanel;
    el('check-status').onclick = function () { openPanel('check'); };
    document.querySelectorAll('.sl-tab').forEach(function (b) {
      b.onclick = function () { openPanel(b.dataset.tab); };
    });

    el('tool-orbit').onclick = function () { setTool('orbit'); };
    el('tool-move').onclick = function () { setTool('move'); };
    el('tool-face').onclick = function () { setTool('face'); };
    el('tool-paint').onclick = function () { setTool(state.viewer.mode === 'paint' ? 'orbit' : 'paint'); };
    bindPaint();
    el('tool-arrange').onclick = function () { state.viewer.arrange(); invalidate(); renderPanel(); };
    el('tool-delete').onclick = function () {
      if (state.viewer.selected) { state.viewer.removeModel(state.viewer.selected); invalidate(); refreshEmpty(); renderPanel(); }
    };
    el('tool-preview').onclick = function () { setPreview(!state.previewOn); };

    document.querySelectorAll('[data-view]').forEach(function (b) {
      b.onclick = function () { state.viewer.setView(b.dataset.view); };
    });

    el('layer-range').oninput = updateLayerLabel;
    el('btn-single').onclick = function () {
      state.singleLayer = !state.singleLayer;
      el('btn-single').classList.toggle('on', state.singleLayer);
      updateLayerLabel();
    };
    el('btn-travels').onclick = function () {
      state.showTravels = !state.showTravels;
      el('btn-travels').classList.toggle('on', state.showTravels);
      state.viewer.setTravelsVisible(state.showTravels);
    };

    bindDropzone();
    placePresets();
    if (narrowQuery.addEventListener) narrowQuery.addEventListener('change', placePresets);
    else narrowQuery.addListener(placePresets);
    refreshEmpty();
    renderPanel();

    document.addEventListener('keydown', function (ev) {
      if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA') return;
      if (ev.key === 'Delete' || ev.key === 'Backspace') el('tool-delete').click();
      if (ev.key === 'p' || ev.key === 'P') el('tool-preview').click();
      if (ev.key === 'Enter' && !state.slicing) slice();
    });
  }

  window.addEventListener('orientationchange', function () {
    setTimeout(function () { state.viewer && state.viewer.frameObjects(); }, 250);
  });

  function setTool(tool) {
    state.viewer.setMode(tool);
    el('tool-orbit').classList.toggle('on', tool === 'orbit');
    el('tool-move').classList.toggle('on', tool === 'move');
    el('tool-face').classList.toggle('on', tool === 'face');
    el('tool-paint').classList.toggle('on', tool === 'paint');
    el('paint-palette').hidden = tool !== 'paint';
  }

  /** The brush palette: which kind of mark the next tap leaves, and how big. */
  function bindPaint() {
    var v = state.viewer;
    var palette = el('paint-palette');

    palette.querySelectorAll('[data-paint]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        v.paintKind = btn.dataset.paint;
        palette.querySelectorAll('[data-paint]').forEach(function (b) {
          b.classList.toggle('on', b === btn);
        });
      });
    });

    var size = el('paint-size');
    size.addEventListener('input', function () {
      v.paintRadius = parseFloat(size.value);
      el('paint-size-value').textContent = size.value + ' mm';
    });
    el('paint-clear').addEventListener('click', function () {
      v.clearPaint();
      updatePaintCount();
    });
    v.onPaint = updatePaintCount;
    updatePaintCount();
  }

  function updatePaintCount() {
    var n = state.viewer.paintCount();
    el('paint-count').textContent = n ? n + ' mark' + (n === 1 ? '' : 's') : 'nothing painted';
    el('paint-clear').disabled = !n;
  }

  function bindDropzone() {
    var zone = el('dropzone');
    var depth = 0;
    ['dragenter', 'dragover'].forEach(function (type) {
      window.addEventListener(type, function (ev) {
        ev.preventDefault();
        if (type === 'dragenter') depth++;
        zone.classList.add('active');
      });
    });
    window.addEventListener('dragleave', function () {
      if (--depth <= 0) { depth = 0; zone.classList.remove('active'); }
    });
    window.addEventListener('drop', function (ev) {
      ev.preventDefault();
      depth = 0;
      zone.classList.remove('active');
      if (ev.dataTransfer && ev.dataTransfer.files.length) loadFiles(ev.dataTransfer.files);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
