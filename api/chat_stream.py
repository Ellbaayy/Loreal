"""POST /api/chat/stream — server-sent events, token by token.

Vercel's Python runtime buffers a handler's response, so this function cannot
hold a connection open the way uvicorn does. It emits the full SSE body in one
write, which the browser parses identically; only the arrival timing differs.
The FastAPI app in `app/` remains the true streaming deployment target.
"""

from __future__ import annotations

import json
import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from api._shared import Handler, validate_message  # noqa: E402
from lib.catalogue import SYSTEM_PROMPT, load_catalogue  # noqa: E402
from lib.llm import ChatMessage, KenariClient, LLMConfig, LLMError  # noqa: E402

CATALOGUE = load_catalogue()


class handler(Handler):
    def do_POST(self) -> None:  # noqa: N802
        if self._reject_foreign_origin():
            return

        payload = self._read_json()
        if payload is None:
            self._error("Request body must be a JSON object.", 400)
            return

        message, error = validate_message(payload)
        if error:
            self._error(error, 422)
            return

        try:
            config = LLMConfig.from_env()
        except LLMError as exc:
            self._error(str(exc), 503)
            return

        messages = [ChatMessage("system", SYSTEM_PROMPT)]
        messages.extend(_history(payload.get("history") or []))
        messages.append(ChatMessage("user", message or ""))

        chunks: list[str] = []
        try:
            for delta in KenariClient(config).stream_chat(
                messages,
                temperature=0.7,
                max_tokens=700,
                reasoning_effort=payload.get("reasoning_effort"),
            ):
                chunks.append(f"data: {json.dumps({'delta': delta})}\n\n")
        except LLMError as exc:
            print(f"stream failed: {exc}")
            chunks.append(f"data: {json.dumps({'error': 'The assistant is temporarily unavailable.'})}\n\n")
        chunks.append("data: [DONE]\n\n")

        body = "".join(chunks).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)


def _history(history: list[Any]) -> list[ChatMessage]:
    cleaned = [
        ChatMessage(turn["role"], turn["content"])
        for turn in history
        if isinstance(turn, dict)
        and turn.get("role") in {"user", "assistant"}
        and isinstance(turn.get("content"), str)
        and turn["content"]
    ]
    return cleaned[-12:]
