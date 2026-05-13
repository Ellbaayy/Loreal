import { Hono } from 'hono';
import { callGroq } from '../groq';

const shop = new Hono();

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

  const raw = await callGroq([{ role: 'user', content: prompt }], 10000);

  if (raw) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end !== -1) {
      try {
        const aiData = JSON.parse(raw.slice(start, end + 1));
        if (aiData?.online && Array.isArray(aiData.online)) {
          return c.json(aiData);
        }
      } catch { }
    }
  }

  return c.json(manualLinks);
});

export default shop;
