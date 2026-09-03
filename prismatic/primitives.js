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
  function eigenSym(m, n) {
    var a = new Float64Array(m);
    var v = new Float64Array(n * n);
    for (var d = 0; d < n; d++) v[d * n + d] = 1;
    for (var sweep = 0; sweep < 64; sweep++) {
      var off = 0;
      for (var i = 0; i < n; i++) for (var j = i + 1; j < n; j++) off += a[i * n + j] * a[i * n + j];
      if (off < 1e-30) break;
      for (var p = 0; p < n - 1; p++) {
        for (var q = p + 1; q < n; q++) {
          var apq = a[p * n + q];
          if (Math.abs(apq) < 1e-300) continue;
          var theta = (a[q * n + q] - a[p * n + p]) / (2 * apq);
          var t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
          var c = 1 / Math.sqrt(t * t + 1), s = t * c;
          for (var k = 0; k < n; k++) {
            var akp = a[k * n + p], akq = a[k * n + q];
            a[k * n + p] = c * akp - s * akq;
            a[k * n + q] = s * akp + c * akq;
          }
          for (var k2 = 0; k2 < n; k2++) {
            var apk = a[p * n + k2], aqk = a[q * n + k2];
            a[p * n + k2] = c * apk - s * aqk;
            a[q * n + k2] = s * apk + c * aqk;
            var vkp = v[k2 * n + p], vkq = v[k2 * n + q];
            v[k2 * n + p] = c * vkp - s * vkq;
            v[k2 * n + q] = s * vkp + c * vkq;
          }
        }
      }
    }
    var order = [];
    for (var o = 0; o < n; o++) order.push(o);
    order.sort(function (x, y) { return a[x * n + x] - a[y * n + y]; });
    return {
      values: order.map(function (i) { return a[i * n + i]; }),
      vectors: order.map(function (i) {
        var out = [];
        for (var r = 0; r < n; r++) out.push(v[r * n + i]);
        return out;
      })
    };
  }

  function eigen3(m) { return eigenSym(m, 3); }

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
    this.m6 = new Float64Array(36);   // sum of w u u', u = [p x n, -n]
    this.seen = null;                 // one facet, kept for its side
    this.faces = [];
  }

  /**
   * One more tangent plane, weighted by how much surface it speaks for, and
   * with it the sixth-order moment that finds an axis.
   *
   * That last one is worth a word. Every surface made by turning something
   * about an axis — a cylinder, a cone, a sphere, a torus — has the property
   * that the normal at every point of it meets that axis. Written down, "the
   * line through p along n meets the line through q along a" is
   *
   *     (p x n).a - n.(a x q) = 0
   *
   * which is linear in a and in the moment a x q together. So the axis of
   * whatever this is falls out as the null direction of one six by six matrix,
   * accumulated a facet at a time like everything else here — and it is the
   * same matrix whatever kind of surface it turns out to be.
   */
  Group.prototype.add = function (n, d, w, face, at) {
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
    if (at) {
      // p only enters as p x n, which is the same for every point along the
      // normal, so where on it the facet was measured does not matter.
      var u = [
        at[1] * n[2] - at[2] * n[1],
        at[2] * n[0] - at[0] * n[2],
        at[0] * n[1] - at[1] * n[0],
        -n[0], -n[1], -n[2]
      ];
      for (var x = 0; x < 6; x++) {
        for (var y = 0; y < 6; y++) this.m6[x * 6 + y] += w * u[x] * u[y];
      }
      if (!this.seen || w > this.seen.w) this.seen = { p: at.slice(), n: n.slice(), w: w };
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
    g.m6 = new Float64Array(this.m6);
    g.seen = this.seen ? { p: this.seen.p.slice(), n: this.seen.n.slice(), w: this.seen.w } : null;
    g.faces = this.faces.slice();
    return g;
  };

  /**
   * The axis this thing was turned about, if it was turned about one: the
   * direction and moment that satisfy every normal at once.
   */
  function axisOfRevolution(g) {
    if (!(g.weight > 0)) return null;
    var e = eigenSym(g.m6, 6);
    var v = e.vectors[0];
    var a = [v[0], v[1], v[2]];
    var len = Math.sqrt(dot(a, a));
    if (!(len > 1e-6)) return null;          // no direction in it: a sphere, or a plane
    a = [a[0] / len, a[1] / len, a[2] / len];
    var b = [v[3] / len, v[4] / len, v[5] / len];
    // b is a x q with q across the axis, so q comes back as -(a x b).
    var q = cross(a, b);
    q = [-q[0], -q[1], -q[2]];
    var along = dot(q, a);
    return { axis: a, point: [q[0] - a[0] * along, q[1] - a[1] * along, q[2] - a[2] * along] };
  }

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

  /**
   * The axes a surface of revolution could be about.
   *
   * Two answers, because the usual one is not always the good one. The normals
   * of a cylinder lie in a plane through the origin, so the direction they have
   * least of is the axis — which is exact on a whole bore and useless on a band
   * a millimetre tall, where the normals barely lean at all and the direction
   * they have least of is noise. Where the normals *meet* is the other answer,
   * and it is the better one there: it uses where the facets are as well as
   * which way they face, and a shallow band pins it down perfectly well.
   *
   * Both are tried and whichever fits the points is kept. On a turned part
   * whose profile is not made of lines and circles — a sculpted bead, a barrel,
   * anything modelled by hand — this is the difference between the band coming
   * back as one cylinder and coming back as three hundred and seventy-eight
   * little planes.
   */
  function turningAxis(g) {
    var turned = axisOfRevolution(g);
    return turned ? turned.axis : null;
  }

  /** A cylinder: axis from the normals, then centre and radius from the planes. */
  function fitCylinder(g, axis) {
    var a = axis;
    if (!a) {
      var found = axisOf(g, false);
      if (!found) return null;
      a = found.axis;
    }
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
  function fitCone(g, points, axis) {
    var q = solve(g.nn, g.dn, 3);
    if (!q) return null;
    var found = axisOf(g, true);
    if (!found) return null;
    var a = axis || found.axis;

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
    // A torus is fitted to the points to begin with — the flat picture its axis
    // makes of them is where the circle came from — so there is nothing here
    // that is not already true of it.
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
    if (s.type === 'torus') {
      // Away from the ring the tube is wrapped around, which is where the
      // nearest point of that ring is.
      var w = [p[0] - s.centre[0], p[1] - s.centre[1], p[2] - s.centre[2]];
      var along = dot(w, s.axis);
      var radial = unit([w[0] - along * s.axis[0], w[1] - along * s.axis[1], w[2] - along * s.axis[2]]);
      if (!radial) return null;
      var spine = [
        s.centre[0] + radial[0] * s.major,
        s.centre[1] + radial[1] * s.major,
        s.centre[2] + radial[2] * s.major
      ];
      var out = unit([p[0] - spine[0], p[1] - spine[1], p[2] - spine[2]]);
      if (!out) return null;
      return s.outward ? out : [-out[0], -out[1], -out[2]];
    }
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
  function tangent(s, normal, points, cosTol, tolerance) {
    var want = facing(s, points);
    if (!want) return false;
    return along(normal, want, dot(normal, want), points, cosTol, tolerance);
  }

  /**
   * The same question with the sign left out: does this face lie along the
   * surface, whichever way round it happens to be written? A rebuild can leave
   * a sliver facing backwards where the surface turns over, and a sliver facing
   * backwards is still on the surface.
   */
  function alongside(s, normal, points, cosTol, tolerance) {
    var want = facing(s, points);
    if (!want) return false;
    var agree = dot(normal, want);
    var side = agree < 0 ? [-normal[0], -normal[1], -normal[2]] : normal;
    return along(side, want, Math.abs(agree), points, cosTol, tolerance);
  }

  /**
   * How square a face may sit to the surface it is on, which depends on how far
   * it reaches the way it is tilted.
   *
   * The question this asks is whether the face lies along the surface or cuts
   * across it, and the reason for asking is the flat end of a cylinder: every
   * corner of it is on the cylinder, because the rim is where the two meet, so
   * nothing but the direction it faces says it is not part of the bore.
   *
   * A fixed angle is the wrong way to ask it. On a part modelled by hand the
   * facets of one smooth band scatter by thirty-odd degrees, and most of them
   * are slivers: long the way the band runs, and a few hundredths of a
   * millimetre across the way they lean. Tilted thirty degrees over four
   * hundredths of a millimetre, a sliver stands a hundredth of a millimetre off
   * the surface — it is on the surface, and refusing it leaves the band in
   * three hundred and seventy-eight pieces, which is what the report was. The
   * same tilt on the end cap of a cylinder is measured across the whole cap and
   * comes to millimetres, and that one really does cut across.
   *
   * So the reach is measured along the one direction that matters — the one the
   * face and the surface part company in, which is across their common line —
   * and the face is kept if what it opens up over that reach is inside the
   * tolerance. Never less than the angle asked for, which is what a face big
   * enough to be judged on its direction alone still gets.
   */
  function along(normal, want, agree, points, cosTol, tolerance) {
    if (agree >= cosTol) return true;
    if (!(tolerance > 0) || !(agree > 0)) return false;
    // The steepest way out of the face's own plane, towards the surface.
    var e = norm([
      want[0] - agree * normal[0],
      want[1] - agree * normal[1],
      want[2] - agree * normal[2]
    ]);
    if (!e) return true;
    var lo = Infinity, hi = -Infinity;
    for (var i = 0; i < points.length; i++) {
      var t = dot(points[i], e);
      if (t < lo) lo = t;
      if (t > hi) hi = t;
    }
    return (hi - lo) / 2 * Math.sqrt(Math.max(0, 1 - agree * agree)) <= tolerance;
  }

  function facing(s, points) {
    var mid = [0, 0, 0];
    for (var i = 0; i < points.length; i++) {
      mid[0] += points[i][0] / points.length;
      mid[1] += points[i][1] / points.length;
      mid[2] += points[i][2] / points.length;
    }
    return normalAt(s, mid);
  }

  /**
   * A doughnut, and the inside of every fillet ever cut.
   *
   * Once the axis is known a torus is a circle again: measure each point by how
   * far it is along the axis and how far out from it, and in that flat picture
   * the whole surface collapses to one circle — the tube's own section, sitting
   * at the major radius. Fit that circle and there is nothing left to find.
   *
   * A ring torus is the only one worth writing down: when the circle comes back
   * bigger than its distance from the axis, what has been fitted is a shape
   * that passes through itself, which is never what anybody drew.
   */
  function fitTorus(g, points) {
    if (!points || points.length < 8) return null;
    var found = axisOfRevolution(g);
    if (!found) return null;
    var a = found.axis, q = found.point;

    var flat = new Array(points.length);
    for (var i = 0; i < points.length; i++) {
      var w = [points[i][0] - q[0], points[i][1] - q[1], points[i][2] - q[2]];
      var t = dot(w, a);
      var rx = w[0] - t * a[0], ry = w[1] - t * a[1], rz = w[2] - t * a[2];
      flat[i] = [Math.sqrt(rx * rx + ry * ry + rz * rz), t];
    }
    var circle = circleThrough(flat);
    if (!circle) return null;
    var major = circle.x, minor = circle.radius;
    if (!(minor > 1e-6) || !(major > minor * 1.02)) return null;

    var centre = [
      q[0] + a[0] * circle.y,
      q[1] + a[1] * circle.y,
      q[2] + a[2] * circle.y
    ];
    var torus = {
      type: 'torus', axis: a, centre: centre,
      major: major, minor: minor, radius: minor, outward: true
    };
    // Which side the material is on, from the one facet the group kept: a
    // doughnut faces away from the ring inside it, the fillet cut out of a
    // corner faces towards it.
    if (g.seen) {
      var out = normalAt(torus, g.seen.p);
      if (out && dot(out, g.seen.n) < 0) torus.outward = false;
    }
    return torus;
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

  /**
   * How far off the surface a point is, with a sign: positive on the side the
   * surface faces. It is what `distance` measures before it forgets which way,
   * and it is also, differentiated, the direction to move to get back on —
   * which is exactly `normalAt`. That pairing is the whole of `pull`.
   */
  function offset(s, p) {
    if (s.type === 'plane') return p[0] * s.x + p[1] * s.y + p[2] * s.z - s.d;
    if (s.type === 'sphere') {
      var dx = p[0] - s.centre[0], dy = p[1] - s.centre[1], dz = p[2] - s.centre[2];
      return Math.sqrt(dx * dx + dy * dy + dz * dz) - s.radius;
    }
    if (s.type === 'cylinder') {
      var wx = p[0] - s.point[0], wy = p[1] - s.point[1], wz = p[2] - s.point[2];
      var t = wx * s.axis[0] + wy * s.axis[1] + wz * s.axis[2];
      var rx = wx - t * s.axis[0], ry = wy - t * s.axis[1], rz = wz - t * s.axis[2];
      return Math.sqrt(rx * rx + ry * ry + rz * rz) - s.radius;
    }
    if (s.type === 'cone') {
      var ax = p[0] - s.apex[0], ay = p[1] - s.apex[1], az = p[2] - s.apex[2];
      var along = ax * s.axis[0] + ay * s.axis[1] + az * s.axis[2];
      var px = ax - along * s.axis[0], py = ay - along * s.axis[1], pz = az - along * s.axis[2];
      var radial = Math.sqrt(px * px + py * py + pz * pz);
      return radial * Math.cos(s.halfAngle) - along * Math.sin(s.halfAngle);
    }
    if (s.type === 'torus') {
      var tx = p[0] - s.centre[0], ty = p[1] - s.centre[1], tz = p[2] - s.centre[2];
      var t2 = tx * s.axis[0] + ty * s.axis[1] + tz * s.axis[2];
      var qx = tx - t2 * s.axis[0], qy = ty - t2 * s.axis[1], qz = tz - t2 * s.axis[2];
      var out = Math.sqrt(qx * qx + qy * qy + qz * qz) - s.major;
      return Math.sqrt(out * out + t2 * t2) - s.minor;
    }
    return NaN;
  }

  /**
   * A corner put back where the surfaces meeting there cross.
   *
   * The planar rebuild already does this with planes, and for the same reason:
   * a corner of the solid belongs to every face that meets at it, and in the
   * part it came from it sat where those faces cross. Once a ring of facets has
   * become one cylinder the corner has to move onto the cylinder, or the file
   * says the edge of a face is somewhere the face is not — which is what a
   * reader trips over, and what leaves a body that will not stitch.
   *
   * Curved surfaces do not cross in one step the way planes do, so it is
   * solved rather than crossed: each surface says how far off it the point is
   * and which way is back, and the step is the damped least-squares answer to
   * all of them at once, taken again until it stops improving. Damped, because
   * two faces meeting at a shallow angle leave a direction the surfaces say
   * nothing about, and an undamped solve will happily slide a corner a
   * millimetre along it to gain a hundredth. The smallest move that fixes what
   * can be fixed is the one wanted.
   */
  function pull(surfaces, p, limit) {
    var at = [p[0], p[1], p[2]];
    var best = at.slice(), bestGap = worstOf(surfaces, at);
    var damping = 1e-6;
    for (var step = 0; step < 16 && bestGap > 1e-12; step++) {
      var M = new Float64Array(9), b = [0, 0, 0], count = 0;
      for (var i = 0; i < surfaces.length; i++) {
        var f = offset(surfaces[i], at);
        var g = normalAt(surfaces[i], at);
        if (!g || !isFinite(f)) continue;
        for (var x = 0; x < 3; x++) {
          b[x] -= f * g[x];
          for (var y = 0; y < 3; y++) M[x * 3 + y] += g[x] * g[y];
        }
        count++;
      }
      if (!count) break;
      var damp = damping * count;
      M[0] += damp; M[4] += damp; M[8] += damp;
      var dx = solve(M, b, 3);
      if (!dx || !isFinite(dx[0]) || !isFinite(dx[1]) || !isFinite(dx[2])) break;
      var next = [at[0] + dx[0], at[1] + dx[1], at[2] + dx[2]];
      var now = worstOf(surfaces, next);
      if (now < bestGap) {
        bestGap = now; best = next; at = next;
        damping = Math.max(1e-9, damping * 0.3);
      } else {
        damping *= 8;
        at = best.slice();
        if (damping > 1e3) break;
      }
    }
    var mx = best[0] - p[0], my = best[1] - p[1], mz = best[2] - p[2];
    var travel = Math.sqrt(mx * mx + my * my + mz * mz);
    if (!isFinite(travel) || (limit > 0 && travel > limit)) return null;
    return best;
  }

  function worstOf(surfaces, p) {
    var worst = 0;
    for (var i = 0; i < surfaces.length; i++) {
      var f = Math.abs(offset(surfaces[i], p));
      if (!isFinite(f)) return Infinity;
      if (f > worst) worst = f;
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
    if (s.type === 'torus') {
      var wx = p[0] - s.centre[0], wy = p[1] - s.centre[1], wz = p[2] - s.centre[2];
      var t = wx * s.axis[0] + wy * s.axis[1] + wz * s.axis[2];
      var qx = wx - t * s.axis[0], qy = wy - t * s.axis[1], qz = wz - t * s.axis[2];
      var out = Math.sqrt(qx * qx + qy * qy + qz * qz) - s.major;
      return Math.abs(Math.sqrt(out * out + t * t) - s.minor);
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
  /**
   * The same, but only the kind of surface it already is. Once a seed has
   * settled what it is looking at, asking again whether it might be a sphere
   * on every face it grows into is two thirds of the work for an answer that
   * does not change — and it lets a long cylinder turn into a sphere halfway
   * along itself, which is not an improvement.
   */
  /** Every surface of this kind worth trying on this group. */
  function tries(kind, group, seats) {
    var out = [];
    if (kind === 'cylinder' || kind === 'cone') {
      // Its own axis first — the one the normals give, which is what each of
      // these was written around — and then the one the normals meet at, for
      // the shallow band where the first is noise.
      var own = kind === 'cylinder' ? fitCylinder(group) : fitCone(group, seats);
      if (own) out.push(own);
      var turned = turningAxis(group);
      if (turned && (!own || Math.abs(dot(turned, own.axis)) < 0.9999)) {
        var other = kind === 'cylinder' ? fitCylinder(group, turned)
          : fitCone(group, seats, turned);
        if (other) out.push(other);
      }
      return out;
    }
    var one = kind === 'sphere' ? fitSphere(group)
      : kind === 'torus' ? fitTorus(group, seats)
      : kind === 'plane' ? fitPlane(group, seats) : null;
    if (one) out.push(one);
    return out;
  }

  /** Sized and positioned against the points, then measured against them. */
  function settle(s, points, seats, tolerance) {
    if (s.type !== 'plane') {
      s = refine(s, seats);
      if (!s) return null;
      if (!(s.radius === undefined || s.radius > 1e-6)) return null;
    }
    var gap = deviation(s, points);
    if (gap > tolerance) return null;
    s.deviation = gap;
    return s;
  }

  function refit(kind, group, points, tolerance, on) {
    var seats = on || points;
    var made = tries(kind, group, seats);
    var best = null;
    for (var i = 0; i < made.length; i++) {
      var s = settle(made[i], points, seats, tolerance);
      if (s && (!best || s.deviation < best.deviation)) best = s;
    }
    return best;
  }

  /**
   * One plane through a group of facets, which is the answer far more often
   * than it looks.
   *
   * A patch that is nearly flat fits a cylinder of radius a hundred, a cone of
   * half angle eighty-six degrees and a doughnut of major radius two hundred
   * and sixty just as well as it fits its own plane, and every one of those is
   * a plane written by somebody who did not notice. Asked as a candidate like
   * any other, and preferred whenever it holds, the plane wins those — and it
   * is also how the gauge simplifies a flat wall that arrived as two hundred
   * facets, since nothing else in here would.
   *
   * Least squares through the corners: the direction they spread in least.
   */
  function fitPlane(g, points) {
    if (!points || points.length < 3) return null;
    var cx = 0, cy = 0, cz = 0, n = points.length;
    for (var i = 0; i < n; i++) { cx += points[i][0]; cy += points[i][1]; cz += points[i][2]; }
    cx /= n; cy /= n; cz /= n;
    var m = new Float64Array(9);
    for (var j = 0; j < n; j++) {
      var x = points[j][0] - cx, y = points[j][1] - cy, z = points[j][2] - cz;
      m[0] += x * x; m[1] += x * y; m[2] += x * z;
      m[4] += y * y; m[5] += y * z; m[8] += z * z;
    }
    m[3] = m[1]; m[6] = m[2]; m[7] = m[5];
    var e = eigen3(m);
    var a = norm(e.vectors[0]);
    if (!a) return null;
    // Facing the way the facets do, so that inside and outside keep their
    // meaning further down.
    if (dot(a, g.sn) < 0) a = [-a[0], -a[1], -a[2]];
    return { type: 'plane', x: a[0], y: a[1], z: a[2], d: a[0] * cx + a[1] * cy + a[2] * cz };
  }

  function fit(group, points, tolerance, on) {
    // Two different sets of points, for two different questions. The surface is
    // sized on the ones that are known to be on it — the mesh's own vertices,
    // which are where it touched the surface — and then judged on everything,
    // the middles of the facets included, which are not on it and are where a
    // wrong answer shows.
    var seats = on || points;
    var best = null;
    ['cylinder', 'cone', 'sphere', 'torus'].forEach(function (kind) {
      var made = tries(kind, group, seats);
      for (var i = 0; i < made.length; i++) {
        var s = settle(made[i], points, seats, tolerance);
        if (s && (!best || s.deviation < best.deviation)) best = s;
      }
    });
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

    // Through the points is not enough: between two of them the circle stands
    // off their chord by the sagitta, and that is a change to the part like any
    // other. Thirty-two points round a bore leave three hundredths of a
    // millimetre, which is the whole reason for doing this; four points round a
    // hole leave a quarter of the radius, and a circle drawn through those four
    // is not the hole, it is a circle that happens to touch its corners.
    for (var g = 0; g < n - 1; g++) {
      var ex = points[g + 1][0] - points[g][0];
      var ey = points[g + 1][1] - points[g][1];
      var ez = points[g + 1][2] - points[g][2];
      var half = Math.min(1, Math.sqrt(ex * ex + ey * ey + ez * ez) / (2 * radius));
      if (radius * (1 - Math.sqrt(1 - half * half)) > tolerance) return null;
    }

    // Which way round. The chain's own turning decides it, so that an edge
    // walked from its first point to its last runs forwards along the circle.
    var turn = 0, swept = 0;
    for (var s = 0; s < n - 1; s++) {
      var p0 = [points[s][0] - centre[0], points[s][1] - centre[1], points[s][2] - centre[2]];
      var p1 = [points[s + 1][0] - centre[0], points[s + 1][1] - centre[1], points[s + 1][2] - centre[2]];
      var turned = cross(p0, p1);
      turn += dot(turned, axis);
      swept += Math.atan2(dot(turned, axis), dot(p0, p1));
    }
    if (turn < 0) axis = [-axis[0], -axis[1], -axis[2]];

    // A chain that comes back to where it started is written as a whole circle,
    // and is then read as one: it has to go all the way round. Three points a
    // third of a millimetre apart and very nearly in a line come back to where
    // they started too, and the circle through them is six millimetres across
    // and passes nowhere near any of the part. Its chords are within tolerance
    // — of the three degrees of it they cover.
    var ax = points[0][0] - points[n - 1][0];
    var ay = points[0][1] - points[n - 1][1];
    var az = points[0][2] - points[n - 1][2];
    if (ax * ax + ay * ay + az * az < 1e-18 &&
        Math.abs(Math.abs(swept) - 2 * Math.PI) > 0.05) return null;

    return { centre: centre, axis: axis, radius: radius };
  }

  root.PrismaticPrimitives = {
    Group: Group,
    fit: fit,
    fitCylinder: fitCylinder,
    fitCone: fitCone,
    fitSphere: fitSphere,
    fitArc: fitArc,
    fitTorus: fitTorus,
    axisOfRevolution: axisOfRevolution,
    refit: refit,
    refine: refine,
    normalAt: normalAt,
    tangent: tangent,
    alongside: alongside,
    distance: distance,
    offset: offset,
    pull: pull,
    deviation: deviation,
    eigen3: eigen3,
    solve: solve
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.PrismaticPrimitives;
})(typeof globalThis !== 'undefined' ? globalThis : window);
