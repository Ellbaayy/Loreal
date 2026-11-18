import { Hono, type Context } from 'hono';
import { query, execute } from '../db';
import { callLLM, transcribeAudio, callVision } from '../llm';
import { uploadMedia, sniffImage } from '../storage';
import { getPerfumeDatabase, type Perfume, type AiResponse } from '../types';

const chat = new Hono();

const MAX_MESSAGES = 50;
const MAX_CONTENT = 8000;
const MAX_AUDIO = 10 * 1024 * 1024;
const MAX_IMAGE = 5 * 1024 * 1024;
const VISITOR_RE = /^[A-Za-z0-9_-]{8,64}$/;

interface Recommendation {
  id: number;
  brand: string;
  name: string;
  image_url: string;
  scent_family: string;
  best_occasion: string;
  reason: string;
  detailed_analysis: string;
  who_is_it_for: string;
  popularity_score: number;
  niche_score: number;
  projection: string;
  odor_safe: boolean;
  odor_safe_reason: string;
  longevity: string;
  top_notes: string;
  middle_notes: string;
  base_notes: string;
  mood: string;
}

interface SessionRow {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
}

interface MessageRow {
  role: string;
  content: string;
  image_url: string | null;
  created_at: string;
}

/**
 * Anonymous visitor id. Sessions are scoped to it so one browser cannot read
 * or delete another's conversations. Clients send it as `x-visitor-id`; when
 * absent the server mints one and returns it in the response.
 */
function visitorId(c: Context): string | null {
  const raw = c.req.header('x-visitor-id') || '';
  return VISITOR_RE.test(raw) ? raw : null;
}

function parseSessionId(value: unknown): number | null {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function sanitizeMessages(input: unknown): { role: 'user' | 'assistant'; content: string }[] | null {
  if (!Array.isArray(input) || input.length > MAX_MESSAGES) return null;
  const out: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') return null;
    const { role, content } = raw as { role?: unknown; content?: unknown };
    if (typeof content !== 'string' || content.length > MAX_CONTENT) return null;
    out.push({ role: role === 'assistant' ? 'assistant' : 'user', content });
  }
  return out;
}

function perfumeList(db: Perfume[]) {
  return db.map((p) => ({
    id: p.id,
    name: p.name,
    brand: p.brand,
    family: p.scent_family || '',
    occasion: p.best_occasion || '',
    mood: p.mood || '',
    notes: [p.top_notes, p.middle_notes].filter(Boolean).join(', '),
  }));
}

/** Join the model's picks back to catalogue rows; unknown ids are dropped. */
function parseAi(raw: string | null, db: Perfume[], fallbackText: string) {
  const out: { text: string; ready: boolean; recommendations: Recommendation[] } = {
    text: fallbackText,
    ready: false,
    recommendations: [],
  };
  if (!raw) return out;

  const BT = String.fromCharCode(96);
  const codeFence = BT + BT + BT;
  let cleaned = raw.trim();
  if (cleaned.startsWith(codeFence + 'json')) cleaned = cleaned.slice(7).trim();
  if (cleaned.endsWith(codeFence)) cleaned = cleaned.slice(0, -3).trim();

  let aiData: AiResponse;
  try {
    aiData = JSON.parse(cleaned) as AiResponse;
  } catch {
    return out;
  }
  if (!aiData || typeof aiData.text !== 'string') return out;

  out.text = aiData.text;
  out.ready = !!aiData.ready;
  if (!out.ready || !Array.isArray(aiData.recommendations)) return out;

  const byId = new Map(db.map((p) => [p.id, p]));
  for (const rec of aiData.recommendations.slice(0, 3)) {
    const p = byId.get(rec?.id as number);
    if (!p) continue;
    out.recommendations.push({
      id: p.id,
      brand: p.brand || 'Unknown',
      name: p.name || 'Unknown',
      image_url: p.image_url || '',
      scent_family: p.scent_family || '-',
      best_occasion: p.best_occasion || '-',
      reason: rec.reason || 'A unique match.',
      detailed_analysis: rec.detailed_analysis || 'Matches your style.',
      who_is_it_for: rec.who_is_it_for || 'Everyone.',
      popularity_score: rec.popularity_score ?? 5,
      niche_score: rec.niche_score ?? 5,
      projection: rec.projection || 'Medium',
      odor_safe: rec.odor_safe ?? true,
      odor_safe_reason: rec.odor_safe_reason || 'Safe choice.',
      longevity: p.longevity || '-',
      top_notes: p.top_notes || '-',
      middle_notes: p.middle_notes || '-',
      base_notes: p.base_notes || '-',
      mood: p.mood || '-',
    });
  }
  return out;
}

