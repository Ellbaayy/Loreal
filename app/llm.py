"""Typed LLM client for the Kenari gateway (OpenAI-compatible)."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Iterable, Iterator


class LLMError(RuntimeError):
    """Raised when the upstream model call fails in a way the caller should surface."""


@dataclass(frozen=True)
class ChatMessage:
    role: str
    content: str

    def to_payload(self) -> dict[str, str]:
        return {"role": self.role, "content": self.content}


@dataclass(frozen=True)
class LLMConfig:
    """Everything the client needs to reach the model, read from the environment.

    The API key is deliberately absent from the constructor signature default so a
    deployed process cannot silently run unauthenticated.
    """

    api_key: str
    base_url: str = "https://kenari.id/v1"
    model: str = "deepseek-v4-1-flash"

    @classmethod
    def from_env(cls) -> "LLMConfig":
        api_key = os.environ.get("KENARI_API_KEY", "").strip()
        if not api_key:
            raise LLMError(
                "KENARI_API_KEY is not set. Add it to your environment or, on "
                "Hugging Face, to Settings -> Variables and secrets."
            )
        return cls(
            api_key=api_key,
            base_url=os.environ.get("KENARI_BASE_URL", "https://kenari.id/v1").rstrip("/"),
            model=os.environ.get("LORE_MODEL", "deepseek-v4-1-flash"),
        )

    @property
    def configured(self) -> bool:
        return bool(self.api_key)


class KenariClient:
    """Minimal streaming chat client. No SDK dependency, so the Space boots fast."""

    def __init__(self, config: LLMConfig, timeout: float = 120.0) -> None:
        self._config = config
        self._timeout = timeout

    def stream_chat(
        self,
        messages: Iterable[ChatMessage],
        *,
        temperature: float = 0.7,
        max_tokens: int = 900,
        reasoning_effort: str | None = None,
    ) -> Iterator[str]:
        """Yield text deltas as the model produces them."""
        if not self._config.configured:
            raise LLMError("LLM is not configured: missing API key.")

        payload: dict[str, Any] = {
            "model": self._config.model,
            "messages": [m.to_payload() for m in messages],
            "stream": True,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if reasoning_effort:
            payload["reasoning_effort"] = reasoning_effort

        request = urllib.request.Request(
            f"{self._config.base_url}/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self._config.api_key}",
                "Accept": "text/event-stream",
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                yield from _iter_sse_content(response)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:400]
            raise LLMError(f"Upstream returned {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise LLMError(f"Could not reach the model gateway: {exc.reason}") from exc

    def complete(
        self,
        messages: Iterable[ChatMessage],
        *,
        temperature: float = 0.7,
        max_tokens: int = 900,
        reasoning_effort: str | None = None,
    ) -> str:
        """Collect a full response. Useful for the structured recommendation pass."""
        return "".join(
            self.stream_chat(
                messages,
                temperature=temperature,
                max_tokens=max_tokens,
                reasoning_effort=reasoning_effort,
            )
        )


def _iter_sse_content(response: Any) -> Iterator[str]:
    """Parse an OpenAI-style SSE stream into plain text deltas."""
    for raw_line in response:
        line = raw_line.decode("utf-8", "replace").strip()
        if not line or not line.startswith("data:"):
            continue
        data = line[len("data:") :].strip()
        if data == "[DONE]":
            break
        try:
            chunk = json.loads(data)
        except json.JSONDecodeError:
            continue
        for choice in chunk.get("choices", []):
            delta = choice.get("delta") or {}
            text = delta.get("content")
            if text:
                yield text
