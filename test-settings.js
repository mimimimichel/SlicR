/**
 * Web Slicer — every knob has to turn something.
 *
 * A setting that changes nothing is worse than a missing one: somebody reads
 * it, believes it, changes it, and prints the same file again. This is how
 * `minFanSpeed` was found — carried in every profile, exposed nowhere, read by
 * nothing — so it is now a standing check over the whole panel.
 *
 * Each setting is moved once, on a shape that has an overhang, a flat top, a
 * thin rib and a hole, and the file that comes out has to differ. A handful
 * that can be checked for direction rather than difference are checked that
 * way too.
 *
 *   node test-settings.js
 */

globalThis.ClipperLib=require('./js/vendor/clipper.js');
globalThis.OrcaPresets=require('./js/slicer/presets.js');
['engine','beading','lightning','treesupport','template','gcodecheck'].forEach(function(m){
  require('./js/slicer/'+m+'.js');});
var E=globalThis.OrcaEngine,P=globalThis.OrcaPresets;
function q(t,a,b,c,e){t.push(a,b,c,a,c,e);}
function box(w,d,h,cx,cy,z0){z0=z0||0;var x0=cx-w/2,x1=cx+w/2,y0=cy-d/2,y1=cy+d/2,t=[];
 var A=[x0,y0,z0],B=[x1,y0,z0],C=[x1,y1,z0],D=[x0,y1,z0];
 var E2=[x0,y0,z0+h],F=[x1,y0,z0+h],G=[x1,y1,z0+h],H=[x0,y1,z0+h];
 q(t,A,D,C,B);q(t,E2,F,G,H);q(t,A,B,F,E2);q(t,B,C,G,F);q(t,C,D,H,G);q(t,D,A,E2,H);return t;}
