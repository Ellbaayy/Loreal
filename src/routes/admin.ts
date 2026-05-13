import { Hono } from 'hono';
import { query, execute } from '../db';
import { uploadToImgbb } from '../imgbb';
import type { Perfume } from '../types';

const admin = new Hono();
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'group3jaya';

function unauthorized(c: any) {
  return c.json({ error: 'Unauthorized' }, 401);
}

function getToken(c: any): string | null {
  const auth = c.req.header('Authorization') || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

admin.post('/admin/login', async (c) => {
  const body = await c.req.json<{ password?: string }>();
  if (body.password === ADMIN_PASS) {
    return c.json({ token: ADMIN_PASS }); // simple token = password
  }
  return c.json({ error: 'Invalid password' }, 401);
});

admin.get('/admin/perfumes', async (c) => {
  if (getToken(c) !== ADMIN_PASS) return unauthorized(c);
  const rows = await query<Perfume>('SELECT * FROM perfumes ORDER BY id DESC');
  return c.json({ perfumes: rows });
});

admin.post('/admin/perfumes', async (c) => {
  if (getToken(c) !== ADMIN_PASS) return unauthorized(c);

  const form = await c.req.formData();
  const brand = (form.get('brand') as string) || '';
  const name = (form.get('name') as string) || '';
  const scent_family = (form.get('scent_family') as string) || '';
  const best_occasion = (form.get('best_occasion') as string) || '';
  const mood = (form.get('mood') as string) || '';
  const longevity = (form.get('longevity') as string) || '';
  const top_notes = (form.get('top_notes') as string) || '';
  const middle_notes = (form.get('middle_notes') as string) || '';
  const base_notes = (form.get('base_notes') as string) || '';
  let image_url = (form.get('current_image') as string) || '';

  const imageFile = form.get('image') as File | null;
  if (imageFile && imageFile.size > 0) {
    const ext = imageFile.name.split('.').pop()?.toLowerCase() || 'jpg';
    const allowed = ['jpg', 'jpeg', 'png', 'webp'];
    if (allowed.includes(ext)) {
      const imgbbUrl = await uploadToImgbb(imageFile, imageFile.name);
      if (imgbbUrl) image_url = imgbbUrl;
    } else {
      return c.json({ error: 'Format file tidak diizinkan (Hanya JPG, JPEG, PNG, WEBP).' }, 400);
    }
  }

  const result = await execute(
    'INSERT INTO perfumes (brand, name, image_url, scent_family, best_occasion, mood, longevity, top_notes, middle_notes, base_notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [brand, name, image_url, scent_family, best_occasion, mood, longevity, top_notes, middle_notes, base_notes]
  );
  return c.json({ ok: true, id: result.insertId });
});

admin.put('/admin/perfumes/:id', async (c) => {
  if (getToken(c) !== ADMIN_PASS) return unauthorized(c);

  const id = parseInt(c.req.param('id'));
  const form = await c.req.formData();
  const brand = (form.get('brand') as string) || '';
  const name = (form.get('name') as string) || '';
  const scent_family = (form.get('scent_family') as string) || '';
  const best_occasion = (form.get('best_occasion') as string) || '';
  const mood = (form.get('mood') as string) || '';
  const longevity = (form.get('longevity') as string) || '';
  const top_notes = (form.get('top_notes') as string) || '';
  const middle_notes = (form.get('middle_notes') as string) || '';
  const base_notes = (form.get('base_notes') as string) || '';
  let image_url = (form.get('current_image') as string) || '';

  const imageFile = form.get('image') as File | null;
  if (imageFile && imageFile.size > 0) {
    const ext = imageFile.name.split('.').pop()?.toLowerCase() || 'jpg';
    const allowed = ['jpg', 'jpeg', 'png', 'webp'];
    if (allowed.includes(ext)) {
      const imgbbUrl = await uploadToImgbb(imageFile, imageFile.name);
      if (imgbbUrl) image_url = imgbbUrl;
    } else {
      return c.json({ error: 'Format file tidak diizinkan (Hanya JPG, JPEG, PNG, WEBP).' }, 400);
    }
  }

  await execute(
    'UPDATE perfumes SET brand=?, name=?, image_url=?, scent_family=?, best_occasion=?, mood=?, longevity=?, top_notes=?, middle_notes=?, base_notes=? WHERE id=?',
    [brand, name, image_url, scent_family, best_occasion, mood, longevity, top_notes, middle_notes, base_notes, id]
  );
  return c.json({ ok: true });
});

admin.delete('/admin/perfumes/:id', async (c) => {
  if (getToken(c) !== ADMIN_PASS) return unauthorized(c);

  const id = parseInt(c.req.param('id'));
  await execute('DELETE FROM perfumes WHERE id = ?', [id]);
  return c.json({ ok: true });
});

export default admin;
