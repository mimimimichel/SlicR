/**
 * Orca Web Slicer — 3D viewport.
 *
 * Printer coordinates throughout: X/Y across the bed, Z up.
 * Camera control is pointer-based so mouse, pen and touch all work the same:
 *   one pointer  -> orbit (or drag the selected model in "move" mode)
 *   two pointers -> pinch zoom + pan
 *   wheel        -> zoom
 */
(function (root) {
  'use strict';
  var THREE = root.THREE;

  var FEATURE_COLORS = [
    0x9aa7b8,  //  0 skirt
    0x9aa7b8,  //  1 brim
    0xff8a3d,  //  2 wall-outer
    0xffc24d,  //  3 wall-inner
    0xe8564f,  //  4 solid
    0xf05a8a,  //  5 top
    0xe8564f,  //  6 bottom
    0x4fc3f7,  //  7 bridge
    0xc08cff,  //  8 sparse
    0x5ad19b,  //  9 support
    0xffe9a8,  // 10 ironing
    0x8de06a,  // 11 gap fill
    0x2fa77a,  // 12 support interface
    0x6b7a90,  // 13 raft
    0xff5fa2,  // 14 overhang wall
    0x7ad3ff   // 15 internal bridge
  ];

  var FEATURE_LABELS = [
    'Skirt', 'Brim', 'Outer wall', 'Inner wall',
    'Solid infill', 'Top surface', 'Bottom surface', 'Bridge', 'Sparse infill', 'Support',
    'Ironing', 'Gap fill', 'Support interface', 'Raft', 'Overhang wall', 'Internal bridge'
  ];

  function Viewer(canvas, opts) {
    this.canvas = canvas;
    this.opts = opts || {};
    this.bed = { x: 256, y: 256, z: 256 };
    this.bedShape = 'rect';
    this.mode = 'orbit';
    this.paintKind = 'enforce';
    this.paintRadius = 3;
    this.onPaint = function () {};
    this.onSelect = this.opts.onSelect || function () {};
    this.onMove = this.opts.onMove || function () {};

    // preserveDrawingBuffer keeps the frame readable so snapshot() can grab the
    // G-code thumbnail without racing the compositor.
    this.renderer = new THREE.WebGLRenderer({
      canvas: canvas, antialias: true, alpha: false, preserveDrawingBuffer: true
    });
    this.renderer.setClearColor(0x06080d, 1);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x06080d, 600, 1600);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.5, 4000);
    this.camera.up.set(0, 0, 1);

    this.target = new THREE.Vector3(128, 128, 40);
    this.spherical = { radius: 460, theta: -Math.PI / 4, phi: Math.PI / 3 };

    this.modelGroup = new THREE.Group();
    this.previewGroup = new THREE.Group();
    this.plateGroup = new THREE.Group();
    this.scene.add(this.plateGroup, this.modelGroup, this.previewGroup);
    this.previewGroup.visible = false;

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    var key = new THREE.DirectionalLight(0xffffff, 0.75);
    key.position.set(-0.4, -0.6, 1);
    this.scene.add(key);
    var rim = new THREE.DirectionalLight(0x8fa5ff, 0.35);
    rim.position.set(0.7, 0.5, 0.4);
    this.scene.add(rim);

    this.models = [];
    this.selected = null;
    this.raycaster = new THREE.Raycaster();

    this.buildPlate();
    this.bindPointer();
    this.updateCamera();

    var self = this;
    this._resize = function () { self.resize(); };
    window.addEventListener('resize', this._resize);
    window.addEventListener('orientationchange', this._resize);
    this.resize();
    this.animate();
  }

  Viewer.FEATURE_COLORS = FEATURE_COLORS;
  Viewer.FEATURE_LABELS = FEATURE_LABELS;

  // --- Build plate ------------------------------------------------------------

  Viewer.prototype.setBed = function (x, y, z, shape) {
    this.bed = { x: x, y: y, z: z };
    this.bedShape = shape || 'rect';
    this.buildPlate();
    this.frameObjects();
  };

  Viewer.prototype.buildPlate = function () {
    var g = this.plateGroup;
    while (g.children.length) { var c = g.children.pop(); if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); }

    var bx = this.bed.x, by = this.bed.y;
    var round = this.bedShape === 'circle';
    var radius = Math.min(bx, by) / 2;

    var surface = new THREE.Mesh(
      round ? new THREE.CircleGeometry(radius, 96) : new THREE.PlaneGeometry(bx, by),
      new THREE.MeshBasicMaterial({ color: 0x0d131d })
    );
    surface.position.set(bx / 2, by / 2, -0.05);
    g.add(surface);

    // 10 mm grid, with a brighter line every 50 mm, clipped to the plate outline.
    var cxp = bx / 2, cyp = by / 2;
    function span(fixed, along) {
      // For a round plate a grid line only spans the chord at that offset.
      if (!round) return [0, along === 'x' ? bx : by];
      var d = Math.abs(fixed - (along === 'x' ? cyp : cxp));
      if (d >= radius) return null;
      var half = Math.sqrt(radius * radius - d * d);
      var c = along === 'x' ? cxp : cyp;
      return [c - half, c + half];
    }

    var minor = [], major = [], s2, x, y;
    for (x = 0; x <= bx + 0.001; x += 10) {
      s2 = span(x, 'y');
      if (!s2) continue;
      (Math.round(x) % 50 === 0 ? major : minor).push(x, s2[0], 0, x, s2[1], 0);
    }
    for (y = 0; y <= by + 0.001; y += 10) {
      s2 = span(y, 'x');
      if (!s2) continue;
      (Math.round(y) % 50 === 0 ? major : minor).push(s2[0], y, 0, s2[1], y, 0);
    }
    g.add(lineSegments(minor, 0x1b2534, 0.65));
    g.add(lineSegments(major, 0x2c3e57, 0.9));

    var border = [];
    if (round) {
      for (var a = 0; a < 96; a++) {
        var a0 = a / 96 * Math.PI * 2, a1 = (a + 1) / 96 * Math.PI * 2;
        border.push(cxp + Math.cos(a0) * radius, cyp + Math.sin(a0) * radius, 0,
                    cxp + Math.cos(a1) * radius, cyp + Math.sin(a1) * radius, 0);
      }
    } else {
      border = [0, 0, 0, bx, 0, 0, bx, 0, 0, bx, by, 0, bx, by, 0, 0, by, 0, 0, by, 0, 0, 0, 0];
    }
    g.add(lineSegments(border, 0x4b5f80, 1));

    // Origin marker.
    g.add(lineSegments([0, 0, 0, 14, 0, 0], 0xff6b6b, 1));
    g.add(lineSegments([0, 0, 0, 0, 14, 0], 0x6bff9d, 1));
    g.add(lineSegments([0, 0, 0, 0, 0, 14], 0x6b9dff, 1));

    // Build-volume cage.
    var bz = this.bed.z;
    var cage = [];
    if (round) {
      for (var k = 0; k < 48; k++) {
        var t0 = k / 48 * Math.PI * 2, t1 = (k + 1) / 48 * Math.PI * 2;
        cage.push(cxp + Math.cos(t0) * radius, cyp + Math.sin(t0) * radius, bz,
                  cxp + Math.cos(t1) * radius, cyp + Math.sin(t1) * radius, bz);
        if (k % 6 === 0) {
          cage.push(cxp + Math.cos(t0) * radius, cyp + Math.sin(t0) * radius, 0,
                    cxp + Math.cos(t0) * radius, cyp + Math.sin(t0) * radius, bz);
        }
      }
    } else {
      var corners = [[0, 0], [bx, 0], [bx, by], [0, by]];
      for (var i = 0; i < 4; i++) {
        var a2 = corners[i], b2 = corners[(i + 1) % 4];
        cage.push(a2[0], a2[1], bz, b2[0], b2[1], bz);
        cage.push(a2[0], a2[1], 0, a2[0], a2[1], bz);
      }
    }
    g.add(lineSegments(cage, 0x1a2534, 0.34));
  };

  function lineSegments(points, color, opacity) {
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    var mat = new THREE.LineBasicMaterial({ color: color, transparent: opacity < 1, opacity: opacity });
    return new THREE.LineSegments(geo, mat);
  }

  // --- Models -----------------------------------------------------------------

  Viewer.prototype.addModel = function (positions, name) {
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions.slice(), 3));
    geo.computeVertexNormals();
    geo.computeBoundingBox();

    var mat = new THREE.MeshPhongMaterial({
      color: 0x6c7ff2, specular: 0x2a3550, shininess: 26,
      flatShading: false, side: THREE.DoubleSide
    });
    var mesh = new THREE.Mesh(geo, mat);

    var model = {
      id: 'm' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      name: name || 'model',
      mesh: mesh,
      source: positions,
      scale: { x: 100, y: 100, z: 100 },
      rotation: { x: 0, y: 0, z: 0 },
      position: { x: 0, y: 0 },
      mirror: { x: 1, y: 1, z: 1 }
    };
    mesh.userData.model = model;
    this.modelGroup.add(mesh);
    this.models.push(model);

    this.centerOnPlate(model);
    this.select(model);
    return model;
  };

  /** Swap a model's mesh for new geometry, keeping its place in the list. */
  Viewer.prototype.replaceGeometry = function (model, positions) {
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions.slice(), 3));
    geo.computeVertexNormals();
    geo.computeBoundingBox();
    model.mesh.geometry.dispose();
    model.mesh.geometry = geo;
    model.source = positions;
    this.applyTransform(model);
  };

  Viewer.prototype.removeModel = function (model) {
    var i = this.models.indexOf(model);
    if (i < 0) return;
    this.models.splice(i, 1);
    this.modelGroup.remove(model.mesh);
    model.mesh.geometry.dispose();
    model.mesh.material.dispose();
    if (this.selected === model) this.select(this.models[0] || null);
  };

  Viewer.prototype.clearModels = function () {
    while (this.models.length) this.removeModel(this.models[0]);
  };

  Viewer.prototype.select = function (model) {
    for (var i = 0; i < this.models.length; i++) {
      this.models[i].mesh.material.color.setHex(this.models[i] === model ? 0x8b9bff : 0x6c7ff2);
      this.models[i].mesh.material.emissive.setHex(this.models[i] === model ? 0x1a2450 : 0x000000);
    }
    this.selected = model || null;
    this.onSelect(this.selected);
  };

  /** Re-apply scale/rotation/position and drop the model onto the bed. */
  Viewer.prototype.applyTransform = function (model) {
    var m = model.mesh;
    m.scale.set(
      model.scale.x / 100 * model.mirror.x,
      model.scale.y / 100 * model.mirror.y,
      model.scale.z / 100 * model.mirror.z
    );
    m.rotation.set(
      model.rotation.x * Math.PI / 180,
      model.rotation.y * Math.PI / 180,
      model.rotation.z * Math.PI / 180
    );
    m.position.set(0, 0, 0);
    m.updateMatrixWorld(true);

    var box = new THREE.Box3().setFromObject(m);
    var cx = (box.min.x + box.max.x) / 2, cy = (box.min.y + box.max.y) / 2;
    m.position.set(model.position.x - cx, model.position.y - cy, -box.min.z);
    m.updateMatrixWorld(true);
    model.bbox = new THREE.Box3().setFromObject(m);
    return model.bbox;
  };

  Viewer.prototype.centerOnPlate = function (model) {
    model.position.x = this.bed.x / 2;
    model.position.y = this.bed.y / 2;
    this.applyTransform(model);
  };

  /** Lay the models out on a simple grid so nothing overlaps. */
  Viewer.prototype.arrange = function () {
    var self = this;
    var boxes = this.models.map(function (m) {
      self.applyTransform(m);
      return { m: m, w: m.bbox.max.x - m.bbox.min.x, d: m.bbox.max.y - m.bbox.min.y };
    });
    if (!boxes.length) return;
    var gap = 6;
    var maxW = Math.max.apply(null, boxes.map(function (b) { return b.w; })) + gap;
    var maxD = Math.max.apply(null, boxes.map(function (b) { return b.d; })) + gap;
    var cols = Math.max(1, Math.floor(this.bed.x / maxW));
    var rows = Math.ceil(boxes.length / cols);
    var totalW = Math.min(cols, boxes.length) * maxW, totalD = rows * maxD;
    var x0 = (this.bed.x - totalW) / 2 + maxW / 2;
    var y0 = (this.bed.y - totalD) / 2 + maxD / 2;
    for (var i = 0; i < boxes.length; i++) {
      boxes[i].m.position.x = x0 + (i % cols) * maxW;
      boxes[i].m.position.y = y0 + Math.floor(i / cols) * maxD;
      this.applyTransform(boxes[i].m);
    }
  };

  /**
   * Rotate the model so the picked facet lies flat on the plate. This is the
   * "place on face" every slicer has, and it beats guessing Euler angles.
   */
  Viewer.prototype.placeOnFace = function (model, worldNormal) {
    var down = new THREE.Vector3(0, 0, -1);
    var turn = new THREE.Quaternion().setFromUnitVectors(worldNormal.clone().normalize(), down);
    var current = new THREE.Quaternion().setFromEuler(new THREE.Euler(
      model.rotation.x * Math.PI / 180,
      model.rotation.y * Math.PI / 180,
      model.rotation.z * Math.PI / 180, 'XYZ'));
    var euler = new THREE.Euler().setFromQuaternion(turn.multiply(current), 'XYZ');
    var deg = 180 / Math.PI;
    model.rotation = {
      x: Math.round(euler.x * deg * 100) / 100,
      y: Math.round(euler.y * deg * 100) / 100,
      z: Math.round(euler.z * deg * 100) / 100
    };
    this.applyTransform(model);
  };

  /** Translucent plane showing where a cut would land. */
  Viewer.prototype.showCutPlane = function (z) {
    if (!this.cutPlane) {
      var geo = new THREE.PlaneGeometry(1, 1);
      var mat = new THREE.MeshBasicMaterial({
        color: 0x6366f1, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false
      });
      this.cutPlane = new THREE.Mesh(geo, mat);
      this.scene.add(this.cutPlane);
    }
    var size = Math.max(this.bed.x, this.bed.y) * 1.05;
    this.cutPlane.scale.set(size, size, 1);
    this.cutPlane.position.set(this.bed.x / 2, this.bed.y / 2, z);
    this.cutPlane.visible = true;
  };

  Viewer.prototype.hideCutPlane = function () {
    if (this.cutPlane) this.cutPlane.visible = false;
  };

  /** One model's triangles with its transform baked in, in bed coordinates. */
  Viewer.prototype.worldTriangles = function (model) {
    var mesh = model.mesh;
    mesh.updateMatrixWorld(true);
    var pos = mesh.geometry.attributes.position;
    var out = new Float32Array(pos.count * 3);
    var flip = (mesh.scale.x * mesh.scale.y * mesh.scale.z) < 0;
    var v = new THREE.Vector3();
    var cursor = 0;
    for (var t = 0; t < pos.count; t += 3) {
      var order = flip ? [0, 2, 1] : [0, 1, 2];
      for (var k = 0; k < 3; k++) {
        v.fromBufferAttribute(pos, t + order[k]).applyMatrix4(mesh.matrixWorld);
        out[cursor++] = v.x; out[cursor++] = v.y; out[cursor++] = v.z;
      }
    }
    return out;
  };

  /** All model triangles baked into bed coordinates, ready for the slicer. */
  /** Each model's triangles on its own, for printing one object at a time. */
  var TOOL_COLORS = [0x4f8ef7, 0xf7854f, 0x4fd07a, 0xd04f9e, 0xd0c34f, 0x8e4fd0, 0x4fd0c3, 0xd05050];

  /** Colour a model by the tool that prints it, so the plate reads at a glance. */
  Viewer.prototype.tintByTool = function (model) {
    if (!model.mesh || !model.mesh.material) return;
    model.mesh.material.color.setHex(TOOL_COLORS[(model.extruder | 0) % TOOL_COLORS.length]);
    model.mesh.material.needsUpdate = true;
  };

  Viewer.prototype.collectObjects = function () {
    var out = [], v = new THREE.Vector3();
    for (var i = 0; i < this.models.length; i++) {
      var mesh = this.models[i].mesh;
      mesh.updateMatrixWorld(true);
      var pos = mesh.geometry.attributes.position;
      var tri = new Float32Array(pos.count * 3);
      var flip = (mesh.scale.x * mesh.scale.y * mesh.scale.z) < 0;
      var cursor = 0;
      for (var t = 0; t < pos.count; t += 3) {
        var order = flip ? [0, 2, 1] : [0, 1, 2];
        for (var k = 0; k < 3; k++) {
          v.fromBufferAttribute(pos, t + order[k]).applyMatrix4(mesh.matrixWorld);
          tri[cursor++] = v.x; tri[cursor++] = v.y; tri[cursor++] = v.z;
        }
      }
      out.push({ name: this.models[i].name || ('Object ' + (i + 1)), positions: tri,
                  extruder: this.models[i].extruder | 0 });
    }
    return out;
  };

  Viewer.prototype.collectTriangles = function () {
    var total = 0, i;
    for (i = 0; i < this.models.length; i++) total += this.models[i].mesh.geometry.attributes.position.count;
    var out = new Float32Array(total * 3);
    var cursor = 0;
    var v = new THREE.Vector3();

    for (i = 0; i < this.models.length; i++) {
      var mesh = this.models[i].mesh;
      mesh.updateMatrixWorld(true);
      var pos = mesh.geometry.attributes.position;
      var flip = (mesh.scale.x * mesh.scale.y * mesh.scale.z) < 0;
      for (var t = 0; t < pos.count; t += 3) {
        var order = flip ? [0, 2, 1] : [0, 1, 2];
        for (var k = 0; k < 3; k++) {
          v.fromBufferAttribute(pos, t + order[k]).applyMatrix4(mesh.matrixWorld);
          out[cursor++] = v.x; out[cursor++] = v.y; out[cursor++] = v.z;
        }
      }
    }
    return out;
  };

  Viewer.prototype.outOfBounds = function () {
    var round = this.bedShape === 'circle';
    var r = Math.min(this.bed.x, this.bed.y) / 2;
    var cx = this.bed.x / 2, cy = this.bed.y / 2;
    for (var i = 0; i < this.models.length; i++) {
      var b = this.models[i].bbox;
      if (!b) continue;
      if (b.max.z > this.bed.z + 0.01) return true;
      if (round) {
        // Every footprint corner has to sit inside the circle.
        var corners = [[b.min.x, b.min.y], [b.max.x, b.min.y], [b.max.x, b.max.y], [b.min.x, b.max.y]];
        for (var c = 0; c < 4; c++) {
          if (Math.hypot(corners[c][0] - cx, corners[c][1] - cy) > r + 0.01) return true;
        }
      } else if (b.min.x < -0.01 || b.min.y < -0.01 ||
                 b.max.x > this.bed.x + 0.01 || b.max.y > this.bed.y + 0.01) {
        return true;
      }
    }
    return false;
  };

  // --- G-code preview ---------------------------------------------------------

  /**
   * Build ribbon geometry from the worker's packed layers.
   * Extrusions become flat quads of the real line width; travels become lines.
   * Per-layer index ranges let the layer slider work without rebuilding.
   */
  Viewer.prototype.buildPreview = function (layers, showTravels) {
    var g = this.previewGroup;
    while (g.children.length) { var c = g.children.pop(); if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); }

    var segCount = 0, travelCount = 0, i, f;
    for (i = 0; i < layers.length; i++) {
      var L = layers[i];
      for (f = 0; f < L.types.length; f++) {
        var n = L.offsets[f + 1] - L.offsets[f];
        if (n >= 2) segCount += n - 1;
      }
      travelCount += L.types.length;
    }
    if (!segCount) { this.previewRanges = []; return { segments: 0 }; }

    var positions = new Float32Array(segCount * 4 * 3);
    var colors = new Float32Array(segCount * 4 * 3);
    var indices = new Uint32Array(segCount * 6);
    var travelPos = new Float32Array(travelCount * 6);

    var vp = 0, ip = 0, quad = 0, tp = 0;
    var ranges = new Array(layers.length);
    var color = new THREE.Color();
    var prevX = 0, prevY = 0, prevZ = 0, hasPrev = false;

    for (i = 0; i < layers.length; i++) {
      var layer = layers[i];
      var startIndex = ip;
      var travelStart = tp / 3;
      var z = layer.z;

      for (f = 0; f < layer.types.length; f++) {
        var s = layer.offsets[f], e = layer.offsets[f + 1];
        if (e - s < 2) continue;
        var featureHalf = Math.max(layer.widths[f], 0.1) / 2;
        var pw = layer.pointWidths;
        color.setHex(FEATURE_COLORS[layer.types[f]] || 0xffffff);

        if (hasPrev) {
          travelPos[tp++] = prevX; travelPos[tp++] = prevY; travelPos[tp++] = prevZ;
          travelPos[tp++] = layer.pts[s * 2]; travelPos[tp++] = layer.pts[s * 2 + 1]; travelPos[tp++] = z;
        }

        for (var p = s; p < e - 1; p++) {
          var ax = layer.pts[p * 2], ay = layer.pts[p * 2 + 1];
          var bx = layer.pts[(p + 1) * 2], by = layer.pts[(p + 1) * 2 + 1];
          var dx = bx - ax, dy = by - ay;
          var len = Math.hypot(dx, dy);
          if (len < 1e-6) continue;
          // Half-width per end, so a variable-width bead tapers on screen too.
          var ha = pw ? Math.max(pw[p], 0.1) / 2 : featureHalf;
          var hb = pw ? Math.max(pw[p + 1], 0.1) / 2 : featureHalf;
          var ux = -dy / len, uy = dx / len;

          positions[vp * 3] = ax + ux * ha; positions[vp * 3 + 1] = ay + uy * ha; positions[vp * 3 + 2] = z;
          positions[vp * 3 + 3] = ax - ux * ha; positions[vp * 3 + 4] = ay - uy * ha; positions[vp * 3 + 5] = z;
          positions[vp * 3 + 6] = bx - ux * hb; positions[vp * 3 + 7] = by - uy * hb; positions[vp * 3 + 8] = z;
          positions[vp * 3 + 9] = bx + ux * hb; positions[vp * 3 + 10] = by + uy * hb; positions[vp * 3 + 11] = z;

          for (var v = 0; v < 4; v++) {
            colors[(vp + v) * 3] = color.r; colors[(vp + v) * 3 + 1] = color.g; colors[(vp + v) * 3 + 2] = color.b;
          }
          indices[ip++] = vp; indices[ip++] = vp + 1; indices[ip++] = vp + 2;
          indices[ip++] = vp; indices[ip++] = vp + 2; indices[ip++] = vp + 3;
          vp += 4;
          quad++;
        }
        prevX = layer.pts[(e - 1) * 2]; prevY = layer.pts[(e - 1) * 2 + 1]; prevZ = z;
        hasPrev = true;
      }
      ranges[i] = { start: startIndex, count: ip - startIndex, travelStart: travelStart, travelCount: tp / 3 - travelStart };
    }

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions.subarray(0, vp * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors.subarray(0, vp * 3), 3));
    geo.setIndex(new THREE.BufferAttribute(indices.subarray(0, ip), 1));
    var mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
    this.previewMesh = new THREE.Mesh(geo, mat);
    g.add(this.previewMesh);

    var tgeo = new THREE.BufferGeometry();
    tgeo.setAttribute('position', new THREE.BufferAttribute(travelPos.subarray(0, tp), 3));
    this.travelMesh = new THREE.LineSegments(tgeo, new THREE.LineBasicMaterial({
      color: 0x3fd0d4, transparent: true, opacity: 0.32
    }));
    this.travelMesh.visible = !!showTravels;
    g.add(this.travelMesh);

    this.previewRanges = ranges;
    this.setVisibleLayers(0, layers.length - 1);
    return { segments: quad, travels: tp / 6 };
  };

  Viewer.prototype.setVisibleLayers = function (from, to) {
    if (!this.previewRanges || !this.previewRanges.length) return;
    from = Math.max(0, Math.min(from, this.previewRanges.length - 1));
    to = Math.max(from, Math.min(to, this.previewRanges.length - 1));
    var a = this.previewRanges[from], b = this.previewRanges[to];
    if (this.previewMesh) this.previewMesh.geometry.setDrawRange(a.start, (b.start + b.count) - a.start);
    if (this.travelMesh) this.travelMesh.geometry.setDrawRange(a.travelStart, (b.travelStart + b.travelCount) - a.travelStart);
  };

  Viewer.prototype.showPreview = function (on) {
    this.previewGroup.visible = !!on;
    this.modelGroup.visible = !on;
  };

  Viewer.prototype.setTravelsVisible = function (on) {
    if (this.travelMesh) this.travelMesh.visible = !!on;
  };

  // --- Camera + input ---------------------------------------------------------

  Viewer.prototype.updateCamera = function () {
    var s = this.spherical;
    s.phi = Math.max(0.05, Math.min(Math.PI - 0.05, s.phi));
    s.radius = Math.max(20, Math.min(3000, s.radius));
    this.camera.position.set(
      this.target.x + s.radius * Math.sin(s.phi) * Math.cos(s.theta),
      this.target.y + s.radius * Math.sin(s.phi) * Math.sin(s.theta),
      this.target.z + s.radius * Math.cos(s.phi)
    );
    this.camera.lookAt(this.target);
  };

  /** Change the viewing angle, then re-fit on whatever is on the plate. */
  Viewer.prototype.setView = function (name) {
    var s = this.spherical;
    switch (name) {
      case 'top': s.theta = -Math.PI / 2; s.phi = 0.06; break;
      case 'front': s.theta = -Math.PI / 2; s.phi = Math.PI / 2 - 0.02; break;
      case 'left': s.theta = Math.PI; s.phi = Math.PI / 2 - 0.02; break;
      case 'right': s.theta = 0; s.phi = Math.PI / 2 - 0.02; break;
      default: s.theta = -Math.PI / 4; s.phi = Math.PI / 3;
    }
    this.frameObjects();
  };

  Viewer.prototype.setMode = function (mode) { this.mode = mode; };

  // ---------------------------------------------------------------------------
  // Paint tools
  // ---------------------------------------------------------------------------

  var PAINT_KINDS = {
    enforce: { color: 0x2ecc71, label: 'Support enforcer' },
    block:   { color: 0xe74c3c, label: 'Support blocker' },
    seam:    { color: 0x3498db, label: 'Seam' }
  };

  /**
   * A painted mark is a ball stuck to the model surface. It is a child of the
   * mesh, so it follows every move, rotation and scale the user applies — paint
   * a seam on a face and it stays on that face.
   */
  Viewer.prototype.addPaintMark = function (model, localPoint, kind, radius) {
    var spec = PAINT_KINDS[kind] || PAINT_KINDS.enforce;
    var geom = new THREE.SphereGeometry(radius, 16, 12);
    var mat = new THREE.MeshBasicMaterial({ color: spec.color, transparent: true, opacity: 0.55 });
    var ball = new THREE.Mesh(geom, mat);
    ball.position.copy(localPoint);
    ball.userData.paint = { kind: kind, radius: radius, model: model };
    ball.renderOrder = 3;
    model.mesh.add(ball);
    (model.paint || (model.paint = [])).push(ball);
    return ball;
  };

  /**
   * One dab of the brush. Marks are only laid down where there is not already
   * one of the same kind within half a brush width, so dragging leaves an even
   * stroke instead of a thousand overlapping balls.
   */
  Viewer.prototype.paintAt = function (model, localPoint, kind, radius) {
    var marks = model.paint || [];
    var minGap = radius * 0.5;
    for (var i = 0; i < marks.length; i++) {
      if (marks[i].userData.paint.kind !== kind) continue;
      if (marks[i].position.distanceTo(localPoint) < minGap) return null;
    }
    return this.addPaintMark(model, localPoint, kind, radius);
  };

  /** Rub out every mark of any kind within the brush of this point. */
  Viewer.prototype.eraseAt = function (model, localPoint, radius) {
    var marks = (model.paint || []).slice();
    var removed = 0;
    for (var i = 0; i < marks.length; i++) {
      if (marks[i].position.distanceTo(localPoint) > radius) continue;
      this.removePaintMark(marks[i]);
      removed++;
    }
    return removed;
  };

  Viewer.prototype.removePaintMark = function (ball) {
    var model = ball.userData.paint.model;
    var at = model.paint ? model.paint.indexOf(ball) : -1;
    if (at >= 0) model.paint.splice(at, 1);
    ball.parent.remove(ball);
    ball.geometry.dispose();
    ball.material.dispose();
  };

  /** Drop every mark, or only those of one kind. */
  Viewer.prototype.clearPaint = function (kind) {
    for (var i = 0; i < this.models.length; i++) {
      var marks = (this.models[i].paint || []).slice();
      for (var k = 0; k < marks.length; k++) {
        if (!kind || marks[k].userData.paint.kind === kind) this.removePaintMark(marks[k]);
      }
    }
  };

  Viewer.prototype.paintCount = function () {
    var n = 0;
    for (var i = 0; i < this.models.length; i++) n += (this.models[i].paint || []).length;
    return n;
  };

  /**
   * Every mark in bed coordinates, ready for the engine. The radius follows the
   * model's scale, so a mark painted on a part that is later doubled in size
   * covers the same feature it was painted on.
   */
  Viewer.prototype.collectPaintMarks = function () {
    var out = [], world = new THREE.Vector3();
    for (var i = 0; i < this.models.length; i++) {
      var mesh = this.models[i].mesh;
      mesh.updateMatrixWorld(true);
      var scale = Math.cbrt(Math.abs(mesh.scale.x * mesh.scale.y * mesh.scale.z)) || 1;
      var marks = this.models[i].paint || [];
      for (var k = 0; k < marks.length; k++) {
        world.copy(marks[k].position).applyMatrix4(mesh.matrixWorld);
        out.push({
          x: world.x, y: world.y, z: world.z,
          r: marks[k].userData.paint.radius * scale,
          kind: marks[k].userData.paint.kind
        });
      }
    }
    return out;
  };


  /**
   * Point the camera at the loaded models (or the whole bed when empty) and
   * pull back just far enough to fit them. Small parts on a big plate are the
   * norm, so this runs on every load and after every slice.
   */
  Viewer.prototype.frameObjects = function () {
    var box = new THREE.Box3();
    var found = false;
    for (var i = 0; i < this.models.length; i++) {
      this.models[i].mesh.updateMatrixWorld(true);
      box.expandByObject(this.models[i].mesh);
      found = true;
    }
    if (!found || box.isEmpty()) {
      this.target.set(this.bed.x / 2, this.bed.y / 2, this.bed.z * 0.12);
      this.spherical.radius = Math.max(this.bed.x, this.bed.y) * 1.8;
      this.updateCamera();
      return;
    }
    var size = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(this.target);
    var extent = Math.max(size.x, size.y, size.z, 5);
    var fov = this.camera.fov * Math.PI / 180;
    var fit = (extent * 0.95) / Math.tan(fov / 2);
    this.spherical.radius = Math.max(extent * 1.6, fit);
    this.updateCamera();
  };

  Viewer.prototype.bindPointer = function () {
    var self = this;
    var pointers = new Map();
    var lastSingle = null, lastPinch = null, dragModel = null, dragOffset = null;
    var moved = 0;
    var painting = null;

    function positionsArray() {
      var a = [];
      pointers.forEach(function (p) { a.push(p); });
      return a;
    }

    function ndc(ev) {
      var r = self.canvas.getBoundingClientRect();
      return new THREE.Vector2(
        ((ev.clientX - r.left) / r.width) * 2 - 1,
        -((ev.clientY - r.top) / r.height) * 2 + 1
      );
    }

    /** Where the pointer ray meets the bed plane (z = height). */
    function bedPoint(ev, height) {
      self.raycaster.setFromCamera(ndc(ev), self.camera);
      var plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -(height || 0));
      var hit = new THREE.Vector3();
      return self.raycaster.ray.intersectPlane(plane, hit) ? hit : null;
    }

    function pick(ev) {
      self.raycaster.setFromCamera(ndc(ev), self.camera);
      var hits = self.raycaster.intersectObjects(self.modelGroup.children, false);
      return hits.length ? hits[0].object.userData.model : null;
    }

    /** A painted ball under the pointer, if any. */
    function pickPaint(ev) {
      self.raycaster.setFromCamera(ndc(ev), self.camera);
      var balls = [];
      for (var i = 0; i < self.models.length; i++) {
        var marks = self.models[i].paint || [];
        for (var k = 0; k < marks.length; k++) balls.push(marks[k]);
      }
      if (!balls.length) return null;
      var hits = self.raycaster.intersectObjects(balls, false);
      return hits.length ? hits[0].object : null;
    }

    /** Where the pointer meets the model surface, in that model's own space. */
    function pickSurface(ev) {
      self.raycaster.setFromCamera(ndc(ev), self.camera);
      var hits = self.raycaster.intersectObjects(self.modelGroup.children, false);
      if (!hits.length) return null;
      var mesh = hits[0].object;
      return {
        model: mesh.userData.model,
        local: mesh.worldToLocal(hits[0].point.clone())
      };
    }

    /**
     * Lay down (or rub out) one dab under the pointer. Returns true if the ray
     * met the model at all, which is what decides whether the drag paints or
     * falls back to orbiting.
     */
    function strokeAt(ev) {
      var surf = pickSurface(ev);
      if (!surf) return false;
      if (self.paintKind === 'erase') self.eraseAt(surf.model, surf.local, self.paintRadius);
      else self.paintAt(surf.model, surf.local, self.paintKind, self.paintRadius);
      self.onPaint();
      return true;
    }

    function pickFace(ev) {
      self.raycaster.setFromCamera(ndc(ev), self.camera);
      var hits = self.raycaster.intersectObjects(self.modelGroup.children, false);
      if (!hits.length || !hits[0].face) return null;
      var mesh = hits[0].object;
      var normal = hits[0].face.normal.clone()
        .applyMatrix3(new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld))
        .normalize();
      return { model: mesh.userData.model, normal: normal };
    }

    self.canvas.addEventListener('pointerdown', function (ev) {
      try { self.canvas.setPointerCapture(ev.pointerId); } catch (e) { /* pointer already gone */ }
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      moved = 0;

      if (pointers.size === 1) {
        lastSingle = { x: ev.clientX, y: ev.clientY, button: ev.button, shift: ev.shiftKey };
        if (self.mode === 'paint' && self.modelGroup.visible) {
          painting = strokeAt(ev) ? 'stroke' : 'miss';
        }
        if (self.mode === 'move' && self.modelGroup.visible) {
          var hit = pick(ev);
          if (hit) {
            self.select(hit);
            var bp = bedPoint(ev, 0);
            if (bp) { dragModel = hit; dragOffset = { x: hit.position.x - bp.x, y: hit.position.y - bp.y }; }
          }
        }
      } else if (pointers.size === 2) {
        var p = positionsArray();
        lastPinch = {
          dist: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y),
          mx: (p[0].x + p[1].x) / 2, my: (p[0].y + p[1].y) / 2
        };
        dragModel = null;
      }
    });

    self.canvas.addEventListener('pointermove', function (ev) {
      if (!pointers.has(ev.pointerId)) return;
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });

      if (pointers.size === 1 && lastSingle) {
        var dx = ev.clientX - lastSingle.x, dy = ev.clientY - lastSingle.y;
        moved += Math.abs(dx) + Math.abs(dy);

        if (painting === 'stroke') {
          // A drag that started on the model paints along it. A drag that
          // started on empty space orbits, so the view is still reachable
          // without leaving the brush.
          strokeAt(ev);
        } else if (dragModel) {
          var bp = bedPoint(ev, 0);
          if (bp) {
            dragModel.position.x = Math.round((bp.x + dragOffset.x) * 10) / 10;
            dragModel.position.y = Math.round((bp.y + dragOffset.y) * 10) / 10;
            self.applyTransform(dragModel);
            self.onMove(dragModel);
          }
        } else if (lastSingle.button === 2 || lastSingle.shift) {
          self.panBy(dx, dy);
        } else {
          self.spherical.theta -= dx * 0.008;
          self.spherical.phi -= dy * 0.008;
          self.updateCamera();
        }
        lastSingle.x = ev.clientX; lastSingle.y = ev.clientY;
      } else if (pointers.size === 2 && lastPinch) {
        var p = positionsArray();
        var dist = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
        var mx = (p[0].x + p[1].x) / 2, my = (p[0].y + p[1].y) / 2;
        if (lastPinch.dist > 0 && dist > 0) {
          self.spherical.radius *= lastPinch.dist / dist;
        }
        self.panBy(mx - lastPinch.mx, my - lastPinch.my);
        lastPinch = { dist: dist, mx: mx, my: my };
        self.updateCamera();
      }
      ev.preventDefault();
    });

    function endPointer(ev) {
      if (pointers.size === 1 && moved < 6 && self.modelGroup.visible && !dragModel) {
        if (self.mode === 'paint') {
          // The dab under the pointer went down when the stroke started, so a
          // plain tap has already painted. Nothing to do here.
        } else if (self.mode === 'face') {
          var hit = pickFace(ev);
          if (hit) {
            self.select(hit.model);
            self.placeOnFace(hit.model, hit.normal);
            self.onMove(hit.model);
          }
        } else {
          self.select(pick(ev));
        }
      }
      pointers.delete(ev.pointerId);
      if (pointers.size < 2) lastPinch = null;
      if (pointers.size === 0) { lastSingle = null; dragModel = null; painting = null; }
    }
    self.canvas.addEventListener('pointerup', endPointer);
    self.canvas.addEventListener('pointercancel', function (ev) { pointers.delete(ev.pointerId); lastPinch = null; lastSingle = null; dragModel = null; painting = null; });
    self.canvas.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });

    self.canvas.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      self.spherical.radius *= ev.deltaY > 0 ? 1.1 : 0.9;
      self.updateCamera();
    }, { passive: false });
  };

  Viewer.prototype.panBy = function (dx, dy) {
    var scale = this.spherical.radius * 0.0022;
    var right = new THREE.Vector3().subVectors(this.camera.position, this.target).cross(this.camera.up).normalize();
    var up = new THREE.Vector3().crossVectors(right, new THREE.Vector3().subVectors(this.camera.position, this.target)).normalize();
    this.target.addScaledVector(right, -dx * scale);
    this.target.addScaledVector(up, -dy * scale);
    this.updateCamera();
  };

  /** Render one square frame at `size` px and return it as a PNG data URL. */
  Viewer.prototype.snapshot = function (size) {
    var canvas = this.renderer.domElement;
    var prevW = canvas.width, prevH = canvas.height;
    var prevAspect = this.camera.aspect;
    var prevRatio = this.renderer.getPixelRatio();
    try {
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(size, size, false);
      this.camera.aspect = 1;
      this.camera.updateProjectionMatrix();
      this.renderer.render(this.scene, this.camera);
      return canvas.toDataURL('image/png');
    } catch (e) {
      return null;
    } finally {
      this.renderer.setPixelRatio(prevRatio);
      this.renderer.setSize(prevW / prevRatio, prevH / prevRatio, false);
      this.camera.aspect = prevAspect;
      this.camera.updateProjectionMatrix();
      this.resize();
    }
  };

  Viewer.prototype.resize = function () {
    var parent = this.canvas.parentElement;
    if (!parent) return;
    var w = parent.clientWidth, h = parent.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  Viewer.prototype.animate = function () {
    var self = this;
    function loop() {
      self._raf = requestAnimationFrame(loop);
      self.renderer.render(self.scene, self.camera);
    }
    loop();
  };

  root.OrcaViewer = Viewer;
})(typeof window !== 'undefined' ? window : globalThis);