/** When the model says "ready" but names nothing valid, show real rows. */
function fallbackRecommendations(db: Perfume[]) {
  return db.slice(0, 3).map((p) => ({
    id: p.id,
    brand: p.brand || 'Unknown',
    name: p.name || 'Unknown',
    image_url: p.image_url || '',
    scent_family: p.scent_family || '-',
    best_occasion: p.best_occasion || '-',
    reason:
      'A standout choice from our collection. ' +
      p.name +
      ' by ' +
      p.brand +
      ' features ' +
      (p.top_notes || 'carefully selected notes') +
      ' at the top, with a ' +
      (p.scent_family || 'unique') +
      ' character perfect for those who appreciate quality craftsmanship.',
    detailed_analysis:
      p.name +
      ' opens with ' +
      (p.top_notes || 'a captivating blend') +
      ', unfolds into ' +
      (p.middle_notes || 'an elegant heart') +
      ', and settles on ' +
      (p.base_notes || 'a memorable base') +
      '. The ' +
      (p.scent_family || 'overall composition') +
      ' makes it versatile for various occasions.',
    who_is_it_for: 'Anyone who appreciates distinctive, well-crafted fragrances.',
    popularity_score: 7,
    niche_score: 6,
    projection: 'Medium',
    odor_safe: true,
    odor_safe_reason: 'Generally well-tolerated in most settings.',
    longevity: p.longevity || '-',
    top_notes: p.top_notes || '-',
    middle_notes: p.middle_notes || '-',
    base_notes: p.base_notes || '-',
    mood: p.mood || '-',
  }));
}

/** True when the session exists and belongs to this visitor. */
async function ownsSession(sessionId: number, visitor: string): Promise<boolean> {
  const rows = await query<{ id: number }>(
    'SELECT id FROM chat_sessions WHERE id = ? AND visitor_id = ?',
    [sessionId, visitor],
  );
  return rows.length > 0;
}

async function createSession(title: string, visitor: string): Promise<number> {
  const result = await execute('INSERT INTO chat_sessions (title, visitor_id) VALUES (?, ?)', [
    title.slice(0, 80),
    visitor,
  ]);
  return result.insertId;
}

async function appendMessage(
  sessionId: number,
  role: 'user' | 'assistant',
  content: string,
  imageUrl?: string,
) {
  if (imageUrl) {
    await execute('INSERT INTO chat_messages (session_id, role, content, image_url) VALUES (?, ?, ?, ?)', [
      sessionId,
      role,
      content,
      imageUrl,
    ]);
  } else {
    await execute('INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)', [
      sessionId,
      role,
      content,
    ]);
  }
  await execute('UPDATE chat_sessions SET updated_at = NOW() WHERE id = ?', [sessionId]);
}

function detectLang(text: string): 'id' | 'en' {
  const idWords = ['halo', 'hai', 'hallo', 'apa', 'kabar', 'saya', 'aku', 'kamu', 'parfum', 'wangi', 'untuk', 'yang', 'dan', 'di', 'dengan', 'bisa', 'tolong', 'cari', 'mau', 'ingin', 'pesan', 'iya', 'tidak', 'ya', 'boleh', 'terima', 'kasih', 'selamat', 'pagi', 'siang', 'sore', 'malam', 'baek', 'banget', 'mohon', 'buat', 'dari', 'ke', 'ini', 'itu', 'ada', 'punya', 'pake', 'pakai'];
  const lower = text.toLowerCase().trim();
  const words = lower.split(/\s+/);
  let idScore = 0, enScore = 0;
  for (const w of words) {
    if (idWords.includes(w)) idScore++;
  }
  const enWords = ['hello', 'hi', 'hey', 'good', 'morning', 'evening', 'afternoon', 'please', 'thank', 'you', 'i', 'me', 'my', 'want', 'need', 'looking', 'for', 'recommend', 'perfume', 'fragrance', 'scent', 'the', 'a', 'an', 'is', 'are', 'can', 'could', 'would', 'help'];
  for (const w of words) {
    if (enWords.includes(w)) enScore++;
  }
  if (idScore > enScore) return 'id';
  return 'en';
}

