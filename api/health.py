"""GET /api/health — reports uptime and whether a model key is present.

Deliberately does not call the model: a health check that spends tokens stops
being cheap enough to poll.
"""

from __future__ import annotations

import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from api._shared import Handler  # noqa: E402
from lib.catalogue import load_catalogue  # noqa: E402
from lib.llm import LLMConfig, LLMError  # noqa: E402


class handler(Handler):
    def do_GET(self) -> None:  # noqa: N802
        try:
            config = LLMConfig.from_env()
            configured, model = True, config.model
        except LLMError:
            configured, model = False, None

        self._send_json(
            {
                "status": "ok",
                "llm_configured": configured,
                "model": model,
                "catalogue_size": len(load_catalogue()),
            }
        )
