import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import chat from './routes/chat';
import shop from './routes/shop';
import admin from './routes/admin';
import { clientKey, hit } from './ratelimit';
import { ensureSchema } from './db';

const app = new Hono();

const CORS_ORIGIN = (process.env.CORS_ORIGIN || '').trim();
const MAX_BODY = 12 * 1024 * 1024; // multipart: images and audio
const MAX_JSON = 256 * 1024; // chat payloads are text

// ── Security headers ────────────────────────────────────────────────
// No CSP: both pages rely on inline event handlers and the Tailwind CDN, so a
// policy permissive enough to run them ('unsafe-inline') would not stop the
// injection it is meant to stop. Escaping at the render site is the real fix.
app.use('*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Permissions-Policy', 'geolocation=(), camera=(self), microphone=(self)');
  await next();
});

// ── CORS ────────────────────────────────────────────────────────────
// Same-origin by default. Set CORS_ORIGIN to a comma-separated allowlist when
// the frontend is served from another host; `*` is accepted but never combined
// with credentials.
app.use('/api/*', async (c, next) => {
  const origin = c.req.header('origin');
  if (CORS_ORIGIN && origin) {
    const allowed = CORS_ORIGIN.split(',').map((o) => o.trim());
    if (allowed.includes('*') || allowed.includes(origin)) {
      c.header('Access-Control-Allow-Origin', allowed.includes('*') ? '*' : origin);
      c.header('Vary', 'Origin');
      c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      c.header('Access-Control-Max-Age', '600');
    }
  }
  if (c.req.method === 'OPTIONS') return c.body(null, 204);
  await next();
});

// ── Body size ───────────────────────────────────────────────────────
app.use('/api/*', async (c, next) => {
  const length = Number(c.req.header('content-length') || 0);
  const isJson = (c.req.header('content-type') || '').includes('application/json');
  const limit = isJson ? MAX_JSON : MAX_BODY;
  if (length > limit) {
    return c.json({ error: `Payload too large (max ${Math.round(limit / 1024)} KB)` }, 413);
  }
  await next();
});

// ── Rate limits ─────────────────────────────────────────────────────
// Chat calls cost money and seconds; login is the only credential check.
app.use('/api/chat', async (c, next) => {
  const wait = hit(`chat:${clientKey(c)}`, 20, 60_000);
  if (wait) return c.json({ error: `Too many requests, retry in ${wait}s` }, 429);
  await next();
});
app.use('/api/chat/*', async (c, next) => {
  const wait = hit(`chat:${clientKey(c)}`, 20, 60_000);
  if (wait) return c.json({ error: `Too many requests, retry in ${wait}s` }, 429);
  await next();
});
app.use('/api/admin/login', async (c, next) => {
  const wait = hit(`login:${clientKey(c)}`, 5, 60_000);
  if (wait) return c.json({ error: `Too many attempts, retry in ${wait}s` }, 429);
  await next();
});
app.use('/api/shop-info', async (c, next) => {
  const wait = hit(`shop:${clientKey(c)}`, 30, 60_000);
  if (wait) return c.json({ error: `Too many requests, retry in ${wait}s` }, 429);
  await next();
});

app.route('/api', chat);
app.route('/api', shop);
app.route('/api', admin);

// ── Static files ────────────────────────────────────────────────────
// Explicit allowlist. A catch-all `serveStatic({ root: '.' })` served .env,
// .git/config, src/ and the SQL files to anyone who asked.
app.get('/', serveStatic({ path: './index.html' }));
app.get('/index.html', serveStatic({ path: './index.html' }));
app.get('/admin', serveStatic({ path: './admin/index.html' }));
app.get('/admin/', serveStatic({ path: './admin/index.html' }));
app.get('/admin/index.html', serveStatic({ path: './admin/index.html' }));
app.use('/uploads/*', serveStatic({ root: './' }));

app.notFound((c) => {
  if (c.req.path.startsWith('/api/')) return c.json({ error: 'Not found' }, 404);
  return c.text('Not found', 404);
});

app.onError((err, c) => {
  // Malformed JSON is a client error, not a server fault.
  if (err instanceof SyntaxError) return c.json({ error: 'Invalid JSON body' }, 400);
  console.error(`[ERROR] ${c.req.method} ${c.req.path}:`, err);
  return c.json({ error: 'Internal server error' }, 500);
});

await ensureSchema().catch((err) => console.error('[DB] schema check failed:', err));

const port = parseInt(process.env.PORT || process.env.APP_PORT || '7860');
console.log(`🚀 LORE-AI listening on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};
