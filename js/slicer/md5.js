/**
 * Orca Web Slicer — MD5.
 *
 * Here for one reason: the Centauri Carbon refuses an upload whose MD5 it was
 * not given, and a browser cannot compute one — crypto.subtle offers SHA and
 * nothing older, deliberately. So this is RFC 1321, written out.
 *
 * It is not used for anything that needs to be secure. It is a checksum the
 * printer asks for to know the file arrived whole.
 *
 * Loaded as a plain script (browser) or required under Node for tests.
 */
(function (root) {
  'use strict';

  // Per-round shift amounts and the sine-derived constants of RFC 1321.
  var S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
  ];
  var K = new Int32Array(64);
  for (var ki = 0; ki < 64; ki++) {
    K[ki] = (Math.floor(Math.abs(Math.sin(ki + 1)) * 4294967296)) | 0;
  }

  function rotl(x, c) { return (x << c) | (x >>> (32 - c)); }

  /**
   * @param {Uint8Array} bytes
   * @returns {string} the digest as 32 lowercase hex characters
   */
  function md5Bytes(bytes) {
    var len = bytes.length;
    // Message, a 0x80 byte, zero padding to 56 mod 64, then the bit length.
    var padded = new Uint8Array(((len + 8) >> 6) * 64 + 64);
    padded.set(bytes);
    padded[len] = 0x80;

    // The length in bits, little-endian, in the last eight bytes. Written as
    // two 32-bit halves because a file can be longer than 2^32 bits (512 MB)
    // and shifting past 31 in JavaScript wraps.
    var bitsLow = (len << 3) >>> 0;
    var bitsHigh = Math.floor(len / 536870912);
    var tail = padded.length - 8;
    padded[tail] = bitsLow & 0xff;
    padded[tail + 1] = (bitsLow >>> 8) & 0xff;
    padded[tail + 2] = (bitsLow >>> 16) & 0xff;
    padded[tail + 3] = (bitsLow >>> 24) & 0xff;
    padded[tail + 4] = bitsHigh & 0xff;
    padded[tail + 5] = (bitsHigh >>> 8) & 0xff;
    padded[tail + 6] = (bitsHigh >>> 16) & 0xff;
    padded[tail + 7] = (bitsHigh >>> 24) & 0xff;

    var a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    var M = new Int32Array(16);

    for (var off = 0; off < padded.length; off += 64) {
      for (var j = 0; j < 16; j++) {
        var p = off + j * 4;
        M[j] = padded[p] | (padded[p + 1] << 8) | (padded[p + 2] << 16) | (padded[p + 3] << 24);
      }

      var A = a0, B = b0, C = c0, D = d0;
      for (var i = 0; i < 64; i++) {
        var F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) & 15; }
        else { F = C ^ (B | ~D); g = (7 * i) & 15; }

        F = (F + A + K[i] + M[g]) | 0;
        A = D; D = C; C = B;
        B = (B + rotl(F, S[i])) | 0;
      }
      a0 = (a0 + A) | 0;
      b0 = (b0 + B) | 0;
      c0 = (c0 + C) | 0;
      d0 = (d0 + D) | 0;
    }

    return hexLE(a0) + hexLE(b0) + hexLE(c0) + hexLE(d0);
  }

  /** A 32-bit word as eight hex characters, least significant byte first. */
  function hexLE(word) {
    var out = '';
    for (var i = 0; i < 4; i++) {
      var byte = (word >>> (i * 8)) & 0xff;
      out += (byte < 16 ? '0' : '') + byte.toString(16);
    }
    return out;
  }

  /** UTF-8 encodes a string, then digests it. */
  function md5(text) {
    if (typeof text !== 'string') return md5Bytes(text);
    if (typeof TextEncoder === 'function') return md5Bytes(new TextEncoder().encode(text));
    // Node before the global TextEncoder, and nothing else.
    var buf = [];
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c < 0x80) buf.push(c);
      else if (c < 0x800) buf.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else buf.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return md5Bytes(new Uint8Array(buf));
  }

  var api = { md5: md5, md5Bytes: md5Bytes };
  root.OrcaMd5 = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