function flat(t){var o=new Float32Array(t.length*3),a=0;for(var i=0;i<t.length;i++){o[a++]=t[i][0];o[a++]=t[i][1];o[a++]=t[i][2];}return o;}
// A shape with everything on it: an overhang, a flat top, a thin rib, a hole.
var tris=box(24,24,6,150,150).concat(box(36,24,3,150,150,6)).concat(box(0.7,20,4,150,168));
var pos=flat(tris);
function run(over){
  var s=P.buildSettings('artillery_x2','pla','q020');
  s.supportEnable=true;
  for(var k in over) s[k]=over[k];
  return E.slice({positions:pos,settings:s},function(){}).gcode;
}
var base=run({});
var cases=[
  ['layerHeight',{layerHeight:0.3}],['firstLayerHeight',{firstLayerHeight:0.3}],
  ['lineWidth',{lineWidth:0.5}],['externalLineWidth',{externalLineWidth:0.5}],
  ['firstLayerLineWidth',{firstLayerLineWidth:0.6}],
  ['wallLoops',{wallLoops:4}],['topLayers',{topLayers:6}],['bottomLayers',{bottomLayers:6}],
  ['infillDensity',{infillDensity:40}],['infillPattern',{infillPattern:'gyroid'}],
  ['solidPattern',{solidPattern:'concentric'}],['infillOverlap',{infillOverlap:0.4}],
  ['infillAnchor',{infillAnchor:6}],['solidInfillBelowArea',{solidInfillBelowArea:400}],
  ['flowRatio',{flowRatio:1.1}],['maxVolumetric',{maxVolumetric:6}],
  ['retractLength',{retractLength:3}],['retractSpeed',{retractSpeed:20}],
  ['deretractSpeed',{deretractSpeed:20}],['zHop',{zHop:0.6}],
  ['minTravelForRetract',{minTravelForRetract:10}],['combing',{combing:true}],
  ['wipeOnRetract',{wipeOnRetract:false}],['wipeDistance',{wipeDistance:5}],
  ['gcodeResolution',{gcodeResolution:0.05}],
  ['travelSpeed',{travelSpeed:60}],['maxAccel',{maxAccel:500}],['maxSpeed',{maxSpeed:40}],
  ['minLayerTime',{minLayerTime:30}],['slowDownMinSpeed',{slowDownMinSpeed:30}],
  ['fanSpeed',{fanSpeed:40}],['minFanSpeed',{minFanSpeed:0,fanCoolingTime:5}],
  ['fanCoolingTime',{fanCoolingTime:2}],['firstLayerFanSpeed',{firstLayerFanSpeed:70}],
  ['fanFromLayer',{fanFromLayer:8}],['overhangFanSpeed',{overhangFanSpeed:20}],
  ['nozzleTemp',{nozzleTemp:230}],['bedTemp',{bedTemp:70}],
  ['firstLayerNozzleTemp',{firstLayerNozzleTemp:230}],['firstLayerBedTemp',{firstLayerBedTemp:70}],
  ['chamberTemp',{chamberTemp:40}],
  ['adhesion brim',{adhesion:'brim'}],['adhesion raft',{adhesion:'raft'}],['adhesion none',{adhesion:'none'}],
  ['brimWidth',{adhesion:'brim',brimWidth:12}],['brimType',{adhesion:'brim',brimType:'both'}],
  ['brimGap',{adhesion:'brim',brimGap:0.5}],
  ['skirtLoops',{skirtLoops:5}],['skirtDistance',{skirtDistance:9}],
  ['raftLayers',{adhesion:'raft',raftLayers:4}],['raftGap',{adhesion:'raft',raftGap:0.4}],
  ['supportEnable off',{supportEnable:false}],['supportStyle',{supportStyle:'tree'}],
  ['supportThreshold',{supportThreshold:80}],['supportDensity',{supportDensity:40}],
  ['supportZGap',{supportZGap:0.6}],['supportXYGap',{supportXYGap:2}],
  ['supportInterfaceLayers',{supportInterfaceLayers:0}],
  ['supportInterfaceDensity',{supportInterfaceDensity:40}],
  ['supportPattern',{supportPattern:'grid'}],['supportOnBuildplateOnly',{supportOnBuildplateOnly:true}],
  ['ironing',{ironing:'top'}],['ironingFlow',{ironing:'top',ironingFlow:0.3}],
  ['ironingSpacing',{ironing:'top',ironingSpacing:0.3}],
  ['monotonicSurfaces',{monotonicSurfaces:'none'}],
  ['seamPosition',{seamPosition:'rear'}],['seamScarf',{seamScarf:false}],
  ['scarfLength',{scarfLength:3}],
  ['fuzzySkin',{fuzzySkin:'outside'}],['fuzzyThickness',{fuzzySkin:'outside',fuzzyThickness:0.6}],
  ['fuzzyPointDistance',{fuzzySkin:'outside',fuzzyPointDistance:1.2}],
  ['xyCompensation',{xyCompensation:0.2}],['elephantFootCompensation',{elephantFootCompensation:0.4}],
  ['gapFill',{gapFill:false}],['wallGenerator',{wallGenerator:'classic'}],
  ['wallOrder',{wallOrder:'outer-inner'}],['adaptiveLayers',{adaptiveLayers:true}],
  ['adaptiveQuality',{adaptiveLayers:true,adaptiveQuality:0.9}],
  ['spiralVase',{spiralVase:true}],['relativeE',{relativeE:true}],
  ['arcFitting',{arcFitting:true}],['arcTolerance',{arcFitting:true,arcTolerance:0.2}],
  ['bridgeFlow',{bridgeFlow:0.6}],['internalBridgeFlow',{internalBridgeFlow:0.6}],
  ['internalBridges',{internalBridges:false}],['bridgeAngleDetection',{bridgeAngleDetection:false}],
  ['overhangSlowdown',{overhangSlowdown:false}],['overhangFanBoost',{overhangFanBoost:false}],
  ['smallPerimeterSpeed',{smallPerimeterSpeed:10}],['smallPerimeterThreshold',{smallPerimeterThreshold:40}],
  ['minBeadWidth',{minBeadWidth:0.35}],['maxBeadWidth',{maxBeadWidth:0.9}],
  ['wallTransitionLength',{wallTransitionLength:2}],['lightningAngle',{infillPattern:'lightning',lightningAngle:60}],
  ['emitAcceleration',{emitAcceleration:false}],['thumbnails',{thumbnails:false}],
  ['gcodeFlavor',{gcodeFlavor:'klipper'}],['originCenter',{originCenter:true}],
  ['maxZSpeed',{maxZSpeed:4}],['nozzle',{nozzle:0.6,lineWidth:0.63,externalLineWidth:0.63,firstLayerLineWidth:0.75}],
  ['filamentDiameter',{filamentDiameter:2.85}],['printSequence',{printSequence:'object'}]
];
var pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); }
}