chat.post('/chat', async (c) => {
  const body = await c.req.json<{ messages?: unknown; session_id?: unknown }>();
  const messages = sanitizeMessages(body?.messages);
  if (!messages) {
    return c.json({ error: `messages must be an array of at most ${MAX_MESSAGES} items, each under ${MAX_CONTENT} characters` }, 400);
  }

  const visitor = visitorId(c) || crypto.randomUUID();
  let sessionId = parseSessionId(body?.session_id);

  if (messages.length === 0) {
    return c.json({
      text: "Hello. I'm your AI fragrance concierge. Tell me about the occasion, your mood, or any notes you love.",
      ready: false,
      recommendations: [],
      session_id: null,
      visitor_id: visitor,
    });
  }

  if (sessionId && !(await ownsSession(sessionId, visitor))) {
    return c.json({ error: 'Session not found' }, 403);
  }

  const db = await getPerfumeDatabase();

  try {
    if (!sessionId) {
      sessionId = await createSession(messages[0]?.content || 'New Conversation', visitor);
      for (const m of messages) await appendMessage(sessionId, m.role, m.content);
    } else {
      const existing = await query<{ cnt: number }>(
        'SELECT COUNT(*) as cnt FROM chat_messages WHERE session_id = ?',
        [sessionId],
      );
      const existingCount = existing[0]?.cnt || 0;
      for (const m of messages.slice(existingCount)) await appendMessage(sessionId, m.role, m.content);
      await execute('UPDATE chat_sessions SET updated_at = NOW() WHERE id = ?', [sessionId]);
    }
  } catch (err) {
    console.error('[CHAT] session persist failed:', err);
  }

  const lastUserMsg = messages.filter((m) => m.role === 'user').pop();
  const lang = lastUserMsg ? detectLang(lastUserMsg.content) : 'en';
  const langName = lang === 'id' ? 'Bahasa Indonesia' : 'English';
  const langInstruction = '[IMPORTANT: Reply in ' + langName + '. Your entire response must be in ' + langName + '.]';

  const perfumeJson0 = JSON.stringify(perfumeList(db));
  const systemPrompt = `You are L'ORE-AI, an expert AI Fragrance Concierge.
AVAILABLE PERFUMES DATABASE:
${perfumeJson0}
RULES:
1. LANGUAGE: Reply in the same language as the user. NEVER mix languages.
2. If the user is just greeting (e.g. "halo", "hai", "hallo", "apa kabar", "good morning", "good evening", "hello", "hi", "hey", "how are you") — respond warmly and set "ready" to false. DO NOT give recommendations.
3. If the user mentions perfume needs, preferences, occasions, desires, or anything related to fragrance — ALWAYS select TOP 3 perfumes from the database. Never ask follow-up questions.
4. Assign different focuses for each when recommending: #1 Best Overall Match, #2 Complementary Alternative, #3 Niche/Unique Pick.
5. For each recommendation, provide a thorough reason (3-4 sentences) explaining EXACTLY why this perfume matches the user's specific request — connect their words (e.g. "untuk wanita", "wangi segar", "acara formal", "tahan lama") to this perfume's notes, scent family, mood, and occasion.
6. OUTPUT FORMAT: Return ONLY valid JSON. No markdown. No extra text.
If greeting: {"text": "Warm, friendly response greeting them and inviting them to share their fragrance preferences...", "ready": false}
If giving recommendations: {"text": "Brief elegant transition acknowledging their request...", "ready": true, "recommendations": [{"id": ID, "reason": "3-4 sentences explaining why this perfume matches their specific request — connect their words to this perfume's characteristics", "detailed_analysis": "2-3 sentences breaking down notes & fit", "who_is_it_for": "1 sentence describing the ideal person", "popularity_score": 0-10, "niche_score": 0-10, "projection": "Soft/Medium/Strong", "odor_safe": true/false, "odor_safe_reason": "Short reason"}]}
Keep "text" under 2 sentences. Be luxurious, concise, and conversational.`;

  const llmMessages = messages.map((m, i) => ({
    role: m.role,
    content:
      i === messages.length - 1 && m.role === 'user' ? langInstruction + ' ' + m.content : m.content,
  }));

  const raw = await callLLM([{ role: 'system', content: systemPrompt }, ...llmMessages]);
  const parsed = parseAi(raw, db, 'I encountered an issue. Please try again or rephrase your request.');
  if (parsed.ready && parsed.recommendations.length === 0) {
    parsed.recommendations = fallbackRecommendations(db);
  }

  try {
    if (sessionId) await appendMessage(sessionId, 'assistant', parsed.text);
  } catch (err) {
    console.error('[CHAT] assistant persist failed:', err);
  }

  return c.json({ ...parsed, session_id: sessionId, visitor_id: visitor });
});

