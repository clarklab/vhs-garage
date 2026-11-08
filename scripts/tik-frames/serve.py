# Tiny file server with CORS on 127.0.0.1:8765, serving $TIK_FRAMES_WORK, so the https
# studio tab can fetch payloads (draft JSON, delivery.json) from the work dir over loopback
# instead of having them pasted into the console. Loopback is a secure context, so the
# https page may call it; the CORS and private-network headers let Chrome through.
import http.server, os
W = os.environ.get('TIK_FRAMES_WORK') or os.path.expanduser('~/.cache/vhs-tik-frames')
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=W, **k)
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*'); self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Cache-Control', 'no-store'); super().end_headers()
    def do_OPTIONS(self): self.send_response(204); self.end_headers()
    def log_message(self, *a): pass
print(f'serving {W} on http://127.0.0.1:8765', flush=True)
http.server.ThreadingHTTPServer(('127.0.0.1', 8765), H).serve_forever()
