"""POST /api/shop-info — placeholder for the retailer lookup the UI once used.

Returns an empty result set rather than fabricating store data. Wire a real
provider here when one is chosen.
"""

from __future__ import annotations

import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from api._shared import Handler  # noqa: E402


class handler(Handler):
    def do_POST(self) -> None:  # noqa: N802
        self._send_json(
            {
                "available": False,
                "shops": [],
                "note": "No retailer provider configured.",
            }
        )
