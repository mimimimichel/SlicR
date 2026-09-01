/**
 * Web Slicer — every printer profile, every feature on.
 *
 * Slices the same part on all of them and insists the safety verifier comes
 * back clean. A profile that cannot produce a safe file is worse than one that
 * does not exist.
 *
 *   node test-profiles.js
 */
globalThis.ClipperLib = require('./js/vendor/clipper.js');
globalThis.OrcaPresets = require('./js/slicer/presets.js');
require('./js/slicer/engine.js');
require('./js/slicer/beading.js');
require('./js/slicer/lightning.js');
require('./js/slicer/treesupport.js');
require('./js/slicer/template.js');
require('./js/slicer/gcodecheck.js');
require('./js/slicer/gcodeview.js');
var E = globalThis.OrcaEngine, P = globalThis.OrcaPresets, V = globalThis.OrcaGcodeView;

// A part with a bit of everything: overhang, thin rib, hole, flat top.
function part(cx, cy, scale) {
  var t = [];
  function tri(a,b,c){ t.push(a[0],a[1],a[2],b[0],b[1],b[2],c[0],c[1],c[2]); }
  var u = 24 * scale, v = 40 * scale;
  for (var i=0;i<48;i++) {
    var a0 = i/48*2*Math.PI, a1 = (i+1)/48*2*Math.PI;
    for (var j=0;j<24;j++) {
      var z0 = j/24*v, z1 = (j+1)/24*v;
      function r(z){ return u/2 * (0.45 + 0.55*Math.sin(Math.PI*(0.15+0.7*z/v))); }
      var A=[cx+Math.cos(a0)*r(z0), cy+Math.sin(a0)*r(z0), z0];
      var B=[cx+Math.cos(a1)*r(z0), cy+Math.sin(a1)*r(z0), z0];
      var C=[cx+Math.cos(a1)*r(z1), cy+Math.sin(a1)*r(z1), z1];
      var D=[cx+Math.cos(a0)*r(z1), cy+Math.sin(a0)*r(z1), z1];
      tri(A,B,C); tri(A,C,D);
    }
  }
  // caps
  for (i=0;i<48;i++) {
    var b0=i/48*2*Math.PI, b1=(i+1)/48*2*Math.PI;
    function rr(z){ return u/2 * (0.45 + 0.55*Math.sin(Math.PI*(0.15+0.7*z/v))); }
    tri([cx,cy,0],[cx+Math.cos(b1)*rr(0),cy+Math.sin(b1)*rr(0),0],[cx+Math.cos(b0)*rr(0),cy+Math.sin(b0)*rr(0),0]);
    tri([cx,cy,v],[cx+Math.cos(b0)*rr(v),cy+Math.sin(b0)*rr(v),v],[cx+Math.cos(b1)*rr(v),cy+Math.sin(b1)*rr(v),v]);
  }
  return new Float32Array(t);
}

var printers = P.printers ? Object.keys(P.printers) : Object.keys(P.PRINTERS || {});
if (!printers.length && P.printerKeys) printers = P.printerKeys();
var pass = 0, fail = 0;

printers.forEach(function (key) {
  var s;
  try { s = P.buildSettings(key, 'pla', 'standard_02'); }
  catch (err) { fail++; console.log('  FAIL ' + key + ' -> buildSettings: ' + err.message); return; }

  // Everything on at once.
  s.supportEnable = true; s.supportStyle = 'tree'; s.ironing = 'top'; s.adhesion = 'brim'; s.fuzzySkin = 'outer';
  s.gapFill = true; s.wallGenerator = 'arachne'; s.seamScarf = true; s.arcFitting = true;
  s.monotonicSurfaces = 'all'; s.overhangSlowdown = true; s.internalBridges = true;
  s.thumbnails = true;
  s.paintMarks = [{ x: s.bedX/2 - 6, y: s.bedY/2, z: 12, r: 3, kind: 'enforce' },
                  { x: s.bedX/2 + 6, y: s.bedY/2, z: 20, r: 3, kind: 'seam' }];

  var scale = Math.min(1, Math.min(s.bedX, s.bedY) / 120);
  var r;
  try { r = E.slice({ positions: part(s.bedX/2, s.bedY/2, scale), settings: s }, function(){}); }
  catch (err) { fail++; console.log('  FAIL ' + key + ' -> threw: ' + err.message); return; }

  var bad = r.report.findings.filter(function (f) { return f.severity !== 'info'; });
  var nan = r.gcode.split('\n').some(function (l) { return /^[GM]\d/.test(l) && /NaN|undefined|Infinity/.test(l); });

  // And the file itself, read the way a printer reads it. A verifier that only
  // looks for dangerous lines will pass a file with nothing in it.
  var read = V.parse(r.gcode);
  var thin = read.stats.segments < 200 ||
             read.stats.layers < r.layers.length ||
             !(read.stats.filamentMm > r.stats.filamentMm * 0.5) ||
             !(read.stats.maxZ > 1);

  if (bad.length || nan || thin || !(r.stats.volumeCm3 > 0)) {
    fail++;
    console.log('  FAIL ' + key + (nan ? ' -> NaN in commands' : '') +
      (thin ? ' -> reads back as ' + JSON.stringify(read.stats) + ' for ' +
        r.layers.length + ' planned layers' : '') +
      (bad.length ? ' -> [' + bad[0].severity + '] ' + bad[0].code + ': ' + bad[0].message : ''));
  } else {
    pass++;
  }
});

console.log('\n' + pass + '/' + (pass + fail) + ' profiles clean with every feature on');
process.exit(fail ? 1 : 0);
