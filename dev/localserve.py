#!/usr/bin/env python3
"""Snelle lokale dev-server voor het cloud-dashboard - GEEN netlify dev (instant start).

Serveert public/ + /config.js (GMAPS uit .env.local) + /api/state uit een bron:

  python3 dev/localserve.py            /api/state = dev/sample-state.json  (niks anders nodig)
  python3 dev/localserve.py pi         /api/state = live Pi  (http://mokum-ais.local:8801/state)
  python3 dev/localserve.py cloud      /api/state = live cloud (Netlify)

Open http://localhost:8899  (poort via PORT=..., env-bestand via ENV_FILE=...).
Frontend aanpassen -> refresh. Ctrl+C stopt.
"""
import http.server, socketserver, os, sys, json, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(HERE, "..", "public")
SAMPLE = os.path.join(HERE, "sample-state.json")
ENVF = os.environ.get("ENV_FILE", "/Users/Micha@backbase.com/Downloads/matsutec/.env.local")
SRC = sys.argv[1] if len(sys.argv) > 1 else "sample"
PORT = int(os.environ.get("PORT", "8899"))
PI_URL = "http://mokum-ais.local:8801/state"
CLOUD_URL = "https://mokum-ais-receiver.netlify.app/api/state"


def envval(key):
    try:
        with open(ENVF) as f:
            for line in f:
                if line.startswith(key + "="):
                    return line.split("=", 1)[1].strip()
    except FileNotFoundError:
        pass
    return ""


GKEY, GID = envval("GMAPS_KEY"), envval("GMAPS_ID")


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=os.path.abspath(PUBLIC), **k)

    def _bytes(self, body, ctype, code=200):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/config.js":
            self._bytes(f"window.GMAPS_KEY={json.dumps(GKEY)};window.GMAPS_ID={json.dumps(GID)};",
                        "application/javascript")
            return
        if self.path.startswith("/api/vessel"):
            # proxy naar mokum-radar met de READ_KEY (net als de Netlify-function)
            from urllib.parse import urlparse, parse_qs
            mmsi = "".join(c for c in (parse_qs(urlparse(self.path).query).get("mmsi", [""])[0]) if c.isdigit())
            key = os.environ.get("MOKUM_READ_KEY") or envval("MOKUM_READ_KEY")
            if not mmsi:
                self._bytes({"error": "mmsi ontbreekt"}, "application/json", 400); return
            if not key:
                self._bytes({"error": "MOKUM_READ_KEY niet gezet in .env.local"}, "application/json", 503); return
            try:
                req = urllib.request.Request(f"https://mokum-radar.fly.dev/api/v2/vessel/{mmsi}", headers={"x-key": key})
                data = json.load(urllib.request.urlopen(req, timeout=10))
                self._bytes(data, "application/json")
            except Exception as e:
                self._bytes({"error": str(e)}, "application/json", 502)
            return
        if self.path.startswith("/api/state"):
            try:
                if SRC == "pi":
                    data = json.load(urllib.request.urlopen(PI_URL, timeout=5)); data["_ageSec"] = 0
                elif SRC == "cloud":
                    data = json.load(urllib.request.urlopen(CLOUD_URL, timeout=8))
                else:
                    data = json.load(open(SAMPLE)); data["_ageSec"] = 1
                self._bytes(data, "application/json")
            except Exception as e:
                self._bytes({"error": str(e)}, "application/json", 502)
            return
        return super().do_GET()

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    # ThreadingHTTPServer: elke request in een eigen thread, zodat browser-polls +
    # proxy-calls elkaar niet blokkeren (single-threaded stalt onder belasting).
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    http.server.ThreadingHTTPServer.daemon_threads = True
    print(f"lokale dev-server: http://localhost:{PORT}  (bron /api/state = {SRC})")
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), H) as httpd:
        httpd.serve_forever()
