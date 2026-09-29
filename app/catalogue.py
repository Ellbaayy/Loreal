"""Fragrance catalogue and the domain logic that builds model prompts from it."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path

DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "fragrances.json"


@dataclass(frozen=True)
class Fragrance:
    name: str
    brand: str
    family: str
    notes: tuple[str, ...]
    moods: tuple[str, ...]
    occasions: tuple[str, ...]
    longevity: str

    def to_dict(self) -> dict[str, object]:
        payload = asdict(self)
        payload["notes"] = list(self.notes)
        payload["moods"] = list(self.moods)
        payload["occasions"] = list(self.occasions)
        return payload


def load_catalogue(path: Path = DATA_PATH) -> tuple[Fragrance, ...]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    return tuple(
        Fragrance(
            name=item["name"],
            brand=item["brand"],
            family=item["family"],
            notes=tuple(item["notes"]),
            moods=tuple(item["moods"]),
            occasions=tuple(item["occasions"]),
            longevity=item["longevity"],
        )
        for item in raw
    )


SYSTEM_PROMPT = """You are L'ORE-AI, a fragrance concierge.

You recommend scents from the catalogue you are given. Never invent a fragrance \
that is not in the catalogue, and never invent notes for one that is. If the \
catalogue holds nothing suitable, say so plainly and suggest what kind of scent \
the user should look for instead.

Ask at most one clarifying question when the request is too vague to act on. \
Otherwise answer directly.

Voice: warm, precise, a little understated. No marketing exhalation, no emoji \
strings, no bulleted wall of text. Two or three short sentences per \
recommendation, and name the notes that justify the pick."""


def build_catalogue_block(catalogue: tuple[Fragrance, ...]) -> str:
    lines = []
    for f in catalogue:
        lines.append(
            f"- {f.brand} — {f.name} | family: {f.family} | "
            f"notes: {', '.join(f.notes)} | "
            f"good for: {', '.join(f.moods)} | "
            f"occasions: {', '.join(f.occasions)} | longevity: {f.longevity}"
        )
    return "\n".join(lines)


def build_selection_prompt(catalogue: tuple[Fragrance, ...], query: str) -> str:
    """Prompt used for the structured pick, which powers the result cards."""
    return (
        f"Catalogue:\n{build_catalogue_block(catalogue)}\n\n"
        f"User request: {query}\n\n"
        "Reply with JSON only, no prose and no code fences, shaped exactly as:\n"
        '{"recommendations":[{"name":"<exact catalogue name>",'
        '"brand":"<exact catalogue brand>","reason":"<one sentence>"}],'
        '"reply":"<one or two conversational sentences for the user>"}\n'
        "Give one to three recommendations. Every name and brand must appear "
        "verbatim in the catalogue."
    )
