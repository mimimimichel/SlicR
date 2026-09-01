#!/usr/bin/env python3
"""
A stand-in Elegoo Centauri Carbon 2 — the HTTP half of it, which is the half a
browser can reach. It enforces what Elegoo's own SDK sends: a PUT per chunk with
a Content-Range that has to be contiguous, the file's MD5 in a header, and an
X-Token it checks.

It assembles the chunks and verifies the digest at the end, so a test can tell
the difference between "the request looked right" and "the file arrived whole".

    python3 test-elegoo-server.py [port] [access-code]
"""
import hashlib
import json
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5098
TOKEN = sys.argv[2] if len(sys.argv) > 2 else "123456"

# name -> {"expect": total, "md5": claimed, "at": next offset, "data": bytes}
transfers = {}
received = []


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers",
                         "Content-Type, Content-Range, X-File-Name, X-File-MD5, X-Token")
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS")

    def _send(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _token_ok(self):
        header = self.headers.get("X-Token")
        query = None
        m = re.search(r"[?&]X-Token=([^&]*)", self.path)
        if m:
            query = m.group(1)
        return (header or query) == TOKEN

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path == "/_received":
            return self._send(200, received)
        if self.path.startswith("/system/info"):
            if not self._token_ok():
                return self._send(401, {"error_code": 1000})
            return self._send(200, {"error_code": 0, "system_info": {
                "sn": "CC2FAKESERIAL", "host_name": "Centauri", "machine_model": "Centauri Carbon 2"}})
        return self._send(404, {"error_code": 404})

    def do_PUT(self):
        if not self.path.startswith("/upload"):
            return self._send(404, {"error_code": 404})
        if not self._token_ok():
            return self._send(401, {"error_code": 1000})

        name = self.headers.get("X-File-Name")
        claimed = self.headers.get("X-File-MD5")
        rng = self.headers.get("Content-Range") or ""
        if not name or not claimed:
            return self._send(400, {"error_code": 2})

        m = re.match(r"bytes (\d+)-(\d+)/(\d+)$", rng)
        if not m:
            return self._send(400, {"error_code": 3})
        start, end, total = int(m.group(1)), int(m.group(2)), int(m.group(3))

        length = int(self.headers.get("Content-Length") or 0)
        chunk = self.rfile.read(length)
        if len(chunk) != end - start + 1:
            return self._send(400, {"error_code": 4})

        t = transfers.get(name)
        if t is None or start == 0:
            t = {"expect": total, "md5": claimed, "at": 0, "data": b""}
            transfers[name] = t
        # The real machine refuses a chunk that does not continue where the last
        # one stopped, which is what error -2 is for on the older protocol.
        if start != t["at"]:
            return self._send(400, {"error_code": 5})

        t["data"] += chunk
        t["at"] = end + 1

        if t["at"] >= total:
            digest = hashlib.md5(t["data"]).hexdigest()
            received.append({
                "name": name,
                "size": len(t["data"]),
                "md5Claimed": claimed,
                "md5Actual": digest,
                "intact": digest == claimed and len(t["data"]) == total,
                "firstLine": t["data"].split(b"\n")[0].decode("utf-8", "replace"),
                "lines": t["data"].count(b"\n"),
            })
            del transfers[name]
        return self._send(200, {"error_code": 0})


HOST = sys.argv[3] if len(sys.argv) > 3 else "127.0.0.1"


if __name__ == "__main__":
    print("fake Centauri Carbon 2 on http://%s:%d, token %s" % (HOST, PORT, TOKEN), flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
