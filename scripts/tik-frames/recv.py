# Local receiver for dump-facts.js: the studio page (https) POSTs JSON here and it
# lands in $TIK_FRAMES_WORK/inbox/<name>. Loopback is a secure context, so the
# https page may call it; the CORS and private-network headers let Chrome through.
import http.server, os
W = os.environ.get('TIK_FRAMES_WORK') or os.path.expanduser('~/.cache/vhs-tik-frames'); os.makedirs(f'{W}/inbox', exist_ok=True)
class H(http.server.BaseHTTPRequestHandler):
    def cors(self):
        self.send_header('Access-Control-Allow-Origin', '*'); self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*'); self.send_header('Access-Control-Allow-Private-Network', 'true')
    def do_OPTIONS(self): self.send_response(204); self.cors(); self.end_headers()
    def do_POST(self):
        name = os.path.basename(self.path.strip('/')) or 'post.json'
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        open(f'{W}/inbox/{name}', 'wb').write(body)
        self.send_response(200); self.cors(); self.send_header('Content-Type', 'text/plain'); self.end_headers(); self.wfile.write(f'saved {len(body)} bytes to {W}/inbox/{name}'.encode())
    def log_message(self, *a): pass
print(f'receiving on http://127.0.0.1:8766 → {W}/inbox/', flush=True)
http.server.ThreadingHTTPServer(('127.0.0.1', 8766), H).serve_forever()
