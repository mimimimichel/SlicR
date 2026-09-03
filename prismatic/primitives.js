/**
 * Prismatic — recognising the shape a ring of facets came from.
 *
 * The prismatic rebuild gives back flat faces, which is the right answer for a
 * part made of flat faces and the wrong one for the bore through it: a hole
 * arrives as thirty-two little planes and leaves as thirty-two little planes,
 * when what it is, and what it was drawn as, is one cylinder.
 *
 * So before writing anything out, the faces are looked at again in groups: are
 * these thirty-two planes all tangent to one cylinder? To one cone? Do they lie
 * on one sphere? If they do, they are not thirty-two faces. They are one.
 *
 * The fits are all least squares on the same observation — a facet's own plane,
 * n·p = d — which is worth saying because it is what makes them cheap and
 * comparable:
 *
 *   Sphere    every tangent plane is one radius from the centre, so
 *             n·c + k = d is linear in the centre and the radius, and k comes
 *             out signed: positive for a ball, negative for a hollow.
 *   Cylinder  the same, with the centre pinned to a plane across the axis —
 *             and the axis is the direction the normals never point in, which
 *             is the smallest eigenvector of their second moment.
 *   Cone      every tangent plane passes through the apex, so n·q = d is
 *             linear in the apex alone; the normals then sit on an offset
 *             plane whose distance from the origin is the sine of the half
 *             angle.
 *
 * Each of those accumulates: a group can take another facet in constant time
 * and be re-solved in constant time, which is what lets the groups be grown one
 * facet at a time without the cost turning quadratic.
 *
 * A fit is never believed on its residual alone. Whatever comes out is measured
 * against every vertex of the group — the real distance to the real surface —
 * and thrown away if it is worse than the tolerance the conversion was given.
 * A part keeps its flat faces rather than gaining a cylinder that is not there.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Enough linear algebra
  // ---------------------------------------------------------------------------

  /** Gaussian elimination with partial pivoting; n is 2, 3 or 4 here. */
  function solve(M, b, n) {
    var A = new Float64Array(n * (n + 1));
    for (var i = 0; i < n; i++) {
      for (var j = 0; j < n; j++) A[i * (n + 1) + j] = M[i * n + j];
      A[i * (n + 1) + n] = b[i];
    }
    for (var c = 0; c < n; c++) {
      var pivot = c;
      for (var p = c + 1; p < n; p++) {
        if (Math.abs(A[p * (n + 1) + c]) > Math.abs(A[pivot * (n + 1) + c])) pivot = p;
      }
      if (!(Math.abs(A[pivot * (n + 1) + c]) > 1e-12)) return null;
      if (pivot !== c) {
        for (var s = c; s <= n; s++) {
          var tmp = A[c * (n + 1) + s];
          A[c * (n + 1) + s] = A[pivot * (n + 1) + s];
          A[pivot * (n + 1) + s] = tmp;
        }
      }
      for (var row = c + 1; row < n; row++) {
        var f = A[row * (n + 1) + c] / A[c * (n + 1) + c];
        if (!f) continue;
        for (var col = c; col <= n; col++) A[row * (n + 1) + col] -= f * A[c * (n + 1) + col];
      }
    }
    var out = new Float64Array(n);
    for (var k = n - 1; k >= 0; k--) {
      var sum = A[k * (n + 1) + n];
      for (var q = k + 1; q < n; q++) sum -= A[k * (n + 1) + q] * out[q];
      out[k] = sum / A[k * (n + 1) + k];
      if (!isFinite(out[k])) return null;
    }
    return out;
  }

  /**
   * Eigenvalues and eigenvectors of a symmetric 3x3, by Jacobi rotations.
   * Returned smallest first, which is the one that gets asked for: the
   * direction a set of normals has least of is the axis they turn about.
   */
  function eigen3(m) {
    var a = new Float64Array(m);
    var v = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    for (var sweep = 0; sweep < 32; sweep++) {
      var off = a[1] * a[1] + a[2] * a[2] + a[5] * a[5];
      if (off < 1e-30) break;
      for (var p = 0; p < 2; p++) {
        for (var q = p + 1; q < 3; q++) {
          var apq = a[p * 3 + q];
          if (Math.abs(apq) < 1e-300) continue;
          var app = a[p * 3 + p], aqq = a[q * 3 + q];
          var theta = (aqq - app) / (2 * apq);
          var t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
          var c = 1 / Math.sqrt(t * t + 1), s = t * c;
          for (var k = 0; k < 3; k++) {
            var akp = a[k * 3 + p], akq = a[k * 3 + q];
            a[k * 3 + p] = c * akp - s * akq;
            a[k * 3 + q] = s * akp + c * akq;
          }
          for (var k2 = 0; k2 < 3; k2++) {
            var apk = a[p * 3 + k2], aqk = a[q * 3 + k2];
            a[p * 3 + k2] = c * apk - s * aqk;
            a[q * 3 + k2] = s * apk + c * aqk;
            var vkp = v[k2 * 3 + p], vkq = v[k2 * 3 + q];
            v[k2 * 3 + p] = c * vkp - s * vkq;
            v[k2 * 3 + q] = s * vkp + c * vkq;
          }
        }
      }
    }
    var order = [0, 1, 2].sort(function (x, y) { return a[x * 3 + x] - a[y * 3 + y]; });
    return {
      values: order.map(function (i) { return a[i * 3 + i]; }),
      vectors: order.map(function (i) { return [v[i], v[3 + i], v[6 + i]]; })
    };
  }

  function norm(v) {
    var len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    return len > 0 ? [v[0] / len, v[1] / len, v[2] / len] : null;
  }
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

  /** Any unit vector across the given one. */
  function across(a) {
    var pick = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    return norm(cross(a, pick));
  }

  // ---------------------------------------------------------------------------
  // A group of facets, and what it might be
  // ---------------------------------------------------------------------------

  function Group() {
    this.weight = 0;
    this.sn = [0, 0, 0];              // sum of w n
    this.nn = new Float64Array(9);    // sum of w n n'
    this.dn = [0, 0, 0];              // sum of w d n
    this.sd = 0;                      // sum of w d
    this.m4 = new Float64Array(16);   // sum of w [n,1][n,1]'
    this.b4 = new Float64Array(4);    // sum of w d [n,1]
    this.faces = [];
  }

  /** One more tangent plane, weighted by how much surface it speaks for. */
  Group.prototype.add = function (n, d, w, face) {
    this.weight += w;
    this.sd += w * d;
    var e = [n[0], n[1], n[2], 1];
    for (var i = 0; i < 3; i++) {
      this.sn[i] += w * n[i];
      this.dn[i] += w * d * n[i];
      for (var j = 0; j < 3; j++) this.nn[i * 3 + j] += w * n[i] * n[j];
    }
    for (var a = 0; a < 4; a++) {
      this.b4[a] += w * d * e[a];
      for (var b = 0; b < 4; b++) this.m4[a * 4 + b] += w * e[a] * e[b];
    }
    if (face !== undefined) this.faces.push(face);
  };

  Group.prototype.copy = function () {
    var g = new Group();
    g.weight = this.weight;
    g.sn = this.sn.slice();
    g.nn = new Float64Array(this.nn);
    g.dn = this.dn.slice();
    g.sd = this.sd;
    g.m4 = new Float64Array(this.m4);
    g.b4 = new Float64Array(this.b4);
    g.faces = this.faces.slice();
    return g;
  };

  /**
   * The axis a set of normals turns about, and how far off that they are. For a
   * cylinder the normals lie in a plane through the origin; for a cone, in one
   * held off it by the sine of the half angle.
   */
  function axisOf(g, centred) {
    if (!(g.weight > 0)) return null;
    var m = new Float64Array(g.nn);
    var mean = [g.sn[0] / g.weight, g.sn[1] / g.weight, g.sn[2] / g.weight];
    if (centred) {
      for (var i = 0; i < 3; i++) {
        for (var j = 0; j < 3; j++) m[i * 3 + j] -= g.weight * mean[i] * mean[j];
      }
    }
    var e = eigen3(m);
    var axis = norm(e.vectors[0]);
    if (!axis) return null;
    return { axis: axis, spread: Math.sqrt(Math.max(0, e.values[0]) / g.weight), mean: mean };
  }

  /** A cylinder: axis from the normals, then centre and radius from the planes. */
  function fitCylinder(g) {
    var found = axisOf(g, false);
    if (!found) return null;
    var a = found.axis;
    var u = across(a);
    if (!u) return null;
    var v = cross(a, u);

    // The centre is pinned to the plane across the axis, so the unknowns are
    // where it sits in (u, v) and the radius.
    function nnDot(x, y) {
      var s = 0;
      for (var i = 0; i < 3; i++) for (var j = 0; j < 3; j++) s += x[i] * g.nn[i * 3 + j] * y[j];
      return s;
    }
    var M = [
      nnDot(u, u), nnDot(u, v), dot(u, g.sn),
      nnDot(v, u), nnDot(v, v), dot(v, g.sn),
      dot(u, g.sn), dot(v, g.sn), g.weight
    ];
    var b = [dot(u, g.dn), dot(v, g.dn), g.sd];
    var x = solve(M, b, 3);
    if (!x || !(Math.abs(x[2]) > 1e-9)) return null;
    return {
      type: 'cylinder',
      axis: a,
      point: [u[0] * x[0] + v[0] * x[1], u[1] * x[0] + v[1] * x[1], u[2] * x[0] + v[2] * x[1]],
      radius: Math.abs(x[2]),
      // The sign of the radius that came out says which side the material is
      // on: a shaft has its normals pointing away from the axis, a bore has
      // them pointing at it.
      outward: x[2] > 0
    };
  }

  /** A sphere: centre and radius straight out of the tangent planes. */
  function fitSphere(g) {
    var x = solve(g.m4, g.b4, 4);
    if (!x || !(Math.abs(x[3]) > 1e-9)) return null;
    return {
      type: 'sphere',
      centre: [x[0], x[1], x[2]],
      radius: Math.abs(x[3]),
      outward: x[3] > 0
    };
  }

  /**
   * A cone: the apex is the one point every tangent plane passes through, and
   * the half angle is how far off the axis the normals lean.
   *
   * Which way along that axis the cone opens is not something the normals can
   * say — the same set of normals describes a cone of material and the hollow
   * countersunk into it, and those open opposite ways. The points settle it:
   * the cone is the side of the apex they are on. Once that is fixed, the sign
   * of the normals' lean says which of the two it is.
   */
  function fitCone(g, points) {
    var q = solve(g.nn, g.dn, 3);
    if (!q) return null;
    var found = axisOf(g, true);
    if (!found) return null;
    var a = found.axis;

    var reach = 0;
    for (var i = 0; i < points.length; i++) {
      reach += (points[i][0] - q[0]) * a[0] + (points[i][1] - q[1]) * a[1] + (points[i][2] - q[2]) * a[2];
    }
    if (reach < 0) a = [-a[0], -a[1], -a[2]];
    if (!points.length) return null;

    var lean = dot(found.mean, a);
    var sine = Math.abs(lean);
    // Too shallow and it is a cylinder; too steep and it is a plane through the
    // apex. Neither is a cone worth writing down as one.
    if (!(sine > 0.02 && sine < 0.999)) return null;
    return {
      type: 'cone',
      apex: [q[0], q[1], q[2]],
      // Pointing the way the cone opens out, which is what STEP wants of it.
      axis: a,
      halfAngle: Math.asin(Math.min(1, sine)),
      // Material inside the cone leans its normals away from the opening.
      outward: lean < 0
    };
  }

  // ---------------------------------------------------------------------------
  // Refitting to the points
  // ---------------------------------------------------------------------------

  /**
   * The tangent planes say what kind of surface this is and which way its axis
   * runs, and they are the right thing to ask: a facet's normal is reliable and
   * accumulates. What they cannot say is how big it is. A facet of a cylinder
   * is a chord, and a chord lies inside the circle it cuts — fit the radius to
   * the facet planes of a thirty-two sided bore and it comes out 5.971 when the
   * hole is 6, which is the inscribed radius of the polygon rather than the
   * radius of the hole.
   *
   * That is not a rounding error, it is the wrong answer, and it shows up as a
   * solid whose edges do not lie on its own faces. So once the kind and the
   * axis are known, the size and position are fitted again to the vertices —
   * which are on the surface, being where the mesh actually touched it.
   */
  function refine(s, points) {
    if (!points || points.length < 4) return s;
    if (s.type === 'sphere') return refineSphere(s, points);
    if (s.type === 'cylinder') return refineCylinder(s, points);
    if (s.type === 'cone') return refineCone(s, points);
    return s;
  }

  /** Kasa's circle, in whatever plane it is handed. */
  function circleThrough(flat) {
    var M = new Float64Array(9), b = new Float64Array(3);
    for (var i = 0; i < flat.length; i++) {
      var row = [2 * flat[i][0], 2 * flat[i][1], 1];
      var rhs = flat[i][0] * flat[i][0] + flat[i][1] * flat[i][1];
      for (var p = 0; p < 3; p++) {
        b[p] += row[p] * rhs;
        for (var q = 0; q < 3; q++) M[p * 3 + q] += row[p] * row[q];
      }
    }
    var x = solve(M, b, 3);
    if (!x) return null;
    var r2 = x[2] + x[0] * x[0] + x[1] * x[1];
    if (!(r2 > 1e-12)) return null;
    return { x: x[0], y: x[1], radius: Math.sqrt(r2) };
  }

  function refineCylinder(s, points) {
    var a = s.axis, u = across(a);
    if (!u) return s;
    var v = cross(a, u);
    var flat = points.map(function (p) { return [dot(p, u), dot(p, v)]; });
    var circle = circleThrough(flat);
    if (!circle) return s;
    return {
      type: 'cylinder',
      axis: a,
      point: [u[0] * circle.x + v[0] * circle.y, u[1] * circle.x + v[1] * circle.y,
              u[2] * circle.x + v[2] * circle.y],
      radius: circle.radius,
      outward: s.outward
    };
  }

  function refineSphere(s, points) {
    var M = new Float64Array(16), b = new Float64Array(4);
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      var row = [2 * p[0], 2 * p[1], 2 * p[2], 1];
      var rhs = p[0] * p[0] + p[1] * p[1] + p[2] * p[2];
      for (var x = 0; x < 4; x++) {
        b[x] += row[x] * rhs;
        for (var y = 0; y < 4; y++) M[x * 4 + y] += row[x] * row[y];
      }
    }
    var sol = solve(M, b, 4);
    if (!sol) return s;
    var r2 = sol[3] + sol[0] * sol[0] + sol[1] * sol[1] + sol[2] * sol[2];
    if (!(r2 > 1e-12)) return s;
    return {
      type: 'sphere',
      centre: [sol[0], sol[1], sol[2]],
      radius: Math.sqrt(r2),
      outward: s.outward
    };
  }

  /**
   * The apex slides along the axis and the half angle opens, both fitted as one
   * straight line through the points measured as (how far along, how far out) —
   * which is what a cone is, turned about its axis.
   */
  function refineCone(s, points) {
    var a = s.axis;
    var sums = { n: 0, t: 0, m: 0, tt: 0, tm: 0 };
    for (var i = 0; i < points.length; i++) {
      var w = [points[i][0] - s.apex[0], points[i][1] - s.apex[1], points[i][2] - s.apex[2]];
      var t = dot(w, a);
      var rx = w[0] - t * a[0], ry = w[1] - t * a[1], rz = w[2] - t * a[2];
      var m = Math.sqrt(rx * rx + ry * ry + rz * rz);
      sums.n++; sums.t += t; sums.m += m; sums.tt += t * t; sums.tm += t * m;
    }
    var det = sums.n * sums.tt - sums.t * sums.t;
    if (!(Math.abs(det) > 1e-12)) return s;
    var slope = (sums.n * sums.tm - sums.t * sums.m) / det;
    var offset = (sums.tt * sums.m - sums.t * sums.tm) / det;
    if (!(slope > 1e-6)) return s;
    var shift = -offset / slope;      // where the radius reaches zero
    return {
      type: 'cone',
      apex: [s.apex[0] + a[0] * shift, s.apex[1] + a[1] * shift, s.apex[2] + a[2] * shift],
      axis: a,
      halfAngle: Math.atan(slope),
      outward: s.outward
    };
  }

  /**
   * Which way the surface faces at a point, material outward. Nothing to say
   * on the axis of a cylinder or at the centre of a sphere, where there is no
   * direction to give.
   */
  function normalAt(s, p) {
    if (s.type === 'plane') return [s.x, s.y, s.z];
    if (s.type === 'sphere') {
      var out = unit([p[0] - s.centre[0], p[1] - s.centre[1], p[2] - s.centre[2]]);
      return out && s.outward ? out : (out ? [-out[0], -out[1], -out[2]] : null);
    }
    if (s.type === 'cylinder' || s.type === 'cone') {
      var base = s.type === 'cylinder' ? s.point : s.apex;
      var w = [p[0] - base[0], p[1] - base[1], p[2] - base[2]];
      var along = dot(w, s.axis);
      var radial = unit([w[0] - along * s.axis[0], w[1] - along * s.axis[1], w[2] - along * s.axis[2]]);
      if (!radial) return null;
      var n = s.type === 'cylinder'
        ? radial
        // A cone's normal leans back from its opening by the half angle.
        : unit([
            radial[0] * Math.cos(s.halfAngle) - s.axis[0] * Math.sin(s.halfAngle),
            radial[1] * Math.cos(s.halfAngle) - s.axis[1] * Math.sin(s.halfAngle),
            radial[2] * Math.cos(s.halfAngle) - s.axis[2] * Math.sin(s.halfAngle)
          ]);
      if (!n) return null;
      return s.outward ? n : [-n[0], -n[1], -n[2]];
    }
    return null;
  }

  function unit(v) {
    var len = Math.sqrt(dot(v, v));
    return len > 0 ? [v[0] / len, v[1] / len, v[2] / len] : null;
  }

  /**
   * Does a flat face lie along this surface, or does it merely touch it?
   *
   * The corners of a cylinder's end cap are every one of them exactly on the
   * cylinder — they are the rim — and a test that only asks where the points
   * are will swallow the cap into the bore. What separates them is which way
   * they face: the cap faces along the axis, the bore across it.
   */
  function tangent(s, normal, points, cosTol) {
    var mid = [0, 0, 0];
    for (var i = 0; i < points.length; i++) {
      mid[0] += points[i][0] / points.length;
      mid[1] += points[i][1] / points.length;
      mid[2] += points[i][2] / points.length;
    }
    var want = normalAt(s, mid);
    if (!want) return false;
    return dot(normal, want) >= cosTol;
  }

  /** How far the furthest of these points sits from the surface. */
  function deviation(surface, points, at) {
    var worst = 0;
    for (var i = 0; i < points.length; i++) {
      var p = at ? at(points[i]) : points[i];
      var gap = distance(surface, p);
      if (!isFinite(gap)) return Infinity;
      if (gap > worst) worst = gap;
    }
    return worst;
  }

  function distance(s, p) {
    if (s.type === 'sphere') {
      var dx = p[0] - s.centre[0], dy = p[1] - s.centre[1], dz = p[2] - s.centre[2];
      return Math.abs(Math.sqrt(dx * dx + dy * dy + dz * dz) - s.radius);
    }
    if (s.type === 'cylinder') {
      var wx = p[0] - s.point[0], wy = p[1] - s.point[1], wz = p[2] - s.point[2];
      var t = wx * s.axis[0] + wy * s.axis[1] + wz * s.axis[2];
      var rx = wx - t * s.axis[0], ry = wy - t * s.axis[1], rz = wz - t * s.axis[2];
      return Math.abs(Math.sqrt(rx * rx + ry * ry + rz * rz) - s.radius);
    }
    if (s.type === 'cone') {
      var ax = p[0] - s.apex[0], ay = p[1] - s.apex[1], az = p[2] - s.apex[2];
      var along = ax * s.axis[0] + ay * s.axis[1] + az * s.axis[2];
      var px = ax - along * s.axis[0], py = ay - along * s.axis[1], pz = az - along * s.axis[2];
      var radial = Math.sqrt(px * px + py * py + pz * pz);
      // Perpendicular distance to the generating line, in the plane through
      // the axis and the point.
      if (along <= 0) return Math.sqrt(along * along + radial * radial);
      return Math.abs(radial * Math.cos(s.halfAngle) - along * Math.sin(s.halfAngle));
    }
    if (s.type === 'plane') {
      return Math.abs(p[0] * s.x + p[1] * s.y + p[2] * s.z - s.d);
    }
    return Infinity;
  }

  /**
   * The best surface this group of facets could be, or nothing. All three are
   * tried and measured against the same points rather than trusting whichever
   * the normals looked most like: a shallow cone and a cylinder are hard to
   * tell apart from the normals alone and easy to tell apart from the answer.
   */
  function fit(group, points, tolerance, on) {
    // Two different sets of points, for two different questions. The surface is
    // sized on the ones that are known to be on it — the mesh's own vertices,
    // which are where it touched the surface — and then judged on everything,
    // the middles of the facets included, which are not on it and are where a
    // wrong answer shows.
    var seats = on || points;
    var tries = [fitCylinder(group), fitCone(group, seats), fitSphere(group)];
    var best = null, bestGap = Infinity;
    for (var i = 0; i < tries.length; i++) {
      var s = tries[i];
      if (!s) continue;
      s = refine(s, seats);
      if (!s) continue;
      if (!(s.radius === undefined || s.radius > 1e-6)) continue;
      var gap = deviation(s, points);
      if (gap <= tolerance && gap < bestGap) { best = s; bestGap = gap; }
    }
    if (best) best.deviation = bestGap;
    return best;
  }

  // ---------------------------------------------------------------------------
  // Circles, for the edges where those surfaces end
  // ---------------------------------------------------------------------------

  /**
   * The circle through a chain of points, if there is one. Three points fix a
   * circle; the rest have to agree with it, and the plane they all lie in has
   * to be one plane.
   *
   * The direction the chain travels sets which way the circle turns, because
   * that is the whole of what an edge's orientation means once its geometry is
   * a circle rather than a list of points.
   */
  function fitArc(points, tolerance) {
    var n = points.length;
    if (n < 3) return null;

    // The plane, by Newell over the chain closed back on itself: exact when the
    // points are coplanar and stable when they are not quite.
    var nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0;
    for (var i = 0; i < n; i++) {
      var a = points[i], b = points[(i + 1) % n];
      nx += (a[1] - b[1]) * (a[2] + b[2]);
      ny += (a[2] - b[2]) * (a[0] + b[0]);
      nz += (a[0] - b[0]) * (a[1] + b[1]);
      cx += a[0]; cy += a[1]; cz += a[2];
    }
    var axis = norm([nx, ny, nz]);
    if (!axis) return null;
    var mid = [cx / n, cy / n, cz / n];

    var u = across(axis);
    if (!u) return null;
    var v = cross(axis, u);
    var flat = new Array(n);
    for (var k = 0; k < n; k++) {
      var w = [points[k][0] - mid[0], points[k][1] - mid[1], points[k][2] - mid[2]];
      var off = dot(w, axis);
      if (Math.abs(off) > tolerance) return null;      // not one plane
      flat[k] = [dot(w, u), dot(w, v)];
    }

    // Kasa's circle: linear once the equation is written as
    // 2x*cx + 2y*cy + (r^2 - |c|^2) = x^2 + y^2.
    var M = new Float64Array(9), b2 = new Float64Array(3);
    for (var m = 0; m < n; m++) {
      var row = [2 * flat[m][0], 2 * flat[m][1], 1];
      var rhs = flat[m][0] * flat[m][0] + flat[m][1] * flat[m][1];
      for (var p = 0; p < 3; p++) {
        b2[p] += row[p] * rhs;
        for (var q = 0; q < 3; q++) M[p * 3 + q] += row[p] * row[q];
      }
    }
    var x = solve(M, b2, 3);
    if (!x) return null;
    var r2 = x[2] + x[0] * x[0] + x[1] * x[1];
    if (!(r2 > 1e-12)) return null;
    var radius = Math.sqrt(r2);

    var centre = [
      mid[0] + u[0] * x[0] + v[0] * x[1],
      mid[1] + u[1] * x[0] + v[1] * x[1],
      mid[2] + u[2] * x[0] + v[2] * x[1]
    ];
    for (var t = 0; t < n; t++) {
      var dx = points[t][0] - centre[0], dy = points[t][1] - centre[1], dz = points[t][2] - centre[2];
      if (Math.abs(Math.sqrt(dx * dx + dy * dy + dz * dz) - radius) > tolerance) return null;
    }

    // Which way round. The chain's own turning decides it, so that an edge
    // walked from its first point to its last runs forwards along the circle.
    var turn = 0;
    for (var s = 0; s < n - 1; s++) {
      var p0 = [points[s][0] - centre[0], points[s][1] - centre[1], points[s][2] - centre[2]];
      var p1 = [points[s + 1][0] - centre[0], points[s + 1][1] - centre[1], points[s + 1][2] - centre[2]];
      turn += dot(cross(p0, p1), axis);
    }
    if (turn < 0) axis = [-axis[0], -axis[1], -axis[2]];
    return { centre: centre, axis: axis, radius: radius };
  }

  root.PrismaticPrimitives = {
    Group: Group,
    fit: fit,
    fitCylinder: fitCylinder,
    fitCone: fitCone,
    fitSphere: fitSphere,
    fitArc: fitArc,
    refine: refine,
    normalAt: normalAt,
    tangent: tangent,
    distance: distance,
    deviation: deviation,
    eigen3: eigen3,
    solve: solve
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.PrismaticPrimitives;
})(typeof globalThis !== 'undefined' ? globalThis : window);
