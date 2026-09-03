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
    body: null,
    saved: null,
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
      snapAxes: el('opt-square').checked,
      recognise: el('opt-recognise').checked
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
    el('btn-step').disabled = !found.triangles;
    el('btn-stl').disabled = !found.triangles;
    el('views').hidden = !found.triangles;
  }

  // ---------------------------------------------------------------------------
  // Doing it
  // ---------------------------------------------------------------------------

  function convert(then) {
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
        // what it did have to be the same thing. And nothing is saved, since
        // there is no solid to save.
        toast('Left alone. ' + report.reason, 'bad');
        return;
      }
      var settings = tolerances();
      try {
        state.body = window.PrismaticSolid.build(report.brep, {
          tolerance: settings.deviation,
          recognise: settings.recognise
        });
      } catch (e) {
        state.body = null;
      }
      state.report = report;
      state.current = report.positions;
      hideToast();
      look(function (found) {
        showReport(report);
        // What is drawn now is the solid rather than the mesh: its own edges,
        // so a recognised bore is two circles and nothing in between, and its
        // own faces, so the bore is one colour. Which is the whole of what was
        // gained, seen rather than counted.
        if (state.body) {
          var features = featuresOf(state.body, found.positions, settings.deviation);
          if (features) state.viewer.setMesh(found.positions, features);
          state.viewer.setEdges(solidEdges(state.body));
        }
        if (typeof then === 'function') then();
      });
      toast('Rebuilt: ' + count(report.trianglesBefore) + ' triangles → ' + count(report.triangles) +
        ', across ' + count(report.faces) + ' faces.', 'good');
    }, 40);
  }

  /**
   * Which face of the finished solid each triangle of the mesh belongs to, so
   * that the picture says the same thing the panel does: a bore that was
   * recognised as one cylinder is drawn as one colour rather than as the
   * twenty-eight little planes it is still made of.
   *
   * Worked out from the geometry rather than carried along from the rebuild:
   * a triangle belongs to the face whose surface it sits on and whose way of
   * facing it agrees with. The converted mesh is small — that being the point
   * of it — so asking every triangle about every face is nothing.
   */
  function featuresOf(body, positions, tolerance) {
    if (!body || !body.faces.length || body.faces.length > 400) return null;
    var P = window.PrismaticPrimitives;
    var count = (positions.length / 9) | 0;
    var out = new Int32Array(count);
    var slack = Math.max(tolerance, 1e-6) * 2;
    for (var t = 0; t < count; t++) {
      var o = t * 9;
      var mid = [
        (positions[o] + positions[o + 3] + positions[o + 6]) / 3,
        (positions[o + 1] + positions[o + 4] + positions[o + 7]) / 3,
        (positions[o + 2] + positions[o + 5] + positions[o + 8]) / 3
      ];
      var ux = positions[o + 3] - positions[o], uy = positions[o + 4] - positions[o + 1], uz = positions[o + 5] - positions[o + 2];
      var wx = positions[o + 6] - positions[o], wy = positions[o + 7] - positions[o + 1], wz = positions[o + 8] - positions[o + 2];
      var nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      var len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      var normal = [nx / len, ny / len, nz / len];

      var best = -1, bestGap = Infinity;
      for (var f = 0; f < body.faces.length; f++) {
        var surface = body.faces[f].surface;
        var gap = P.distance(surface, mid);
        if (!(gap <= slack) || gap >= bestGap) continue;
        var facing = P.normalAt(surface, mid);
        if (!facing) continue;
        if (normal[0] * facing[0] + normal[1] * facing[1] + normal[2] * facing[2] < 0.7) continue;
        best = f; bestGap = gap;
      }
      out[t] = best >= 0 ? best : body.faces.length;
    }
    return out;
  }

  /** The body's edges as line segments, circles walked round. */
  function solidEdges(body) {
    var out = [];
    var at = function (id) {
      return [body.vertices[id * 3], body.vertices[id * 3 + 1], body.vertices[id * 3 + 2]];
    };
    body.edges.forEach(function (edge) {
      if (edge.curve.type !== 'circle') {
        var a = at(edge.a), b = at(edge.b);
        out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
        return;
      }
      var c = edge.curve;
      var axis = c.axis;
      var pick = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      var u = normalise([axis[1] * pick[2] - axis[2] * pick[1],
                         axis[2] * pick[0] - axis[0] * pick[2],
                         axis[0] * pick[1] - axis[1] * pick[0]]);
      var v = [axis[1] * u[2] - axis[2] * u[1], axis[2] * u[0] - axis[0] * u[2], axis[0] * u[1] - axis[1] * u[0]];
      var start = at(edge.a), end = at(edge.b);
      var from = angleOf(start, c, u, v);
      var span = edge.closed ? 2 * Math.PI : sweep(from, angleOf(end, c, u, v));
      var steps = Math.max(6, Math.ceil(72 * Math.abs(span) / (2 * Math.PI)));
      var previous = null;
      for (var i = 0; i <= steps; i++) {
        var t = from + span * i / steps;
        var p = [
          c.centre[0] + c.radius * (u[0] * Math.cos(t) + v[0] * Math.sin(t)),
          c.centre[1] + c.radius * (u[1] * Math.cos(t) + v[1] * Math.sin(t)),
          c.centre[2] + c.radius * (u[2] * Math.cos(t) + v[2] * Math.sin(t))
        ];
        if (previous) out.push(previous[0], previous[1], previous[2], p[0], p[1], p[2]);
        previous = p;
      }
    });
    return new Float32Array(out);
  }
  function normalise(v) {
    var len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) || 1;
    return [v[0] / len, v[1] / len, v[2] / len];
  }
  function angleOf(p, c, u, v) {
    var w = [p[0] - c.centre[0], p[1] - c.centre[1], p[2] - c.centre[2]];
    return Math.atan2(w[0] * v[0] + w[1] * v[1] + w[2] * v[2],
                      w[0] * u[0] + w[1] * u[1] + w[2] * u[2]);
  }
  function sweep(from, to) {
    var span = to - from;
    while (span <= 1e-9) span += 2 * Math.PI;
    return span;
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
      ['Corners off their planes', report.flatness < 1e-9 ? 'none' : mm(report.flatness)],
      ['Watertight', report.watertight ? 'yes' : 'no'],
      state.body ? ['Solid faces', shapes(state.body.counts), true] : null,
      state.body ? ['Solid edges', count(state.body.edges.length) + curves(state.body)] : null
    ]);
    el('report-block').hidden = false;
  }

  /** "6 planes and a cylinder", said the way a person would. */
  function shapes(counts) {
    var said = [];
    [['plane', 'plane', 'planes'], ['cylinder', 'cylinder', 'cylinders'],
     ['cone', 'cone', 'cones'], ['sphere', 'sphere', 'spheres']].forEach(function (kind) {
      var n = counts[kind[0]];
      if (n) said.push(count(n) + ' ' + (n === 1 ? kind[1] : kind[2]));
    });
    return said.length ? said.join(', ') : 'none';
  }
  function curves(body) {
    var circles = body.edges.filter(function (e) { return e.curve.type === 'circle'; }).length;
    return circles ? ', ' + count(circles) + ' of them circles' : '';
  }

  function reset() {
    if (!state.source) return;
    state.current = state.source;
    state.report = null;
    state.body = null;
    state.saved = null;
    el('report-block').hidden = true;
    el('saved').innerHTML = '';
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
    state.body = null;
    state.framed = false;
    el('report-block').hidden = true;
    el('saved').innerHTML = '';
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

  function baseName() {
    return (state.name || 'mesh').replace(/\.(stl|obj|3mf|step|stp)$/i, '');
  }

  /**
   * Hand a file to whatever is holding the page. Returns where it went, because
   * the two ends of that differ: a browser has the file the moment the link is
   * clicked, while Android has it once the storage picker has been answered,
   * and telling somebody a file is saved before they have said where is a small
   * lie that costs them the file.
   */
  function download(blob, name, mime) {
    if (window.PrismaticNative) {
      window.PrismaticNative.save(blob, name, mime, function (err) {
        if (err) toast('That file did not reach Android: ' + (err.message || err), 'bad');
      });
      return 'android';
    }
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    return 'browser';
  }

  /** "Saved x." in a browser; "here it is, say where it goes" on a phone. */
  function saidWhere(where, name, rest) {
    if (where === 'android') return name + ' is ready — choose where it goes. ' + rest;
    return 'Saved ' + name + ' — ' + rest;
  }

  function saveSTL() {
    if (!state.current) return;
    var name = baseName() + (state.report ? '-solid' : '') + '.stl';
    var where = download(stl(state.current, name), name, 'model/stl');
    toast(saidWhere(where, name, 'The mesh, for printing.'), 'good');
  }

  /**
   * The one that was the point of all this. A mesh has to be converted before
   * there is a solid to write, so pressing Save STEP on a mesh that has not
   * been converted converts it first and shows what that did, rather than
   * refusing or — worse — quietly writing the triangles out as faces.
   */
  function saveSTEP() {
    if (!state.current || state.busy) return;
    if (!state.report || !state.body) { convert(saveSTEP); return; }
    var name = baseName() + '.step';
    var file;
    try {
      file = window.PrismaticStep.write(state.body, { name: baseName() });
    } catch (e) {
      toast('The STEP file could not be written: ' + (e.message || e), 'bad');
      return;
    }
    state.saved = file;
    var where = download(new Blob([file.text], { type: 'model/step' }), name, 'model/step');
    showSaved(file, name);

    if (!file.solid) {
      toast(saidWhere(where, name, 'It is surfaces rather than a solid: the mesh has ' +
        file.looseEdges + ' open edge' + (file.looseEdges === 1 ? '' : 's') +
        ', so there is no inside to it. Fusion will offer to stitch them.'), 'bad');
    } else {
      toast(saidWhere(where, name, shapes(file.surfaces) + ' over ' + count(file.edges) +
        ' edges, as ' + (file.bodies === 1 ? 'one solid body' : count(file.bodies) + ' solid bodies') +
        '. Fusion opens it as a body you can edit.'), 'good');
    }
  }

  function showSaved(file, name) {
    facts(el('saved'), [
      ['Written', name, true],
      ['Made of', shapes(file.surfaces)],
      ['As', file.solid
        ? (file.bodies === 1 ? 'a solid body' : count(file.bodies) + ' solid bodies')
        : 'surfaces — the mesh is open'],
      ['Faces', count(file.faces)],
      ['Edges', count(file.edges)],
      ['Corners', count(file.vertices)],
      file.cavities ? ['Enclosed cavities', count(file.cavities)] : null
    ]);
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
    el('btn-convert').onclick = function () { convert(); };
    el('btn-reset').onclick = reset;
    el('btn-step').onclick = saveSTEP;
    el('btn-stl').onclick = saveSTL;

    var settle = null;
    ['opt-angle', 'opt-deviation', 'opt-square', 'opt-recognise'].forEach(function (id) {
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

    // A mesh opened with the app from somewhere else: at startup, and again
    // whenever Android says another one has arrived.
    if (window.PrismaticNative) {
      window.PrismaticAndroidOpen = function () { window.PrismaticNative.incoming(openFile); };
      window.PrismaticAndroidOpen();
    }

    window.addEventListener('keydown', function (ev) {
      if (ev.target && /input|textarea/i.test(ev.target.tagName)) return;
      if (ev.key === 'o') el('file-input').click();
      else if (ev.key === 'Enter' && !el('btn-convert').disabled) convert();
      else if (ev.key === 's' && !el('btn-step').disabled) saveSTEP();
      else if (ev.key === 'f') state.viewer.frame();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