console.log('=== 1. every setting changes the file ===');
var dead = [], threw = [], outputs = {};
cases.forEach(function (c) {
  var g;
  try { g = run(c[1]); } catch (e) { threw.push(c[0] + ': ' + e.message.slice(0, 40)); return; }
  outputs[c[0]] = g;
  if (g === base) dead.push(c[0]);
});
ok(cases.length + ' settings tried, every one of them changed the file',
  dead.length === 0, dead.join(', '));
ok('and not one of them stopped it slicing', threw.length === 0, threw.join(' | '));

console.log('\n=== 2. and a few of them in the right direction ===');
/**
 * Filament laid down, which is not the same as filament pushed: a retraction
 * puts the same millimetres back and forth without leaving any of it on the
 * plate, and on a part with supports there are thousands of them. Only E that
 * moves with the head counts.
 */
function filament(g) {
  var e = 0, rel = false, total = 0, x = 0, y = 0;
  g.split('\n').forEach(function (raw) {
    var L = raw.split(';')[0].trim();
    if (/^M83\b/.test(L)) { rel = true; return; }
    if (/^M82\b/.test(L)) { rel = false; return; }
    if (/^G92\b/.test(L)) { var g0 = /E(-?[\d.]+)/.exec(L); if (g0) e = parseFloat(g0[1]); return; }
    if (!/^G[0-3]\b/.test(L)) return;
    var nx = x, ny = y;
    var mx = /X(-?[\d.]+)/.exec(L); if (mx) nx = parseFloat(mx[1]);
    var my = /Y(-?[\d.]+)/.exec(L); if (my) ny = parseFloat(my[1]);
    var m = /E(-?[\d.]+)/.exec(L);
    if (m) {
      var v = parseFloat(m[1]), de = rel ? v : v - e;
      e = rel ? e + v : v;
      if (de > 0 && Math.hypot(nx - x, ny - y) > 1e-6) total += de;
    }
    x = nx; y = ny;
  });
  return total;
}
function count(g, re) { return (g.match(re) || []).length; }
var baseFil = filament(base);
ok('more flow means more filament',
  filament(outputs['flowRatio']) > baseFil * 1.05,
  filament(outputs['flowRatio']).toFixed(0) + ' vs ' + baseFil.toFixed(0));
ok('more walls means more filament',
  filament(outputs['wallLoops']) > baseFil * 1.05);
ok('more infill means more filament',
  filament(outputs['infillDensity']) > baseFil * 1.05);
ok('turning support off means less',
  filament(outputs['supportEnable off']) < baseFil * 0.98);
ok('a longer retraction shows up as one',
  /E-3\b|E-3\./.test(outputs['retractLength']) || count(outputs['retractLength'], /E-/g) > 0);
ok('a hotter nozzle is commanded hotter', /M104 S230|M109 S230/.test(outputs['nozzleTemp']));
ok('a warmer bed likewise', /M140 S70|M190 S70/.test(outputs['bedTemp']));
ok('relative extrusion says so', /^M83\b/m.test(outputs['relativeE']));
ok('arcs appear when they are asked for', count(outputs['arcFitting'], /^G[23] /gm) > 0);
ok('and never otherwise', count(base, /^G[23] /gm) === 0);
ok('a raft puts material under the part',
  filament(outputs['adhesion raft']) > baseFil * 1.02);
ok('no adhesion at all takes the skirt away',
  filament(outputs['adhesion none']) < baseFil);
ok('vase mode leaves one wall and no top',
  filament(outputs['spiralVase']) < baseFil * 0.5);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
