/**
 * Prismatic — writing the solid out as STEP.
 *
 * An STL is a bag of triangles, and every program that opens one has to guess
 * what the part was. A STEP file does not need guessing: it says here is a
 * point, here is an edge between two points, here is a plane, here is the face
 * bounded by those edges lying on that plane, and here is the closed shell all
 * those faces make. Fusion opens it as a solid body — faces you can click,
 * fillet, sketch on and extrude from — which is the whole reason to have
 * rebuilt the mesh into faces in the first place.
 *
 * Nothing here is a conversion. The faces, their surfaces and their loops all
 * come out of the rebuild and the recognition already; this walks them and
 * writes them down in ISO 10303-21, part 21 of the standard everyone calls
 * STEP. A face that was found to be a cylinder is written as a cylinder, and
 * the ring of thirty-two segments around the end of it as one circle — which
 * is the difference between a hole you can dimension and thirty-two faces you
 * cannot.
 *
 * Two things have to be right or the file is a pile of surfaces rather than a
 * solid, and both are structural rather than a matter of taste:
 *
 *   Edges are shared. One EDGE_CURVE between two points, used once by each of
 *   the two faces that meet along it, the second one traversing it backwards.
 *   A file with two coincident edges instead is a shell with a seam down it,
 *   and what comes into Fusion is a surface body that will not take a fillet.
 *
 *   Loops turn the right way. An outer boundary runs anticlockwise seen from
 *   outside the material, a hole runs the other way, and the face normal is
 *   the plane's own. Get one of them backwards and the solid is inside out.
 *
 * The bodies are separated too: a mesh holding three unconnected parts becomes
 * three solids in the file rather than one impossible one.
 */
