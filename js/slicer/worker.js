/**
 * Orca Web Slicer — slicing worker.
 * Keeps the heavy geometry off the UI thread and streams progress back.
 * If a browser (or an Android WebView) refuses to run this, the app falls back
 * to slicing in the page — see sliceInPage() in app.js.
 */
/* global importScripts, postMessage */
'use strict';

importScripts('../vendor/clipper.js', 'presets.js', 'engine.js', 'beading.js', 'lightning.js', 'treesupport.js', 'template.js', 'gcodecheck.js');

self.onmessage = function (ev) {
  var msg = ev.data;
  if (msg.cmd !== 'slice') return;

  try {
    var started = Date.now();
    var result = self.OrcaEngine.slice(
      { positions: msg.positions, objects: msg.objects, settings: msg.settings },
      function (fraction, label) {
        postMessage({ type: 'progress', value: Math.max(0, Math.min(1, fraction)), label: label || '' });
      }
    );

    var packed = self.OrcaEngine.packLayers(result.layers);
    var transfer = [];
    for (var i = 0; i < packed.length; i++) {
      transfer.push(packed[i].pts.buffer, packed[i].pointWidths.buffer,
                    packed[i].offsets.buffer, packed[i].types.buffer, packed[i].widths.buffer);
    }

    postMessage({
      type: 'done',
      layers: packed,
      gcode: result.gcode,
      stats: result.stats,
      report: result.report,
      bounds: result.bounds,
      elapsed: Date.now() - started
    }, transfer);
  } catch (err) {
    postMessage({ type: 'error', message: (err && err.message) || String(err), stack: err && err.stack });
  }
};
