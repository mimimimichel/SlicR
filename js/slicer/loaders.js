/**
 * Orca Web Slicer — model loaders.
 * STL (binary + ASCII), OBJ and 3MF. Everything is normalised to a flat
 * Float32Array of triangle vertices (x,y,z ×3 per triangle) in millimetres.
 */
(function (root) {
  'use strict';

  // --- STL --------------------------------------------------------------------

  function isBinarySTL(buffer) {
    if (buffer.byteLength < 84) return false;
    var view = new DataView(buffer);
    var triangles = view.getUint32(80, true);
    if (84 + triangles * 50 === buffer.byteLength) return true;
    // Fall back to sniffing for the "solid" keyword followed by "facet".
    var head = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(512, buffer.byteLength)));
    return !/^\s*solid/i.test(head) || !/facet\s+normal/i.test(head);
  }

  function parseBinarySTL(buffer) {
    var view = new DataView(buffer);
    var count = view.getUint32(80, true);
    var max = Math.floor((buffer.byteLength - 84) / 50);
    if (count > max) count = max;
    var out = new Float32Array(count * 9);
    var o = 84;
    for (var i = 0; i < count; i++) {
      o += 12;                                   // skip the stored normal
      for (var v = 0; v < 9; v++) {
        var f = view.getFloat32(o, true);
        // A corrupt float in a binary STL is still nine bytes of file; reading
        // it as a coordinate poisons every measurement taken afterwards.
        out[i * 9 + v] = isFinite(f) ? f : 0;
        o += 4;
      }
      o += 2;                                    // attribute byte count
    }
    return out;
  }

  function parseAsciiSTL(text) {
    var verts = [];
    var re = /vertex\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/g;
    var m;
    while ((m = re.exec(text)) !== null) {
      var x = +m[1], y = +m[2], z = +m[3];
      // A corner that does not parse is not a corner. Dropping the three
      // numbers keeps the rest of the file, which is what a repair tool would
      // leave behind anyway.
      if (isFinite(x) && isFinite(y) && isFinite(z)) verts.push(x, y, z);
    }
    var usable = Math.floor(verts.length / 9) * 9;
    return new Float32Array(verts.slice(0, usable));
  }

  function parseSTL(buffer) {
    if (isBinarySTL(buffer)) return parseBinarySTL(buffer);
    return parseAsciiSTL(new TextDecoder().decode(new Uint8Array(buffer)));
  }

  // --- OBJ --------------------------------------------------------------------

  function parseOBJ(text) {
    var vx = [], out = [];
    var lines = text.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.charCodeAt(0) === 118 && line.charCodeAt(1) === 32) {         // "v "
        var p = line.split(/\s+/);
        vx.push(+p[1], +p[2], +p[3]);
      } else if (line.charCodeAt(0) === 102 && line.charCodeAt(1) === 32) {  // "f "
        var parts = line.trim().split(/\s+/).slice(1);
        var idx = [];
        for (var j = 0; j < parts.length; j++) {
          var n = parseInt(parts[j].split('/')[0], 10);
          if (isNaN(n)) continue;
          idx.push(n < 0 ? (vx.length / 3) + n : n - 1);
        }
        var count = vx.length / 3;
        for (var k = 1; k + 1 < idx.length; k++) {                            // fan-triangulate
          var tri = [idx[0], idx[k], idx[k + 1]];
          // A face naming a corner the file never gave is not a triangle. Left
          // in, it becomes three NaNs, and one bad line loses the whole model
          // rather than one face of it.
          if (tri[0] < 0 || tri[0] >= count ||
              tri[1] < 0 || tri[1] >= count ||
              tri[2] < 0 || tri[2] >= count) continue;
          var bad = false, buf = [];
          for (var t = 0; t < 3; t++) {
            var b = tri[t] * 3;
            if (!isFinite(vx[b]) || !isFinite(vx[b + 1]) || !isFinite(vx[b + 2])) { bad = true; break; }
            buf.push(vx[b], vx[b + 1], vx[b + 2]);
          }
          if (!bad) out.push.apply(out, buf);
        }
      }
    }
    return new Float32Array(out);
  }

  // --- Minimal ZIP reader (for 3MF) -------------------------------------------

  function findEndOfCentralDirectory(view, length) {
    var max = Math.min(length, 66000);
    for (var i = length - 22; i >= length - max && i >= 0; i--) {
      if (view.getUint32(i, true) === 0x06054b50) return i;
    }
    return -1;
  }

  async function unzip(buffer) {
    var view = new DataView(buffer);
    var eocd = findEndOfCentralDirectory(view, buffer.byteLength);
    if (eocd < 0) throw new Error('Not a valid ZIP/3MF archive');

    var entryCount = view.getUint16(eocd + 10, true);
    var cdOffset = view.getUint32(eocd + 16, true);
    var files = {};
    var p = cdOffset;

    for (var i = 0; i < entryCount; i++) {
      if (view.getUint32(p, true) !== 0x02014b50) break;
      var method = view.getUint16(p + 10, true);
      var compSize = view.getUint32(p + 20, true);
      var nameLen = view.getUint16(p + 28, true);
      var extraLen = view.getUint16(p + 30, true);
      var commentLen = view.getUint16(p + 32, true);
      var localOffset = view.getUint32(p + 42, true);
      var name = new TextDecoder().decode(new Uint8Array(buffer, p + 46, nameLen));
      p += 46 + nameLen + extraLen + commentLen;

      var lNameLen = view.getUint16(localOffset + 26, true);
      var lExtraLen = view.getUint16(localOffset + 28, true);
      var dataStart = localOffset + 30 + lNameLen + lExtraLen;
      var raw = new Uint8Array(buffer, dataStart, compSize);

      if (method === 0) {
        files[name] = raw.slice();
      } else if (method === 8) {
        files[name] = await inflateRaw(raw);
      }
    }
    return files;
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('This browser cannot decompress 3MF files (DecompressionStream unavailable)');
    }
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    var buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  // --- 3MF --------------------------------------------------------------------

  function parseMatrix(str) {
    if (!str) return null;
    var v = str.trim().split(/\s+/).map(Number);
    if (v.length !== 12 || v.some(isNaN)) return null;
    return v;   // row-major 4×3: p' = p · M(3×3) + translation
  }

  function applyMatrix(m, x, y, z) {
    if (!m) return [x, y, z];
    return [
      x * m[0] + y * m[3] + z * m[6] + m[9],
      x * m[1] + y * m[4] + z * m[7] + m[10],
      x * m[2] + y * m[5] + z * m[8] + m[11]
    ];
  }

  function multiplyMatrix(a, b) {
    if (!a) return b;
    if (!b) return a;
    var out = new Array(12);
    for (var r = 0; r < 3; r++) {
      for (var c = 0; c < 3; c++) {
        out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
      }
    }
    out[9] = a[9] * b[0] + a[10] * b[3] + a[11] * b[6] + b[9];
    out[10] = a[9] * b[1] + a[10] * b[4] + a[11] * b[7] + b[10];
    out[11] = a[9] * b[2] + a[10] * b[5] + a[11] * b[8] + b[11];
    return out;
  }

  async function parse3MF(buffer) {
    var files = await unzip(buffer);
    var modelName = Object.keys(files).find(function (n) { return /3dmodel\.model$/i.test(n); })
      || Object.keys(files).find(function (n) { return /\.model$/i.test(n); });
    if (!modelName) throw new Error('No 3D model found inside the 3MF');

    var xml = new TextDecoder().decode(files[modelName]);
    var doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('Corrupt 3MF model XML');

    var unit = (doc.documentElement.getAttribute('unit') || 'millimeter').toLowerCase();
    var UNIT_SCALE = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };
    var scale = UNIT_SCALE[unit] || 1;

    var objects = {};
    var objNodes = doc.getElementsByTagName('object');
    for (var i = 0; i < objNodes.length; i++) {
      var id = objNodes[i].getAttribute('id');
      if (id) objects[id] = objNodes[i];
    }

    var out = [];
    function emitObject(node, matrix, depth) {
      if (!node || depth > 12) return;
      var mesh = node.getElementsByTagName('mesh')[0];
      if (mesh && mesh.parentNode === node) {
        var vertNodes = mesh.getElementsByTagName('vertex');
        var coords = new Float64Array(vertNodes.length * 3);
        for (var v = 0; v < vertNodes.length; v++) {
          var p = applyMatrix(matrix,
            parseFloat(vertNodes[v].getAttribute('x')),
            parseFloat(vertNodes[v].getAttribute('y')),
            parseFloat(vertNodes[v].getAttribute('z')));
          coords[v * 3] = p[0] * scale; coords[v * 3 + 1] = p[1] * scale; coords[v * 3 + 2] = p[2] * scale;
        }
        var triNodes = mesh.getElementsByTagName('triangle');
        for (var t = 0; t < triNodes.length; t++) {
          var i1 = +triNodes[t].getAttribute('v1'), i2 = +triNodes[t].getAttribute('v2'), i3 = +triNodes[t].getAttribute('v3');
          out.push(coords[i1 * 3], coords[i1 * 3 + 1], coords[i1 * 3 + 2],
                   coords[i2 * 3], coords[i2 * 3 + 1], coords[i2 * 3 + 2],
                   coords[i3 * 3], coords[i3 * 3 + 1], coords[i3 * 3 + 2]);
        }
      }
      var comps = node.getElementsByTagName('component');
      for (var c = 0; c < comps.length; c++) {
        var refId = comps[c].getAttribute('objectid');
        var childMatrix = multiplyMatrix(parseMatrix(comps[c].getAttribute('transform')), matrix);
        if (objects[refId] && objects[refId] !== node) emitObject(objects[refId], childMatrix, depth + 1);
      }
    }

    var items = doc.getElementsByTagName('item');
    if (items.length) {
      for (var it = 0; it < items.length; it++) {
        var oid = items[it].getAttribute('objectid');
        if (objects[oid]) emitObject(objects[oid], parseMatrix(items[it].getAttribute('transform')), 0);
      }
    } else {
      Object.keys(objects).forEach(function (k) { emitObject(objects[k], null, 0); });
    }

    if (!out.length) throw new Error('The 3MF contains no printable geometry');
    return new Float32Array(out);
  }

  // --- Entry point ------------------------------------------------------------

  async function loadFile(file) {
    var name = (file.name || '').toLowerCase();
    if (name.endsWith('.3mf')) return parse3MF(await file.arrayBuffer());
    if (name.endsWith('.obj')) return parseOBJ(await file.text());
    if (name.endsWith('.stl')) return parseSTL(await file.arrayBuffer());
    // Unknown extension: sniff the content.
    var buf = await file.arrayBuffer();
    var head = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(256, buf.byteLength)));
    if (head.charCodeAt(0) === 0x50 && head.charCodeAt(1) === 0x4b) return parse3MF(buf);
    if (/^\s*(v|#|o|g|mtllib)\s/m.test(head)) return parseOBJ(new TextDecoder().decode(new Uint8Array(buf)));
    return parseSTL(buf);
  }

  root.OrcaLoaders = {
    loadFile: loadFile,
    parseSTL: parseSTL,
    parseOBJ: parseOBJ,
    parse3MF: parse3MF,
    unzip: unzip
  };
  // Exported like every other module, so the parsers can be held to a pile of
  // damaged files without a browser.
  if (typeof module !== 'undefined' && module.exports) module.exports = root.OrcaLoaders;
})(typeof globalThis !== 'undefined' ? globalThis : window);
