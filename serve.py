#!/usr/bin/env python3
"""No-cache static server for local development.

    python3 serve.py [port]        # default 8080

Why this and not `python3 -m http.server`: the stock handler sends
`Last-Modified`, so the browser revalidates and takes a 304. That is exactly
wrong here. `manifest.json` names the current Parquet, and a stale copy pins
the client to a file the archive refresh may already have pruned — the page
then boots, queries, and fails with "Table with name live does not exist",
which reads as an app bug rather than a caching one. Production solves this in
netlify.toml; locally, nothing is cached at all.

This serves the working tree, so a reload always shows the file you just saved.
"""
import functools
import http.server
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080


class Handler(http.server.SimpleHTTPRequestHandler):
    def send_header(self, keyword, value):
        # Dropping Last-Modified is the point: without a validator the browser
        # has nothing to send an If-Modified-Since against, so it refetches.
        if keyword == "Last-Modified":
            return
        super().send_header(keyword, value)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s\n" % (fmt % args))


if __name__ == "__main__":
    handler = functools.partial(Handler, directory=ROOT)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    print(f"Tremor → http://localhost:{PORT}  (no-store; serving {ROOT})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print()
