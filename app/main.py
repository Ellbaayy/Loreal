"""FastAPI application: chat endpoint plus a self-contained demo page."""

from __future__ import annotations

import html
import json
import logging
import re
import unicodedata
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
    """Extract the selection object from a model reply.

    Models drift: they wrap JSON in fences, add a sentence of preamble, leave a
    trailing comma, or escape apostrophes as HTML entities. Rejecting the whole
    reply over any of those loses good recommendations, so each is handled.
    """
    text = _strip_code_fences(raw)
    candidate = _slice_object(text)

    if candidate is not None:
        for attempt in (candidate, _drop_trailing_commas(candidate)):
            try:
                parsed = json.loads(attempt)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                parsed.setdefault("recommendations", [])
                parsed.setdefault("reply", "")
                return parsed

    # No usable object: salvage the picks individually before giving up, so a
    # single malformed entry does not discard its valid siblings.
    salvaged = _salvage_picks(text)
    if salvaged:
        logger.info("recovered %d pick(s) from malformed JSON", len(salvaged))
        return {"reply": "", "recommendations": salvaged}
    return {"reply": raw.strip(), "recommendations": []}


def _strip_code_fences(raw: str) -> str:
    text = raw.strip()
    if not text.startswith("```"):
        return text
    body = text[3:]
    if body.startswith("json"):
        body = body[4:]
    return body.split("```")[0].strip()


def _slice_object(text: str) -> str | None:
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1 or end < start:
        return None
    return text[start : end + 1]


def _drop_trailing_commas(text: str) -> str:
    """Remove commas that sit directly before a closing brace or bracket."""
    return re.sub(r",(\s*[}\]])", r"\1", text)


def _salvage_picks(text: str) -> list[dict[str, str]]:
    """Pull individual {name, brand, reason} triples out of broken JSON.

    Deliberately regex-based rather than json-based: by this point the payload
    is known not to parse, and a deterministic match is enough to recover the
    fields we need. Anything unmatched is discarded, never invented.
    """
    picks: list[dict[str, str]] = []
    pattern = re.compile(
        r'\{[^{}]*?"name"\s*:\s*"(?P<name>[^"]+)"[^{}]*?'
        r'"brand"\s*:\s*"(?P<brand>[^"]+)"'
        r'(?:[^{}]*?"reason"\s*:\s*"(?P<reason>[^"]*)")?[^{}]*?\}',
        re.DOTALL,
    )
    for match in pattern.finditer(text):
        picks.append(
            {
                "name": match.group("name"),
                "brand": match.group("brand"),
                "reason": match.group("reason") or "",
            }
        )
    return picks


def _normalise(value: Any) -> str:
    """Fold a catalogue-facing string into a comparable key.

    Handles HTML entities (Chlo&#233;), accents, curly apostrophes, and
    whitespace so a cosmetic difference cannot reject a real match.
    """
    text = html.unescape(str(value))
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.replace("\u2019", "'").replace("\u2018", "'")
    return re.sub(r"\s+", " ", text).strip().casefold()


def _hydrate(picks: Any) -> list[dict[str, Any]]:
    """Attach catalogue facts to each pick, dropping any name the model invented."""
    if not isinstance(picks, list):
        return []

    by_pair = {(_normalise(f.name), _normalise(f.brand)): f for f in CATALOGUE}
    by_name = {_normalise(f.name): f for f in CATALOGUE}

    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for pick in picks:
        if not isinstance(pick, dict):
            continue
        name, brand = _normalise(pick.get("name", "")), _normalise(pick.get("brand", ""))
        # Fall back to name-only when the model shuffles the brand, but only if
        # that name is unambiguous in the catalogue.
        match = by_pair.get((name, brand)) or by_name.get(name)
        if match is None:
            logger.warning("dropping off-catalogue pick: %r / %r", pick.get("name"), pick.get("brand"))
            continue
        if _normalise(match.name) in seen:
            continue
        seen.add(_normalise(match.name))
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
