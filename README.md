# L'ORE-AI

An AI fragrance concierge. You describe an occasion, a mood, or notes you
already like, and it picks scents from a fixed catalogue and explains why.

This is the rebuilt backend. The previous deployment lost its model
configuration and answered every message with a static greeting, so the
inference layer was rewritten against a current model.

## How it works

```
POST /api/chat
  -> system prompt (voice + "never invent a fragrance")
  -> catalogue dumped into the prompt as grounding context
  -> model returns JSON: { recommendations[], reply }
  -> every recommended name is matched back against the catalogue
  -> unknown names are dropped and logged, never shown
```

The last step is the point. A recommender that can hallucinate products is
worse than no recommender, so the model proposes and the server verifies.
`data/fragrances.json` is the source of truth.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/` | Demo interface |
| `GET` | `/health` | Uptime plus whether a key is configured. Does not call the model. |
| `GET` | `/api/catalogue` | The full catalogue as JSON |
| `POST` | `/api/chat` | Returns `{ reply, recommendations[] }` |
| `POST` | `/api/chat/stream` | Server-sent events, token by token |

### Request

```json
{
  "message": "Date night, something confident but not loud",
  "history": [{ "role": "user", "content": "..." }],
  "reasoning_effort": "low"
}
```

`reasoning_effort` accepts `low`, `high`, or `max`, and is omitted when null.

## Configuration

All settings come from the environment. Nothing is hardcoded, and no key is
ever written to a file in this repository.

| Variable | Required | Default |
| --- | --- | --- |
| `KENARI_API_KEY` | yes | — |
| `KENARI_BASE_URL` | no | `https://kenari.id/v1` |
| `LORE_MODEL` | no | `deepseek-v4-1-flash` |

The service starts without a key and reports `llm_configured: false` from
`/health`, so a misconfigured deployment fails loudly instead of silently
returning canned text.

## Running locally

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export KENARI_API_KEY=your_key_here
uvicorn app.main:app --reload
```

## Deploying to a Hugging Face Space

1. Create a new **Docker** Space (this repo ships a `Dockerfile`).
2. Push this directory to the Space.
3. Open **Settings → Variables and secrets → New secret**, add
   `KENARI_API_KEY`, and paste the key there. Secrets are injected as
   environment variables and are never readable from the repository.
4. The Space listens on port `7860`, which is what the Dockerfile exposes.

Rotate the key from the provider dashboard if it has ever been pasted into a
chat, a file, or a commit. A key that has been exposed stays exposed.

## Model

`deepseek-v4-1-flash` via the Kenari gateway. The catalogue and the model
name are both configurable, so switching providers means changing an
environment variable rather than editing code.
