import { Hono } from 'hono';
import { callLLM } from '../llm';

const shop = new Hono();

// The model returns URLs; only these hosts are allowed through. Anything else
// (including javascript: and data:) falls back to the generated search links.
const ALLOWED_HOSTS = ['shopee.co.id', 'tokopedia.com', 'lazada.co.id', 'google.com'];

function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    const host = url.hostname.replace(/^www\./, '');
    return ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith('.' + allowed))
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function buildManualLinks(name: string, brand: string) {
  return {
    online: [
      { platform: 'Shopee', url: `https://shopee.co.id/search?keyword=${encodeURIComponent(`${brand} ${name}`)}` },
      { platform: 'Tokopedia', url: `https://www.tokopedia.com/search?st=product&q=${encodeURIComponent(`${brand} ${name}`)}` },
      { platform: 'Lazada', url: `https://www.lazada.co.id/catalog/?q=${encodeURIComponent(`${brand} ${name}`)}` },
    ],
    offline: {
      advice: 'Visit an official counter or a trusted nearby retailer to ensure product authenticity.',
      map_url: `https://www.google.com/maps/search/${encodeURIComponent(`${brand} official store`)}`,
    },
  };
}

shop.post('/shop-info', async (c) => {
  const body = await c.req.json<{ name?: string; brand?: string }>();
  const name = (body.name || '').trim();
  const brand = (body.brand || '').trim();

  const manualLinks = buildManualLinks(name, brand);

  if (!name || !brand) {
    return c.json(manualLinks);
  }

  const prompt = `You are a Shopping Concierge AI. User wants to buy: ${name} by ${brand}.
TASK: Generate valid search links for Shopee, Tokopedia, Lazada. Create a Google Maps link for nearest official store.
OUTPUT STRICT JSON ONLY (NO markdown, NO extra text):
{
  "online": [
    { "platform": "Shopee", "url": "URL_HERE" },
    { "platform": "Tokopedia", "url": "URL_HERE" },
    { "platform": "Lazada", "url": "URL_HERE" }
  ],
  "offline": {
    "advice": "Short advice text",
    "map_url": "Google Maps URL"
  }
}`;

  const raw = await callLLM([{ role: 'user', content: prompt }], 10000);

  if (raw) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end !== -1) {
      try {
        const aiData = JSON.parse(raw.slice(start, end + 1)) as {
          online?: { platform?: unknown; url?: unknown }[];
          offline?: { advice?: unknown; map_url?: unknown };
        };
        const online = (aiData.online || [])
          .map((link) => ({ platform: String(link?.platform || '').slice(0, 40), url: safeUrl(link?.url) }))
          .filter((link): link is { platform: string; url: string } => Boolean(link.url));
        const mapUrl = safeUrl(aiData.offline?.map_url);
        if (online.length === 3) {
          return c.json({
            online,
            offline: {
              advice: String(aiData.offline?.advice || manualLinks.offline.advice).slice(0, 300),
              map_url: mapUrl || manualLinks.offline.map_url,
            },
          });
        }
      } catch { }
    }
  }

  return c.json(manualLinks);
});

export default shop;
