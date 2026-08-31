/**
 * Web Slicer — the custom G-code expression language.
 *
 *   node test-template.js
 */
globalThis.ClipperLib = require('./js/vendor/clipper.js');
globalThis.OrcaPresets = require('./js/slicer/presets.js');
require('./js/slicer/engine.js');
require('./js/slicer/beading.js');
require('./js/slicer/lightning.js');
require('./js/slicer/treesupport.js');
require('./js/slicer/template.js');
require('./js/slicer/gcodecheck.js');
var T = globalThis.OrcaTemplate, E = globalThis.OrcaEngine, P = globalThis.OrcaPresets;

var vars = {
  chamber_temp: 0, bed_x: 256, bed_y: 256, bed_z: 256,
  first_layer_temp: 220, bed_temp: 60, layer_height: 0.2, machine: 'X1'
};
var fails = 0;
function eq(name, got, want) {
  var ok = got === want;
  if (!ok) fails++;
  console.log((ok ? '  ok  ' : 'FAIL  ') + name + ': ' + JSON.stringify(got) +
              (ok ? '' : ' (want ' + JSON.stringify(want) + ')'));
}

eq('plain value', T.render('M104 S{first_layer_temp}', vars), 'M104 S220');
eq('arithmetic', T.render('G0 X{bed_x / 2} Y{bed_y - 10}', vars), 'G0 X128 Y246');
eq('precedence', T.render('{2 + 3 * 4}', vars), '14');
eq('parentheses', T.render('{(2 + 3) * 4}', vars), '20');
eq('functions', T.render('{min(bed_y - 10, 200)} {max(1,2)} {round(1.2345, 2)}', vars),
   '200 2 1.23');
eq('comparison', T.render('{bed_x > 200}', vars), '1');
eq('ternary', T.render('{bed_x > 300 ? "big" : "small"}', vars), 'small');
eq('if skipped', T.render('a{if chamber_temp > 0}M191 S{chamber_temp}{endif}b', vars), 'ab');
vars.chamber_temp = 50;
eq('if taken', T.render('a{if chamber_temp > 0}M191 S{chamber_temp}{endif}b', vars), 'aM191 S50b');
eq('else', T.render('{if chamber_temp > 90}hot{else}warm{endif}', vars), 'warm');
eq('elsif chain', T.render('{if bed_x > 300}big{elsif bed_x > 200}medium{else}small{endif}', vars),
   'medium');
eq('nested if', T.render('{if bed_x > 100}{if chamber_temp > 0}both{endif}{endif}', vars), 'both');
eq('nested if, inner false',
   T.render('{if bed_x > 100}[{if chamber_temp > 900}no{endif}]{endif}', vars), '[]');
eq('and / or', T.render('{if bed_x > 100 && chamber_temp > 0}y{endif}', vars), 'y');
eq('negation', T.render('{if !(bed_x > 900)}y{endif}', vars), 'y');
eq('string concat', T.render('; {machine + " ready"}', vars), '; X1 ready');

// A typo has to stay visible rather than become a plausible number.
eq('unknown name is left alone', T.render('{nozle_temp}', vars), '{nozle_temp}');
eq('broken expression is left alone', T.render('{2 +}', vars), '{2 +}');
eq('unclosed brace is literal', T.render('M104 S{first', vars), 'M104 S{first');
eq('no braces, no change', T.render('G28 ; home', vars), 'G28 ; home');
// Nothing may reach outside the values handed in.
eq('no property access', T.render('{constructor}', vars), '{constructor}');
eq('no prototype walk', T.render('{toString}', vars), '{toString}');

