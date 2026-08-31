globalThis.ClipperLib = require('./js/vendor/clipper.js');
globalThis.OrcaPresets = require('./js/slicer/presets.js');
require('./js/slicer/engine.js');
require('./js/slicer/beading.js');
var C = require('./js/slicer/gcodecheck.js');
var E = globalThis.OrcaEngine, P = globalThis.OrcaPresets;
function box(cx,cy,w,h){var x0=cx-w/2,y0=cy-w/2,x1=cx+w/2,y1=cy+w/2;
 var v=[[x0,y0,0],[x1,y0,0],[x1,y1,0],[x0,y1,0],[x0,y0,h],[x1,y0,h],[x1,y1,h],[x0,y1,h]];
 var f=[[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
 var o=[];f.forEach(t=>t.forEach(i=>o.push(v[i][0],v[i][1],v[i][2])));return new Float32Array(o);}

var pass=0,fail=0;
function expectCatch(label, gcode, settings, code, severity){
  var v=C.verify(gcode, settings);
  var hit=v.findings.find(f=>f.code===code||f.code===code+'.more');
  if(hit && (!severity||hit.severity===severity)){pass++;console.log('  caught  '+label.padEnd(52)+'-> ['+hit.severity+'] '+hit.message.slice(0,74));}
  else {fail++;console.log('  MISSED  '+label.padEnd(52)+'-> expected '+code+'; got '+(v.findings.map(f=>f.code).join(',')||'nothing'));}
}
function expectClean(label, gcode, settings){
  var v=C.verify(gcode,settings);
  if(v.errors===0&&v.warnings===0){pass++;console.log('  clean   '+label);}
  else {fail++;console.log('  NOISE   '+label+' -> '+v.findings.map(f=>f.severity+':'+f.code).join(', '));}
}

var s=P.buildSettings('ender3','pla','q020');
var g=E.slice({positions:box(110,110,20,6),settings:s},function(){}).gcode;
expectClean('Ender-3 baseline', g, s);

console.log('\n=== kinematics: Z axis speed ===');
expectCatch('layer change sent at XY travel speed', g.replace(/^G1 Z0\.65 F\d+/m,'G1 Z0.65 F18000'), s, 'z.speed.high', 'error');
expectCatch('Z slightly over the axis limit', g.replace(/^G1 Z0\.65 F\d+/m,'G1 Z0.65 F1000'), s, 'z.speed.warn', 'warning');

console.log('\n=== collision: sweeping the finished print ===');
var swept = g.replace(/G91 ; relative\nG1 Z10 F\d+ ; lift\nG90 ; absolute\nG1 X5 Y(\d+) F6000 ; present print/,
                      'G1 X5 Y$1 F6000 ; present print\nG91 ; relative\nG1 Z10 F720 ; lift\nG90 ; absolute');
expectCatch('head crosses the part before lifting', swept, s, 'collision.sweep', 'error');
expectClean('standard end G-code lifts first', g, s);

console.log('\n=== thermal: a step that is never waited out ===');
var jump = g.replace(/^;LAYER:5$/m, ';LAYER:5\nM104 S265');
expectCatch('nozzle target jumps 50 C mid-print without M109', jump, s, 'temp.step.nowait', 'warning');
var waited = g.replace(/^;LAYER:5$/m, ';LAYER:5\nM104 S265\nM109 S265');
expectClean('same jump, but waited out with M109', waited, s);

console.log('\n=== profile limits cannot be talked up without saying so ===');
var raised=JSON.parse(JSON.stringify(s)); raised.maxNozzleTemp=400;
expectCatch('profile nozzle limit raised above factory', g, raised, 'limit.raised.nozzle', 'warning');
var absurd=JSON.parse(JSON.stringify(s)); absurd.maxNozzleTemp=600;
expectCatch('profile raised past the absolute ceiling still caps at 500',
  g.replace(/M109 S\d+/, 'M109 S550'), absurd, 'temp.nozzle.high', 'error');
var bedRaised=JSON.parse(JSON.stringify(s)); bedRaised.maxBedTemp=200;
expectCatch('bed limit raised past the ceiling still caps at 150',
  g.replace(/M190 S\d+/, 'M190 S160'), bedRaised, 'temp.bed.high', 'error');

console.log('\n'+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
