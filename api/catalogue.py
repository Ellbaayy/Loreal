"""GET /api/catalogue — the full fragrance dataset as JSON."""

from __future__ import annotations

import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from api._shared import Handler  # noqa: E402
from lib.catalogue import load_catalogue  # noqa: E402


class handler(Handler):
    def do_GET(self) -> None:  # noqa: N802
        self._send_json([f.to_dict() for f in load_catalogue()])