(function (root) {
  'use strict';

  /**
   * A real, the way part 21 wants it: always a decimal point, never more
   * precision than a double actually carries.
   */
  function num(v) {
    if (!isFinite(v)) v = 0;
    if (v === 0) return '0.';
    var s = v.toPrecision(12);
    if (s.indexOf('e') >= 0) {
      var bits = s.split('e');
      var mantissa = bits[0].replace(/0+$/, '').replace(/\.$/, '');
      if (mantissa.indexOf('.') < 0) mantissa += '.';
      return mantissa + 'E' + bits[1];
    }
    if (s.indexOf('.') >= 0) {
      s = s.replace(/0+$/, '');
      if (s.charAt(s.length - 1) === '.') return s;
      return s;
    }
    return s + '.';
  }

  function text(s) {
    return "'" + String(s == null ? '' : s).replace(/'/g, "''").replace(/[^\x20-\x7e]/g, '_') + "'";
  }

  /**
   * Which faces are joined to which, through the edges they share. A mesh of
   * three loose parts has to leave here as three solids: one closed shell with
   * three separate skins in it is not a body anyone can open.
   */
  function components(faces, edgeFaces) {
    var parent = new Int32Array(faces.length);
    for (var i = 0; i < faces.length; i++) parent[i] = i;
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    edgeFaces.forEach(function (on) {
      if (on.length < 2) return;
      var a = find(on[0]), b = find(on[1]);
      if (a !== b) parent[b] = a;
    });
    var groups = new Map();
    for (var f = 0; f < faces.length; f++) {
      var root2 = find(f);
      var list = groups.get(root2);
      if (!list) { list = []; groups.set(root2, list); }
      list.push(f);
    }
    var out = [];
    groups.forEach(function (list) { out.push(list); });
    return out;
  }

  /**
   * What a set of faces encloses. Each one carries what it contributed while it
   * was still flat, which is the only moment the arithmetic is simple and is
   * enough for the one question asked of it here: a shell that comes out
   * negative is inside out, which makes it an enclosed cavity rather than a
   * body.
   */
  function volumeOf(brep, faces) {
    var total = 0;
    for (var i = 0; i < faces.length; i++) total += brep.faces[faces[i]].volume || 0;
    return total;
  }

  function unit(v) {
    var len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    return len > 0 ? [v[0] / len, v[1] / len, v[2] / len] : [0, 0, 1];
  }
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

  /** Any unit vector across the given one, for a placement's reference direction. */
  function across(a) {
    return unit(cross(a, Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
  }

  // ---------------------------------------------------------------------------

  /**
   * Write the solid. Returns the file and a note of what went into it, so the
   * app can say what it saved rather than only that it saved something.
   */
  function write(brep, options) {
    var o = options || {};
    var name = (o.name || 'part').replace(/\.(step|stp|stl|obj|3mf)$/i, '');

    // --- who meets whom -----------------------------------------------------
    // The edges arrive already shared: one entry for the edge, whichever way
    // round the two faces walk it. All that is wanted here is which two.
    var edgeFaces = brep.edges.map(function () { return []; });
    brep.faces.forEach(function (face, f) {
      face.loops.forEach(function (loop) {
        loop.forEach(function (step) {
          if (edgeFaces[step.edge].indexOf(f) < 0) edgeFaces[step.edge].push(f);
        });
      });
    });

    var loose = 0;
    edgeFaces.forEach(function (on) { if (on.length !== 2) loose++; });

    var parts = components(brep.faces, edgeFaces);
    var solids = [];
    var cavities = 0;
    var openShells = 0;
    parts.forEach(function (list) {
      var closed = true;
      var seen = new Set(list);
      edgeFaces.forEach(function (on) {
        if (!on.length || !seen.has(on[0])) return;
        if (on.length !== 2) closed = false;
      });
      var volume = closed ? volumeOf(brep, list) : 0;
      // A shell whose faces all point inwards is an enclosed cavity. It is a
      // body in its own right here, named as what it is, rather than written
      // as a solid of negative size.
      if (closed && volume < 0) cavities++;
      if (!closed) openShells++;
      solids.push({ faces: list, volume: volume, cavity: closed && volume < 0, closed: closed });
    });
    // A mesh with a hole in it is a surface, not a solid, and the file has to
    // say which. Written as a solid it would open as one and then refuse every
    // operation that needs an inside; written as surfaces it opens as what it
    // is, and stitching it is a job Fusion already knows how to offer.
    var solidFile = openShells === 0;

    // --- the file -----------------------------------------------------------
    var lines = [];
    var next = 1;
    function put(body) { lines.push('#' + next + '=' + body + ';'); return next++; }

    var used = new Map();          // vertex -> VERTEX_POINT id
    var directions = new Map();    // deduped, since a prismatic part has few

    function direction(x, y, z) {
      var key = num(x) + ',' + num(y) + ',' + num(z);
      var id = directions.get(key);
      if (id === undefined) {
        id = put("DIRECTION(''," + '(' + num(x) + ',' + num(y) + ',' + num(z) + '))');
        directions.set(key, id);
      }
      return id;
    }
    function point(x, y, z) {
      return put("CARTESIAN_POINT(''," + '(' + num(x) + ',' + num(y) + ',' + num(z) + '))');
    }
    function vertexOf(v) {
      var id = used.get(v);
      if (id === undefined) {
        id = put("VERTEX_POINT(''," + '#' + point(brep.vertices[v * 3], brep.vertices[v * 3 + 1], brep.vertices[v * 3 + 2]) + ')');
        used.set(v, id);
      }
      return id;
    }

    var stamp = new Date().toISOString().replace(/\.\d+Z$/, '');
    var head = [
      'ISO-10303-21;',
      'HEADER;',
      'FILE_DESCRIPTION((' + text('a prismatic solid rebuilt from a mesh') + "),'2;1');",
      'FILE_NAME(' + text(name + '.step') + ',' + text(stamp) + ',(' + text(o.author || '') + '),(' +
        text(o.organization || '') + '),' + text('Prismatic') + ',' + text('Prismatic') + ',' + text('') + ');',
      "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
      'ENDSEC;',
      'DATA;'
    ];

    var context = put("APPLICATION_CONTEXT('core data for automotive mechanical design processes')");
    put('APPLICATION_PROTOCOL_DEFINITION(' + text('international standard') + ',' +
      text('automotive_design') + ',2000,#' + context + ')');
    var productContext = put("PRODUCT_CONTEXT(''," + '#' + context + ',' + text('mechanical') + ')');
    var product = put('PRODUCT(' + text(name) + ',' + text(name) + ",'',(#" + productContext + '))');
    put('PRODUCT_RELATED_PRODUCT_CATEGORY(' + text('part') + ",$,(#" + product + '))');
    var formation = put("PRODUCT_DEFINITION_FORMATION('','',#" + product + ')');
    var definitionContext = put('PRODUCT_DEFINITION_CONTEXT(' + text('part definition') + ',#' +
      context + ',' + text('design') + ')');
    var definition = put('PRODUCT_DEFINITION(' + text('design') + ",'',#" + formation + ',#' + definitionContext + ')');
    var shape = put("PRODUCT_DEFINITION_SHAPE('','',#" + definition + ')');

    var lengthUnit = put('(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))');
    var angleUnit = put('(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))');
    var solidUnit = put('(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())');
    // What the file says about itself: how far apart two points have to be
    // before they are two points. On a body of flat faces this is the tolerance
    // of the arithmetic rather than of the part, since every vertex is put
    // exactly where its planes cross. A recognised cylinder is fitted rather
    // than solved, so it carries its own small slack, and the file has to own
    // up to whichever is larger.
    var tolerance = Math.min(1e-4, Math.max(1e-7, Math.max(brep.flatness || 0, brep.slack || 0) * 4));
    var uncertainty = put('UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(' + num(tolerance) + '),#' +
      lengthUnit + ',' + text('distance_accuracy_value') + ',' + text('confusion accuracy') + ')');
    var geometry = put('(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#' +
      uncertainty + '))GLOBAL_UNIT_ASSIGNED_CONTEXT((#' + lengthUnit + ',#' + angleUnit + ',#' +
      solidUnit + "))REPRESENTATION_CONTEXT('',''))");

    var origin = put("CARTESIAN_POINT('',(0.,0.,0.))");
    var world = put("AXIS2_PLACEMENT_3D(''," + '#' + origin + ',#' + direction(0, 0, 1) + ',#' + direction(1, 0, 0) + ')');

    // --- geometry -----------------------------------------------------------

    /** A placement is a point, the way its z points, and where its x starts. */
    function placement(at, axis, ref) {
      var x = ref || across(axis);
      return put("AXIS2_PLACEMENT_3D(''," + '#' + point(at[0], at[1], at[2]) +
        ',#' + direction(axis[0], axis[1], axis[2]) + ',#' + direction(x[0], x[1], x[2]) + ')');
    }

    brep.edges.forEach(function (edge) {
      var a = [brep.vertices[edge.a * 3], brep.vertices[edge.a * 3 + 1], brep.vertices[edge.a * 3 + 2]];
      var b = [brep.vertices[edge.b * 3], brep.vertices[edge.b * 3 + 1], brep.vertices[edge.b * 3 + 2]];
      var curve;
      if (edge.curve.type === 'circle') {
        var c = edge.curve;
        // Which way the circle's axis points is which way the edge runs along
        // it, and for a closed edge — a ring where one face meets another all
        // the way round, starting and ending at the same corner — it is the
        // only thing that says so.
        curve = put("CIRCLE(''," + '#' + placement(c.centre, c.axis) + ',' + num(c.radius) + ')');
      } else {
        var d = unit([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
        var along = put("VECTOR(''," + '#' + direction(d[0], d[1], d[2]) + ',1.)');
        curve = put("LINE(''," + '#' + point(a[0], a[1], a[2]) + ',#' + along + ')');
      }
      edge.id = put("EDGE_CURVE(''," + '#' + vertexOf(edge.a) + ',#' + vertexOf(edge.b) +
        ',#' + curve + ',.T.)');
    });

    var faceIds = new Array(brep.faces.length);
    brep.faces.forEach(function (face, f) {
      var s = face.surface;

      // A loop that goes all the way round a cylinder or a cone closes on the
      // surface's own seam rather than on anything of its own, so there is no
      // outer boundary to name — the face is the whole way round. A patch that
      // does not has one like any other face.
      var periodic = (s.type === 'cylinder' || s.type === 'cone' || s.type === 'sphere') &&
        face.loops.length > 1;

      var bounds = [];
      face.loops.forEach(function (loop, index) {
        var oriented = loop.map(function (step) {
          var edge = brep.edges[step.edge];
          return '#' + put("ORIENTED_EDGE('',*,*,#" + edge.id + ',' + (step.forward ? '.T.' : '.F.') + ')');
        });
        var loopId = put("EDGE_LOOP(''," + '(' + oriented.join(',') + '))');
        var kind = (!periodic && index === 0) ? 'FACE_OUTER_BOUND' : 'FACE_BOUND';
        bounds.push('#' + put(kind + "(''," + '#' + loopId + ',.T.)'));
      });

      var surfaceId, sense = true;
      if (s.type === 'cylinder') {
        surfaceId = put("CYLINDRICAL_SURFACE(''," + '#' + placement(s.point, s.axis) + ',' + num(s.radius) + ')');
        // The surface faces away from its axis. A shaft does too; a bore is the
        // same surface with the material on the other side of it.
        sense = s.outward;
      } else if (s.type === 'sphere') {
        surfaceId = put("SPHERICAL_SURFACE(''," + '#' + placement(s.centre, [0, 0, 1]) + ',' + num(s.radius) + ')');
        sense = s.outward;
      } else if (s.type === 'cone') {
        // Placed where the cone has a radius worth quoting rather than at the
        // apex, where it has none.
        var reach = 0;
        face.points.forEach(function (loop) {
          loop.forEach(function (v) {
            var t = (brep.vertices[v * 3] - s.apex[0]) * s.axis[0] +
                    (brep.vertices[v * 3 + 1] - s.apex[1]) * s.axis[1] +
                    (brep.vertices[v * 3 + 2] - s.apex[2]) * s.axis[2];
            if (t > reach) reach = t;
          });
        });
        var atRadius = Math.max(reach, 1e-3) * Math.tan(s.halfAngle);
        var seat = [
          s.apex[0] + s.axis[0] * Math.max(reach, 1e-3),
          s.apex[1] + s.axis[1] * Math.max(reach, 1e-3),
          s.apex[2] + s.axis[2] * Math.max(reach, 1e-3)
        ];
        surfaceId = put("CONICAL_SURFACE(''," + '#' + placement(seat, s.axis) + ',' +
          num(atRadius) + ',' + num(s.halfAngle) + ')');
        sense = s.outward;
      } else {
        surfaceId = put("PLANE(''," + '#' + placement([s.x * s.d, s.y * s.d, s.z * s.d], [s.x, s.y, s.z]) + ')');
      }

      faceIds[f] = put("ADVANCED_FACE(''," + '(' + bounds.join(',') + '),#' + surfaceId +
        ',' + (sense ? '.T.' : '.F.') + ')');
    });

    var items = ['#' + world];
    solids.forEach(function (solid, i) {
      var faceList = '(' + solid.faces.map(function (f) { return '#' + faceIds[f]; }).join(',') + ')';
      var label = solids.length === 1 ? name
        : name + ' ' + (solid.cavity ? 'cavity ' : 'body ') + (i + 1);
      if (solidFile) {
        var shell = put("CLOSED_SHELL(''," + faceList + ')');
        items.push('#' + put('MANIFOLD_SOLID_BREP(' + text(label) + ',#' + shell + ')'));
      } else {
        var open = put((solid.closed ? 'CLOSED_SHELL' : 'OPEN_SHELL') + "(''," + faceList + ')');
        items.push('#' + put('SHELL_BASED_SURFACE_MODEL(' + text(label) + ',(#' + open + '))'));
      }
    });

    var representation = put((solidFile ? 'ADVANCED_BREP_SHAPE_REPRESENTATION' : 'MANIFOLD_SURFACE_SHAPE_REPRESENTATION') +
      "(''," + '(' + items.join(',') + '),#' + geometry + ')');
    put('SHAPE_DEFINITION_REPRESENTATION(#' + shape + ',#' + representation + ')');

    var curves = { plane: 0, cylinder: 0, cone: 0, sphere: 0 };
    brep.faces.forEach(function (f) { curves[f.surface.type]++; });
    var circles = brep.edges.filter(function (e) { return e.curve.type === 'circle'; }).length;

    return {
      text: head.concat(lines).concat(['ENDSEC;', 'END-ISO-10303-21;', '']).join('\n'),
      faces: brep.faces.length,
      surfaces: curves,
      circles: circles,
      edges: brep.edges.length,
      vertices: used.size,
      bodies: solids.length,
      cavities: cavities,
      solid: solidFile,
      looseEdges: loose,
      volume: solids.reduce(function (a, s) { return a + s.volume; }, 0)
    };
  }

  root.PrismaticStep = { write: write, num: num };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.PrismaticStep;
})(typeof globalThis !== 'undefined' ? globalThis : window);
