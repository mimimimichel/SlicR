/**
 * Prismatic — the viewport.
 *
 * One mesh, seen from any angle, painted so that what the conversion found is
 * on the screen rather than only in the numbers: every flat face gets its own
 * colour, and the edges where two faces meet are drawn over the top. A part
 * whose faces were found properly reads as a handful of flat colours with the
 * part's real edges between them; one where they were not is a confetti of
 * little patches, and you can see that at a glance instead of being told.
 *
 * Z is up, as it is everywhere else in this repo. Pointer control is the same
 * for mouse, pen and touch:
 *   one pointer  -> orbit          shift or right button -> pan
 *   two pointers -> pinch and pan  wheel -> zoom
 */
(function (root) {
  'use strict';
  var THREE = root.THREE;

  var PLAIN = 0x8b9bff;   // the one colour a mesh wears when it is not painted

  function Viewer(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: false });
    this.renderer.setClearColor(0x06080d, 1);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 20000);
    this.camera.up.set(0, 0, 1);
    this.target = new THREE.Vector3(0, 0, 0);
    this.spherical = { radius: 200, theta: -Math.PI / 4, phi: Math.PI / 3 };

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.62));
    var key = new THREE.DirectionalLight(0xffffff, 0.7);
    key.position.set(-0.4, -0.6, 1);
    this.scene.add(key);
    var rim = new THREE.DirectionalLight(0x8fa5ff, 0.3);
    rim.position.set(0.7, 0.5, 0.4);
    this.scene.add(rim);

    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.mesh = null;
    this.edges = null;
    this.extent = 100;
    this.shadeByFace = true;
    this.showEdges = true;

    this.dirty = true;
    bindPointer(this);
    var self = this;
    window.addEventListener('resize', function () { self.resize(); });
    this.resize();
    (function loop() {
      requestAnimationFrame(loop);
      if (!self.dirty) return;
      self.dirty = false;
      self.renderer.render(self.scene, self.camera);
    })();
  }

  /**
   * A colour per face, spread by the golden angle so that neighbours — which
   * are numbered in the order they were grown, and so are usually adjacent —
   * never land on the same hue.
   */
  function faceColor(i, out) {
    var h = (i * 137.508) % 360 / 360;
    var s = 0.42, l = 0.62;
    var q = l + s * (l < 0.5 ? l : 1 - l) - l * s;
    var p = 2 * l - q;
    out[0] = hue(p, q, h + 1 / 3);
    out[1] = hue(p, q, h);
    out[2] = hue(p, q, h - 1 / 3);
  }
  function hue(p, q, t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  }

  /** Show a mesh, coloured by the face each triangle was put in. */
  Viewer.prototype.setMesh = function (positions, face, normals) {
    this.clearMesh();
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions.slice(), 3));

    if (face && face.length * 9 === positions.length) {
      var colors = new Float32Array(positions.length);
      var rgb = [0, 0, 0];
      for (var t = 0; t < face.length; t++) {
        faceColor(face[t] < 0 ? 0 : face[t], rgb);
        for (var k = 0; k < 3; k++) {
          colors[t * 9 + k * 3] = rgb[0];
          colors[t * 9 + k * 3 + 1] = rgb[1];
          colors[t * 9 + k * 3 + 2] = rgb[2];
        }
      }
      geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    }
    // Flat shading while what is on screen is the mesh, because a face that is
    // not flat should look like it is not flat: smoothing the normals would
    // hide the very thing being judged.
    //
    // Once a solid has been recognised out of it that is no longer the thing
    // being judged. A ring of two dozen facets called one cylinder is a
    // cylinder in the file — smooth, exact — and drawing it faceted says the
    // shape was not found when it was. So when the normals of the recognised
    // surfaces are handed in, they are used: a cylinder comes out round, and
    // the corners between faces stay crisp because a triangle soup keeps its
    // own copy of every corner and each copy carries its own face's normal.
    var given = !!(normals && normals.length === positions.length);
    if (given) geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals.slice(), 3));
    else geo.computeVertexNormals();
    geo.computeBoundingBox();

    // The base colour has to be white while the face colours are in use, or
    // every hue comes back multiplied by it and they all look alike.
    this.hasColors = !!(face && face.length * 9 === positions.length);
    var painted = this.hasColors && this.shadeByFace;
    this.mesh = new THREE.Mesh(geo, new THREE.MeshPhongMaterial({
      color: painted ? 0xffffff : PLAIN, specular: 0x1c2438, shininess: 18,
      flatShading: !given, side: THREE.DoubleSide,
      vertexColors: painted
    }));
    this.group.add(this.mesh);

    var b = geo.boundingBox;
    this.bounds = {
      min: { x: b.min.x, y: b.min.y, z: b.min.z },
      max: { x: b.max.x, y: b.max.y, z: b.max.z }
    };
    this.extent = Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z, 1);
    this.dirty = true;
  };

  /** The lines where one face meets another, drawn just off the surface. */
  Viewer.prototype.setEdges = function (segments) {
    if (this.edges) {
      this.group.remove(this.edges);
      this.edges.geometry.dispose();
      this.edges.material.dispose();
      this.edges = null;
    }
    if (!segments || !segments.length) { this.dirty = true; return; }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(segments.slice(), 3));
    var mat = new THREE.LineBasicMaterial({ color: 0x0b1018, transparent: true, opacity: 0.85 });
    mat.depthTest = true;
    this.edges = new THREE.LineSegments(geo, mat);
    // Pull the lines a whisker towards the camera so they are not eaten by the
    // surface they sit exactly on.
    this.edges.renderOrder = 2;
    this.edges.material.polygonOffset = true;
    this.edges.visible = this.showEdges;
    this.group.add(this.edges);
    this.dirty = true;
  };

  Viewer.prototype.clearMesh = function () {
    if (!this.mesh) return;
    this.group.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh = null;
    this.dirty = true;
  };

  Viewer.prototype.clear = function () {
    this.clearMesh();
    this.setEdges(null);
  };

  Viewer.prototype.setShadeByFace = function (on) {
    this.shadeByFace = !!on;
    if (this.mesh) {
      var painted = this.hasColors && this.shadeByFace;
      this.mesh.material.vertexColors = painted;
      this.mesh.material.color.setHex(painted ? 0xffffff : PLAIN);
      this.mesh.material.needsUpdate = true;
    }
    this.dirty = true;
  };

  Viewer.prototype.setEdgesVisible = function (on) {
    this.showEdges = !!on;
    if (this.edges) this.edges.visible = this.showEdges;
    this.dirty = true;
  };

  /** Put the whole part on the screen, whatever size it happens to be. */
  Viewer.prototype.frame = function () {
    if (!this.bounds) return;
    var b = this.bounds;
    this.target.set((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
    var fov = this.camera.fov * Math.PI / 180;
    this.spherical.radius = Math.max(this.extent * 0.9 / Math.tan(fov / 2), this.extent * 1.4);
    this.camera.near = Math.max(this.extent / 1000, 0.01);
    this.camera.far = this.spherical.radius * 20;
    this.camera.updateProjectionMatrix();
    this.updateCamera();
  };

  Viewer.prototype.setView = function (name) {
    var s = this.spherical;
    if (name === 'top') { s.theta = -Math.PI / 2; s.phi = 0.06; }
    else if (name === 'front') { s.theta = -Math.PI / 2; s.phi = Math.PI / 2 - 0.02; }
    else if (name === 'left') { s.theta = Math.PI; s.phi = Math.PI / 2 - 0.02; }
    else { s.theta = -Math.PI / 4; s.phi = Math.PI / 3; }
    this.frame();
  };

  Viewer.prototype.updateCamera = function () {
    var s = this.spherical;
    s.phi = Math.max(0.05, Math.min(Math.PI - 0.05, s.phi));
    s.radius = Math.max(this.extent * 0.05, Math.min(this.extent * 60, s.radius));
    this.camera.position.set(
      this.target.x + s.radius * Math.sin(s.phi) * Math.cos(s.theta),
      this.target.y + s.radius * Math.sin(s.phi) * Math.sin(s.theta),
      this.target.z + s.radius * Math.cos(s.phi)
    );
    this.camera.lookAt(this.target);
    this.dirty = true;
  };

  /** Slide the view sideways, at the rate the distance makes it look right. */
  Viewer.prototype.panBy = function (dx, dy, radius) {
    var r = radius || this.spherical.radius;
    var scale = 2 * r * Math.tan(this.camera.fov * Math.PI / 360) / Math.max(this.canvas.clientHeight, 1);
    var right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
    var up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
    this.target.addScaledVector(right, -dx * scale);
    this.target.addScaledVector(up, dy * scale);
    this.updateCamera();
  };

  Viewer.prototype.resize = function () {
    var w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  };

  function bindPointer(self) {
    var pointers = new Map();
    var single = null, pinch = null;
    var canvas = self.canvas;

    function two() {
      var out = [];
      pointers.forEach(function (p) { out.push(p); });
      return out;
    }

    canvas.addEventListener('pointerdown', function (ev) {
      try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* pointer already gone */ }
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (pointers.size === 1) {
        single = { x: ev.clientX, y: ev.clientY, button: ev.button, shift: ev.shiftKey };
      } else if (pointers.size === 2) {
        var p = two();
        pinch = {
          mx: (p[0].x + p[1].x) / 2, my: (p[0].y + p[1].y) / 2,
          // Measured from where the gesture began: a browser delivers one move
          // per finger, so halfway through a two-finger drag only one of them
          // has moved and the distance between them is wrong by a whole step.
          startDist: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y),
          startRadius: self.spherical.radius
        };
      }
    });

    canvas.addEventListener('pointermove', function (ev) {
      if (!pointers.has(ev.pointerId)) return;
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (pointers.size === 1 && single) {
        var dx = ev.clientX - single.x, dy = ev.clientY - single.y;
        if (single.button === 2 || single.shift) self.panBy(dx, dy);
        else {
          self.spherical.theta -= dx * 0.008;
          self.spherical.phi -= dy * 0.008;
          self.updateCamera();
        }
        single.x = ev.clientX; single.y = ev.clientY;
      } else if (pointers.size === 2 && pinch) {
        var p = two();
        var dist = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
        var mx = (p[0].x + p[1].x) / 2, my = (p[0].y + p[1].y) / 2;
        if (pinch.startDist > 0 && dist > 0) {
          self.spherical.radius = pinch.startRadius * (pinch.startDist / dist);
        }
        self.panBy(mx - pinch.mx, my - pinch.my, pinch.startRadius);
        pinch.mx = mx; pinch.my = my;
        self.updateCamera();
      }
      ev.preventDefault();
    });

    function end(ev) {
      pointers.delete(ev.pointerId);
      if (pointers.size < 2) pinch = null;
      if (pointers.size === 0) single = null;
    }
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });
    canvas.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      self.spherical.radius *= ev.deltaY > 0 ? 1.12 : 0.89;
      self.updateCamera();
    }, { passive: false });
  }

  root.PrismaticViewer = Viewer;
})(typeof globalThis !== 'undefined' ? globalThis : window);
