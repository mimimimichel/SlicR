/**
 * Prismatic — the Android side of the page.
 *
 * In a browser this file does nothing at all: it looks for the bridge the
 * Android shell installs, does not find it, and leaves. Inside the app it fills
 * in the two things a WebView cannot do on its own.
 *
 * Handing a file out. A blob URL with a download attribute is a dead end in a
 * WebView — the click does nothing and no error says so. Instead the bytes go
 * across to Java in pieces and land in a temp file, and the system's storage
 * picker chooses where that file ends up. Base64 for the crossing, so a binary
 * STL and a text STEP travel the same road and neither is reinterpreted on the
 * way; the count of bytes that arrived is checked against the count that was
 * sent, because a STEP file that stops halfway through a face is worse than one
 * that never arrived.
 *
 * Taking a file in. When somebody opens a mesh with the app, Android copies it
 * into the cache and the page pulls it across when it is ready — pulled rather
 * than pushed, because thirty megabytes cannot cross this bridge in one string
 * and the page is the side that knows when it can take it.
 */
(function (root) {
  'use strict';

  var native = root.AndroidPrismatic;
  if (!native) return;

  var CHUNK = 192 * 1024;    // bytes per hop; base64 makes that 256 KB of string

  /** Base64 of a slice, built in small pieces so the argument list stays sane. */
  function encode(bytes, from, to) {
    var out = '';
    for (var i = from; i < to; i += 8192) {
      var end = Math.min(i + 8192, to);
      out += String.fromCharCode.apply(null, bytes.subarray(i, end));
    }
    return root.btoa(out);
  }

  function decode(text) {
    var raw = root.atob(text);
    var bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  }

  function save(blob, name, mime, done) {
    var reader = new FileReader();
    reader.onerror = function () { done(new Error('the file could not be read back')); };
    reader.onload = function () {
      var bytes = new Uint8Array(reader.result);
      if (!native.beginSave(name, mime || 'application/octet-stream')) {
        done(new Error('Android would not open a file to write'));
        return;
      }
      try {
        for (var at = 0; at < bytes.length; at += CHUNK) {
          var end = Math.min(at + CHUNK, bytes.length);
          if (!native.appendSave(encode(bytes, at, end))) {
            throw new Error('a piece of the file did not cross');
          }
        }
        // What was sent and what arrived have to be the same number.
        var landed = parseInt(native.pendingBytes(), 10);
        if (landed !== bytes.length) {
          throw new Error(landed + ' of ' + bytes.length + ' bytes arrived');
        }
      } catch (e) {
        native.discardSave();
        done(e);
        return;
      }
      native.endSave();
      done(null);
    };
    reader.readAsArrayBuffer(blob);
  }

  /**
   * Fetch the mesh the app was opened with, if there is one, and hand it over
   * as a File so the page can read it exactly as it reads one that came from
   * the picker.
   */
  function incoming(deliver) {
    var name = native.incomingName();
    if (!name) return false;
    var size = parseInt(native.incomingSize(), 10) || 0;
    if (!size) { native.incomingDone(); return false; }

    var parts = [];
    var at = 0;
    while (at < size) {
      var piece = native.incomingChunk(String(at), String(CHUNK));
      if (!piece) break;
      var bytes = decode(piece);
      if (!bytes.length) break;
      parts.push(bytes);
      at += bytes.length;
    }
    native.incomingDone();
    if (at < size) {
      native.toast('That file did not come across whole.');
      return false;
    }
    deliver(new File(parts, name));
    return true;
  }

  root.PrismaticNative = {
    save: save,
    incoming: incoming,
    toast: function (message) { native.toast(message); }
  };
})(typeof window !== 'undefined' ? window : this);
