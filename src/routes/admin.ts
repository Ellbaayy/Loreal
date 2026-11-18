import { Hono, type Context } from 'hono';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { query, execute } from '../db';
import { uploadMedia, sniffImage } from '../storage';
import type { Perfume } from '../types';

const admin = new Hono();

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'group3jaya';
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_IMAGE = 5 * 1024 * 1024;

if (!process.env.ADMIN_PASSWORD) {
  console.warn('[ADMIN] ADMIN_PASSWORD is not set; using the built-in default. Set it before exposing this app.');
}

// ── Tokens ──────────────────────────────────────────────────────────
// The bearer token is an HMAC over its own expiry, keyed by the password, so
// the password itself never travels on every request and a leaked token dies
// after 12 hours. Changing ADMIN_PASSWORD invalidates all outstanding tokens.
function sign(payload: string): string {
  return createHmac('sha256', ADMIN_PASSWORD).update(payload).digest('base64url');
}

function mintToken(): { token: string; expires_at: number } {
  const expires_at = Date.now() + TOKEN_TTL_MS;
  return { token: `${expires_at}.${sign(String(expires_at))}`, expires_at };
}

function verifyToken(token: string | null): boolean {
  if (!token) return false;
  const [expRaw, sig] = token.split('.');
  if (!expRaw || !sig) return false;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = Buffer.from(sign(expRaw));
  const given = Buffer.from(sig);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Constant-time password check: hash first so lengths always match. */
function passwordMatches(input: string): boolean {
  const a = createHash('sha256').update(input).digest();
  const b = createHash('sha256').update(ADMIN_PASSWORD).digest();
  return timingSafeEqual(a, b);
}

function getToken(c: { req: { header: (n: string) => string | undefined } }): string | null {
  const auth = c.req.header('Authorization') || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

function unauthorized(c: Context) {
  return c.json({ error: 'Unauthorized' }, 401);
}

// ── Field handling ──────────────────────────────────────────────────
const FIELD_LIMITS = {
  brand: 120,
  name: 160,
  image_url: 2048,
  scent_family: 120,
  best_occasion: 120,
  mood: 120,
  longevity: 80,
  top_notes: 2000,
  middle_notes: 2000,
  base_notes: 2000,
} as const;

type FieldName = keyof typeof FIELD_LIMITS;

function field(form: FormData, key: FieldName): string {
  const value = form.get(key);
  return typeof value === 'string' ? value.trim().slice(0, FIELD_LIMITS[key]) : '';
}

function safeImageUrl(value: string): string {
  if (!value) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : '';
  } catch {
    return '';
  }
}

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Read the multipart body and return the validated catalogue fields. */
async function readPerfumeForm(c: Context): Promise<{ fields: Record<FieldName, string>; image: File | null } | { error: string }> {
  const form = await c.req.formData();
  const fields = {} as Record<FieldName, string>;
  for (const key of Object.keys(FIELD_LIMITS) as FieldName[]) fields[key] = field(form, key);

  if (!fields.brand || !fields.name) return { error: 'brand and name are required' };
  fields.image_url = safeImageUrl(fields.image_url);

  const image = form.get('image');
  if (image instanceof File && image.size > 0) {
    if (image.size > MAX_IMAGE) return { error: 'Image too large (max 5 MB)' };
    const bytes = new Uint8Array(await image.arrayBuffer());
    if (!sniffImage(bytes)) return { error: 'Unsupported image format (jpg, png, webp, gif only)' };
    return { fields, image };
  }
  return { fields, image: null };
}

// ── Routes ──────────────────────────────────────────────────────────
admin.post('/admin/login', async (c) => {
  const body = await c.req.json<{ password?: unknown }>();
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!password || !passwordMatches(password)) {
    return c.json({ error: 'Invalid password' }, 401);
  }
  return c.json(mintToken());
});

admin.get('/admin/perfumes', async (c) => {
  if (!verifyToken(getToken(c))) return unauthorized(c);
  const rows = await query<Perfume>('SELECT * FROM perfumes ORDER BY id DESC');
  return c.json({ perfumes: rows });
});

admin.post('/admin/perfumes', async (c) => {
  if (!verifyToken(getToken(c))) return unauthorized(c);

  const parsed = await readPerfumeForm(c);
  if ('error' in parsed) return c.json({ error: parsed.error }, 400);

  const { fields, image } = parsed;
  let image_url = fields.image_url;
  if (image) {
    const mediaUrl = await uploadMedia(image, image.name);
    if (mediaUrl) image_url = mediaUrl;
  }

  const result = await execute(
    'INSERT INTO perfumes (brand, name, image_url, scent_family, best_occasion, mood, longevity, top_notes, middle_notes, base_notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [fields.brand, fields.name, image_url, fields.scent_family, fields.best_occasion, fields.mood, fields.longevity, fields.top_notes, fields.middle_notes, fields.base_notes],
  );
  return c.json({ ok: true, id: result.insertId });
});

admin.put('/admin/perfumes/:id', async (c) => {
  if (!verifyToken(getToken(c))) return unauthorized(c);

  const id = parseId(c.req.param('id'));
  if (!id) return c.json({ error: 'Invalid id' }, 400);

  const parsed = await readPerfumeForm(c);
  if ('error' in parsed) return c.json({ error: parsed.error }, 400);

  const { fields, image } = parsed;
  let image_url = fields.image_url;
  if (image) {
    const mediaUrl = await uploadMedia(image, image.name);
    if (mediaUrl) image_url = mediaUrl;
  }

  const result = await execute(
    'UPDATE perfumes SET brand=?, name=?, image_url=?, scent_family=?, best_occasion=?, mood=?, longevity=?, top_notes=?, middle_notes=?, base_notes=? WHERE id=?',
    [fields.brand, fields.name, image_url, fields.scent_family, fields.best_occasion, fields.mood, fields.longevity, fields.top_notes, fields.middle_notes, fields.base_notes, id],
  );
  if (result.affectedRows === 0) return c.json({ error: 'Perfume not found' }, 404);
  return c.json({ ok: true });
});

admin.delete('/admin/perfumes/:id', async (c) => {
  if (!verifyToken(getToken(c))) return unauthorized(c);

  const id = parseId(c.req.param('id'));
  if (!id) return c.json({ error: 'Invalid id' }, 400);

  const result = await execute('DELETE FROM perfumes WHERE id = ?', [id]);
  if (result.affectedRows === 0) return c.json({ error: 'Perfume not found' }, 404);
  return c.json({ ok: true });
});

export default admin;
