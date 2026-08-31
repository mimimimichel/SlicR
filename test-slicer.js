/**
 * Web Slicer — engine stress test.
 *
 * Slices demanding shapes with every feature switched on and asserts the result
 * is sane: no thrown errors, no findings from the G-code verifier, a positive
 * volume and duration, and no NaN reaching a G/M command.
 *
 *   node test-slicer.js
 */
globalThis.ClipperLib = require('./js/vendor/clipper.js');
globalThis.OrcaPresets = require('./js/slicer/presets.js');
require('./js/slicer/engine.js');
require('./js/slicer/beading.js');
require('./js/slicer/lightning.js');
require('./js/slicer/template.js');
require('./js/slicer/gcodecheck.js');
var E = globalThis.OrcaEngine, P = globalThis.OrcaPresets;

function mesh(fn, uSteps, vSteps, closed) {
  var t = [];
  function tri(a,b,c){ t.push(a[0],a[1],a[2],b[0],b[1],b[2],c[0],c[1],c[2]); }
  for (var i=0;i<uSteps;i++) for (var j=0;j<vSteps;j++){
    var a=fn(i/uSteps,j/vSteps), b=fn((i+1)/uSteps,j/vSteps),
        c=fn((i+1)/uSteps,(j+1)/vSteps), d=fn(i/uSteps,(j+1)/vSteps);
    tri(a,b,c); tri(a,c,d);
  }
  return new Float32Array(t);
}
var SHAPES = {
  sphere: mesh(function(u,v){ var th=u*2*Math.PI, ph=v*Math.PI;
    return [128+Math.sin(ph)*Math.cos(th)*14, 128+Math.sin(ph)*Math.sin(th)*14, 14.2-Math.cos(ph)*14]; }, 64, 32),
  torus: mesh(function(u,v){ var th=u*2*Math.PI, ph=v*2*Math.PI;
    return [128+(14+5*Math.cos(ph))*Math.cos(th), 128+(14+5*Math.cos(ph))*Math.sin(th), 5.2+5*Math.sin(ph)]; }, 72, 28),
  cone: mesh(function(u,v){ var th=u*2*Math.PI, r=16-14*v;
    return [128+Math.cos(th)*r, 128+Math.sin(th)*r, v*22]; }, 72, 40),
  spiralTower: mesh(function(u,v){ var th=u*2*Math.PI + v*4, r=10+3*Math.sin(v*8);
    return [128+Math.cos(th)*r, 128+Math.sin(th)*r, v*25]; }, 64, 60)
};

var fails = 0, runs = 0;
function run(shapeName, printer, quality, tweak, label) {
  var s = P.buildSettings(printer, 'pla', quality);
  s.supportEnable = true; s.ironing = 'top'; s.adhesion = 'brim'; s.fuzzySkin = 'none';
  if (tweak) tweak(s);
  var t0 = Date.now();
  var r;
  try { r = E.slice({ positions: SHAPES[shapeName], settings: s }, function(){}); }
  catch (err) { fails++; console.log('  THREW   ' + label + ' -> ' + err.message); return; }
  runs++;
  var ms = Date.now() - t0;
  var bad = [];
  if (r.report.errors) bad.push(r.report.errors + ' errors');
  if (r.report.warnings) bad.push(r.report.warnings + ' warnings');
  if (!(r.stats.volumeCm3 > 0)) bad.push('no volume');
  if (!(r.stats.seconds > 0)) bad.push('no time');
  if (!isFinite(r.stats.grams)) bad.push('mass not finite');
  if (r.layers.length < 5) bad.push('only ' + r.layers.length + ' layers');
  var cmds = r.gcode.split('\n').filter(function(l){ return /^[GM]\d/.test(l); });
  if (cmds.some(function(l){ return /NaN|undefined|Infinity/.test(l); })) bad.push('NaN in commands');
  if (bad.length) { fails++; console.log('  FAIL    ' + label.padEnd(46) + '-> ' + bad.join(', ')); 
    r.report.findings.slice(0,2).forEach(function(f){ console.log('             [' + f.severity + '] ' + f.code + ' @' + f.line + ': ' + f.message); }); }
  else console.log('  ok      ' + label.padEnd(46) + String(ms+'ms').padStart(7) +
    ' ' + String(r.layers.length).padStart(4) + 'L  ' + r.stats.grams.toFixed(2) + 'g  ' +
    E.formatDuration(r.stats.seconds) + (r.stats.arcs ? '  ' + r.stats.arcs + ' arcs' : ''));
}

console.log('=== demanding shapes, every feature on ===');
Object.keys(SHAPES).forEach(function(shape){
  run(shape, 'centauri_carbon', 'q020', null, shape + ' / centauri / 0.20');
});
console.log('\n=== across printers and qualities ===');
[['ender3','q028'],['bambu_x1c','q012'],['flsun_v400','q016'],['creality_k1','q020'],['prusa_mk4','q008']].forEach(function(c){
  run('sphere', c[0], c[1], null, 'sphere / ' + c[0] + ' / ' + c[1]);
});
console.log('\n=== every infill pattern on a torus ===');
['grid','lines','triangles','gyroid','honeycomb','cubic','concentric','lightning'].forEach(function(pat){
  run('torus', 'centauri_carbon', 'q020', function(s){ s.infillPattern = pat; }, 'torus / infill ' + pat);
});
console.log('\n=== awkward combinations ===');
[['vase mode', function(s){ s.spiralVase = true; s.supportEnable = false; }],
 ['raft + adaptive layers', function(s){ s.adhesion='raft'; s.adaptiveLayers=true; }],
 ['0 walls, 100% infill', function(s){ s.wallLoops=0; s.infillDensity=100; }],
 ['1 wall, 0% infill, no top/bottom', function(s){ s.wallLoops=1; s.infillDensity=0; s.topLayers=0; s.bottomLayers=0; }],
 ['classic walls, no arcs, no scarf', function(s){ s.wallGenerator='classic'; s.arcFitting=false; s.seamScarf=false; }],
 ['relative E + klipper + monotonic all', function(s){ s.relativeE=true; s.gcodeFlavor='klipper'; s.monotonicSurfaces='all'; }],
 ['0.8 nozzle', function(s){ s.nozzle=0.8; s.lineWidth=0.85; s.externalLineWidth=0.85; s.firstLayerLineWidth=0.95; }]
].forEach(function(c){ run('cone', 'centauri_carbon', 'q020', c[1], 'cone / ' + c[0]); });

console.log('\n' + (runs - fails) + '/' + runs + ' passed');
process.exit(fails ? 1 : 0);