chat.post('/chat/with-audio', async (c) => {
  const form = await c.req.formData();
  const audioFile = form.get('audio') as File | null;
  if (!audioFile || audioFile.size === 0) {
    return c.json({ error: 'No audio file provided.' }, 400);
  }
  if (audioFile.size > MAX_AUDIO) {
    return c.json({ error: 'Audio file too large (max 10 MB).' }, 413);
  }

  const visitor = visitorId(c) || crypto.randomUUID();
  let sessionId = parseSessionId(form.get('session_id'));
  if (sessionId && !(await ownsSession(sessionId, visitor))) {
    return c.json({ error: 'Session not found' }, 403);
  }

  const buffer = await audioFile.arrayBuffer();
  const transcript = await transcribeAudio(buffer, audioFile.type);
  if (!transcript) {
    return c.json({ error: 'Failed to transcribe audio.' }, 500);
  }

  try {
    if (!sessionId) sessionId = await createSession(transcript, visitor);
    await appendMessage(sessionId, 'user', transcript);
  } catch (err) {
    console.error('[CHAT] audio session persist failed:', err);
  }

  const db = await getPerfumeDatabase();
  const perfumeJson = JSON.stringify(perfumeList(db));
  const systemPrompt = `You are L'ORE-AI, an expert AI Fragrance Concierge.
AVAILABLE PERFUMES DATABASE:
${perfumeJson}
RULES:
1. LANGUAGE — THIS IS THE MOST IMPORTANT RULE: Analyze the user's latest message and identify its language. Your ENTIRE response MUST be written in EXACTLY that same language. NEVER mix languages.
2. You MUST ALWAYS select TOP 3 perfumes from the database above. Never ask follow-up questions.
3. Assign different focuses: #1 Best Overall Match, #2 Complementary Alternative, #3 Niche/Unique Pick.
4. For each recommendation, provide a thorough reason (3-4 sentences) explaining why this perfume matches the user's request.
5. OUTPUT FORMAT: Return ONLY valid JSON.
{"text": "Brief transition...", "ready": true, "recommendations": [{"id": ID, "reason": "3-4 sentences explaining the match", "detailed_analysis": "2-3 sentences breaking down notes & fit", "who_is_it_for": "1 sentence", "popularity_score": 0-10, "niche_score": 0-10, "projection": "Soft/Medium/Strong", "odor_safe": true/false, "odor_safe_reason": "Short reason"}]}
6. Keep "text" under 2 sentences. Be luxurious, concise, and conversational.`;

  const raw = await callLLM([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: transcript },
  ]);
  const parsed = parseAi(raw, db, '');
  if (parsed.ready && parsed.recommendations.length === 0) {
    parsed.recommendations = fallbackRecommendations(db);
  }

  try {
    if (sessionId) await appendMessage(sessionId, 'assistant', parsed.text);
  } catch (err) {
    console.error('[CHAT] audio assistant persist failed:', err);
  }

  return c.json({ ...parsed, session_id: sessionId, visitor_id: visitor, transcript });
});

