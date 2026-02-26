import http.server
import socketserver

PORT = 8000

class NoCacheHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        # Crucial for WASM multithreading: enables SharedArrayBuffer
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        super().end_headers()

    def guess_type(self, path):
        # Override WASM MIME type to ensure it loads properly
        if path.endswith(".wasm"):
            return "application/wasm"
        elif path.endswith(".js"):
            return "application/javascript"
        elif path.endswith(".nnue"):
            return "application/octet-stream"
        return super().guess_type(path)

with socketserver.ThreadingTCPServer(("", PORT), NoCacheHTTPRequestHandler) as httpd:
    print(f"Serving at port {PORT} with NO CACHE headers")
    httpd.serve_forever()
