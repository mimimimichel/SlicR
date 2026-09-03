/**
 * Prismatic — the app.
 *
 * Open a mesh, look at what the conversion found in it, convert, save. The
 * whole thing runs in the page: the file is read with FileReader and written
 * back out with a Blob, and nothing is sent anywhere.
 *
 * The order matters more than it looks. A mesh is inspected before anything is
 * done to it, and what the inspection found is what gets drawn — face by face,
 * in colour. So the tolerances can be dialled in against the picture rather
 * than against a guess, and Convert only ever does what is already on screen.
 */
(function () {
  'use strict';

  var el = function (id) { return document.getElementById(id); };

  var state = {
    viewer: null,
    name: '',
    source: null,      // the mesh as it was opened
    current: null,     // what is on screen: the source, or the rebuild
    look: null,        // the last inspection of `current`
    report: null,
    busy: false,
    pending: null
  };

  // ---------------------------------------------------------------------------
  // Numbers, said the way a person would
  // ---------------------------------------------------------------------------

  function count(n) { return (n | 0).toLocaleString(); }
  function mm(n) { return n.toFixed(3) + ' mm'; }
  function facts(node, rows) {
    node.innerHTML = '';
    rows.forEach(function (row) {
      if (!row) return;
      var dt = document.createElement('dt');
      dt.textContent = row[0];
      var dd = document.createElement('dd');
      if (row[2]) {
        var b = document.createElement('b');
        b.textContent = row[1];
        if (row[2] !== true) b.className = row[2];
        dd.appendChild(b);
      } else {
        dd.textContent = row[1];
      }
      node.appendChild(dt);
      node.appendChild(dd);
    });
  }

  var toastTimer = null;
  function toast(text, kind, hold) {
    var box = el('toast');
    box.className = 'pr-toast' + (kind ? ' ' + kind : '');
    box.textContent = text;
    box.hidden = false;
    clearTimeout(toastTimer);
    if (hold !== true) toastTimer = setTimeout(function () { box.hidden = true; }, kind === 'bad' ? 9000 : 3200);
  }
  function hideToast() { clearTimeout(toastTimer); el('toast').hidden = true; }

  function tolerances() {
    return {
      angle: parseFloat(el('opt-angle').value) || 1.5,
      deviation: parseFloat(el('opt-deviation').value) || 0.05,
      snapAxes: el('opt-square').checked
    };
  }

  // ---------------------------------------------------------------------------
  // Looking at what is open
  // ---------------------------------------------------------------------------

  /**
   * Inspect whatever is on screen and draw the answer. Reading a large mesh
   * takes a moment on the one thread there is, so the message goes up first and
   * the work waits for the browser to have painted it.
   */
  function look(then) {
    if (!state.current) return;
    if (state.busy) { state.pending = then || true; return; }
    state.busy = true;
    toast('Reading the mesh…', null, true);
    setTimeout(function () {
      var found;
      try {
        found = window.Prismatic.inspect(state.current, tolerances());
      } catch (e) {
        state.busy = false;
        toast('That mesh could not be read: ' + (e.message || e), 'bad');
        return;
      }
      state.look = found;
      state.viewer.setMesh(found.positions, found.face);
      state.viewer.setEdges(found.edges);
      if (!state.framed) { state.viewer.frame(); state.framed = true; }
      showMesh(found);
      state.busy = false;
      hideToast();
      if (typeof then === 'function') then(found);
      var again = state.pending;
      state.pending = null;
      if (again) look(typeof again === 'function' ? again : null);
    }, 30);
  }

  function showMesh(found) {
    facts(el('facts'), [
      ['Triangles', count(found.triangles)],
      ['Flat faces', count(found.faces)],
      ['Off flat', mm(found.deviation)],
      ['Watertight', found.watertight ? 'yes' : (found.openEdges ? found.openEdges + ' open edges' : 'no')]
    ]);

    var box = el('verdict');
    if (found.verdict === 'empty') {
      box.className = 'pr-verdict bad';
      box.textContent = 'There is no geometry here.';
    } else if (found.verdict === 'organic') {
      box.className = 'pr-verdict warn';
      box.textContent = 'Almost nothing on this mesh folds sharply, so it was never a prismatic ' +
        'part — this is a scan or a sculpt. Converting it would flatten what is curved into ' +
        'faces up to ' + found.deviation.toFixed(3) + ' mm from where the surface is now. ' +
        'Tighten the deviation, or leave it be.';
    } else if (found.verdict === 'mixed') {
      box.className = 'pr-verdict';
      // Curved regions are only flattened where their facets fall inside the
      // tolerances, and the faces that were found already say whether they did:
      // the deviation is how far the surface would move, measured rather than
      // guessed at.
      box.textContent = 'Flat faces and curved ones together. Where facets sit closer than the ' +
        'tolerances allow they are merged into one plane — here that moves the surface by at ' +
        'most ' + found.deviation.toFixed(3) + ' mm. The rest is kept facet for facet.';
    } else if (found.deviation < 1e-6 && found.triangles <= found.faces * 2) {
      box.className = 'pr-verdict good';
      box.textContent = 'Flat to the micron, and in as few triangles as those faces can be drawn. ' +
        'This is already the solid.';
    } else {
      box.className = 'pr-verdict';
      box.textContent = 'A prismatic part: its faces meet at real edges. The facets sit up to ' +
        found.deviation.toFixed(3) + ' mm off the faces they belong to.';
    }

    // What the panel is describing is whatever is on screen, and after a
    // conversion that is no longer the mesh that was opened.
    el('facts-head').textContent = state.report ? 'The rebuilt solid' : 'The mesh';
    el('btn-convert').disabled = !found.triangles || !!state.report;
    el('btn-export').disabled = !found.triangles;
    el('views').hidden = !found.triangles;
  }

  // ---------------------------------------------------------------------------
  // Doing it
  // ---------------------------------------------------------------------------

  function convert() {
    if (!state.current || state.busy) return;
    state.busy = true;
    toast('Rebuilding the solid…', null, true);
    setTimeout(function () {
      var report;
      try {
        report = window.Prismatic.toSolid(state.source, tolerances());
      } catch (e) {
        state.busy = false;
        toast('The conversion failed: ' + (e.message || e), 'bad');
        return;
      }
      state.busy = false;
      if (!report.ok) {
        // Nothing is replaced on the screen either: what it says it did and
        // what it did have to be the same thing.
        toast('Left alone. ' + report.reason, 'bad');
        return;
      }
      state.report = report;
      state.current = report.positions;
      hideToast();
      look(function () { showReport(report); });
      toast('Rebuilt: ' + count(report.trianglesBefore) + ' triangles → ' + count(report.triangles) +
        ', across ' + count(report.faces) + ' faces.', 'good');
    }, 40);
  }

  function showReport(report) {
    var saved = report.trianglesBefore > 0
      ? Math.round((1 - report.triangles / report.trianglesBefore) * 100) : 0;
    facts(el('report'), [
      ['Triangles', count(report.trianglesBefore) + ' → ' + count(report.triangles), true],
      [' ', saved > 0 ? saved + '% fewer' : 'no fewer', saved > 0 ? 'down' : ''],
      ['Faces', count(report.faces)],
      ['Rebuilt from outlines', count(report.rebuilt) + ' of ' + count(report.faces)],
      report.keptFacets ? ['Kept their facets', count(report.keptFacets)] : null,
      ['Volume held to', (report.volumeError * 100).toFixed(3) + '%'],
      ['Furthest a vertex moved', mm(report.moved)],
      ['Watertight', report.watertight ? 'yes' : 'no']
    ]);
    el('report-block').hidden = false;
  }

  function reset() {
    if (!state.source) return;
    state.current = state.source;
    state.report = null;
    el('report-block').hidden = true;
    hideToast();
    look();
  }

  // ---------------------------------------------------------------------------
  // In and out
  // ---------------------------------------------------------------------------

  function open(positions, name) {
    if (!positions || positions.length < 9) {
      toast('There were no triangles in that file.', 'bad');
      return;
    }
    state.name = name;
    state.source = positions;
    state.current = positions;
    state.report = null;
    state.framed = false;
    el('report-block').hidden = true;
    el('empty').hidden = true;
    el('file-name').textContent = name;
    look();
  }

  function openFile(file) {
    if (!file) return;
    toast('Reading ' + file.name + '…', null, true);
    window.OrcaLoaders.loadFile(file).then(function (positions) {
      open(positions, file.name);
    }).catch(function (e) {
      toast('That file could not be read: ' + (e.message || e), 'bad');
    });
  }

  /** A binary STL of whatever is on screen. */
  function stl(positions, name) {
    var tris = (positions.length / 9) | 0;
    var buf = new ArrayBuffer(84 + tris * 50);
    var view = new DataView(buf);
    var header = 'Prismatic — ' + name;
    for (var c = 0; c < 80; c++) view.setUint8(c, c < header.length ? header.charCodeAt(c) & 0x7f : 32);
    view.setUint32(80, tris, true);
    for (var t = 0; t < tris; t++) {
      var i = t * 9, o = 84 + t * 50;
      var ux = positions[i + 3] - positions[i], uy = positions[i + 4] - positions[i + 1], uz = positions[i + 5] - positions[i + 2];
      var wx = positions[i + 6] - positions[i], wy = positions[i + 7] - positions[i + 1], wz = positions[i + 8] - positions[i + 2];
      var nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      var len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      view.setFloat32(o, nx / len, true);
      view.setFloat32(o + 4, ny / len, true);
      view.setFloat32(o + 8, nz / len, true);
      for (var k = 0; k < 9; k++) view.setFloat32(o + 12 + k * 4, positions[i + k], true);
      view.setUint16(o + 48, 0, true);
    }
    return new Blob([buf], { type: 'model/stl' });
  }

  function save() {
    if (!state.current) return;
    var base = (state.name || 'mesh').replace(/\.(stl|obj|3mf)$/i, '');
    var name = base + (state.report ? '-solid' : '') + '.stl';
    var url = URL.createObjectURL(stl(state.current, name));
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    toast('Saved ' + name + '.', 'good');
  }

  // ---------------------------------------------------------------------------
  // A part to try it on
  // ---------------------------------------------------------------------------

  /**
   * An L-bracket with a bore through the base, extruded from its profile and
   * then cut into sixteen times as many facets as it needs — which is what an
   * STL of it would look like coming out of anywhere.
   */
  function sample() {
    var LENGTH = 40;
    var outer = [[0, 0], [30, 0], [30, 24], [24, 24], [24, 6], [0, 6]];
    var hole = [];
    for (var i = 0; i < 28; i++) {
      var a = -2 * Math.PI * i / 28;
      hole.push([12 + 2.6 * Math.cos(a), 3 + 2.6 * Math.sin(a)]);
    }

    var flat = [];
    outer.concat(hole).forEach(function (p) { flat.push(p[0], p[1]); });
    var index = earcut(flat, [outer.length], 2);

    var out = [];
    function push(p) { out.push(p[0], p[1], p[2]); }

    // The profile lies in Y/Z and is extruded along X. A cap triangle wound
    // anticlockwise in that plane faces +X, so the far cap takes them as they
    // come and the near cap takes them the other way round — whichever way
    // earcut happened to hand them back.
    for (var k = 0; k < index.length; k += 3) {
      var t = [index[k] * 2, index[k + 1] * 2, index[k + 2] * 2];
      var twice = (flat[t[1]] - flat[t[0]]) * (flat[t[2] + 1] - flat[t[0] + 1]) -
                  (flat[t[1] + 1] - flat[t[0] + 1]) * (flat[t[2]] - flat[t[0]]);
      if (twice < 0) { var swap = t[1]; t[1] = t[2]; t[2] = swap; }
      push([LENGTH, flat[t[0]], flat[t[0] + 1]]);
      push([LENGTH, flat[t[1]], flat[t[1] + 1]]);
      push([LENGTH, flat[t[2]], flat[t[2] + 1]]);
      push([0, flat[t[0]], flat[t[0] + 1]]);
      push([0, flat[t[2]], flat[t[2] + 1]]);
      push([0, flat[t[1]], flat[t[1] + 1]]);
    }

    // The outline runs anticlockwise and the bore clockwise, so the same walls
    // face out of the part in one case and into the bore in the other.
    function wall(p0, p1) {
      push([0, p0[0], p0[1]]); push([LENGTH, p1[0], p1[1]]); push([LENGTH, p0[0], p0[1]]);
      push([0, p0[0], p0[1]]); push([0, p1[0], p1[1]]); push([LENGTH, p1[0], p1[1]]);
    }
    for (var j = 0; j < outer.length; j++) wall(outer[j], outer[(j + 1) % outer.length]);
    for (var h = 0; h < hole.length; h++) wall(hole[h], hole[(h + 1) % hole.length]);

    var mesh = new Float32Array(out);
    return subdivide(subdivide(mesh));
  }

  /** Every triangle into four: the same shape, in four times the facets. */
  function subdivide(positions) {
    var out = new Float32Array(positions.length * 4);
    var at = 0;
    for (var i = 0; i < positions.length; i += 9) {
      var a = [positions[i], positions[i + 1], positions[i + 2]];
      var b = [positions[i + 3], positions[i + 4], positions[i + 5]];
      var c = [positions[i + 6], positions[i + 7], positions[i + 8]];
      var ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      [[a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]].forEach(function (t) {
        for (var k = 0; k < 3; k++) { out[at++] = t[k][0]; out[at++] = t[k][1]; out[at++] = t[k][2]; }
      });
    }
    return out;
  }
  function mid(a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]; }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  function boot() {
    state.viewer = new window.PrismaticViewer(el('view'));

    el('btn-open').onclick = function () { el('file-input').click(); };
    el('btn-open-2').onclick = function () { el('file-input').click(); };
    el('file-input').onchange = function (ev) {
      openFile(ev.target.files && ev.target.files[0]);
      ev.target.value = '';
    };
    document.querySelector('[data-demo]').onclick = function () {
      open(sample(), 'bracket.stl');
    };
    el('btn-convert').onclick = convert;
    el('btn-reset').onclick = reset;
    el('btn-export').onclick = save;

    var settle = null;
    ['opt-angle', 'opt-deviation', 'opt-square'].forEach(function (id) {
      el(id).addEventListener('change', function () {
        // A tolerance that changes is a different answer, so the rebuild that
        // came out of the old one is no longer what is being described.
        if (state.report) reset();
        clearTimeout(settle);
        settle = setTimeout(function () { look(); }, 120);
      });
    });

    el('opt-shade').onchange = function () { state.viewer.setShadeByFace(el('opt-shade').checked); };
    el('opt-edges').onchange = function () { state.viewer.setEdgesVisible(el('opt-edges').checked); };

    var views = el('views');
    views.querySelectorAll('[data-view]').forEach(function (btn) {
      btn.onclick = function () {
        views.querySelectorAll('[data-view]').forEach(function (b) { b.classList.remove('on'); });
        btn.classList.add('on');
        state.viewer.setView(btn.dataset.view);
      };
    });
    views.querySelector('[data-view="iso"]').classList.add('on');

    var stage = document.querySelector('.pr-stage');
    ['dragenter', 'dragover'].forEach(function (kind) {
      stage.addEventListener(kind, function (ev) { ev.preventDefault(); stage.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (kind) {
      stage.addEventListener(kind, function (ev) { ev.preventDefault(); stage.classList.remove('over'); });
    });
    stage.addEventListener('drop', function (ev) {
      openFile(ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0]);
    });

    window.addEventListener('keydown', function (ev) {
      if (ev.target && /input|textarea/i.test(ev.target.tagName)) return;
      if (ev.key === 'o') el('file-input').click();
      else if (ev.key === 'Enter' && !el('btn-convert').disabled) convert();
      else if (ev.key === 'f') state.viewer.frame();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
