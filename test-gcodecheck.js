globalThis.ClipperLib = require('./js/vendor/clipper.js');
globalThis.OrcaPresets = require('./js/slicer/presets.js');
require('./js/slicer/engine.js');
require('./js/slicer/beading.js');
require('./js/slicer/template.js');
var C = require('./js/slicer/gcodecheck.js');
var E = globalThis.OrcaEngine, P = globalThis.OrcaPresets;

function box(cx,cy,w,h){
  var x0=cx-w/2,y0=cy-w/2,x1=cx+w/2,y1=cy+w/2;
  var v=[[x0,y0,0],[x1,y0,0],[x1,y1,0],[x0,y1,0],[x0,y0,h],[x1,y0,h],[x1,y1,h],[x0,y1,h]];
  var f=[[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
  var o=[]; f.forEach(t=>t.forEach(i=>o.push(v[i][0],v[i][1],v[i][2]))); return new Float32Array(o);
}
function slice(printerKey, filamentKey, tweak){
  var s=P.buildSettings(printerKey, filamentKey||'pla','q020');
  if(tweak) tweak(s);
  var p=P.PRINTERS[printerKey];
  var mesh=box(p.bed.x/2, p.bed.y/2, Math.min(20, p.bed.x*0.3), 6);
  return { gcode: E.slice({positions:mesh, settings:s}, function(){}).gcode, settings: s };
}

var pass=0, fail=0;
function expectClean(label, r){
  var v=C.verify(r.gcode, r.settings);
  if(v.errors===0){ pass++; }
  else { fail++; console.log('  FALSE ALARM on '+label+':');
    v.findings.filter(f=>f.severity==='error').slice(0,3).forEach(f=>console.log('      ['+f.code+'] '+f.message+' @line '+f.line+'  '+f.text)); }
  return v;
}
function expectCatch(label, gcode, settings, code, severity){
  var v=C.verify(gcode, settings);
  var hit=v.findings.find(f=>f.code===code || f.code===code+'.more');
  if(hit && (!severity || hit.severity===severity)){ pass++; console.log('  caught  '+label.padEnd(46)+'-> ['+hit.severity+'] '+hit.message.slice(0,72)); }
  else { fail++; console.log('  MISSED  '+label.padEnd(46)+'-> expected '+code+(severity?'/'+severity:'')+
    '; got: '+(v.findings.slice(0,3).map(f=>f.code).join(',')||'nothing')); }
}

console.log('=== 1. clean output from every printer profile must pass ===');
var keys=Object.keys(P.PRINTERS);
var falseAlarms=0;
keys.forEach(function(k){
  var r=slice(k);
  var v=C.verify(r.gcode, r.settings);
  if(v.errors>0){ falseAlarms++; console.log('  FALSE ALARM '+k+':', v.findings.filter(f=>f.severity==='error').map(f=>f.code+'@'+f.line).join(', '));
    v.findings.filter(f=>f.severity==='error').slice(0,2).forEach(f=>console.log('      '+f.message+'  |  '+f.text)); }
});
console.log('  '+(keys.length-falseAlarms)+'/'+keys.length+' printer profiles produce G-code with zero errors');
if(falseAlarms===0) pass++; else fail++;

console.log('\n=== 2. clean output across filaments and options ===');
[['centauri_carbon','petg'],['bambu_x1c','abs'],['ender3','tpu95'],['flsun_v400','asa'],['qidi_q1pro','pa_cf']].forEach(function(c){
  expectClean(c.join('/'), slice(c[0], c[1]));
});
['supportEnable','spiralVase','adaptiveLayers'].forEach(function(opt){
  expectClean('option '+opt, slice('centauri_carbon','pla',function(s){ s[opt]=true; }));
});
expectClean('raft + brim + ironing', slice('centauri_carbon','pla',function(s){ s.adhesion='raft'; s.ironing='top'; }));
expectClean('relative E + klipper', slice('creality_k1','pla',function(s){ s.relativeE=true; }));

console.log('\n=== 3. injected faults must all be caught ===');
var base = slice('prusa_mk3s');
var g = base.gcode, st = base.settings;
function withLine(gc, find, replace){ return gc.replace(find, replace); }

expectCatch('nozzle commanded to 400 C', withLine(g,/M109 S\d+/, 'M109 S400'), st, 'temp.nozzle.high', 'error');
expectCatch('bed commanded to 200 C', withLine(g,/M190 S\d+/, 'M190 S200'), st, 'temp.bed.high', 'error');
expectCatch('nozzle heater left on at end', g.replace(/M104 S0[^\n]*\n/, ''), st, 'heater.nozzle.on', 'error');
expectCatch('bed heater left on at end', g.replace(/M140 S0[^\n]*\n/, ''), st, 'heater.bed.on', 'error');
expectCatch('no wait for temperature (cold extrude)', g.replace(/M109 S\d+[^\n]*\n/, ''), st, 'extrude.cold', 'error');
expectCatch('extruding with the nozzle at 20 C', g.replace(/M104 S\d+/, 'M104 S20').replace(/M109 S\d+/, 'M109 S20'), st, 'extrude.cold.temp', 'error');
expectCatch('move off the side of the bed', g.replace(/^G0 X[\d.]+ Y[\d.]+/m, 'G0 X999 Y10'), st, 'bounds.xy', 'error');
expectCatch('move below the bed surface', g.replace(/^G1 Z0\.65[^\n]*/m, 'G1 Z-4 F1800'), st, 'bounds.z.low', 'error');
expectCatch('move above maximum height', g.replace(/^G1 Z0\.65[^\n]*/m, 'G1 Z900 F1800'), st, 'bounds.z.high', 'error');
expectCatch('machine never homed', g.replace(/^G28[^\n]*\n/m, ''), st, 'home.missing', 'error');
expectCatch('move before homing', g.replace(/^G28([^\n]*)\n/m, 'G1 X10 Y10 F3000\nG28$1\n'), st, 'move.unhomed', 'error');
expectCatch('cold extrusion enabled (M302)', g.replace(/^G28/m, 'M302 P1\nG28'), st, 'dangerous.M302', 'error');
expectCatch('steps/mm overwritten (M92)', g.replace(/^G28/m, 'M92 E1200\nG28'), st, 'dangerous.M92', 'error');
expectCatch('EEPROM write (M500)', g.replace(/^G28/m, 'M500\nG28'), st, 'dangerous.M500', 'error');
expectCatch('stepper current changed (M906)', g.replace(/^G28/m, 'M906 X2000\nG28'), st, 'dangerous.M906', 'error');
expectCatch('PID autotune inside a print (M303)', g.replace(/^G28/m, 'M303 E0 S250 C8\nG28'), st, 'dangerous.M303', 'error');
expectCatch('NaN in a coordinate', g.replace(/^G1 X[\d.]+ Y[\d.]+ E[\d.-]+/m, 'G1 XNaN Y10 E1'), st, 'malformed', 'error');
expectCatch('zero feedrate', g.replace(/^G0 X([\d.]+) Y([\d.]+) F\d+/m, 'G0 X$1 Y$2 F0'), st, 'feed.zero', 'error');
expectCatch('absurd single extrusion', g.replace(/^G1 X([\d.]+) Y([\d.]+) E[\d.]+/m, 'G1 X$1 Y$2 E9999'), st, 'extrude.huge', 'error');
expectCatch('file ends in relative mode', g.replace(/^M84[^\n]*/m, 'G91\nM84'), st, 'mode.relative', 'warning');
expectCatch('footer disagrees with the moves', g.replace(/; filament used \[mm\] = \d+/, '; filament used [mm] = 99999'), st, 'filament.mismatch', 'warning');
expectCatch('file with no moves at all', '; nothing here\nM104 S0\nM140 S0\n', st, 'empty', 'error');

console.log('\n=== 4. circular bed: coordinates outside the plate ===');
var delta = slice('flsun_v400');
expectCatch('delta move outside the circle', delta.gcode.replace(/^G0 X(-?[\d.]+) Y(-?[\d.]+)/m, 'G0 X149 Y149'), delta.settings, 'bounds.xy', 'error');
console.log('  (149,149) is inside a 300x300 square but 210 mm from the centre of a 300 mm circle');

console.log('\n=== 5. the delta origin bug this work uncovered ===');
var deltaCorner = JSON.parse(JSON.stringify(delta.settings)); deltaCorner.originCenter = false;
var v = C.verify(delta.gcode, deltaCorner);
console.log('  same file checked as if the origin were a corner ->', v.errors, 'errors,',
  'first:', v.findings.filter(f=>f.severity==='error')[0] ? v.findings.filter(f=>f.severity==='error')[0].code : 'none');
if(v.errors>0) pass++; else { fail++; console.log('  MISSED: an origin mismatch should be flagged'); }

// --- the file must say how coordinates are read before it moves ---
// G90/G91 and M82/M83 survive between prints, so a file that starts moving
// without setting them does whatever the previous one left behind.
expectCatch('moving before the positioning mode is set',
  ['M140 S60', 'M190 S60', 'M104 S200', 'M109 S200',
   'G28', 'G1 Z2.0 F1200',                    // moves, and G90 has not been sent
   'G90', 'M82', 'G92 E0',
   ';LAYER:0', ';Z:0.2', 'G1 X10 Y10 E1 F1200',
   'M104 S0', 'M140 S0'].join('\n'),
  base.settings, 'mode.unset', 'error');

// And the same file with G90 sent first must not be flagged for it.
var okModes = C.verify(['M140 S60', 'M190 S60', 'M104 S200', 'M109 S200',
  'G90', 'M82', 'G28', 'G1 Z2.0 F1200', 'G92 E0',
  ';LAYER:0', ';Z:0.2', 'G1 X10 Y10 E1 F1200',
  'M104 S0', 'M140 S0'].join('\n'), base.settings);
if (okModes.findings.some(function (f) { return f.code === 'mode.unset'; })) {
  fail++; console.log('  FALSE ALARM: mode.unset raised on a file that sets G90 first');
} else { pass++; console.log('  ok      G90 before the first move is not flagged'); }

// --- commands that name an axis without a value are not malformed ---
// 'G28 Z' homes Z alone; 'M84 X Y E' releases three motors and leaves Z holding.
var bare = C.verify(['G90', 'M82', 'M140 S60', 'M190 S60', 'M104 S200', 'M109 S200',
  'G28', 'G28 Z', ';LAYER:0', ';Z:0.2', 'G1 X10 Y10 E1 F1200',
  'M104 S0', 'M140 S0', 'M84 X Y E'].join('\n'), base.settings);
if (bare.findings.some(function (f) { return f.code === 'malformed'; })) {
  fail++; console.log('  FALSE ALARM: a bare axis letter read as a missing value');
} else { pass++; console.log('  ok      G28 Z and M84 X Y E are read as written'); }

// --- SET_KINEMATIC_POSITION moves the coordinates, not the head ---
// A machine reaches a wiper past the end of its bed by renaming where it is.
// Read literally, the moves after it look like a leap across the plate.
var kin = C.verify(['G90', 'M82', 'M140 S60', 'M190 S60', 'M104 S200', 'M109 S200',
  'G28', 'G1 X225 Y205 F5000', 'SET_KINEMATIC_POSITION Y=0', 'G1 Y15 F4000',
  ';LAYER:0', ';Z:0.2', 'G1 X10 Y10 E1 F1200',
  'M104 S0', 'M140 S0'].join('\n'), base.settings);
if (kin.errors === 0) { pass++; console.log('  ok      SET_KINEMATIC_POSITION is followed, not read as a move'); }
else { fail++; console.log('  FALSE ALARM on a re-based coordinate system:',
  kin.findings.filter(function (f) { return f.severity === 'error'; })[0].code); }

// --- the declared reach is a limit, not a licence ---
// A machine may purge in front of its plate; it may not drive into the frame.
var reachSettings = P.buildSettings('centauri_carbon', 'pla', 'q020');
expectCatch('a start script beyond what the machine reaches',
  ['G90', 'M82', 'M140 S60', 'M190 S60', 'M104 S200', 'M109 S200',
   'G28', 'G1 X128 Y-1.2 F20000', 'G1 X128 Y-40 F20000',
   ';LAYER:0', ';Z:0.2', 'G1 X10 Y10 E1 F1200',
   'M104 S0', 'M140 S0'].join('\n'),
  reachSettings, 'bounds.xy', 'error');

// --- lifting Z before homing is allowed; everything else still is not ---
// A bed slinger homes X and Y first and drags the nozzle across the plate from
// wherever the last print left it, so the machine's own script raises Z first.
var head = ['G90', 'M82', 'M140 S60', 'M190 S60', 'M104 S200', 'M109 S200'];
var tail = [';LAYER:0', ';Z:0.2', 'G1 X10 Y10 E1 F1200', 'M104 S0', 'M140 S0'];
var lift = C.verify(head.concat(['G1 Z3 F3000', 'G28'], tail).join('\n'), base.settings);
if (lift.findings.some(function (f) { return f.code === 'move.unhomed'; })) {
  fail++; console.log('  FALSE ALARM: a Z lift before homing read as an unhomed move');
} else { pass++; console.log('  ok      lifting Z before homing is allowed'); }

expectCatch('an X/Y move before homing',
  head.concat(['G1 X100 Y100 F3000', 'G28'], tail).join('\n'),
  base.settings, 'move.unhomed', 'error');
expectCatch('a downward Z move before homing',
  head.concat(['G1 Z-2 F3000', 'G28'], tail).join('\n'),
  base.settings, 'move.unhomed', 'error');

// --- the file may only speak what the machine is known to understand -------
// G2/G3 needs ARC_SUPPORT compiled into Marlin and a [gcode_arcs] section in
// Klipper; M420 needs bed levelling; M900 needs linear advance; M200 needs
// volumetric extrusion. A printer without one of them does not skip the line,
// it stops the print. So the body may only use what both firmware families
// implement, plus whatever this machine's own scripts already use.
console.log('\n=== 12. only commands this machine is known to accept ===');

var vocabHead = ['G90', 'M82', 'M140 S60', 'M190 S60', 'M104 S200', 'M109 S200', 'G28'];
var vocabTail = ['M104 S0', 'M140 S0', 'M84'];
function bodyWith(line, settings) {
  return vocabHead.concat([';LAYER_CHANGE', ';LAYER:0', ';Z:0.2',
    'G1 Z0.2 F600', 'G1 X100 Y100 E1 F1200', line, 'G1 X110 Y100 E2 F1200',
    ';END_GCODE'], vocabTail).join('\n');
}
var x2 = P.buildSettings('artillery_x2', 'pla', 'q020');

// M900 is linear advance, M73 a progress report, M201 a machine limit, M572
// pressure advance on Duet, SET_PRESSURE_ADVANCE the Klipper spelling of it.
// Every one is optional on the firmware that has it at all — and the X2's own
// scripts ask for none of them.
['M900 K0.05', 'M73 P50', 'M201 X500', 'M572 D0 S0.05', 'M486 S0',
 'SET_PRESSURE_ADVANCE ADVANCE=0.05']
  .forEach(function (line) {
    expectCatch('a body that uses ' + line.split(' ')[0],
      bodyWith(line, x2), x2, 'command.unsupported', 'error');
  });

// But M420 is in the X2's own start script — its bed mesh is switched on
// there — so the machine plainly knows it.
var known = C.verify(bodyWith('M420 S1', x2), x2);
if (known.findings.some(function (f) { return f.code === 'command.unsupported'; })) {
  fail++; console.log('  FALSE ALARM: M420 rejected on a machine whose own script uses it');
} else { pass++; console.log('  ok      M420 passes on the X2, whose start script switches its mesh on'); }

// The plain commands both firmware families implement are never questioned.
var plain = C.verify(bodyWith('M204 S800', x2), x2);
if (plain.findings.some(function (f) { return f.code === 'command.unsupported'; })) {
  fail++; console.log('  FALSE ALARM: M204 reported as unsupported');
} else { pass++; console.log('  ok      M204, M106, M104 and the rest of the core pass'); }

// A machine that is sent M6211 by its own manufacturer plainly knows M6211.
var cc2 = P.buildSettings('centauri_carbon_2', 'pla', 'q020');
var vendorOwn = C.verify(bodyWith('M6211 A1 L200 T0 Q215 R215 S215', cc2), cc2);
if (vendorOwn.findings.some(function (f) { return f.code === 'command.unsupported'; })) {
  fail++; console.log('  FALSE ALARM: a command from the machine\'s own start script was rejected');
} else { pass++; console.log('  ok      a command the machine\'s own scripts use is allowed in the body'); }

// And editing the start script widens the vocabulary the moment it is edited.
var edited = P.buildSettings('artillery_x2', 'pla', 'q020');
edited.startGcode = edited.startGcode + '\nM900 K0.12 ; linear advance';
var afterEdit = C.verify(bodyWith('M900 K0.05', edited), edited);
if (afterEdit.findings.some(function (f) { return f.code === 'command.unsupported'; })) {
  fail++; console.log('  FALSE ALARM: M900 still rejected after the start script was told about it');
} else { pass++; console.log('  ok      a start script that uses a command permits it in the body too'); }

// The report says what the file needed, and where each command is known.
var listed = C.verify(bodyWith('M204 S800', x2), x2).summary.commands;
var names = listed.map(function (c) { return c.command; }).join(' ');
if (/G1/.test(names) && /M204/.test(names) &&
    listed.every(function (c) { return !!c.known; })) {
  pass++; console.log('  ok      the report lists every command the body used (' + names + ')');
} else { fail++; console.log('  MISSED  command list: ' + JSON.stringify(listed)); }

// Every profile, every feature: the whole catalogue has to stay inside its
// own vocabulary. This is the promise, checked rather than asserted.
var outside = [];
Object.keys(P.PRINTERS).forEach(function (k) {
  var s = P.buildSettings(k, 'pla', 'q020');
  s.supportEnable = true; s.ironing = 'top'; s.adhesion = 'brim'; s.gapFill = true;
  s.wallGenerator = 'arachne'; s.seamScarf = true; s.monotonicSurfaces = 'all';
  s.internalBridges = true; s.arcFitting = true;
  var pr = P.PRINTERS[k];
  var mesh = box(pr.bed.x / 2, pr.bed.y / 2, Math.min(20, pr.bed.x * 0.3), 6);
  var g = E.slice({ positions: mesh, settings: s }, function () {}).gcode;
  var v = C.verify(g, s);
  v.findings.forEach(function (f) {
    if (f.code === 'command.unsupported' || f.code === 'arc.unsupported') {
      outside.push(k + ': ' + f.message);
    }
  });
});
if (!outside.length) { pass++; console.log('  ok      all ' + Object.keys(P.PRINTERS).length +
  ' machines produce a file inside their own vocabulary, every feature on'); }
else { fail++; console.log('  MISSED  ' + outside.length + ' outside: ' + outside.slice(0, 3).join(' | ')); }

console.log('\n'+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
