/**
 * Orca Web Slicer — multipart bodies, built by hand.
 *
 * The uploads used to hand a FormData object to fetch and let the browser
 * assemble it. That works in a browser and nowhere else — and inside the
 * Android app the request cannot go through the browser at all: the page is
 * served over https from the app's own asset host, the printer is a plain http
 * box on the local network, and no printer sends the cross-origin headers a
 * browser demands before it will talk to one. Those requests have to be made
 * natively, and a FormData object cannot cross that bridge.
 *
 * So the body is built here, as a string, exactly as it goes on the wire.
 * G-code is ASCII, so a string is byte-for-byte what a file upload would be,
 * and the same bytes go out whether they leave through fetch or through Java.
 *
 * Loaded as a plain script (browser) or required under Node for tests.
 */
(function (root) {
  'use strict';

  /**
   * A boundary that cannot appear in the body. Random, and checked against the
   * content: a boundary that occurs inside the file would split it in two.
   */
  function boundaryFor(parts) {
    for (var attempt = 0; attempt < 8; attempt++) {
      var b = '----OrcaSlicer' + Math.random().toString(36).slice(2) +
              Date.now().toString(36);
      var clash = false;
      for (var i = 0; i < parts.length; i++) {
        if (String(parts[i].value != null ? parts[i].value : '').indexOf(b) >= 0) clash = true;
      }
      if (!clash) return b;
    }
    return '----OrcaSlicer' + Date.now().toString(36) + 'x';
  }

  /**
   * Build a multipart/form-data body.
   *
   *   parts: [{ name, value }]                       — a plain field
   *          [{ name, value, filename, type }]       — a file
   *
   * Returns { body, contentType }. Order is preserved: some firmwares read the
   * fields as a stream and expect the file last, which is how the callers
   * order them.
   */
  function build(parts) {
    var boundary = boundaryFor(parts);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      out.push('--' + boundary + '\r\n');
      out.push('Content-Disposition: form-data; name="' + p.name + '"' +
        (p.filename ? '; filename="' + p.filename + '"' : '') + '\r\n');
      if (p.type) out.push('Content-Type: ' + p.type + '\r\n');
      out.push('\r\n');
      out.push(String(p.value != null ? p.value : ''));
      out.push('\r\n');
    }
    out.push('--' + boundary + '--\r\n');
    return {
      body: out.join(''),
      contentType: 'multipart/form-data; boundary=' + boundary
    };
  }

  root.OrcaMultipart = { build: build };
  if (typeof module === 'object' && module.exports) module.exports = root.OrcaMultipart;
})(typeof globalThis !== 'undefined' ? globalThis : self);
