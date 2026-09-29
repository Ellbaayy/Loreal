# L'ORE-AI

An AI fragrance concierge. You describe an occasion, a mood, or notes you
already like, and it picks scents from a fixed catalogue and explains why.

This is the rebuilt service. The previous deployment lost its model
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

That verification has to be forgiving in the right way. The model names things
inconsistently — `Chlo&#233;` instead of `Chloé`, `Tom Ford — Tobacco Vanille`
with the brand folded into the name field, stray trailing commas, a truncated
payload. Each of those is handled in `lib/selection.py`, because rejecting a
whole reply over a cosmetic difference throws away good recommendations.

## Layout

```
api/          Vercel serverless functions (stdlib only, no dependencies)
app/          FastAPI application (alternative deployment)
lib/          Shared domain code: catalogue, model client, response parsing
data/         fragrances.json — the catalogue, and the source of truth
static/       Demo interface
```

`lib/` is framework-free. Neither entry point imports the other, and both use
the same catalogue and the same parser.

## Two deployment targets

### Vercel (serverless)

Vercel does not run a long-lived Python process, so each endpoint is a function
in `api/`:

| Path | File |
| --- | --- |
| `/api/health` | `api/health.py` |
| `/api/catalogue` | `api/catalogue.py` |
| `/api/chat` | `api/chat.py` |
| `/api/chat/stream` | `api/chat_stream.py` (rewritten by `vercel.json`) |
| `/api/shop-info` | `api/shop_info.py` (rewritten by `vercel.json`) |

The functions use only the standard library, so nothing is installed at build
time and cold starts stay short. Set the key in **Project → Settings →
Environment Variables** as `KENARI_API_KEY`, then redeploy.

One caveat, stated plainly: Vercel buffers a function's response, so
`/api/chat/stream` returns the full event stream in a single write. The browser
parses it identically; only the arrival timing differs.

### FastAPI (persistent server)

For real token-by-token streaming, or to run locally:

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r app/requirements.txt
cp .env.example .env      # then fill in KENARI_API_KEY
set -a; source .env; set +a
uvicorn app.main:app --reload
```

Open <http://127.0.0.1:8000>. The header reports which model is live, and says
so plainly when no key is configured rather than failing quietly.

## Configuration

All settings come from the environment. Nothing is hardcoded, and no key is
ever written to a file in this repository.

| Variable | Required | Default |
| --- | --- | --- |
| `KENARI_API_KEY` | yes | — |
| `KENARI_BASE_URL` | no | `https://kenari.id/v1` |
| `LORE_MODEL` | no | `deepseek-v4-1-flash` |

`.env` is gitignored. `.env.example` documents the variable *names* only and
must never hold a value. A key that has been committed stays in the repository
history even after the file is edited — rotate it at the provider instead.

The service starts without a key and reports `llm_configured: false` from
`/api/health`, so a misconfigured deployment fails loudly.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Uptime and whether a key is present. Does not call the model. |
| `GET` | `/api/catalogue` | The full catalogue as JSON |
| `POST` | `/api/chat` | Returns `{ reply, recommendations[] }` |
| `POST` | `/api/chat/stream` | Server-sent events |
| `POST` | `/api/shop-info` | Retailer lookup. Returns `available: false` until a provider is wired. |

### Request

```json
{
  "message": "Date night, something confident but not loud",
  "history": [{ "role": "user", "content": "..." }],
  "reasoning_effort": "low"
}
```

`reasoning_effort` accepts `low`, `high`, or `max`, and is omitted when null.

Browser requests are accepted only from `localhost` and `*.vercel.app`.
Requests without an `Origin` header (curl, server-to-server) pass through.

## Model

`deepseek-v4-1-flash` via the Kenari gateway. Both the model name and the
catalogue are configurable, so switching providers means changing an
environment variable rather than editing code.
