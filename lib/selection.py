"""Parsing and validation of the model's selection payload.

Kept separate from both entry points because the drift this guards against is a
property of the model, not of the transport.

The model proposes; this module verifies. Anything not found in the catalogue is
dropped rather than shown, so a hallucinated product cannot reach the user.
"""

from __future__ import annotations

import html
import json
import logging
import re
import unicodedata
from typing import Any

logger = logging.getLogger("lore.selection")


def parse_selection(raw: str) -> dict[str, Any]:
    """Extract the selection object from a model reply.

    Models drift: they wrap JSON in fences, add a sentence of preamble, leave a
    trailing comma, or escape apostrophes as HTML entities. Rejecting the whole
    reply over any of those loses good recommendations, so each is handled.
    """
    text = strip_code_fences(raw)
    candidate = slice_object(text)

    if candidate is not None:
        for attempt in (candidate, drop_trailing_commas(candidate)):
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
    salvaged = salvage_picks(text)
    if salvaged:
        logger.info("recovered %d pick(s) from malformed JSON", len(salvaged))
        return {"reply": "", "recommendations": salvaged}
    return {"reply": raw.strip(), "recommendations": []}


def strip_code_fences(raw: str) -> str:
    text = raw.strip()
    if not text.startswith("```"):
        return text
    body = text[3:]
    if body.startswith("json"):
        body = body[4:]
    return body.split("```")[0].strip()


def slice_object(text: str) -> str | None:
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1 or end < start:
        return None
    return text[start : end + 1]


def drop_trailing_commas(text: str) -> str:
    """Remove commas that sit directly before a closing brace or bracket."""
    return re.sub(r",(\s*[}\]])", r"\1", text)


def salvage_picks(text: str) -> list[dict[str, str]]:
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


def normalise(value: Any) -> str:
    """Fold a catalogue-facing string into a comparable key.

    Handles HTML entities (Chlo&#233;), accents, curly apostrophes, and
    whitespace so a cosmetic difference cannot reject a real match.
    """
    text = html.unescape(str(value))
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.replace("\u2019", "'").replace("\u2018", "'")
    return re.sub(r"\s+", " ", text).strip().casefold()


def resolve(pick_name: Any, pick_brand: Any, catalogue: tuple[Any, ...]) -> Any | None:
    """Find the catalogue entry a pick refers to, or None.

    The model names fragrances inconsistently: sometimes `name` is clean, and
    sometimes it arrives as "Tom Ford — Tobacco Vanille" with the brand folded
    into the name field. Each of those is tried, and a name-only match is
    accepted because catalogue names are unique.
    """
    target_name = normalise(pick_name)
    target_brand = normalise(pick_brand)

    for entry in catalogue:
        entry_name, entry_brand = normalise(entry.name), normalise(entry.brand)
        if target_name == entry_name and target_brand == entry_brand:
            return entry
        if target_name == entry_name:
            return entry
    # Brand folded into the name field, separated by a dash or em dash.
    parts = re.split(r"\s+[-\u2013\u2014]\s+", target_name, maxsplit=1)
    if len(parts) == 2:
        head, tail = parts
        for entry in catalogue:
            if normalise(entry.name) in (head, tail) and (
                not target_brand or normalise(entry.brand) == target_brand
            ):
                return entry
    return None


def hydrate(picks: Any, catalogue: tuple[Any, ...]) -> list[dict[str, Any]]:
    """Attach catalogue facts to each pick, dropping any name the model invented.

    The catalogue is passed in rather than imported so this module stays free of
    filesystem assumptions and both entry points can share it.
    """
    if not isinstance(picks, list):
        return []

    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for pick in picks:
        if not isinstance(pick, dict):
            continue
        match = resolve(pick.get("name", ""), pick.get("brand", ""), catalogue)
        if match is None:
            logger.warning("dropping off-catalogue pick: %r / %r", pick.get("name"), pick.get("brand"))
            continue
        key = normalise(match.name)
        if key in seen:
            continue
        seen.add(key)
        entry = match.to_dict()
        entry["reason"] = str(pick.get("reason", ""))
        out.append(entry)
    return out