chat.post('/chat/with-image', async (c) => {
  const form = await c.req.formData();
  const imageFile = form.get('image') as File | null;
  const textMessage = String(form.get('message') || '').slice(0, MAX_CONTENT);
  if (!imageFile || imageFile.size === 0) {
    return c.json({ error: 'No image file provided.' }, 400);
  }
  if (imageFile.size > MAX_IMAGE) {
    return c.json({ error: 'Image too large (max 5 MB).' }, 413);
  }

  const buffer = await imageFile.arrayBuffer();
  const sniffed = sniffImage(new Uint8Array(buffer));
  if (!sniffed) {
    return c.json({ error: 'Unsupported image format (jpg, png, webp, gif only).' }, 415);
  }

  const visitor = visitorId(c) || crypto.randomUUID();
  let sessionId = parseSessionId(form.get('session_id'));
  if (sessionId && !(await ownsSession(sessionId, visitor))) {
    return c.json({ error: 'Session not found' }, 403);
  }

  const filename = Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.' + sniffed.ext;
  const mediaUrl = (await uploadMedia(buffer, filename)) || '';
  const base64 = Buffer.from(buffer).toString('base64');

  const visionPrompt = textMessage
    ? 'Analyze this perfume-related image. The user says: "' + textMessage + '". Describe what you see and identify the perfume if possible.'
    : 'Analyze this perfume-related image. Describe the perfume bottle, branding, and any visible details. Identify the perfume if possible.';

  const visionResult = await callVision(visionPrompt, base64, sniffed.mime);

  const userContent = textMessage || 'Lihat gambar ini';
  try {
    if (!sessionId) sessionId = await createSession(textMessage || 'Upload gambar', visitor);
    await appendMessage(sessionId, 'user', userContent, mediaUrl);
  } catch (err) {
    console.error('[CHAT] image session persist failed:', err);
  }

  const db = await getPerfumeDatabase();
  const perfumeJson2 = JSON.stringify(perfumeList(db));
  const visionContext = visionResult || 'No description available.';
  const systemPrompt = `You are L'ORE-AI, an expert AI Fragrance Concierge.
AVAILABLE PERFUMES DATABASE:
${perfumeJson2}
RULES:
1. LANGUAGE — THIS IS THE MOST IMPORTANT RULE: Analyze the user's latest message and identify its language. Your ENTIRE response MUST be written in EXACTLY that same language. NEVER mix languages.
2. The user uploaded a photo of a perfume. Use this context: "${visionContext}"
3. You MUST ALWAYS select TOP 3 perfumes from the database. If the uploaded image shows a specific perfume, recommend similar perfumes from the database.
4. For each recommendation, explain why it matches the user's preferences.
5. OUTPUT FORMAT: Return ONLY valid JSON.
{"text": "Brief transition...", "ready": true, "recommendations": [{"id": ID, "reason": "3-4 sentences explaining the match", "detailed_analysis": "2-3 sentences breaking down notes & fit", "who_is_it_for": "1 sentence", "popularity_score": 0-10, "niche_score": 0-10, "projection": "Soft/Medium/Strong", "odor_safe": true/false, "odor_safe_reason": "Short reason"}]}
6. Keep "text" under 2 sentences. Be luxurious, concise, and conversational.`;

  const raw = await callLLM([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ]);
  const parsed = parseAi(raw, db, '');
  if (parsed.ready && parsed.recommendations.length === 0) {
    parsed.recommendations = fallbackRecommendations(db);
  }

  try {
    if (sessionId) await appendMessage(sessionId, 'assistant', parsed.text);
  } catch (err) {
    console.error('[CHAT] image assistant persist failed:', err);
  }

  return c.json({ ...parsed, session_id: sessionId, visitor_id: visitor, vision_analysis: visionResult });
});

chat.get('/sessions', async (c) => {
  const visitor = visitorId(c);
  if (!visitor) return c.json({ sessions: [] });
  const rows = await query<SessionRow>(
    'SELECT s.id, s.title, s.created_at, s.updated_at, COUNT(m.id) as message_count FROM chat_sessions s LEFT JOIN chat_messages m ON m.session_id = s.id WHERE s.visitor_id = ? GROUP BY s.id ORDER BY s.updated_at DESC LIMIT 50',
    [visitor],
  );
  return c.json({ sessions: rows });
});

chat.get('/sessions/:id/messages', async (c) => {
  const id = parseSessionId(c.req.param('id'));
  const visitor = visitorId(c);
  if (!id || !visitor || !(await ownsSession(id, visitor))) {
    return c.json({ error: 'Session not found' }, 404);
  }
  const rows = await query<MessageRow>(
    'SELECT m.role, m.content, m.image_url, m.created_at FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id WHERE m.session_id = ? AND s.visitor_id = ? ORDER BY m.created_at ASC',
    [id, visitor],
  );
  return c.json({ messages: rows });
});

chat.delete('/sessions/:id', async (c) => {
  const id = parseSessionId(c.req.param('id'));
  const visitor = visitorId(c);
  if (!id || !visitor || !(await ownsSession(id, visitor))) {
    return c.json({ error: 'Session not found' }, 404);
  }
  // chat_messages has ON DELETE CASCADE, so one statement is enough.
  await execute('DELETE FROM chat_sessions WHERE id = ? AND visitor_id = ?', [id, visitor]);
  return c.json({ ok: true });
});

export default chat;
