#!/usr/bin/env python3
"""Serve Testside locally: python3 serve.py  → http://127.0.0.1:8740"""
import http.server, functools, os, sys

class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
    def log_message(self, *a):
        pass

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8740
os.chdir(os.path.dirname(os.path.abspath(__file__)))
print(f'Testside running at http://127.0.0.1:{port}  (Ctrl+C to stop)')
http.server.ThreadingHTTPServer(('127.0.0.1', port), NoCache).serve_forever()
