"""Shared helpers for the Vercel serverless functions in this directory.

Vercel's Python runtime passes a request object in and expects a response object
out. This module keeps the two handlers focused on their own logic rather than
repeating CORS, body parsing, and error shaping.
"""

from __future__ import annotations

import json
import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any

# The project root must be importable so `lib.*` resolves when Vercel runs this
# file directly rather than as part of an installed package.
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

ALLOWED_ORIGIN_SUFFIXES = (".vercel.app",)
LOCAL_HOSTS = {"localhost", "127.0.0.1"}

MAX_BODY_BYTES = 64 * 1024
MAX_MESSAGES = 20
MAX_MESSAGE_CHARS = 4000
MAX_HISTORY = 40


class Handler(BaseHTTPRequestHandler):
    """Base class that adds JSON replies, CORS, and a body reader.

    Vercel instantiates the subclass per invocation, so no state is kept here.
    """

    def _reject_foreign_origin(self) -> bool:
        """Refuse browser calls from origins outside this project.

        Returns True when the request was rejected. The CORS header alone only
        stops the *browser* from reading the reply; it still spends the user's
        model quota. Requests without an Origin header (curl, server-to-server)
        are allowed through, since those are not driveable from a web page.
        """
        origin = self.headers.get("origin")
        if origin and _allowed_origin(origin) == "null":
            self._error("Forbidden origin.", 403)
            return True
        return False

    def _send_json(self, payload: Any, status: int = 200, extra: dict[str, str] | None = None) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        origin = self.headers.get("origin")
        self.send_header("Access-Control-Allow-Origin", _allowed_origin(origin))
        self.send_header("Vary", "Origin")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _error(self, message: str, status: int, extra: dict[str, str] | None = None) -> None:
        self._send_json({"detail": message}, status=status, extra=extra)

    def _read_json(self) -> dict[str, Any] | None:
        try:
            length = int(self.headers.get("content-length") or 0)
        except ValueError:
            return None
        if length <= 0 or length > MAX_BODY_BYTES:
            return None
        try:
            parsed = json.loads(self.rfile.read(length).decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None
        return parsed if isinstance(parsed, dict) else None

    def do_OPTIONS(self) -> None:  # noqa: N802 - name required by BaseHTTPRequestHandler
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", _allowed_origin(self.headers.get("origin")))
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Vary", "Origin")
        self.end_headers()

    def log_message(self, fmt: str, *args: Any) -> None:
        """Route through stdout so Vercel captures it; the default goes to stderr."""
        sys.stdout.write("%s - %s\n" % (self.address_string(), fmt % args))


def _allowed_origin(origin: str | None) -> str:
    """Echo the caller's origin only when it is one we expect.

    A wildcard would let any site drive this endpoint and spend the user's
    model quota, so same-project preview and production hostnames are matched
    by suffix instead.
    """
    if not origin:
        return "*"
    host = origin.split("://")[-1].split("/")[0].split(":")[0].lower()
    if host in LOCAL_HOSTS or host.endswith(ALLOWED_ORIGIN_SUFFIXES):
        return origin
    return "null"


def validate_message(payload: dict[str, Any]) -> tuple[str | None, str | None]:
    """Return (message, error). Exactly one of the two is None."""
    message = payload.get("message")
    if not isinstance(message, str) or not message.strip():
        return None, "message must be a non-empty string"
    if len(message) > MAX_MESSAGE_CHARS:
        return None, f"message must be at most {MAX_MESSAGE_CHARS} characters"

    history = payload.get("history")
    if history is not None and not isinstance(history, list):
        return None, "history must be an array"
    if isinstance(history, list) and len(history) > MAX_HISTORY:
        return None, f"history must contain at most {MAX_HISTORY} turns"

    effort = payload.get("reasoning_effort")
    if effort is not None and effort not in {"low", "high", "max"}:
        return None, "reasoning_effort must be one of: low, high, max"

    return message, None
