/**
 * In-process rate limiting.
 *
 * Deliberately simple: fixed-window counters in a Map. A single Bun process
 * serves this app (HF Space, docker-compose, local), so a shared store would
 * be premature. Growth is bounded by pruning expired buckets on every sweep.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

function sweep(now: number) {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/** Read the client address; Hono/Bun fills `x-forwarded-for` behind a proxy. */
export function clientKey(c: { req: { header: (n: string) => string | undefined } }): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return c.req.header('x-real-ip') || 'unknown';
}

/**
 * Consume one token. Returns null when allowed, or the number of seconds the
 * caller should wait. `windowMs` is the full window, not a sliding average.
 */
export function hit(key: string, limit: number, windowMs: number): number | null {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    if (buckets.size > 10_000) sweep(now);
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return null;
  }
  if (bucket.count >= limit) {
    return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  }
  bucket.count += 1;
  return null;
}

/** Clear the counter for a key (e.g. after a successful login). */
export function reset(key: string): void {
  buckets.delete(key);
}
