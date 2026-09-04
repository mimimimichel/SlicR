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

  // ---------------------------------------------------------------------------
  // The gauge
  // ---------------------------------------------------------------------------

  /**
   * One control for three tolerances, because three numbers in millimetres and
   * degrees are not what somebody wants to think about. Pushed up, more of the
   * mesh collapses into fewer faces and the surface is allowed to move further
   * to do it.
   *
   * What it means is relative to the part: a twentieth of a millimetre is a lot
   * on a five millimetre bead and nothing on a three hundred millimetre bracket,
   * so the gauge is a proportion of the part's own size, along a scale where
   * every step is the same proportional step rather than the same number of
   * millimetres.
   *
   * The two tolerances are not the same tolerance, and pinning them together
   * was the single worst thing in here.
   *
   * The deviation is how far the *rebuild* may move the mesh — a rewrite of the
   * triangles themselves. Open that up and faces reach across features, corners
   * are flung onto crossings that are nowhere near where they were, the volume
   * runs away from the original and the conversion refuses. It has to stay
   * modest, and past about a thousandth of the part it stops paying.
   *
   * The shape tolerance is how far a *recognised* surface may sit off the
   * facets it replaces, and that is a different question with a different
   * answer. A cylinder put back where a hundred little planes were is not a
   * rewrite of the mesh, it is the mesh's own surface named — and naming it
   * generously is exactly what somebody pushing a slider marked "simple" is
   * asking for. It can safely run out to a percent of the part, and on a
   * modelled-by-hand part that is the difference between a thousand faces and
   * fifty.
   */
  var TIGHTEST = -3.9;      // log10 of the shape tolerance, as a fraction of the part, at rest
  var RESHAPE = -2.0;       // and how far it may go, pushed all the way

  // The rebuild does not move with the gauge, and it took a while to see that
  // it should not. Two levers on one slider means every notch changes the mesh
  // the recognition is then run on, and the answer jumps about for reasons that
  // have nothing to do with what was asked: on a rosary the count went 583, then
  // 1030, then 60. Held still, every part tried comes back monotone — more
  // simplification, fewer faces, every time. And it costs nothing, because
  // recognising a plane is what simplifies flat faces now, not the rebuild.
  var REWRITE = -3.75;      // how far the rebuild may move the mesh, always
  var FACET = 0.7;          // deg — and how far a facet may lean from its face

  // And how far the shape tolerance has to be able to reach.
  //
  // A proportion of the part is the wrong yardstick on its own, and the way it
  // is wrong is the whole of this. What a recognised surface costs is set by
  // how coarse the *mesh* is, not by how big the part is: calling a polygon a
  // cylinder moves the surface out to where the arc is, and a shape a modeller
  // left in twenty-four sides asks a quarter of a millimetre for that where the
  // same shape in twenty thousand triangles asks seven thousandths. Thirty
  // times as much, on a part three times the size. Below that price nothing can
  // be recognised however hard the gauge is pushed, and the gauge said nothing
  // about it.
  //
  // So the top of its travel is whichever is further: a percent of the part, or
  // four times what this mesh's own faceting costs. It only ever adds reach —
  // on a finely tessellated part the first is bigger and nothing changes.
  var COARSE = 4;

  // And a ceiling, from the size of the *features* rather than the size of the
  // part, because those are not the same thing. A rosary is sixty-four
  // millimetres across and made of beads four millimetres round; a percent of
  // the part is a sixth of a bead, and at that tolerance a bead is within reach
  // of being called a cylinder — which is what came back, ten beads turned into
  // ten little drums. An eighth of the smallest feature's radius is as far as
  // the gauge may go, and never less than what this mesh's own faceting costs,
  // or a coarse mesh could not be recognised at all.
  var FEATURE = 0.12;

  function topShape(size, mesh) {
    var scale = size > 0 ? size : 100;
    var part = scale * Math.pow(10, RESHAPE);
    var feature = mesh && mesh.radius > 0 ? mesh.radius * FEATURE : Infinity;
    return Math.max((mesh && mesh.faceting || 0) * COARSE, Math.min(part, feature));
  }

  function gaugeToTolerances(gauge, size, mesh) {
    var t = Math.max(0, Math.min(1, gauge / 100));
    var scale = size > 0 ? size : 100;
    var floor = scale * Math.pow(10, TIGHTEST);
    var reach = Math.log(topShape(size, mesh) / floor) / Math.LN10;
    return {
      deviation: scale * Math.pow(10, REWRITE),
      tolerance: floor * Math.pow(10, reach * t),
      angle: FACET
    };
  }

  /** And back again, so a hand-typed tolerance moves the gauge to match. */
  function tolerancesToGauge(tolerance, size, mesh) {
    var scale = size > 0 ? size : 100;
    var floor = scale * Math.pow(10, TIGHTEST);
    var reach = Math.log(topShape(size, mesh) / floor) / Math.LN10;
    if (!(reach > 0)) return 0;
    var t = Math.log(tolerance / floor) / Math.LN10 / reach;
    return Math.max(0, Math.min(100, Math.round(t * 100)));
  }

  /** What the mesh on screen is like, once it has been looked at. */
  function meshFaceting() {
    return state.look ? { faceting: state.look.faceting || 0, radius: state.look.radius || 0 } : null;
  }

  /** How big the part is, corner to corner. Measured, not asked of the viewer. */
  function modelSize() {
    var p = state.source;
    if (!p || !p.length) return 100;
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < p.length; i += 3) {
      for (var k = 0; k < 3; k++) {
        if (p[i + k] < lo[k]) lo[k] = p[i + k];
        if (p[i + k] > hi[k]) hi[k] = p[i + k];
      }
    }
    var x = hi[0] - lo[0], y = hi[1] - lo[1], z = hi[2] - lo[2];
    var span = Math.sqrt(x * x + y * y + z * z);
    return span > 0 ? span : 100;
  }

  function roundish(mm) {
    if (mm >= 1) return mm.toFixed(2);
    if (mm >= 0.1) return mm.toFixed(3);
    return mm.toFixed(4);
  }

  /** Move the two fields to wherever the gauge is, and say what that means. */
  function applyGauge(rerun) {
    var found = gaugeToTolerances(parseFloat(el('opt-simplify').value), modelSize(), meshFaceting());
    el('opt-deviation').value = roundish(found.deviation);
    el('opt-tolerance').value = roundish(found.tolerance);
    el('opt-angle').value = found.angle.toFixed(found.angle < 1 ? 2 : 1);
    showReading();
    if (rerun) { state.done = null; look(); }
  }

  /**
   * What the gauge is set to, and — when there is one that matches it — what
   * came of it. Mid-drag there is only the setting: the count beside it would
   * be the last answer sitting next to the new question, which reads as though
   * nothing changed.
   */
  function showReading(tail) {
    var t = tolerances();
    // The shape tolerance leads, because it is the one the gauge moves and the
    // one that decides what comes back. What the rebuild is held to is said
    // after it, small, because it no longer changes.
    el('simplify-reading').innerHTML = 'shapes to <b>' + roundish(t.tolerance) + ' mm</b>' +
      ' · mesh held to ' + roundish(t.deviation) + ' mm' + (tail ? ' · ' + tail : '');
  }

  function tolerances() {
    var deviation = parseFloat(el('opt-deviation').value) || 0.05;
    return {
      angle: parseFloat(el('opt-angle').value) || 1.5,
      deviation: deviation,
      // Never tighter than the rebuild's own: a surface is being asked to stand
      // in for facets that are already allowed to be that far off.
      tolerance: Math.max(deviation, parseFloat(el('opt-tolerance').value) || deviation),
      snapAxes: el('opt-square').checked,
      recognise: el('opt-recognise').checked
    };
  }

  /**
   * The setting to use, found by trying them rather than by guessing.
   *
   * The gauge is a proportion of the part and of its features, which is the
   * right shape for a guess and is still a guess: how far a particular mesh can
   * be pushed before it stops being the part depends on what is on it. A ring
   * with lettering round the inside gives up its lettering somewhere the maths
   * cannot know in advance.
   *
   * So it is measured. The rebuild is done once — it no longer moves with the
   * gauge, which is what makes this cheap — and the recognition is run at a
   * handful of settings. Three to start with, then wherever the answer is
   * still moving.
   *
   * What is compared is not the count alone. Each setting comes back with
   * three numbers: how many faces, how many of them are named shapes rather
   * than flats, and how far the surfaces actually sit off the mesh — which is
   * a fraction of what the setting allowed, and is the only honest price.
   *
   * Then the settings are walked from the faithful end, and a looser one is
   * taken over the one in hand when either
   *
   *   it removes a seventh of the faces that are left, or
   *   it finds a shape — a cylinder, a ball — without adding faces.
   *
   * That second line is the one that matters to somebody who has to edit the
   * result. Twenty faces that include four cylinders is a part; twenty flats
   * in the same places is a picture of one. A step that trades flats for a
   * cylinder barely moves the count and is worth taking every time.
   *
   * Whatever is chosen, the search then walks it back: it halves the distance
   * to the setting below and keeps going while the answer holds. The gauge
   * ends up on the *tightest* setting that gives what was chosen — 58 rather
   * than 67 — which is accuracy that costs nothing.
   */
  var SEARCH = {
    budget: 6,      // builds — three to survey, the rest to sharpen
    keep: 0.85,     // a looser setting must cut this share of the faces
    close: 7        // gauge points: stop halving once this near
  };

  function findBest() {
    if (!state.source || state.busy) return;
    if (state.report) reset();
    state.busy = true;
    var settings = tolerances();

    toast('Trying a few settings…', null, true);
    setTimeout(function () {
      var report;
      try {
        report = window.Prismatic.toSolid(state.source, settings);
      } catch (e) {
        state.busy = false;
        toast('The conversion failed: ' + (e.message || e), 'bad');
        return;
      }
      if (!report.ok) {
        state.busy = false;
        toast('Left alone. ' + report.reason, 'bad');
        return;
      }
      var size = modelSize(), mesh = meshFaceting();
      var probes = [], tried = 0;

      /**
       * One setting, built and measured — unless it has been built already, or
       * unless it asks for a tolerance another setting has already been given.
       * Near the ends the gauge is clamped by the mesh's own coarseness, so
       * two settings can be the same question; asking it twice is a build
       * spent on an answer already in hand.
       */
      function probe(gauge, then) {
        gauge = Math.max(0, Math.min(100, Math.round(gauge)));
        var known = at(gauge);
        if (known) { then(known); return; }
        var tol = gaugeToTolerances(gauge, size, mesh).tolerance;
        var same = null;
        probes.forEach(function (p) {
          if (Math.abs(Math.log(p.tolerance / tol)) < 0.01) same = p;
        });
        if (same) {
          var copy = { gauge: gauge, tolerance: tol, faces: same.faces, named: same.named,
                       strain: same.strain, body: same.body };
          insert(copy);
          then(copy);
          return;
        }
        toast('Trying the settings… ' + (tried + 1), null, true);
        setTimeout(function () {
          var body = null;
          try {
            body = window.PrismaticSolid.build(report.brep, {
              tolerance: tol, recognise: settings.recognise
            });
          } catch (e) { body = null; }
          tried++;
          var c = body && body.counts;
          var made = {
            gauge: gauge, tolerance: tol, body: body,
            faces: body ? body.faces.length : Infinity,
            named: c ? c.cylinder + c.cone + c.sphere + c.torus : 0,
            strain: body ? (body.strain || 0) : Infinity
          };
          insert(made);
          then(made);
        }, 0);
      }

      function at(gauge) {
        for (var i = 0; i < probes.length; i++) if (probes[i].gauge === gauge) return probes[i];
        return null;
      }
      function insert(p) {
        var i = 0;
        while (i < probes.length && probes[i].gauge < p.gauge) i++;
        probes.splice(i, 0, p);
      }

      /** Is b worth having instead of a? */
      function better(b, a) {
        if (!isFinite(b.faces)) return false;
        if (b.faces <= a.faces * SEARCH.keep) return true;
        return b.faces <= a.faces && b.named > a.named;
      }

      /** The best of what has been tried, walked from the faithful end. */
      function choose() {
        var pick = probes[0];
        for (var i = 1; i < probes.length; i++) if (better(probes[i], pick)) pick = probes[i];
        return pick;
      }

      probe(0, function () {
        probe(50, function () {
          probe(100, function () { sharpen(); });
        });
      });

      // Walk the winner back: the answer is somewhere between the setting
      // below it — known to be worth pushing past — and the winner itself.
      // Halve that gap, and move the near end whenever the middle turns out to
      // be answer enough. What "answer enough" means is the same test read the
      // other way: the middle stands if the winner is not worth having over it.
      function sharpen() {
        var pick = choose(), lo = null;
        for (var i = 0; i < probes.length; i++) {
          if (probes[i].gauge < pick.gauge) lo = probes[i];
        }
        (function narrow() {
          if (!lo || tried >= SEARCH.budget || pick.gauge - lo.gauge <= SEARCH.close) {
            chosen(pick);
            return;
          }
          probe((pick.gauge + lo.gauge) / 2, function (mid) {
            if (better(pick, mid)) lo = mid; else pick = mid;
            narrow();
          });
        })();
      }

      function chosen(pick) {
        state.busy = false;
        state.byGauge = true;
        el('opt-simplify').value = pick.gauge;
        applyGauge(false);
        el('simplify-advice').innerHTML = advice(pick, probes, tried);
        el('simplify-advice').hidden = false;
        convert(null, { report: report, body: pick.body });
      }
    }, 40);
  }

  /**
   * What was chosen and what it cost, in the terms the choice was made in.
   * Somebody who disagrees with the answer can only move the gauge sensibly if
   * they are told what the settings either side of it do.
   */
  function advice(pick, probes, tried) {
    var loosest = probes[probes.length - 1];
    var tightest = probes[0];
    var said = 'Tried ' + tried + ' setting' + (tried === 1 ? '' : 's') +
      '. <b>' + count(pick.faces) + ' face' + (pick.faces === 1 ? '' : 's') + '</b> here';
    if (pick.named) {
      said += ', ' + count(pick.named) + ' of them ' +
        (pick.named === 1 ? 'a named shape' : 'named shapes') + ' rather than flats';
    }
    said += pick.strain > 1e-6
      ? ', with the surfaces sitting ' + mm(pick.strain) + ' off the mesh.'
      : ', sitting exactly on the mesh.';

    if (pick === tightest) {
      said += ' Pushing further ' + (loosest.faces >= tightest.faces
        ? 'gained nothing — this part needs no simplifying.'
        : 'reaches ' + count(loosest.faces) + ' faces, which is not worth what it costs.');
    } else if (pick !== loosest && loosest.faces < pick.faces) {
      said += ' The loosest setting reaches ' + count(loosest.faces) +
        ', for ' + mm(loosest.strain) + ' — not worth it.';
    }
    return said;
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
      // How far the gauge can reach depends on how coarse this mesh is, and
      // that is only known now that it has been looked at. So the gauge is put
      // back where it says it is — unless somebody has typed a tolerance by
      // hand, in which case theirs stands.
      if (state.byGauge !== false) applyGauge(false);
      showReading(state.body ? null : '<b>' + count(found.faces) + '</b> flat face' +
        (found.faces === 1 ? '' : 's'));
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

  /**
   * The sentence that was missing, and that this whole page needed.
   *
   * Somebody looking at a coarse mesh pushes the gauge to the end, nothing is
   * recognised, and there is nothing on the screen to say why. Why is that the
   * mesh's own faceting: calling a twenty-four sided polygon a cylinder puts
   * the surface out where the arc is, a quarter of a millimetre away, and no
   * shape tolerance below that can call it anything. Said out loud it stops
   * being a mystery and becomes a number to aim at.
   */
  function priceOf(found) {
    if (!(found.faceting > 1e-6)) return '';
    return ' Its curves are drawn coarsely enough that naming one — a cylinder, a ball — ' +
      'moves the surface by at least ' + mm(found.faceting) + ', so the shape tolerance has ' +
      'to reach that before anything is found.';
  }

  function showMesh(found) {
    facts(el('facts'), [
      ['Triangles', count(found.triangles)],
      ['Flat faces', count(found.faces)],
      ['Off flat', mm(found.deviation)],
      // The number that says what recognising this mesh's curves will cost, and
      // therefore how far the gauge has to go before anything happens at all.
      // A part with no curves in it has nothing to pay and the row is left out.
      found.faceting > 1e-6 ? ['Curves cost at least', mm(found.faceting)] : null,
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
        'Tighten the deviation, or leave it be.' + priceOf(found);
    } else if (found.verdict === 'mixed') {
      box.className = 'pr-verdict';
      // Curved regions are only flattened where their facets fall inside the
      // tolerances, and the faces that were found already say whether they did:
      // the deviation is how far the surface would move, measured rather than
      // guessed at.
      box.textContent = 'Flat faces and curved ones together. Where facets sit closer than the ' +
        'tolerances allow they are merged into one plane — here that moves the surface by at ' +
        'most ' + found.deviation.toFixed(3) + ' mm. The rest is kept facet for facet.' +
        priceOf(found);
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
    // Searching stays offered after a conversion: it puts the mesh back itself.
    el('btn-best').disabled = !found.triangles;
    el('btn-step').disabled = !found.triangles;
    el('btn-stl').disabled = !found.triangles;
    el('views').hidden = !found.triangles;
  }

  // ---------------------------------------------------------------------------
  // Doing it
  // ---------------------------------------------------------------------------

  function convert(then, ready) {
    if (!state.current || state.busy) return;
    state.busy = true;
    toast('Rebuilding the solid…', null, true);
    setTimeout(function () {
      var report;
      try {
        // The search has already done this at the setting it chose, and the
        // rebuild no longer moves with the gauge, so there is nothing to redo.
        report = ready ? ready.report : window.Prismatic.toSolid(state.source, tolerances());
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
        state.body = ready && ready.body ? ready.body : window.PrismaticSolid.build(report.brep, {
          tolerance: settings.tolerance,
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
          showSolidReading();
          var Solid = window.PrismaticSolid;
          var features = Solid.featuresOf(state.body, found.positions, settings.tolerance);
          // Both or neither. Drawing the solid's edges over the mesh's own
          // colours puts one thing's boundaries on another thing's faces, and
          // what that looks like is patches of different colour with no edge
          // between them.
          if (features) {
            var drawn = Solid.smoothed(state.body, found.positions, features, settings.tolerance);
            state.viewer.setMesh(drawn, features, Solid.normalsOf(state.body, drawn, features));
            state.viewer.setEdges(solidEdges(state.body));
          }
        }
        if (typeof then === 'function') then();
      });
      toast('Rebuilt: ' + count(report.trianglesBefore) + ' triangles → ' + count(report.triangles) +
        ', across ' + count(report.faces) + ' faces.', 'good');
    }, 40);
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
      state.body ? ['Solid edges', count(state.body.edges.length) + curves(state.body)] : null,
      // What the recognised surfaces cost. A corner belongs to every face that
      // meets there and is put back where they cross, but two faces meeting at
      // a shallow angle barely pin a corner down at all, and at the loose end
      // of the gauge a few of them stay off. Saying so is better than the file
      // saying it for us in somebody else's modeller.
      state.body ? ['Corners off their faces',
        state.body.slack < 1e-9 ? 'none' : mm(state.body.slack)] : null,
      // What the constraint pass was able to say. Not decoration: it is the
      // difference between faces a modeller can grab hold of — parallel ones
      // that stay parallel, holes that are one diameter — and a very tidy
      // measurement of a mesh, which is what every one of these was before.
      state.body && agreed(state.body.aligned) ?
        ['Surfaces made to agree', agreed(state.body.aligned)] : null,
      // And what the setting was actually spent on, which is not the setting.
      // A shape tolerance is a permission; this is the bill. On a part that
      // fits well it is a fraction of what was allowed, and knowing that is
      // what tells somebody the gauge has room left in it.
      state.body ? ['Surfaces off the mesh',
        state.body.strain < 1e-9 ? 'none' : mm(state.body.strain)] : null
    ]);
    el('report-block').hidden = false;
  }

  /** What was constrained to what, in the order it was decided. */
  function agreed(made) {
    if (!made) return '';
    var said = [];
    if (made.squared) said.push(count(made.squared) + ' squared');
    if (made.concentric) said.push(count(made.concentric) + ' concentric');
    if (made.sized) said.push(count(made.sized) + ' to one size');
    return said.join(' · ');
  }

  /** Once there is a solid, the gauge says what it actually came to. */
  function showSolidReading() {
    if (!state.body) return;
    showReading('<b>' + shapes(state.body.counts) + '</b>');
  }

  /** "6 planes and a cylinder", said the way a person would. */
  function shapes(counts) {
    var said = [];
    [['plane', 'plane', 'planes'], ['cylinder', 'cylinder', 'cylinders'],
     ['cone', 'cone', 'cones'], ['sphere', 'sphere', 'spheres'],
     ['torus', 'torus', 'tori']].forEach(function (kind) {
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
    el('simplify-advice').hidden = true;
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
    el('simplify-advice').hidden = true;
    el('saved').innerHTML = '';
    el('empty').hidden = true;
    el('file-name').textContent = name;
    // The gauge is a proportion of the part, so what it means moves with the
    // part. Settled before looking, not after, or the first answer is the one
    // the last part's tolerances gave.
    applyGauge(false);
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
    function changed() {
      // A tolerance that changes is a different answer, so the rebuild that
      // came out of the old one is no longer what is being described.
      if (state.report) reset();
      clearTimeout(settle);
      settle = setTimeout(function () { look(); }, 120);
    }
    ['opt-angle', 'opt-deviation', 'opt-tolerance', 'opt-square', 'opt-recognise'].forEach(function (id) {
      el(id).addEventListener('change', function () {
        if (id === 'opt-tolerance' || id === 'opt-deviation') {
          state.byGauge = false;
          el('opt-simplify').value = tolerancesToGauge(tolerances().tolerance, modelSize(), meshFaceting());
        }
        changed();
      });
    });

    // Dragging only moves the numbers; letting go rebuilds. So a drag across
    // the whole gauge is one answer rather than a hundred, and the answer is
    // the model itself rather than a description of it — the point of a gauge
    // being that you can see what it did.
    el('btn-best').onclick = findBest;
    el('opt-simplify').addEventListener('input', function () {
      state.byGauge = true;
      el('simplify-advice').hidden = true;
      applyGauge(false);
    });
    el('opt-simplify').addEventListener('change', function () {
      state.byGauge = true;
      applyGauge(false);
      if (state.source) convert();
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