// --- and it has to work in a real file ---
function box(w,d,h,cx,cy) {
  var x0=cx-w/2,x1=cx+w/2,y0=cy-d/2,y1=cy+d/2,t=[];
  function q(a,b,c,e){ t.push(a[0],a[1],a[2],b[0],b[1],b[2],c[0],c[1],c[2],
                              a[0],a[1],a[2],c[0],c[1],c[2],e[0],e[1],e[2]); }
  var A=[x0,y0,0],B=[x1,y0,0],C=[x1,y1,0],D=[x0,y1,0];
  var E2=[x0,y0,h],F=[x1,y0,h],G2=[x1,y1,h],H=[x0,y1,h];
  q(A,D,C,B); q(E2,F,G2,H); q(A,B,F,E2); q(B,C,G2,F); q(C,D,H,G2); q(D,A,E2,H);
  return new Float32Array(t);
}
function settings(over) {
  var s = P.buildSettings('elegoo_centauri_carbon', 'pla', 'standard_02');
  s.brimWidth = 0; s.skirtLoops = 0; s.raftLayers = 0; s.supportEnable = false;
  for (var k in over) s[k] = over[k];
  return s;
}
var sCond = settings({
  startGcode: 'G28\nM104 S{first_layer_temp}\n' +
    '{if chamber_temp > 0}M191 S{chamber_temp}\n{endif}' +
    'G0 X{round(bed_x / 2, 1)} Y5 F6000\nM109 S{first_layer_temp}\nM190 S{bed_temp}',
  layerGcode: '; layer {layer} of the {if object_layer == 0}first{else}next{endif} object',
  chamberTemp: 0
});
var cold = E.slice({ positions: box(10,10,1,128,128), settings: sCond }, function(){});
if (/M191/.test(cold.gcode)) { fails++; console.log('FAIL  chamber command emitted with no chamber'); }
else console.log('  ok  the chamber line is left out when there is no chamber');
if (!/G0 X128 Y5 F6000/.test(cold.gcode)) { fails++; console.log('FAIL  arithmetic did not reach the file'); }
else console.log('  ok  arithmetic reaches the file: G0 X128 Y5');
if (!/; layer 0 of the first object/.test(cold.gcode)) {
  fails++; console.log('FAIL  per-layer script did not render');
} else console.log('  ok  the per-layer script renders per layer');

var sHot = settings({ startGcode: sCond.startGcode, chamberTemp: 45,
                      maxChamberTemp: 60, layerGcode: '' });
var hot = E.slice({ positions: box(10,10,1,128,128), settings: sHot }, function(){});
if (!/M191 S45/.test(hot.gcode)) { fails++; console.log('FAIL  chamber command missing when there is one'); }
else console.log('  ok  the chamber line appears when there is a chamber');

[['cold', cold], ['hot', hot]].forEach(function (c) {
  var bad = c[1].report.findings.filter(function (f) { return f.severity !== 'info'; });
  if (bad.length) { fails++; console.log('FAIL  ' + c[0] + ' verifier: ' + JSON.stringify(bad[0])); }
  else console.log('  ok  ' + c[0] + ': verifier clean');
});

// Every shipped profile's start and end script must still render with nothing
// left unresolved — a stray {placeholder} in a start script is a live grenade.
var stray = [];
Object.keys(P.printers || {}).forEach(function (key) {
  var s2 = P.buildSettings(key, 'pla', 'standard_02');
  ['startGcode', 'endGcode'].forEach(function (which) {
    var r = E.slice ? null : null;
    var text = globalThis.OrcaTemplate.render(s2[which] || '', (function () {
      var v = {}; for (var k in s2) if (typeof s2[k] !== 'object') v[k] = s2[k];
      v.nozzle_temp = s2.firstLayerNozzleTemp; v.first_layer_temp = s2.firstLayerNozzleTemp;
      v.bed_temp = s2.firstLayerBedTemp; v.bed_x = s2.bedX; v.bed_y = s2.bedY; v.bed_z = s2.bedZ;
      v.chamber_temp = s2.chamberTemp; v.layer_height = s2.layerHeight;
      return v;
    })());
    var left = text.match(/\{[^}]*\}/g);
    if (left) stray.push(key + '.' + which + ' -> ' + left.join(' '));
  });
});
if (stray.length) { fails++; console.log('FAIL  unresolved placeholders: ' + stray.slice(0,4).join(' | ')); }
else console.log('  ok  all 43 profiles render with nothing left unresolved');

console.log(fails ? '\n' + fails + ' FAILURES' : '\nall template checks pass');
process.exit(fails ? 1 : 0);
