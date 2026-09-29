"""POST /api/chat — returns a conversational reply plus structured picks."""

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
from lib.catalogue import SYSTEM_PROMPT, build_selection_prompt, load_catalogue  # noqa: E402
from lib.llm import ChatMessage, KenariClient, LLMConfig, LLMError  # noqa: E402
from lib.selection import hydrate, parse_selection  # noqa: E402

CATALOGUE = load_catalogue()


class handler(Handler):
    """Vercel looks for a class named `handler` in each file."""

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
        messages.append(ChatMessage("user", build_selection_prompt(CATALOGUE, message or "")))

        try:
            raw = KenariClient(config).complete(
                messages,
                temperature=0.6,
                max_tokens=900,
                reasoning_effort=payload.get("reasoning_effort"),
            )
        except LLMError as exc:
            print(f"chat failed: {exc}")
            self._error("The assistant is temporarily unavailable.", 502)
            return

        selection = parse_selection(raw)
        self._send_json(
            {
                "reply": selection.get("reply", ""),
                "recommendations": hydrate(selection.get("recommendations", []), CATALOGUE),
            }
        )


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
