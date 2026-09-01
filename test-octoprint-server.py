#!/usr/bin/env python3
"""
A stand-in OctoPrint, just enough of the real one to prove the client talks to
it: the same three endpoints, the same API-key header, the same status codes,
and CORS enabled the way a person has to enable it in OctoPrint's own settings.

It records what it was given at /_received so a test can read back the exact
file and flags that arrived.

    python3 test-octoprint-server.py [port] [api-key]
"""
import json
import sys
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5099
API_KEY = sys.argv[2] if len(sys.argv) > 2 else "TESTKEY"

received = []
commands = []

# What this machine says about itself, and what the control endpoints change.
state = {
    "text": "Operational", "printing": False,
    "nozzle": 24.1, "nozzleTarget": 0, "bed": 23.4, "bedTarget": 0,
    "file": None, "percent": None, "left": None,
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "X-Api-Key, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _send(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _authorised(self):
        return self.headers.get("X-Api-Key") == API_KEY

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path == "/_received":
            return self._send(200, received)
        if self.path == "/_commands":
            return self._send(200, commands)
        if self.path.startswith("/_printing"):
            # Let a test put the machine into a printing state to drive against.
            state.update(text="Printing", printing=True, file="part.gcode",
                         percent=42, left=1800, nozzle=214.6, nozzleTarget=215,
                         bed=59.8, bedTarget=60)
            return self._send(200, state)
        if not self._authorised():
            return self._send(403, {"error": "Invalid API key"})
        if self.path == "/api/version":
            return self._send(200, {"api": "0.1", "server": "1.10.2", "text": "OctoPrint 1.10.2"})
        if self.path == "/api/connection":
            return self._send(200, {"current": {"state": "Operational"}})
        if self.path == "/api/job":
            return self._send(200, {"state": state["text"], "job": {"file": {"name": state["file"]}},
                                    "progress": {"completion": state["percent"],
                                                 "printTimeLeft": state["left"]}})
        if self.path == "/api/printer":
            return self._send(200, {
                "state": {"text": state["text"], "flags": {"printing": state["printing"]}},
                "temperature": {
                    "tool0": {"actual": state["nozzle"], "target": state["nozzleTarget"]},
                    "bed": {"actual": state["bed"], "target": state["bedTarget"]},
                },
            })
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._authorised():
            return self._send(403, {"error": "Invalid API key"})

        # The control endpoints, which record what they were told so a test can
        # check the machine was actually driven and not merely asked politely.
        if self.path in ("/api/job", "/api/printer/printhead", "/api/printer/tool",
                         "/api/printer/bed", "/api/printer/command"):
            length = int(self.headers.get("Content-Length") or 0)
            try:
                sent = json.loads(self.rfile.read(length) or b"{}")
            except ValueError:
                return self._send(400, {"error": "bad json"})
            commands.append({"path": self.path, "body": sent})

            if self.path == "/api/job":
                if sent.get("command") == "pause":
                    action = sent.get("action")
                    if action == "resume" or (action == "toggle" and state["text"] == "Paused"):
                        state["text"], state["printing"] = "Printing", True
                    else:
                        state["text"], state["printing"] = "Paused", False
                elif sent.get("command") == "cancel":
                    state.update(text="Operational", printing=False, file=None,
                                 percent=None, left=None)
            elif self.path == "/api/printer/bed":
                state["bedTarget"] = sent.get("target", 0)
            elif self.path == "/api/printer/tool" and sent.get("command") == "target":
                state["nozzleTarget"] = (sent.get("targets") or {}).get("tool0", 0)
            return self._send(204, {})

        if not self.path.startswith("/api/files/"):
            return self._send(404, {"error": "not found"})

        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        text = raw.decode("utf-8", "replace")

        name = None
        m = re.search(r'name="file"; filename="([^"]*)"', text)
        if m:
            name = m.group(1)
        flags = re.findall(r'name="(select|print)"\r?\n\r?\n(\w+)', text)

        # The file part's body, between its own blank line and the next boundary.
        gcode = ""
        if m:
            after = text[m.end():]
            start = after.find("\r\n\r\n")
            if start >= 0:
                rest = after[start + 4:]
                end = rest.find("\r\n--")
                gcode = rest if end < 0 else rest[:end]

        received.append({
            "name": name,
            "flags": {k: v for k, v in flags},
            "bytes": len(raw),
            "firstLine": gcode.split("\n")[0] if gcode else "",
            "lines": gcode.count("\n"),
        })
        target = self.path.rsplit("/", 1)[-1]
        return self._send(201, {"done": True, "files": {target: {"name": name, "path": name}}})


HOST = sys.argv[3] if len(sys.argv) > 3 else "127.0.0.1"


if __name__ == "__main__":
    print("fake OctoPrint on http://%s:%d, key %s" % (HOST, PORT, API_KEY), flush=True)
    # Threading, because a browser holds its connection open between requests
    # and a single-threaded server would make everything else wait on it.
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
