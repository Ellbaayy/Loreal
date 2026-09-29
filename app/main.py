"""FastAPI application: chat endpoint plus a self-contained demo page."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from app.catalogue import (
    SYSTEM_PROMPT,
    build_selection_prompt,
    load_catalogue,
)
from app.llm import ChatMessage, KenariClient, LLMConfig, LLMError

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("lore")

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

app = FastAPI(title="L'ORE-AI", version="2.0.0")

CATALOGUE = load_catalogue()


def _client() -> KenariClient:
    """Build a client per request so configuration problems surface as HTTP errors."""
    try:
        return KenariClient(LLMConfig.from_env())
    except LLMError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    history: list[dict[str, str]] = Field(default_factory=list, max_length=40)
    reasoning_effort: str | None = Field(default=None, pattern="^(low|high|max)$")


@app.get("/health")
def health() -> dict[str, Any]:
    """Report whether the service is up and whether a key is present.

    Deliberately does not call the model: a health check that spends tokens
    stops being cheap enough to poll.
    """
    try:
        config = LLMConfig.from_env()
        configured, model = True, config.model
    except LLMError:
        configured, model = False, None
    return {
        "status": "ok",
        "llm_configured": configured,
        "model": model,
        "catalogue_size": len(CATALOGUE),
    }


@app.get("/api/catalogue")
def catalogue() -> JSONResponse:
    return JSONResponse([f.to_dict() for f in CATALOGUE])


@app.post("/api/chat")
async def chat(request: ChatRequest) -> JSONResponse:
    """Non-streaming reply: returns the conversational text plus structured picks."""
    client = _client()

    messages = [ChatMessage("system", SYSTEM_PROMPT)]
    messages.extend(_history_to_messages(request.history))
    messages.append(
        ChatMessage("user", build_selection_prompt(CATALOGUE, request.message))
    )

    try:
        raw = client.complete(
            messages,
            temperature=0.6,
            max_tokens=900,
            reasoning_effort=request.reasoning_effort,
        )
    except LLMError as exc:
        logger.warning("chat failed: %s", exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    payload = _parse_selection(raw)
    payload["recommendations"] = _hydrate(payload.get("recommendations", []))
    return JSONResponse(payload)


@app.post("/api/chat/stream")
async def chat_stream(request: ChatRequest) -> StreamingResponse:
    """Token-by-token reply for the conversational transcript."""
    client = _client()

    messages = [ChatMessage("system", SYSTEM_PROMPT)]
    messages.extend(_history_to_messages(request.history))
    messages.append(ChatMessage("user", request.message))

    def event_stream():
        try:
            for delta in client.stream_chat(
                messages,
                temperature=0.7,
                max_tokens=700,
                reasoning_effort=request.reasoning_effort,
            ):
                yield f"data: {json.dumps({'delta': delta})}\n\n"
        except LLMError as exc:
            logger.warning("stream failed: %s", exc)
            yield f"data: {json.dumps({'error': str(exc)})}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


def _history_to_messages(history: list[dict[str, str]]) -> list[ChatMessage]:
    """Keep only well-formed turns, and only the most recent ones."""
    cleaned = [
        ChatMessage(turn["role"], turn["content"])
        for turn in history
        if turn.get("role") in {"user", "assistant"} and turn.get("content")
    ]
    return cleaned[-12:]


def _parse_selection(raw: str) -> dict[str, Any]:
    """Extract the JSON object from a model reply, tolerating stray code fences."""
    text = raw.strip()
    if text.startswith("```"):
        text = text.split("```")[1] if "```" in text[3:] else text[3:]
        text = text.removeprefix("json").strip()
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1:
        # Model ignored the schema. Degrade to a plain reply rather than erroring.
        return {"reply": raw.strip(), "recommendations": []}
    try:
        parsed = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return {"reply": raw.strip(), "recommendations": []}
    if not isinstance(parsed, dict):
        return {"reply": raw.strip(), "recommendations": []}
    parsed.setdefault("recommendations", [])
    parsed.setdefault("reply", "")
    return parsed


def _hydrate(picks: Any) -> list[dict[str, Any]]:
    """Attach catalogue facts to each pick, dropping any name the model invented."""
    if not isinstance(picks, list):
        return []
    by_name = {(f.name.lower(), f.brand.lower()): f for f in CATALOGUE}
    out: list[dict[str, Any]] = []
    for pick in picks:
        if not isinstance(pick, dict):
            continue
        key = (str(pick.get("name", "")).lower(), str(pick.get("brand", "")).lower())
        match = by_name.get(key)
        if match is None:
            logger.info("dropping invented fragrance: %s", pick.get("name"))
            continue
        entry = match.to_dict()
        entry["reason"] = str(pick.get("reason", ""))
        out.append(entry)
    return out


@app.get("/api/shop-info")
def shop_info() -> dict[str, Any]:
    """Placeholder for the retailer lookup the original UI used.

    Returns an empty result set rather than fabricating store data. Wire a real
    provider here when one is chosen.
    """
    return {"available": False, "shops": [], "note": "No retailer provider configured."}
