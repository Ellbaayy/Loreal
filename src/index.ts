import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import chat from './routes/chat';
import shop from './routes/shop';
import admin from './routes/admin';

const app = new Hono();

app.use('/*', async (c, next) => {
  c.res.headers.set('Access-Control-Allow-Origin', '*');
  c.res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  c.res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (c.req.method === 'OPTIONS') return c.body(null, 204);
  await next();
});

app.route('/api', chat);
app.route('/api', shop);
app.route('/api', admin);

app.use('/uploads/*', serveStatic({ root: '.' }));
app.use('/admin/*', serveStatic({ root: './admin' }));
app.use('/*', serveStatic({ root: '.' }));

const port = parseInt(process.env.PORT || process.env.APP_PORT || '7860');

console.log(`🚀 LORE-AI Server running on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};
