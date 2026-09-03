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
 * Nothing here is a conversion. The faces, their planes and their loops all
 * come out of the rebuild already; this walks them and writes them down in
 * ISO 10303-21, part 21 of the standard everyone calls STEP.
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
  function components(faces, edges) {
    var parent = new Int32Array(faces.length);
    for (var i = 0; i < faces.length; i++) parent[i] = i;
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    edges.forEach(function (e) {
      if (e.faces.length < 2) return;
      var a = find(e.faces[0]), b = find(e.faces[1]);
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
   * The volume a set of planar faces encloses. On a plane every point has the
   * same distance to the origin along the normal, so the divergence theorem
   * collapses to a third of that distance times the area — no triangulating
   * anything. A shell that comes out negative is inside out: an enclosed
   * cavity, taken on its own.
   */
  function volumeOf(brep, faces) {
    var total = 0;
    for (var i = 0; i < faces.length; i++) {
      var face = brep.faces[faces[i]];
      total += face.d * areaOf(brep, face) / 3;
    }
    return total;
  }

  function basisOf(face) {
    var ax = Math.abs(face.x) < 0.9 ? 1 : 0, ay = 1 - ax;
    var ux = -face.z * ay, uy = face.z * ax, uz = face.x * ay - face.y * ax;
    var len = Math.sqrt(ux * ux + uy * uy + uz * uz);
    if (!(len > 0)) { ux = 1; uy = 0; uz = 0; len = 1; }
    ux /= len; uy /= len; uz /= len;
    return {
      ux: ux, uy: uy, uz: uz,
      vx: face.y * uz - face.z * uy, vy: face.z * ux - face.x * uz, vz: face.x * uy - face.y * ux
    };
  }

  /** Signed area in the face's own plane: the outline, less its holes. */
  function areaOf(brep, face) {
    var b = basisOf(face);
    var total = 0;
    for (var l = 0; l < face.loops.length; l++) {
      var loop = face.loops[l], sum = 0;
      for (var i = 0; i < loop.length; i++) {
        var a = loop[i] * 3, c = loop[(i + 1) % loop.length] * 3;
        var ax = brep.vertices[a] * b.ux + brep.vertices[a + 1] * b.uy + brep.vertices[a + 2] * b.uz;
        var ay = brep.vertices[a] * b.vx + brep.vertices[a + 1] * b.vy + brep.vertices[a + 2] * b.vz;
        var cx = brep.vertices[c] * b.ux + brep.vertices[c + 1] * b.uy + brep.vertices[c + 2] * b.uz;
        var cy = brep.vertices[c] * b.vx + brep.vertices[c + 1] * b.vy + brep.vertices[c + 2] * b.vz;
        sum += ax * cy - cx * ay;
      }
      total += sum / 2;
    }
    return total;
  }

  // ---------------------------------------------------------------------------

  /**
   * Write the solid. Returns the file and a note of what went into it, so the
   * app can say what it saved rather than only that it saved something.
   */
  function write(brep, options) {
    var o = options || {};
    var name = (o.name || 'part').replace(/\.(step|stp|stl|obj|3mf)$/i, '');
    var vertexCount = brep.vertices.length / 3;

    // --- the edges, each one shared by the two faces that meet along it ------
    var edges = new Map();
    var order = [];
    brep.faces.forEach(function (face, f) {
      face.loops.forEach(function (loop) {
        for (var i = 0; i < loop.length; i++) {
          var a = loop[i], b = loop[(i + 1) % loop.length];
          if (a === b) continue;
          var key = a < b ? a * vertexCount + b : b * vertexCount + a;
          var edge = edges.get(key);
          if (!edge) {
            edge = { a: a < b ? a : b, b: a < b ? b : a, faces: [] };
            edges.set(key, edge);
            order.push(edge);
          }
          if (edge.faces.indexOf(f) < 0) edge.faces.push(f);
        }
      });
    });

    var loose = 0;
    edges.forEach(function (e) { if (e.faces.length !== 2) loose++; });

    var parts = components(brep.faces, edges);
    var solids = [];
    var cavities = 0;
    var openShells = 0;
    parts.forEach(function (list) {
      var closed = true;
      var seen = new Set(list);
      edges.forEach(function (e) {
        if (!seen.has(e.faces[0])) return;
        if (e.faces.length !== 2) closed = false;
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
    // before they are two points. The rebuild puts every vertex on the corner
    // its planes cross at, so this is the tolerance of the arithmetic, not of
    // the part.
    var tolerance = Math.min(1e-4, Math.max(1e-7, (brep.flatness || 0) * 4));
    var uncertainty = put('UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(' + num(tolerance) + '),#' +
      lengthUnit + ',' + text('distance_accuracy_value') + ',' + text('confusion accuracy') + ')');
    var geometry = put('(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#' +
      uncertainty + '))GLOBAL_UNIT_ASSIGNED_CONTEXT((#' + lengthUnit + ',#' + angleUnit + ',#' +
      solidUnit + "))REPRESENTATION_CONTEXT('',''))");

    var origin = put("CARTESIAN_POINT('',(0.,0.,0.))");
    var world = put("AXIS2_PLACEMENT_3D(''," + '#' + origin + ',#' + direction(0, 0, 1) + ',#' + direction(1, 0, 0) + ')');

    // --- geometry -----------------------------------------------------------
    order.forEach(function (edge) {
      var a = edge.a * 3, b = edge.b * 3;
      var dx = brep.vertices[b] - brep.vertices[a];
      var dy = brep.vertices[b + 1] - brep.vertices[a + 1];
      var dz = brep.vertices[b + 2] - brep.vertices[a + 2];
      var len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      var va = vertexOf(edge.a), vb = vertexOf(edge.b);
      var from = point(brep.vertices[a], brep.vertices[a + 1], brep.vertices[a + 2]);
      var along = put("VECTOR(''," + '#' + direction(dx / len, dy / len, dz / len) + ',1.)');
      var line = put("LINE(''," + '#' + from + ',#' + along + ')');
      edge.id = put("EDGE_CURVE(''," + '#' + va + ',#' + vb + ',#' + line + ',.T.)');
    });

    var faceIds = new Array(brep.faces.length);
    brep.faces.forEach(function (face, f) {
      var bounds = [];
      face.loops.forEach(function (loop, index) {
        var oriented = [];
        for (var i = 0; i < loop.length; i++) {
          var a = loop[i], b = loop[(i + 1) % loop.length];
          if (a === b) continue;
          var key = a < b ? a * vertexCount + b : b * vertexCount + a;
          var edge = edges.get(key);
          // The edge was written once, from its lower-numbered end. A loop
          // running the other way down it says so rather than writing it twice.
          oriented.push('#' + put("ORIENTED_EDGE('',*,*,#" + edge.id + ',' + (edge.a === a ? '.T.' : '.F.') + ')'));
        }
        var loopId = put("EDGE_LOOP(''," + '(' + oriented.join(',') + '))');
        bounds.push('#' + put((index === 0 ? 'FACE_OUTER_BOUND' : 'FACE_BOUND') + "(''," + '#' + loopId + ',.T.)'));
      });

      // The plane, placed at the point of it nearest the origin, with the
      // face's own normal for its axis.
      var at = point(face.x * face.d, face.y * face.d, face.z * face.d);
      var b2 = basisOf(face);
      var placement = put("AXIS2_PLACEMENT_3D(''," + '#' + at + ',#' + direction(face.x, face.y, face.z) +
        ',#' + direction(b2.ux, b2.uy, b2.uz) + ')');
      var plane = put("PLANE(''," + '#' + placement + ')');
      faceIds[f] = put("ADVANCED_FACE(''," + '(' + bounds.join(',') + '),#' + plane + ',.T.)');
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

    return {
      text: head.concat(lines).concat(['ENDSEC;', 'END-ISO-10303-21;', '']).join('\n'),
      faces: brep.faces.length,
      edges: order.length,
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
