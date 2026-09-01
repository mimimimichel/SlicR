/**
 * Orca Web Slicer — Presets.
 *
 * Printers, filaments, quality profiles and G-code flavours.
 * Loaded as a plain script (browser, worker) or required under Node for tests.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // G-code flavours
  //
  // Most firmwares understand the same core, so a flavour only carries the
  // handful of commands that genuinely differ.
  // ---------------------------------------------------------------------------

  var FLAVORS = {
    marlin: {
      name: 'Marlin / Marlin 2',
      acceleration: function (a) { return 'M204 S' + Math.round(a); },
      fan: function (pwm) { return pwm > 0 ? 'M106 S' + pwm : 'M107'; },
      supportsArcs: true
    },
    klipper: {
      name: 'Klipper',
      // Klipper answers M204 as well as SET_VELOCITY_LIMIT, and M204 is what
      // these machines' own vendor scripts use — Elegoo call it inside their
      // start G-code. A firmware that has trimmed the extended command still
      // takes this one.
      acceleration: function (a) { return 'M204 S' + Math.round(a); },
      fan: function (pwm) { return pwm > 0 ? 'M106 S' + pwm : 'M107'; },
      supportsArcs: true
    },
    reprap: {
      name: 'RepRap / Duet',
      acceleration: function (a) { return 'M204 P' + Math.round(a) + ' T' + Math.round(a); },
      fan: function (pwm) { return pwm > 0 ? 'M106 P0 S' + pwm : 'M106 P0 S0'; },
      supportsArcs: true
    },
    smoothie: {
      name: 'Smoothieware',
      acceleration: function (a) { return 'M204 S' + Math.round(a); },
      fan: function (pwm) { return pwm > 0 ? 'M106 S' + pwm : 'M107'; },
      supportsArcs: false
    }
  };

  // ---------------------------------------------------------------------------
  // Shared start / end G-code templates
  //
  // Placeholders: {nozzle_temp} {bed_temp} {bed_x} {bed_y} {layer_height}
  // ---------------------------------------------------------------------------

  var STARTS = {
    // Warm before homing, not hot: every vendor profile I have compared this
    // against sets 150 °C for the homing move and only then goes to temperature.
    // A nozzle brought straight to 215 drools onto the plate while the machine
    // homes, and then drags through what it left.
    standard: [
      'G90 ; absolute coordinates',
      'M140 S{bed_temp} ; set bed temp',
      'M104 S{min(150, nozzle_temp)} ; warm, not hot enough to drool',
      'G28 ; home all axes',
      'M190 S{bed_temp} ; wait for bed',
      'M104 S{nozzle_temp} ; set nozzle temp',
      'M109 S{nozzle_temp} ; wait for nozzle',
      'G92 E0',
      'G1 Z2.0 F{z_feed}',
      'G1 X5 Y20 Z0.3 F5000',
      'G1 X5 Y{prime_end} Z0.3 F1500 E15 ; prime line',
      'G1 X5.4 Y{prime_end} Z0.3 F5000',
      'G1 X5.4 Y20 Z0.3 F1500 E30 ; prime line back',
      'G92 E0'
    ].join('\n'),

    // Same, plus the stored mesh. M420 loads what the machine already measured;
    // G29 re-probes the whole bed on every print, which is what this used to
    // send. No vendor profile does that — Sovol load the mesh, Creality and
    // Anycubic leave it to the firmware — and on a machine set up for manual
    // mesh levelling a bare G29 starts an interactive procedure and waits.
    mesh: [
      'G90 ; absolute coordinates',
      'M140 S{bed_temp}',
      'M104 S{min(150, nozzle_temp)} ; warm, not hot enough to drool',
      'G28 ; home all axes',
      'M420 S1 ; use the mesh the machine has stored',
      'M190 S{bed_temp}',
      'M104 S{nozzle_temp}',
      'M109 S{nozzle_temp}',
      'G92 E0',
      'G1 Z2.0 F{z_feed}',
      'G1 X5 Y20 Z0.3 F5000',
      'G1 X5 Y{prime_end} Z0.3 F1500 E15 ; prime line',
      'G1 X5.4 Y{prime_end} Z0.3 F5000',
      'G1 X5.4 Y20 Z0.3 F1500 E30 ; prime line back',
      'G92 E0'
    ].join('\n'),

    // The Centauri Carbon 2, from Elegoo's own machine G-code, and a different
    // machine from the first one under the lid: it probes the plate on every
    // print (BED_MESH_CALIBRATE over just the area about to be used) where the
    // CC1 wipes the nozzle and trusts a stored mesh, it loads filament through
    // M6211, and it parks with G180 rather than M749.
    centauri2: [
      ';===== Elegoo Centauri Carbon 2 =====',
      'G90',
      'M104 S140 ; warm, not hot enough to drool while probing',
      'M140 S{bed_temp}',
      // Elegoo pass an A flag here that their firmware reads and nothing else
      // does. Without it this simply waits, which is the safe reading.
      'M190 S{bed_temp} ; wait for the bed before touching it with the probe',
      'M106 S0',
      'BED_MESH_CALIBRATE mesh_min={max(5, first_layer_min_x - 5)},{max(5, first_layer_min_y - 5)}' +
        ' mesh_max={min(bed_x - 5, first_layer_max_x + 5)},{min(bed_y - 5, first_layer_max_y + 5)}' +
        ' ALGORITHM=bicubic PROBE_COUNT=9,9 ADAPTIVE=0 ADAPTIVE_MARGIN=0 FROM_SLICER=1',
      'G28 ; home',
      'M109 S{nozzle_temp} ; wait for the nozzle',
      'M6211 A1 L200 T0 Q{nozzle_temp} R{nozzle_temp} S{nozzle_temp} ; load filament',
      'T0',
      'SET_PRINT_STATS_INFO TOTAL_LAYER={total_layers} CURRENT_LAYER=0',
      // The purge line runs along the lip in front of the plate. If the part
      // starts within half a millimetre of that edge, there is nowhere to put
      // it and the filament is pushed out on the spot instead.
      '{if first_layer_min_y > 0.5}',
      'G180 S7',
      'G1 X{bed_x / 2 - 1} Y-1.2 F20000',
      'G1 Z0.5 F900',
      'M83',
      'G92 E0',
      'G1 E6 F600 ; charge the nozzle',
      'M106 S200',
      'G1 X{bed_x / 2 - 41} E20 F3000 ; purge line',
      'G1 F6000',
      'G1 X{bed_x / 2 - 46} E0.8',
      'M106 S0',
      'G180 S8',
      '{else}',
      'M83',
      'G92 E0',
      'G1 E30 F600 ; nowhere to draw a line, so push it out where it stands',
      '{endif}',
      'G1 F20000',
      'G92 E0'
    ].join('\n'),

    // Elegoo's Neptune 4 family, from their own machine G-code. It levels in
    // firmware and has no G29 — Klipper does not have that command at all, and
    // refuses a file that uses it.
    neptune4: [
      'M400 ; let the buffer drain',
      'M220 S100 ; feed rate back to 100%',
      'M221 S100 ; flow rate back to 100%',
      'M104 S140 ; warm, not hot enough to drool',
      'M190 S{bed_temp} ; wait for the bed',
      'G90',
      'G28 ; home',
      'G1 Z10 F300',
      'G1 X{purge_end} Y0.5 F6000',
      'G1 Z0.4 F300',
      'M109 S{nozzle_temp} ; wait for the nozzle',
      'G92 E0',
      'G1 X{purge_far} E30 F400 ; prime line along the front edge',
      'G1 Z0.6 F120 ; up off the line',
      'G1 X{purge_back} F3000',
      'G92 E0'
    ].join('\n'),

    // The Sidewinders and the Genius, from Artillery's own machine G-code. Three
    // things here that the generic script does not do, in the order they matter:
    // the Z lift BEFORE homing, because a bed slinger homes X and Y first and
    // drags the nozzle across the plate from wherever the last print left it;
    // M420 to actually switch the mesh on after probing it; and M200 D0, since
    // volumetric extrusion left on by another job silently rescales every E in
    // this one.
    artillery: [
      'G90 ; absolute coordinates',
      'M83 ; relative extrusion for the prime',
      'M200 D0 ; volumetric extrusion off',
      'M220 S100 ; feed rate back to 100%',
      'M221 S100 ; flow rate back to 100%',
      'M190 S{bed_temp} ; wait for the bed',
      'M104 S{nozzle_temp} ; start the nozzle, do not wait',
      'G1 Z3 F3000 ; up off the plate before homing drags across it',
      'G28 ; home',
      'G1 X3 Y3 F5000 ; ooze in the corner, not over the print',
      'M109 S{nozzle_temp} ; wait for the nozzle',
      'M190 S{bed_temp}',
      '{abl}',
      'G92 E0',
      'G1 Z3 F3000',
      'G1 X10 Y0.5 Z0.25 F5000 ; prime line along the front edge',
      'G1 X100 Y0.5 Z0.25 F1500 E15',
      'G1 X100 Y0.2 Z0.25 F5000',
      'G1 X10 Y0.2 Z0.25 F1500 E15',
      'G92 E0'
    ].join('\n'),

    // The X3 and X4 generation has the wipe and the prime line in firmware.
    artillery_x3: [
      'G90 ; absolute coordinates',
      'M200 D0 ; volumetric extrusion off',
      'M220 S100',
      'M221 S100',
      'M104 S140 ; warm, not hot enough to drool',
      'M190 S{bed_temp} ; wait for the bed',
      'G1 Z3 F3000 ; up off the plate before homing drags across it',
      'G28 ; home',
      'NOZZLE_WIPE',
      'M109 S{nozzle_temp} ; wait for the nozzle',
      'DRAW_LINE_ONLY ; the machine primes itself',
      'G92 E0'
    ].join('\n'),

    klipper: [
      'START_PRINT BED_TEMP={bed_temp} EXTRUDER_TEMP={nozzle_temp}',
      'G92 E0'
    ].join('\n'),

    // Elegoo Centauri Carbon. Transliterated from Elegoo's own machine G-code in
    // the OrcaSlicer profile they maintain, because this machine does not have
    // the START_PRINT macro the DIY Klipper builds do, and the generic script is
    // wrong for it in two ways that both end with the nozzle on the plate: it
    // never calls M729, the firmware routine that wipes the nozzle and applies
    // the stored Z offset and mesh, and it purges on the print area instead of
    // the strip in front of it.
    centauri: [
      ';===== Elegoo Centauri Carbon =====',
      'M400 ; let the buffer drain before touching anything',
      'M220 S100 ; feed rate back to 100%',
      'M221 S100 ; flow rate back to 100%',
      'M104 S140 ; warm, but not hot enough to drool while homing',
      'M140 S{bed_temp}',
      'G90',
      'M83',
      'G28 ; home',
      'M729 ; clean the nozzle, load the mesh and the Z offset',
      'M190 S{bed_temp} ; wait for the bed',
      'M109 S{nozzle_temp} ; wait for the nozzle',
      'SET_PRINT_STATS_INFO TOTAL_LAYER={total_layers} CURRENT_LAYER=0',
      'G1 X{bed_x_half} Y-1.2 F20000',
      'G1 Z0.3 F900',
      'G92 E0',
      'G1 F1200',
      'G1 X0 E10.156 ; purge line, on the lip in front of the plate',
      'G1 Y98.8 E7.934',
      'G1 X0.9 Y100 E0.1',
      'G1 Y-0.3 E7.934',
      'G1 X{purge_end} E6.284',
      'G3 I-1 J0 Z0.6 F1200 ; curl off the line rather than drag through it',
      'G1 F20000',
      'G92 E0'
    ].join('\n'),

    // Klipper machines whose macro is PRINT_START taking EXTRUDER and BED —
    // Voron's convention, and what OrcaSlicer ships for them. The temperatures
    // are also sent the ordinary way first, because a hand-written PRINT_START
    // may or may not wait for them.
    printstart: [
      'M190 S{bed_temp}',
      'M109 S{nozzle_temp}',
      'PRINT_START EXTRUDER={nozzle_temp} BED={bed_temp}',
      'G92 E0'
    ].join('\n'),

    // Qidi's macro is PRINT_START, and it takes its own parameter names. It
    // homes, meshes and heats; what is left here is the purge.
    qidi: [
      'PRINT_START BED={bed_temp} HOTEND={nozzle_temp} CHAMBER={chamber_temp}',
      'M190 S{bed_temp}',
      'M109 S{nozzle_temp}',
      'G90',
      'M83',
      'G92 E0',
      'G1 X5 Y5 Z0.3 F6000',
      'G1 X{prime_x} Y5 Z0.3 E{prime_e} F1200 ; purge line',
      'G1 X{prime_x} Y5.5 Z0.3 F6000',
      'G1 X5 Y5.5 Z0.3 E{prime_e} F1200',
      'G92 E0',
      'G1 Z1 F600'
    ].join('\n'),

    // The X-Plus 3 and its siblings run the same macro with no parameters at
    // all, and drive the mesh from the file.
    qidi_x3: [
      'PRINT_START',
      'G28',
      'M141 S0',
      'G0 Z50 F600',
      'M190 S{bed_temp} ; wait for the bed before probing it',
      'G28 Z',
      'G29 ; mesh',
      'G0 X0 Y0 Z50 F6000',
      'M141 S{chamber_temp}',
      'M109 S{nozzle_temp}',
      'M106 P3 S255 ; filter fan',
      'M83',
      'G92 E0',
      'G1 X5 Y5 Z0.3 F6000',
      'G1 X{prime_x} Y5 Z0.3 E{prime_e} F1200 ; purge line',
      'G1 X{prime_x} Y5.5 Z0.3 F6000',
      'G1 X5 Y5.5 Z0.3 E{prime_e} F1200',
      'G92 E0',
      'G1 Z1 F600'
    ].join('\n'),

    // The SV08's START_PRINT takes no parameters and does not heat; its own
    // script does that, and draws the purge in relative moves.
    sovol_sv08: [
      'G28',
      'G90',
      'G1 X0 F9000',
      'G1 Y20',
      'G1 Z0.600 F600',
      'G1 Y0 F9000',
      'START_PRINT',
      'G90',
      'G1 X0 F9000',
      'G1 Y20',
      'G1 Z0.600 F600',
      'G1 Y0 F9000',
      'M400',
      'G91',
      'M83',
      'M140 S{bed_temp}',
      'M104 S{nozzle_temp}',
      'M190 S{bed_temp}',
      'M109 S{nozzle_temp}',
      'G1 E25 F300 ; charge the nozzle',
      'G4 P1000',
      'G1 E-0.200 Z5 F600',
      'G1 X88.000 F9000',
      'G1 Z-5.000 F600',
      'G1 X87.000 E20.88 F1800 ; purge lines',
      'G1 X87.000 E13.92 F1800',
      'G1 Y1 E0.16 F1800',
      'G1 X-87.000 E13.92 F1800',
      'G1 X-87.000 E20.88 F1800',
      'G1 Y1 E0.24 F1800',
      'G1 X87.000 E20.88 F1800',
      'G1 X87.000 E13.92 F1800',
      'G1 E-0.200 Z1 F600',
      'M400'
    ].join('\n'),

    // The X4s have no start macro at all. They wipe the nozzle on a pad reached
    // by redefining Y — SET_KINEMATIC_POSITION moves the coordinate system, not
    // the head — and then draw their lines along the front edge.
    artillery_x4: [
      'M104 S140',
      'M190 S{bed_temp}',
      'M109 S{nozzle_temp}',
      'G28',
      'G1 X{wipe_x} Y{wipe_y} Z10 F5000',
      'SET_KINEMATIC_POSITION Y=0 ; the wiper sits past the end of the bed',
      'G1 Y{wipe_in} F4000',
      'G1 X{wipe_x} F4000',
      'G1 Z-1 F600 ; down onto the pad',
      'G1 X{wipe_x2} F4000',
      'G1 Y{wipe_in2} F4000',
      'G1 X{wipe_x} F4000',
      'G92 E0',
      'G1 Z10 F1200',
      'G1 Y0 F5000',
      'G1 E-1 F3000',
      'M400',
      'SET_KINEMATIC_POSITION Y={wipe_y} ; and back to where the bed really is',
      'G92 E-1',
      'M140 S{bed_temp}',
      'M109 S{nozzle_temp}',
      'G1 X0 Y0.8 Z0.8 F18000',
      'G92 E0',
      'G1 X0 Y0.8 Z0.3 E8 F600',
      'G92 E0',
      'G1 X{line_x} Y0.8 Z0.3 F1800 E{line_e} ; purge line',
      'G92 E0',
      'G1 X{line_x} Y0 Z0.3 F1800 E0.08',
      'G92 E0',
      'G1 X{line_x2} Y0 Z0.3 F1800 E10.0',
      'G92 E0',
      'G1 X{line_x2} Y1.6 Z0.3 F1800 E0.16',
      'G92 E0',
      'G1 X{line_x3} Y1.6 Z0.3 F1800 E8',
      'G92 E0',
      'G1 X{line_x3} Y0 Z0.3 F1800 E0.16',
      'G92 E0',
      'G1 E-1 Z5 F18000',
      'G92 E0'
    ].join('\n'),

    delta: [
      'M140 S{bed_temp}',
      'M104 S{nozzle_temp}',
      'G28 ; home',
      'M190 S{bed_temp}',
      'M109 S{nozzle_temp}',
      'G92 E0',
      'G1 Z5 F{z_feed}',
      'G1 X-{prime_radius} Y0 Z0.3 F5000',
      'G3 X{prime_radius} Y0 I{prime_radius} J0 E20 F1200 ; prime arc',
      'G92 E0'
    ].join('\n')
  };

  var ENDS = {
    standard: [
      'M104 S0 ; nozzle off',
      'M140 S0 ; bed off',
      'G92 E0',
      'G1 E-3 F1800 ; retract',
      'G91 ; relative',
      'G1 Z10 F{z_feed} ; lift',
      'G90 ; absolute',
      'G1 X5 Y{present_y} F6000 ; present print',
      'M107 ; fan off',
      'M84 ; motors off'
    ].join('\n'),

    centauri2: [
      ';===== Elegoo Centauri Carbon 2 =====',
      'M140 S0 ; bed off',
      'M83 ; the retract below is a distance',
      'G92 E0',
      'G1 E-1.5 F1800 ; retract',
      // Elegoo write this lift as a full circle of radius 1 — a G2 with no
      // endpoint, which finishes where it started, one layer higher. This
      // machine is sent no arcs anywhere else, and an end script that stops on
      // an unknown command leaves the heaters running, so it is the same lift
      // without the curl.
      'G1 Z{max_z + 0.5} F3000 ; up off the part',
      'M106 S0 ; part fan off',
      'M106 P2 S0 ; auxiliary fan off',
      'G90',
      'G1 Z{min(max_z + 5, bed_z - 0.5)} F20000 ; get the head clear',
      'G180 S9 ; park',
      'M104 S0 ; nozzle off',
      'M84 ; motors off'
    ].join('\n'),

    neptune4: [
      'G90 ; absolute',
      'M83 ; the retract below is a distance',
      'G92 E0',
      'G1 E-1.5 F1800 ; retract',
      // The same lift as Elegoo's, without the arc: this machine is not sent
      // one anywhere else either.
      'G1 Z{max_z + 0.5} F3000 ; up off the part',
      'G90',
      'G1 X10 Y{present_y} Z{min(max_z + 50, bed_z)} E-5 F{z_feed} ; present the print',
      'M106 S0 ; fan off',
      'M104 S0 ; nozzle off',
      'M140 S0 ; bed off',
      'M84 X Y E ; motors off, Z still holding'
    ].join('\n'),

    artillery: [
      'G4 ; let the buffer drain',
      'M83 ; the retract below is a distance',
      'G92 E0',
      'G1 E-0.5 F3000 ; retract so it does not string on the way out',
      'G91 ; relative',
      'G1 X1 Y1 F1200 ; wiggle off the last spot',
      'G90 ; absolute',
      'G1 Z{min(max_z + 120, bed_z)} F{z_feed} ; run the bed out from under the head',
      'M200 D0',
      'M220 S100',
      'M221 S100',
      'M106 S0 ; fan off',
      'M104 S0 ; nozzle off',
      'M140 S0 ; bed off',
      'M84 ; motors off'
    ].join('\n'),

    klipper: [
      'END_PRINT',
      'M104 S0',
      'M140 S0',
      'M107'
    ].join('\n'),

    centauri: [
      ';===== Elegoo Centauri Carbon =====',
      'M400',
      'M140 S0 ; bed off',
      'M106 S255 ; blow on the nozzle while it comes down',
      'M83',
      'G92 E0',
      'G1 E-0.8 F1800 ; retract',
      'G2 I1 J0 Z{max_z + 0.5} F3000 ; curl away from the part',
      'G90',
      'G1 Z{min(max_z + 50, bed_z - 0.5)} F20000 ; get the head clear',
      'M204 S5000',
      'M749 ; park the toolhead the way the firmware wants it',
      'M400',
      'G1 X202 F20000',
      'G1 Y250 F20000',
      'G1 Y264.5 F1200 ; present the plate',
      'M400',
      'G92 E0',
      'M104 S0 ; nozzle off',
      'M140 S0 ; bed off',
      'M106 S0 ; part fan off',
      'M106 P2 S0 ; auxiliary fan off',
      'M106 P3 S0 ; chamber fan off',
      'M84 ; motors off'
    ].join('\n'),

    printstart: [
      'PRINT_END',
      'M104 S0',
      'M140 S0',
      'M107'
    ].join('\n'),

    qidi: [
      'M141 S0 ; chamber off',
      'M104 S0',
      'M140 S0',
      'M83 ; the retract below is a distance, not a position',
      'G1 E-3 F1800',
      'G0 Z{min(max_z + 3, bed_z)} F600',
      'G0 X0 Y0 F12000',
      'M107'
    ].join('\n'),

    artillery_x4: [
      'G91 ; relative',
      'M83 ; and E with it — Klipper keeps the two apart',
      'G1 E-1 F2700',
      // Artillery lift 0.2 mm here before wiping sideways. A millimetre costs
      // nothing and keeps the nozzle off the top surface it just laid.
      'G1 E-1 Z1 F2400',
      'G1 X5 Y5 F3000 ; wipe off',
      'G1 Z1',
      'G90 ; absolute',
      'G1 X0 Y{present_y} F3000 ; present the print',
      'M106 S0',
      'M104 S0',
      'M140 S0',
      'M84 X Y E'
    ].join('\n'),

    delta: [
      'M104 S0',
      'M140 S0',
      'G92 E0',
      'G1 E-3 F1800',
      'G91',
      'G1 Z20 F{z_feed}',
      'G90',
      'M107',
      'M84'
    ].join('\n')
  };

  /**
   * Build a printer entry. Only the bed and the interesting motion numbers vary
   * between most machines, so everything else falls back to sane defaults.
   */
  function printer(name, brand, bx, by, bz, opts) {
    opts = opts || {};
    var shape = opts.shape || 'rect';
    var start = STARTS[opts.start || 'standard'];
    var end = ENDS[opts.end || 'standard'];
    var zSpeed = opts.maxZSpeed || 12;
    var zFeed = Math.round(Math.min(opts.travel || 200, zSpeed) * 60);
    var primeX = Math.round(bx * 0.4);

    // Linear advance, where the machine's own vendor sets a value for it.
    //
    // Marlin's LIN_ADVANCE holds the pressure in the melt chamber steady as the
    // head speeds up and slows down. Without it the nozzle keeps pushing into a
    // corner it has already reached and leaves a blob there, then starts the
    // next line short. It is per-machine and per-hotend, and guessing it is
    // worse than leaving it off — so this is only ever the number the vendor
    // publishes for that exact machine, and nothing is emitted otherwise.
    if (opts.linearAdvance != null) {
      var setup = 'M900 K' + opts.linearAdvance + ' ; linear advance, the value ' +
        brand + ' publishes for this machine';
      start = /^M8[23]\b.*$/m.test(start)
        ? start.replace(/^(M8[23]\b.*)$/m, '$1\n' + setup)
        : (/^G90\b.*$/m.test(start)
          ? start.replace(/^(G90\b.*)$/m, '$1\n' + setup)
          : setup + '\n' + start);
    }

    return {
      name: name,
      brand: brand,
      bed: { x: bx, y: by, z: bz },
      shape: shape,
      // Deltas home to the middle of the plate, so their G-code origin is the
      // centre, not a corner. Getting this wrong drives the head into the frame.
      originCenter: opts.originCenter != null ? opts.originCenter : shape === 'circle',
      maxNozzleTemp: opts.maxNozzleTemp || 300,
      maxBedTemp: opts.maxBedTemp || 120,
      maxChamberTemp: opts.maxChamberTemp || 60,
      // The Z axis is far slower than X/Y on a leadscrew machine. Commanding a
      // layer change at travel speed asks it for something it cannot do.
      maxZSpeed: zSpeed,
      // What sweeps the plate. A bed-slinger throws the bed back and forth
      // under a fixed X beam, so anything already printed at the same Y as the
      // nozzle is in the beam's path; a corexy or delta head moves over the
      // plate and only the extruder body is in the way.
      kinematics: opts.kinematics || (shape === 'circle' ? 'delta' : 'bedslinger'),
      // How far the head really reaches, [minX, minY, maxX, maxY], where the
      // machine's own scripts step outside the print area — purging on the lip
      // in front of the plate, sliding the bed out to hand the part over. Left
      // unset, the print area is all that is assumed to exist.
      reach: opts.reach || null,
      // And how far below the plate they go — a wiper pad usually sits lower
      // than the print surface.
      reachZ: opts.reachZ != null ? opts.reachZ : 0,
      extruders: opts.extruders || 1,
      nozzle: opts.nozzle || 0.4,
      filamentDiameter: opts.filamentDiameter || 1.75,
      flavor: opts.flavor || 'marlin',
      // Whether this machine's firmware takes G2/G3 at all. A machine whose
      // own vendor never sends it does not get it from here either, however
      // the arc-fitting switch is set.
      arcs: opts.arcs !== false,
      maxAccel: opts.accel || 3000,
      travelSpeed: opts.travel || 200,
      retractLength: opts.retract != null ? opts.retract : 0.8,
      retractSpeed: opts.retractSpeed || 40,
      zHop: opts.zHop != null ? opts.zHop : 0.2,
      maxSpeed: opts.maxSpeed || 300,
      layerGcode: opts.layerGcode || '',
      startGcode: start
        // Only the machines that have a probe should be asked to run one: G29
        // on a printer without one is at best ignored and at worst an error.
        .replace(/\{abl\}\n?/g, opts.abl
          ? 'G29 ; probe the bed\nM420 S1 Z3 ; switch the mesh on, fading out by 3 mm\n'
          : '')
        .replace(/\{prime_end\}/g, Math.max(40, Math.round(by * 0.8)))
        .replace(/\{prime_radius\}/g, Math.round(bx / 2 - 12))
        .replace(/\{bed_x_half\}/g, Math.round(bx / 2))
        .replace(/\{purge_end\}/g, Math.round(bx / 2 - 50))
        .replace(/\{purge_far\}/g, Math.round(bx / 2 + 50))
        .replace(/\{purge_back\}/g, Math.round(bx / 2 + 47))
        // A purge line from X5 along the front, and what it costs in filament:
        // a 0.5 by 0.3 mm section is 0.15 mm2, against 3.3 mm2 of 1.75 stock.
        .replace(/\{prime_x\}/g, primeX)
        .replace(/\{prime_e\}/g, Math.round((primeX - 5) * 0.0624 * 10) / 10)
        .replace(/\{wipe_x\}/g, Math.round(bx * 0.75))
        .replace(/\{wipe_x2\}/g, Math.round(bx * 0.75) + 50)
        .replace(/\{wipe_y\}/g, by - 3)
        .replace(/\{wipe_in\}/g, Math.round(by * 0.05))
        .replace(/\{wipe_in2\}/g, Math.round(by * 0.05) + 5)
        .replace(/\{line_x\}/g, Math.round(bx * 0.7))
        .replace(/\{line_x2\}/g, Math.round(bx * 0.3))
        .replace(/\{line_x3\}/g, Math.round(bx * 0.6))
        .replace(/\{line_e\}/g, Math.round(bx * 0.7 * 0.1))
        .replace(/\{z_feed\}/g, zFeed),
      endGcode: end
        .replace(/\{present_y\}/g, Math.max(10, Math.round(by - 20)))
        .replace(/\{z_feed\}/g, zFeed)
    };
  }

  var PRINTERS = {
    // --- Elegoo ---
    // Klipper, like every other machine of its generation here, and with its own
    // start and end scripts: it was the one profile left on the generic Marlin
    // script, which homes and then goes straight to the first layer height
    // without the machine's own routine — so no nozzle wipe, no mesh, no saved
    // Z offset, and the nozzle drags on the plate.
    centauri_carbon: printer('Elegoo Centauri Carbon', 'Elegoo', 256, 256, 256,
      { kinematics: 'corexy', accel: 8000, travel: 300, retract: 0.8, retractSpeed: 40,
        flavor: 'klipper', start: 'centauri', end: 'centauri',
        // Elegoo's own scripts purge on the strip in front of the plate and run
        // the bed out to Y264.5 to present the print.
        reach: [-2, -3, 256, 266],
        // The screen's layer counter reads this, not the ;LAYER comments.
        layerGcode: 'SET_PRINT_STATS_INFO TOTAL_LAYER={total_layers}' +
          ' CURRENT_LAYER={layer_num + 1}',
        maxSpeed: 500, maxNozzleTemp: 320, maxBedTemp: 110, maxZSpeed: 20 }),
    // The second machine of the name, and not the same one: it probes on every
    // print instead of wiping and reloading a stored mesh, and it parks
    // differently. Same plate, same 0.4 hardened nozzle.
    centauri_carbon_2: printer('Elegoo Centauri Carbon 2', 'Elegoo', 256, 256, 256,
      { kinematics: 'corexy', accel: 20000, travel: 500, retract: 0.8, retractSpeed: 30,
        flavor: 'klipper', start: 'centauri2', end: 'centauri2',
        reach: [-2, -3, 256, 266],
        // Both parameters, the way Elegoo's own layer script sends them.
        layerGcode: 'SET_PRINT_STATS_INFO TOTAL_LAYER={total_layers}' +
          ' CURRENT_LAYER={layer_num + 1}',
        // Elegoo turn arc fitting off for this machine by name, and for the
        // Centauri 2 and the Neptunes, while leaving it on everywhere else in
        // their catalogue. Whatever the reason, the machine is not to be sent
        // a G2 or a G3.
        arcs: false,
        zHop: 0.4, maxSpeed: 500, maxNozzleTemp: 320, maxBedTemp: 110, maxZSpeed: 20 }),
    // Elegoo turn arc fitting off for the Neptune line too, by name.
    elegoo_neptune4: printer('Elegoo Neptune 4 / Pro', 'Elegoo', 230, 230, 265,
      { accel: 4000, travel: 250, retract: 1.0, flavor: 'klipper', arcs: false,
        start: 'neptune4', end: 'neptune4' }),
    elegoo_neptune4_plus: printer('Elegoo Neptune 4 Plus', 'Elegoo', 325, 325, 385,
      { accel: 4000, travel: 250, retract: 1.0, flavor: 'klipper', arcs: false,
        start: 'neptune4', end: 'neptune4' }),

    // --- Bambu Lab ---
    bambu_a1: printer('Bambu Lab A1', 'Bambu Lab', 256, 256, 256,
      { kinematics: 'bedslinger', accel: 10000, travel: 300, retract: 0.8, retractSpeed: 30, zHop: 0.4, maxSpeed: 500, maxZSpeed: 20 }),
    bambu_a1_mini: printer('Bambu Lab A1 mini', 'Bambu Lab', 180, 180, 180,
      { kinematics: 'bedslinger', accel: 10000, travel: 300, retract: 0.8, retractSpeed: 30, zHop: 0.4, maxSpeed: 500, maxZSpeed: 20 }),
    bambu_p1: printer('Bambu Lab P1P / P1S', 'Bambu Lab', 256, 256, 256,
      { kinematics: 'corexy', accel: 10000, travel: 350, retract: 0.8, retractSpeed: 30, zHop: 0.4, maxSpeed: 500, maxNozzleTemp: 300, maxBedTemp: 120, maxZSpeed: 20 }),
    bambu_x1c: printer('Bambu Lab X1 Carbon', 'Bambu Lab', 256, 256, 256,
      { kinematics: 'corexy', accel: 10000, travel: 350, retract: 0.8, retractSpeed: 30, zHop: 0.4, maxSpeed: 500, maxNozzleTemp: 320, maxBedTemp: 120, maxZSpeed: 20 }),

    // --- Prusa ---
    prusa_mk3s: printer('Prusa MK3S+', 'Prusa', 250, 210, 210,
      { accel: 2000, travel: 180, retract: 0.8, retractSpeed: 35, zHop: 0.4, maxZSpeed: 12 }),
    prusa_mk4: printer('Prusa MK4 / MK4S', 'Prusa', 250, 210, 220,
      { accel: 4000, travel: 200, retract: 0.7, retractSpeed: 35, zHop: 0.4, maxZSpeed: 15 }),
    prusa_mini: printer('Prusa MINI+', 'Prusa', 180, 180, 180,
      { accel: 2500, travel: 180, retract: 3.2, retractSpeed: 35, zHop: 0.4, maxZSpeed: 12 }),
    prusa_xl: printer('Prusa XL', 'Prusa', 360, 360, 360,
      { extruders: 5, kinematics: 'corexy', accel: 4000, travel: 250, retract: 0.7, retractSpeed: 35, zHop: 0.4, maxNozzleTemp: 300, maxBedTemp: 120, maxZSpeed: 15 }),
    prusa_core_one: printer('Prusa CORE One', 'Prusa', 250, 220, 270,
      { kinematics: 'corexy', accel: 6000, travel: 250, retract: 0.7, retractSpeed: 35, zHop: 0.4, maxNozzleTemp: 300, maxBedTemp: 120, maxZSpeed: 20 }),

    // --- Creality ---
    ender3: printer('Creality Ender-3 / V2', 'Creality', 220, 220, 250,
      { accel: 500, travel: 120, retract: 5, retractSpeed: 45, zHop: 0, maxSpeed: 150 }),
    ender3_s1: printer('Creality Ender-3 S1 / Pro', 'Creality', 220, 220, 270,
      { accel: 1500, travel: 150, retract: 0.8, retractSpeed: 40, start: 'mesh' }),
    ender5_plus: printer('Creality Ender-5 Plus', 'Creality', 350, 350, 400,
      { accel: 1000, travel: 150, retract: 5, retractSpeed: 45, start: 'mesh' }),
    creality_k1: printer('Creality K1', 'Creality', 220, 220, 250,
      { kinematics: 'corexy', accel: 12000, travel: 300, retract: 0.5, retractSpeed: 40, flavor: 'klipper',
        start: 'klipper', end: 'klipper', maxSpeed: 600, maxNozzleTemp: 300, maxBedTemp: 120, maxZSpeed: 30 }),
    creality_k1_max: printer('Creality K1 Max', 'Creality', 300, 300, 300,
      { kinematics: 'corexy', accel: 12000, travel: 300, retract: 0.5, retractSpeed: 40, flavor: 'klipper',
        start: 'klipper', end: 'klipper', maxSpeed: 600, maxNozzleTemp: 300, maxBedTemp: 120, maxZSpeed: 30 }),
    creality_k2_plus: printer('Creality K2 Plus', 'Creality', 350, 350, 350,
      { kinematics: 'corexy', accel: 15000, travel: 400, retract: 0.5, retractSpeed: 40, flavor: 'klipper',
        start: 'klipper', end: 'klipper', maxSpeed: 600, maxNozzleTemp: 350, maxBedTemp: 120, maxZSpeed: 30 }),
    creality_cr10: printer('Creality CR-10 / Smart Pro', 'Creality', 300, 300, 400,
      { accel: 800, travel: 120, retract: 5, retractSpeed: 45, zHop: 0 }),

    // --- Anycubic ---
    anycubic_kobra2: printer('Anycubic Kobra 2 / Neo', 'Anycubic', 220, 220, 250,
      { accel: 2500, travel: 200, retract: 1.5, start: 'mesh' }),
    anycubic_kobra3: printer('Anycubic Kobra 3', 'Anycubic', 255, 255, 260,
      { accel: 6000, travel: 300, retract: 1.0, linearAdvance: 0.051,
        start: 'mesh', maxSpeed: 500 }),

    // --- Sovol ---
    sovol_sv06: printer('Sovol SV06', 'Sovol', 220, 220, 250,
      { accel: 2000, travel: 180, retract: 1.0, start: 'mesh' }),
    sovol_sv06_plus: printer('Sovol SV06 Plus', 'Sovol', 300, 300, 340,
      { accel: 2000, travel: 180, retract: 1.0, start: 'mesh' }),
    // START_PRINT here takes no parameters, and does not heat: the file does.
    sovol_sv08: printer('Sovol SV08', 'Sovol', 350, 350, 345,
      { kinematics: 'corexy', accel: 12000, travel: 400, retract: 0.5, flavor: 'klipper',
        start: 'sovol_sv08', end: 'klipper', maxSpeed: 600, maxZSpeed: 25 }),

    // --- Qidi ---
    // Qidi's macro is PRINT_START, not START_PRINT, and the two families take
    // different parameters — the X3 takes none at all.
    qidi_xplus3: printer('Qidi X-Plus 3', 'Qidi', 280, 280, 270,
      { kinematics: 'corexy', accel: 12000, travel: 300, retract: 0.8, flavor: 'klipper',
        start: 'qidi_x3', end: 'qidi', maxSpeed: 600, maxNozzleTemp: 350, maxBedTemp: 120, maxZSpeed: 25 }),
    qidi_q1pro: printer('Qidi Q1 Pro', 'Qidi', 245, 245, 240,
      { kinematics: 'corexy', accel: 12000, travel: 300, retract: 0.8, flavor: 'klipper',
        start: 'qidi', end: 'qidi', maxSpeed: 600, maxNozzleTemp: 350, maxBedTemp: 120, maxZSpeed: 25 }),

    // --- Voron ---
    // Voron's convention is PRINT_START, taking EXTRUDER and BED.
    voron_02: printer('Voron 0.2', 'Voron', 120, 120, 120,
      { kinematics: 'corexy', accel: 10000, travel: 300, retract: 0.6, flavor: 'klipper',
        start: 'printstart', end: 'printstart', maxSpeed: 400, maxZSpeed: 30 }),
    voron_trident: printer('Voron Trident 300', 'Voron', 300, 300, 250,
      { kinematics: 'corexy', accel: 12000, travel: 400, retract: 0.6, flavor: 'klipper',
        start: 'printstart', end: 'printstart', maxSpeed: 500, maxNozzleTemp: 300, maxBedTemp: 120, maxZSpeed: 25 }),
    voron_24_350: printer('Voron 2.4 (350)', 'Voron', 350, 350, 330,
      { kinematics: 'corexy', accel: 12000, travel: 400, retract: 0.6, flavor: 'klipper',
        start: 'printstart', end: 'printstart', maxSpeed: 500, maxNozzleTemp: 300, maxBedTemp: 120, maxZSpeed: 25 }),

    // --- Artillery ---
    // The X1 has no probe; the X2 does, and the mesh has to be switched on after
    // it is measured. Both are bed slingers that home X and Y before Z, so the
    // lift that Artillery's own script does first is not optional.
    artillery_x1: printer('Artillery Sidewinder X1', 'Artillery', 300, 300, 400,
      { accel: 1000, travel: 120, retract: 1.5, zHop: 0,
        start: 'artillery', end: 'artillery' }),
    artillery_x2: printer('Artillery Sidewinder X2', 'Artillery', 300, 300, 400,
      { accel: 1500, travel: 150, retract: 1.5, linearAdvance: 0.12,
        start: 'artillery', end: 'artillery', abl: true }),
    artillery_x3: printer('Artillery Sidewinder X3 Plus', 'Artillery', 300, 305, 400,
      { accel: 3000, travel: 200, retract: 1.2, maxSpeed: 300,
        start: 'artillery_x3', end: 'artillery' }),
    // No start macro at all on these: the file does the wiping and the priming,
    // and the wiper pad is past the back of the bed and a millimetre below it.
    artillery_x4_plus: printer('Artillery Sidewinder X4 Plus', 'Artillery', 300, 310, 400,
      { accel: 12000, travel: 300, retract: 0.8, flavor: 'klipper',
        start: 'artillery_x4', end: 'artillery_x4', reach: [-6, 0, 300, 310], reachZ: -1,
        maxSpeed: 500, maxZSpeed: 20 }),
    artillery_x4_pro: printer('Artillery Sidewinder X4 Pro', 'Artillery', 240, 250, 260,
      { accel: 20000, travel: 500, retract: 0.8, flavor: 'klipper',
        start: 'artillery_x4', end: 'artillery_x4', reach: [-6, 0, 240, 250], reachZ: -1,
        maxSpeed: 600, maxNozzleTemp: 320, maxBedTemp: 120, maxZSpeed: 25 }),
    artillery_genius: printer('Artillery Genius', 'Artillery', 220, 220, 250,
      { accel: 1000, travel: 120, retract: 1.5, zHop: 0 }),
    artillery_genius_pro: printer('Artillery Genius Pro', 'Artillery', 220, 220, 250,
      { accel: 1500, travel: 150, retract: 1.5, start: 'mesh' }),
    artillery_hornet: printer('Artillery Hornet', 'Artillery', 230, 230, 250,
      { accel: 1500, travel: 150, retract: 5, retractSpeed: 45, zHop: 0 }),

    // --- Deltas (round bed) ---
    flsun_v400: printer('FLSun V400 (delta)', 'FLSun', 300, 300, 410,
      { shape: 'circle', accel: 10000, travel: 400, retract: 3.0, flavor: 'klipper',
        start: 'delta', end: 'delta', maxSpeed: 500, maxZSpeed: 400 }),
    flsun_q5: printer('FLSun Q5 (delta)', 'FLSun', 200, 200, 200,
      { shape: 'circle', accel: 3000, travel: 200, retract: 3.5, start: 'delta', end: 'delta', maxZSpeed: 200 }),

    // --- Generic ---
    generic_220: printer('Generic 220 × 220', 'Generic', 220, 220, 250,
      { accel: 1500, travel: 150, retract: 5, retractSpeed: 45, zHop: 0 }),
    generic_250: printer('Generic 250 × 250', 'Generic', 250, 250, 300,
      { accel: 3000, travel: 200 }),
    generic_300: printer('Generic 300 × 300', 'Generic', 300, 300, 350,
      { accel: 3000, travel: 200 }),
    generic_0_6: printer('Generic 0.6 nozzle 250 × 250', 'Generic', 250, 250, 300,
      { nozzle: 0.6, accel: 3000, travel: 200 })
  };

  // ---------------------------------------------------------------------------
  // Filaments
  // ---------------------------------------------------------------------------

  function filament(name, opts) {
    return {
      name: name,
      family: opts.family || name,
      nozzleTemp: opts.temp,
      firstLayerNozzleTemp: opts.temp1 != null ? opts.temp1 : opts.temp + 5,
      bedTemp: opts.bed,
      firstLayerBedTemp: opts.bed1 != null ? opts.bed1 : opts.bed,
      fanSpeed: opts.fan,
      firstLayerFanSpeed: opts.fan1 != null ? opts.fan1 : 0,
      fanFromLayer: opts.fanFrom || 2,
      minFanSpeed: opts.minFan != null ? opts.minFan : Math.min(opts.fan, 30),
      flowRatio: opts.flow != null ? opts.flow : 0.98,
      density: opts.density,
      costPerKg: opts.cost,
      maxVolumetric: opts.vol,
      minLayerTime: opts.minLayerTime != null ? opts.minLayerTime : 5,
      chamberTemp: opts.chamber || 0,
      color: opts.color
    };
  }

  var FILAMENTS = {
    pla:        filament('PLA',            { temp: 210, bed: 60,  fan: 100, fan1: 0, vol: 15, density: 1.24, cost: 20, color: '#6366f1' }),
    pla_fast:   filament('PLA High Speed', { temp: 220, bed: 60,  fan: 100, fan1: 0, vol: 24, density: 1.24, cost: 24, color: '#818cf8', minLayerTime: 3 }),
    pla_silk:   filament('PLA Silk',       { temp: 225, bed: 60,  fan: 80,  fan1: 0, vol: 12, density: 1.25, cost: 26, color: '#c4b5fd', flow: 1.0 }),
    pla_cf:     filament('PLA-CF',         { temp: 225, bed: 60,  fan: 100, fan1: 0, vol: 13, density: 1.22, cost: 38, color: '#4b5563', flow: 0.96 }),
    petg:       filament('PETG',           { temp: 240, bed: 80,  fan: 50,  fan1: 0, vol: 12, density: 1.27, cost: 24, color: '#22d3ee', flow: 0.95, fanFrom: 3 }),
    petg_cf:    filament('PETG-CF',        { temp: 250, bed: 80,  fan: 40,  fan1: 0, vol: 11, density: 1.30, cost: 42, color: '#0e7490', flow: 0.94, fanFrom: 3 }),
    abs:        filament('ABS',            { temp: 255, bed: 100, fan: 20,  fan1: 0, vol: 14, density: 1.04, cost: 22, color: '#fb7185', fanFrom: 4, chamber: 50, minLayerTime: 8 }),
    abs_cf:     filament('ABS-CF',         { temp: 265, bed: 100, fan: 15,  fan1: 0, vol: 13, density: 1.08, cost: 40, color: '#9f1239', fanFrom: 4, chamber: 50, minLayerTime: 8 }),
    asa:        filament('ASA',            { temp: 260, bed: 100, fan: 20,  fan1: 0, vol: 14, density: 1.07, cost: 28, color: '#fbbf24', fanFrom: 4, chamber: 50, minLayerTime: 8 }),
    tpu95:      filament('TPU 95A',        { temp: 230, bed: 40,  fan: 60,  fan1: 0, vol: 4,  density: 1.21, cost: 35, color: '#a855f7', flow: 1.05 }),
    tpu85:      filament('TPU 85A',        { temp: 225, bed: 35,  fan: 70,  fan1: 0, vol: 2.5, density: 1.15, cost: 42, color: '#c084fc', flow: 1.08 }),
    pa:         filament('PA (Nylon)',     { temp: 270, bed: 90,  fan: 20,  fan1: 0, vol: 12, density: 1.14, cost: 55, color: '#34d399', fanFrom: 4, chamber: 50, minLayerTime: 8 }),
    pa_cf:      filament('PA-CF',          { temp: 285, bed: 100, fan: 20,  fan1: 0, vol: 12, density: 1.18, cost: 75, color: '#047857', fanFrom: 4, chamber: 60, minLayerTime: 8 }),
    pc:         filament('PC',             { temp: 275, bed: 105, fan: 15,  fan1: 0, vol: 12, density: 1.20, cost: 45, color: '#94a3b8', fanFrom: 4, chamber: 60, minLayerTime: 10 }),
    hips:       filament('HIPS',           { temp: 240, bed: 100, fan: 30,  fan1: 0, vol: 12, density: 1.04, cost: 26, color: '#e2e8f0', fanFrom: 3 }),
    pvа_placeholder: null,
    pva:        filament('PVA (soluble)',  { temp: 215, bed: 60,  fan: 50,  fan1: 0, vol: 5,  density: 1.23, cost: 80, color: '#fde68a' }),
    pp:         filament('PP',             { temp: 245, bed: 90,  fan: 40,  fan1: 0, vol: 10, density: 0.90, cost: 48, color: '#67e8f9', flow: 1.0, fanFrom: 3 })
  };
  delete FILAMENTS.pvа_placeholder;

  // ---------------------------------------------------------------------------
  // Quality
  // ---------------------------------------------------------------------------

  function quality(name, h, h1, s) {
    return {
      name: name, layerHeight: h, firstLayerHeight: h1,
      speeds: {
        perimeter: s.p, externalPerimeter: s.e, solidInfill: s.si, infill: s.i,
        topSolid: s.t, firstLayer: s.f, support: s.sup, bridge: s.b,
        internalBridge: Math.round(s.b * 1.2),
        gapFill: s.g, ironing: s.iron
      }
    };
  }

  var QUALITY = {
    q006: quality('0.06 mm — Ultra fine', 0.06, 0.2, { p: 40, e: 22, si: 50, i: 70, t: 30, f: 18, sup: 40, b: 25, g: 25, iron: 18 }),
    q008: quality('0.08 mm — Extra fine', 0.08, 0.2, { p: 45, e: 25, si: 60, i: 80, t: 35, f: 20, sup: 45, b: 25, g: 30, iron: 20 }),
    q012: quality('0.12 mm — Fine',       0.12, 0.2, { p: 60, e: 30, si: 80, i: 120, t: 45, f: 22, sup: 60, b: 30, g: 40, iron: 20 }),
    q016: quality('0.16 mm — Optimal',    0.16, 0.2, { p: 80, e: 40, si: 110, i: 160, t: 55, f: 25, sup: 80, b: 35, g: 50, iron: 22 }),
    q020: quality('0.20 mm — Standard',   0.20, 0.25, { p: 90, e: 45, si: 120, i: 180, t: 60, f: 28, sup: 90, b: 40, g: 55, iron: 22 }),
    q024: quality('0.24 mm — Fast',       0.24, 0.28, { p: 95, e: 48, si: 125, i: 190, t: 62, f: 30, sup: 95, b: 42, g: 58, iron: 24 }),
    q028: quality('0.28 mm — Draft',      0.28, 0.30, { p: 100, e: 50, si: 130, i: 200, t: 65, f: 30, sup: 100, b: 45, g: 60, iron: 24 }),
    q032: quality('0.32 mm — Extra draft', 0.32, 0.35, { p: 100, e: 50, si: 130, i: 200, t: 65, f: 30, sup: 100, b: 45, g: 60, iron: 24 })
  };

  // ---------------------------------------------------------------------------
  // Settings assembly
  // ---------------------------------------------------------------------------

  /** Build a full, flat settings object from the three preset keys. */
  function buildSettings(printerKey, filamentKey, qualityKey) {
    var p = PRINTERS[printerKey] || PRINTERS.centauri_carbon;
    var f = FILAMENTS[filamentKey] || FILAMENTS.pla;
    var q = QUALITY[qualityKey] || QUALITY.q020;
    var w = Math.round(p.nozzle * 1.05 * 100) / 100;

    return {
      printerKey: printerKey, filamentKey: filamentKey, qualityKey: qualityKey,

      // --- Printer ---
      bedX: p.bed.x, bedY: p.bed.y, bedZ: p.bed.z,
      bedShape: p.shape,
      originCenter: p.originCenter,
      maxNozzleTemp: p.maxNozzleTemp,
      maxBedTemp: p.maxBedTemp,
      maxChamberTemp: p.maxChamberTemp,
      maxZSpeed: p.maxZSpeed,
      // How much room the extruder body needs around a finished part, and how
      // tall a part has to be before it is in the way at all. Conservative
      // defaults: most hotends clear a couple of centimetres and sweep a fist.
      extruderClearanceRadius: p.clearanceRadius || 45,
      extruderClearanceHeight: p.clearanceHeight || 25,
      kinematics: p.kinematics,
      bedReach: p.reach || null,
      bedReachZ: p.reachZ || 0,
      extruderCount: p.extruders,
      // What a fresh tool has to push out before it can be trusted to lay a
      // clean line: the old colour is still sitting in the melt zone.
      purgeVolume: 55,
      primeTowerWidth: 45,
      primeTowerX: -1, primeTowerY: -1,          // -1 = place it automatically
      toolChangeGcode: 'T{next_extruder}',
      printSequence: 'layer',
      // Kept alongside the editable limits so the verifier can say when a limit
      // has been raised above what this machine actually shipped with.
      factoryMaxNozzleTemp: p.maxNozzleTemp,
      factoryMaxBedTemp: p.maxBedTemp,
      nozzle: p.nozzle,
      filamentDiameter: p.filamentDiameter,
      gcodeFlavor: p.flavor,
      machineArcs: p.arcs !== false,
      maxAccel: p.maxAccel,
      maxSpeed: p.maxSpeed,
      travelSpeed: p.travelSpeed,
      retractLength: p.retractLength,
      retractSpeed: p.retractSpeed,
      deretractSpeed: p.retractSpeed,
      zHop: p.zHop,
      startGcode: p.startGcode,
      endGcode: p.endGcode,
      layerGcode: p.layerGcode || '',
      relativeE: false,
      emitAcceleration: true,
      thumbnails: true,

      // --- Filament ---
      nozzleTemp: f.nozzleTemp, firstLayerNozzleTemp: f.firstLayerNozzleTemp,
      bedTemp: f.bedTemp, firstLayerBedTemp: f.firstLayerBedTemp,
      chamberTemp: f.chamberTemp,
      fanSpeed: f.fanSpeed, firstLayerFanSpeed: f.firstLayerFanSpeed,
      minFanSpeed: f.minFanSpeed,
      fanFromLayer: f.fanFromLayer,
      flowRatio: f.flowRatio,
      filamentDensity: f.density,
      filamentCost: f.costPerKg,
      maxVolumetric: f.maxVolumetric,
      minLayerTime: f.minLayerTime,
      slowDownMinSpeed: 12,

      // --- Quality ---
      layerHeight: q.layerHeight,
      firstLayerHeight: q.firstLayerHeight,
      speeds: JSON.parse(JSON.stringify(q.speeds)),
      adaptiveLayers: false,
      adaptiveQuality: 0.5,

      // --- Walls & shell ---
      wallGenerator: 'arachne',     // classic | arachne (variable-width beads)
      minBeadWidth: Math.round(p.nozzle * 0.85 * 100) / 100,
      maxBeadWidth: Math.round(p.nozzle * 1.8 * 100) / 100,
      // How far a wall is given to change its mind. A bead count that flips
      // from one loop to two cannot do it at a point: the widths ramp across
      // this distance, and a wall that is about to end tapers over it.
      wallTransitionLength: Math.round(p.nozzle * 1.05 * 100) / 100,
      // How far a sparse infill line runs along the wall it lands on, so it is
      // bonded to the shell rather than resting against it.
      infillAnchor: Math.round(p.nozzle * 2 * 100) / 100,
      // An internal pocket smaller than this is filled solid rather than
      // sparse: sparse infill in a small pocket is a handful of loose strands.
      solidInfillBelowArea: 70,
      supportStyle: 'normal',
      supportBranchAngle: 40,
      supportBranchDiameter: 5,
      supportBranchDiameterAngle: 5,
      supportTipDiameter: Math.round(p.nozzle * 2 * 100) / 100,
      supportTipSpacing: Math.round(p.nozzle * 8 * 100) / 100,
      wallLoops: 2,
      topLayers: 4,
      bottomLayers: 3,
      lineWidth: w,
      externalLineWidth: w,
      firstLayerLineWidth: Math.round(p.nozzle * 1.25 * 100) / 100,
      infillOverlap: 0.15,
      wallOrder: 'inner-outer-inner',   // inner-outer | outer-inner | inner-outer-inner
      seamPosition: 'aligned',
      seamScarf: true,
      scarfLength: 10,   // mm the seam is spread over
      // Speed caps for an external wall by how far it reaches over thin air,
      // in bands of 25%. Nothing here speeds a wall up; they only cap it.
      overhangSlowdown: true,
      overhangSpeeds: (function () {
        var e = q.speeds.externalPerimeter;
        var bands = [Math.round(e * 0.6), Math.round(e * 0.4), Math.max(10, Math.round(e * 0.25))];
        // The last band is fully unsupported; never let it come out faster than
        // the band before it.
        bands.push(Math.max(8, Math.min(bands[2], Math.round(q.speeds.bridge * 0.5))));
        return bands;
      })(),
      overhangFanBoost: true,
      smallPerimeterSpeed: Math.max(10, Math.round(q.speeds.externalPerimeter * 0.5)),
      smallPerimeterThreshold: 12,   // mm of loop length
      gapFill: true,
      fuzzySkin: 'none',            // none | outer | all
      fuzzyThickness: 0.3,
      fuzzyPointDistance: 0.8,

      // --- Dimensional compensation ---
      xyCompensation: 0,
      elephantFootCompensation: 0.15,

      bridgeAngleDetection: true,
      internalBridges: true,
      internalBridgeFlow: 1.0,
      // Replace runs of tiny segments on a curve with a single G2/G3.
      //
      // Off, because that is how these machines are shipped: of the 797 vendor
      // process profiles in OrcaSlicer, 629 turn arc fitting off. G2/G3 is
      // optional in both worlds — a compile-time flag in Marlin, the
      // [gcode_arcs] section in Klipper — and a printer without it does not
      // ignore the command, it stops the print where it stands.
      arcFitting: false,
      arcTolerance: 0.05,

      // --- Infill ---
      infillDensity: 15,
      infillPattern: 'grid',
      lightningAngle: 40,   // how far lightning branches lean out per layer
      solidPattern: 'lines',
      monotonicSurfaces: 'top',  // none | top | all — one-sweep ordering costs travel,
                                 // so it defaults to the surfaces you actually see
      ironing: 'none',              // none | top | all-solid
      ironingFlow: 0.1,
      ironingSpacing: 0.1,

      // --- Supports ---
      supportEnable: false,
      supportThreshold: 55,
      supportZGap: 0.2,
      supportXYGap: 0.6,
      supportDensity: 12,
      supportPattern: 'lines',
      supportOnBuildplateOnly: false,
      supportInterfaceLayers: 2,
      supportInterfaceDensity: 70,

      // --- Adhesion ---
      adhesion: 'skirt',            // none | skirt | brim | raft
      skirtLoops: 2,
      skirtDistance: 3,
      brimWidth: 5,
      brimType: 'outer',            // outer | inner | both
      brimGap: 0.1,
      raftLayers: 2,
      raftGap: 0.2,

      // How close two points have to be before the second is not worth a
      // command of its own. The value every reference slicer ships; below it
      // the machine cannot act on the difference, and the commands cost the
      // firmware more than the accuracy is worth.
      gcodeResolution: 0.0125,

      // --- Travel ---
      // Skipping the retraction when the travel keeps the nozzle over plastic
      // saves time, and every reference slicer ships it off: over sparse infill
      // the nozzle is really over air, and over solid it draws a line across
      // the surface it just laid. Off, the nozzle retracts whenever it travels
      // further than the distance below, which is what stops stringing.
      combing: false,
      minTravelForRetract: 1.5,
      wipeOnRetract: true,
      wipeDistance: 2,

      // --- Special ---
      spiralVase: false
    };
  }

  var API = {
    PRINTERS: PRINTERS,
    FILAMENTS: FILAMENTS,
    QUALITY: QUALITY,
    FLAVORS: FLAVORS,
    STARTS: STARTS,
    ENDS: ENDS,
    buildSettings: buildSettings
  };

  root.OrcaPresets = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
