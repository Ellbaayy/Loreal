import { Hono } from 'hono';
import { query, execute } from '../db';
import { callLLM, transcribeAudio, callVision } from '../llm';
import { uploadMedia } from '../storage';
import { getPerfumeDatabase, type Perfume, type ChatSession, type AiResponse } from '../types';

const chat = new Hono();

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
  const body = await c.req.json<{ messages?: { role: string; content: string }[]; session_id?: number | null }>();
  const messages = body.messages || [];
  let sessionId = body.session_id || null;

  if (messages.length === 0) {
    return c.json({ text: "Hello. I'm your AI fragrance concierge. Tell me about the occasion, your mood, or any notes you love.", ready: false, recommendations: [], session_id: null });
  }

  const db = await getPerfumeDatabase();

  const perfumeListForAI = db.map((p) => ({
    id: p.id,
    name: p.name,
    brand: p.brand,
    family: p.scent_family || '',
    occasion: p.best_occasion || '',
    mood: p.mood || '',
    notes: [p.top_notes, p.middle_notes].filter(Boolean).join(', '),
  }));

  try {
    const sessions = await query<ChatSession>('SELECT id FROM chat_sessions LIMIT 0');
    const hasDB = sessions !== undefined;

    if (hasDB) {
      if (!sessionId) {
        const title = (messages[0]?.content || 'New Conversation').slice(0, 80);
        const result = await execute('INSERT INTO chat_sessions (title) VALUES (?)', [title]);
        sessionId = result.insertId;
        for (const m of messages) {
          await execute('INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)', [sessionId, m.role, m.content]);
        }
      } else {
        const existing = await query<{ cnt: number }>('SELECT COUNT(*) as cnt FROM chat_messages WHERE session_id = ?', [sessionId]);
        const existingCount = existing[0]?.cnt || 0;
        const newMessages = messages.slice(existingCount);
        for (const m of newMessages) {
          await execute('INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)', [sessionId, m.role, m.content]);
        }
        await execute('UPDATE chat_sessions SET updated_at = NOW() WHERE id = ?', [sessionId]);
      }
    }
  } catch { }

    const lastUserMsg = messages.filter(m => m.role === 'user').pop();
  const lang = lastUserMsg ? detectLang(lastUserMsg.content) : 'en';
  const langName = lang === 'id' ? 'Bahasa Indonesia' : 'English';
  const langInstruction = '[IMPORTANT: Reply in ' + langName + '. Your entire response must be in ' + langName + '.]';

  const perfumeJson0 = JSON.stringify(perfumeListForAI);
  const systemPrompt = 'You are L\'ORE-AI, an expert AI Fragrance Concierge.\nAVAILABLE PERFUMES DATABASE:\n' + perfumeJson0 + '\nRULES:\n1. LANGUAGE: Reply in the same language as the user. NEVER mix languages.\n2. If the user is just greeting (e.g. "halo", "hai", "hallo", "apa kabar", "good morning", "good evening", "hello", "hi", "hey", "how are you") — respond warmly and set "ready" to false. DO NOT give recommendations.\n3. If the user mentions perfume needs, preferences, occasions, desires, or anything related to fragrance — ALWAYS select TOP 3 perfumes from the database. Never ask follow-up questions.\n4. Assign different focuses for each when recommending: #1 Best Overall Match, #2 Complementary Alternative, #3 Niche/Unique Pick.\n5. For each recommendation, provide a thorough reason (3-4 sentences) explaining EXACTLY why this perfume matches the user\'s specific request — connect their words (e.g. "untuk wanita", "wangi segar", "acara formal", "tahan lama") to this perfume\'s notes, scent family, mood, and occasion.\n6. OUTPUT FORMAT: Return ONLY valid JSON. No markdown. No extra text.\nIf greeting: {"text": "Warm, friendly response greeting them and inviting them to share their fragrance preferences...", "ready": false}\nIf giving recommendations: {"text": "Brief elegant transition acknowledging their request...", "ready": true, "recommendations": [{"id": ID, "reason": "3-4 sentences explaining why this perfume matches their specific request — connect their words to this perfume\'s characteristics", "detailed_analysis": "2-3 sentences breaking down notes & fit", "who_is_it_for": "1 sentence describing the ideal person", "popularity_score": 0-10, "niche_score": 0-10, "projection": "Soft/Medium/Strong", "odor_safe": true/false, "odor_safe_reason": "Short reason"}]}\nKeep "text" under 2 sentences. Be luxurious, concise, and conversational.';

  let finalOutput: any = { text: 'I encountered an issue. Please try again or rephrase your request.', ready: false, recommendations: [], session_id: sessionId };

  const groqMessages = messages.map((m, i) => {
    const role = m.role as 'user' | 'assistant';
    const content = i === messages.length - 1 && m.role === 'user'
      ? langInstruction + ' ' + m.content
      : m.content;
    return { role, content };
  });

  const raw = await callLLM([
    { role: 'system', content: systemPrompt },
    ...groqMessages,
  ]);

  if (raw) {
    const BT = String.fromCharCode(96);
    const codeFence = BT + BT + BT;
    let cleaned = raw.trim();
    if (cleaned.startsWith(codeFence + 'json')) cleaned = cleaned.slice(7).trim();
    if (cleaned.endsWith(codeFence)) cleaned = cleaned.slice(0, -3).trim();
    try {
      const aiData = JSON.parse(cleaned) as AiResponse;
      if (aiData.text) {
        finalOutput.text = aiData.text;
        finalOutput.ready = !!aiData.ready;
        if (finalOutput.ready && aiData.recommendations?.length) {
          const dbMap = new Map(db.map((p) => [p.id, p]));
          for (const rec of aiData.recommendations.slice(0, 3)) {
            const p = dbMap.get(rec.id);
            if (p) {
              finalOutput.recommendations.push({
                id: p.id, brand: p.brand || 'Unknown', name: p.name || 'Unknown', image_url: p.image_url || '',
                scent_family: p.scent_family || '-', best_occasion: p.best_occasion || '-',
                reason: rec.reason || 'A unique match.',
                detailed_analysis: rec.detailed_analysis || 'Matches your style.',
                who_is_it_for: rec.who_is_it_for || 'Everyone.',
                popularity_score: rec.popularity_score ?? 5, niche_score: rec.niche_score ?? 5,
                projection: rec.projection || 'Medium',
                odor_safe: rec.odor_safe ?? true, odor_safe_reason: rec.odor_safe_reason || 'Safe choice.',
                longevity: p.longevity || '-', top_notes: p.top_notes || '-',
                middle_notes: p.middle_notes || '-', base_notes: p.base_notes || '-', mood: p.mood || '-',
              });
            }
          }
        }
      }
    } catch { }
  }

  if (finalOutput.ready && !finalOutput.recommendations.length) {
    const fallbacks = db.slice(0, 3);
    for (const p of fallbacks) {
      finalOutput.recommendations.push({
        id: p.id, brand: p.brand || 'Unknown', name: p.name || 'Unknown', image_url: p.image_url || '',
        scent_family: p.scent_family || '-', best_occasion: p.best_occasion || '-',
        reason: 'A standout choice from our collection. ' + p.name + ' by ' + p.brand + ' features ' + (p.top_notes || 'carefully selected notes') + ' at the top, with a ' + (p.scent_family || 'unique') + ' character perfect for those who appreciate quality craftsmanship.',
        detailed_analysis: p.name + ' opens with ' + (p.top_notes || 'a captivating blend') + ', unfolds into ' + (p.middle_notes || 'an elegant heart') + ', and settles on ' + (p.base_notes || 'a memorable base') + '. The ' + (p.scent_family || 'overall composition') + ' makes it versatile for various occasions.',
        who_is_it_for: 'Anyone who appreciates distinctive, well-crafted fragrances.',
        popularity_score: 7, niche_score: 6,
        projection: 'Medium',
        odor_safe: true, odor_safe_reason: 'Generally well-tolerated in most settings.',
        longevity: p.longevity || '-', top_notes: p.top_notes || '-',
        middle_notes: p.middle_notes || '-', base_notes: p.base_notes || '-', mood: p.mood || '-',
      });
    }
  }

  try {
    if (sessionId) {
      await execute("INSERT INTO chat_messages (session_id, role, content) VALUES (?, 'assistant', ?)", [sessionId, finalOutput.text]);
      await execute('UPDATE chat_sessions SET updated_at = NOW() WHERE id = ?', [sessionId]);
    }
  } catch { }

  return c.json(finalOutput);
});

chat.post('/chat/with-audio', async (c) => {
  const form = await c.req.formData();
  const audioFile = form.get('audio') as File | null;
  const sessionIdParam = form.get('session_id') as string | null;
  let sessionId = sessionIdParam ? parseInt(sessionIdParam) : null;

  if (!audioFile) {
    return c.json({ error: 'No audio file provided.' }, 400);
  }

  const buffer = await audioFile.arrayBuffer();
  const transcript = await transcribeAudio(buffer, audioFile.type);

  if (!transcript) {
    return c.json({ error: 'Failed to transcribe audio.' }, 500);
  }

  const messages = [{ role: 'user', content: transcript }];

  try {
    const sessions = await query<ChatSession>('SELECT id FROM chat_sessions LIMIT 0');
    const hasDB = sessions !== undefined;
    if (hasDB) {
      if (!sessionId) {
        const title = transcript.slice(0, 80);
        const result = await execute('INSERT INTO chat_sessions (title) VALUES (?)', [title]);
        sessionId = result.insertId;
      }
      await execute('INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)', [sessionId, 'user', transcript]);
    }
  } catch { }

  const db = await getPerfumeDatabase();
  const perfumeListForAI = db.map((p) => ({
    id: p.id, name: p.name, brand: p.brand, family: p.scent_family || '',
    occasion: p.best_occasion || '', mood: p.mood || '',
    notes: [p.top_notes, p.middle_notes].filter(Boolean).join(', '),
  }));

  const perfumeJson = JSON.stringify(perfumeListForAI);
  const systemPrompt = 'You are L\'ORE-AI, an expert AI Fragrance Concierge.\nAVAILABLE PERFUMES DATABASE:\n' + perfumeJson + '\nRULES:\n1. LANGUAGE — THIS IS THE MOST IMPORTANT RULE: Analyze the user\'s latest message and identify its language. Your ENTIRE response MUST be written in EXACTLY that same language. NEVER mix languages.\n2. You MUST ALWAYS select TOP 3 perfumes from the database above. Never ask follow-up questions.\n3. Assign different focuses: #1 Best Overall Match, #2 Complementary Alternative, #3 Niche/Unique Pick.\n4. For each recommendation, provide a thorough reason (3-4 sentences) explaining why this perfume matches the user\'s request.\n5. OUTPUT FORMAT: Return ONLY valid JSON.\n{"text": "Brief transition...", "ready": true, "recommendations": [{"id": ID, "reason": "3-4 sentences explaining the match", "detailed_analysis": "2-3 sentences breaking down notes & fit", "who_is_it_for": "1 sentence", "popularity_score": 0-10, "niche_score": 0-10, "projection": "Soft/Medium/Strong", "odor_safe": true/false, "odor_safe_reason": "Short reason"}]}\n6. Keep "text" under 2 sentences. Be luxurious, concise, and conversational.';

  let finalOutput: any = { text: '', ready: false, recommendations: [], session_id: sessionId, transcript };

  const raw = await callLLM([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: transcript },
  ]);

  if (raw) {
    const BT = String.fromCharCode(96);
    const codeFence = BT + BT + BT;
    let cleaned = raw.trim();
    if (cleaned.startsWith(codeFence + 'json')) cleaned = cleaned.slice(7).trim();
    if (cleaned.endsWith(codeFence)) cleaned = cleaned.slice(0, -3).trim();
    try {
      const aiData = JSON.parse(cleaned) as AiResponse;
      if (aiData.text) {
        finalOutput.text = aiData.text;
        finalOutput.ready = !!aiData.ready;
        if (finalOutput.ready && aiData.recommendations?.length) {
          const dbMap = new Map(db.map((p) => [p.id, p]));
          for (const rec of aiData.recommendations.slice(0, 3)) {
            const p = dbMap.get(rec.id);
            if (p) {
              finalOutput.recommendations.push({
                id: p.id, brand: p.brand || 'Unknown', name: p.name || 'Unknown', image_url: p.image_url || '',
                scent_family: p.scent_family || '-', best_occasion: p.best_occasion || '-',
                reason: rec.reason || 'A unique match.',
                detailed_analysis: rec.detailed_analysis || 'Matches your style.',
                who_is_it_for: rec.who_is_it_for || 'Everyone.',
                popularity_score: rec.popularity_score ?? 5, niche_score: rec.niche_score ?? 5,
                projection: rec.projection || 'Medium',
                odor_safe: rec.odor_safe ?? true, odor_safe_reason: rec.odor_safe_reason || 'Safe choice.',
                longevity: p.longevity || '-', top_notes: p.top_notes || '-',
                middle_notes: p.middle_notes || '-', base_notes: p.base_notes || '-', mood: p.mood || '-',
              });
            }
          }
        }
      }
    } catch { }
  }

  if (finalOutput.ready && !finalOutput.recommendations.length) {
    const fallbacks = db.slice(0, 3);
    for (const p of fallbacks) {
      finalOutput.recommendations.push({
        id: p.id, brand: p.brand || 'Unknown', name: p.name || 'Unknown', image_url: p.image_url || '',
        scent_family: p.scent_family || '-', best_occasion: p.best_occasion || '-',
        reason: 'A standout choice from our collection. ' + p.name + ' by ' + p.brand + ' features ' + (p.top_notes || 'carefully selected notes') + '.',
        detailed_analysis: p.name + ' opens with ' + (p.top_notes || 'a captivating blend') + '.',
        who_is_it_for: 'Anyone who appreciates distinctive fragrances.',
        popularity_score: 7, niche_score: 6, projection: 'Medium',
        odor_safe: true, odor_safe_reason: 'Well-tolerated in most settings.',
        longevity: p.longevity || '-', top_notes: p.top_notes || '-',
        middle_notes: p.middle_notes || '-', base_notes: p.base_notes || '-', mood: p.mood || '-',
      });
    }
  }

  try {
    if (sessionId) {
      await execute("INSERT INTO chat_messages (session_id, role, content) VALUES (?, 'assistant', ?)", [sessionId, finalOutput.text]);
      await execute('UPDATE chat_sessions SET updated_at = NOW() WHERE id = ?', [sessionId]);
    }
  } catch { }

  return c.json(finalOutput);
});

chat.post('/chat/with-image', async (c) => {
  const form = await c.req.formData();
  const imageFile = form.get('image') as File | null;
  const textMessage = (form.get('message') as string) || '';
  const sessionIdParam = form.get('session_id') as string | null;
  let sessionId = sessionIdParam ? parseInt(sessionIdParam) : null;

  if (!imageFile) {
    return c.json({ error: 'No image file provided.' }, 400);
  }

  const buffer = await imageFile.arrayBuffer();
  const ext = imageFile.name.split('.').pop() || 'jpg';
  const filename = Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.' + ext;

  const mediaUrl = await uploadMedia(buffer, filename);
  const imageUrl = mediaUrl || '';

  const base64 = Buffer.from(buffer).toString('base64');

  const visionPrompt = textMessage
    ? 'Analyze this perfume-related image. The user says: "' + textMessage + '". Describe what you see and identify the perfume if possible.'
    : 'Analyze this perfume-related image. Describe the perfume bottle, branding, and any visible details. Identify the perfume if possible.';

  const visionResult = await callVision(visionPrompt, base64, imageFile.type || 'image/jpeg');

  const userContent = textMessage || 'Lihat gambar ini';
  const messages = [{ role: 'user', content: userContent }];

  try {
    const sessions = await query<ChatSession>('SELECT id FROM chat_sessions LIMIT 0');
    const hasDB = sessions !== undefined;
    if (hasDB) {
      if (!sessionId) {
        const title = (textMessage || 'Upload gambar').slice(0, 80);
        const result = await execute('INSERT INTO chat_sessions (title) VALUES (?)', [title]);
        sessionId = result.insertId;
      }
      await execute('INSERT INTO chat_messages (session_id, role, content, image_url) VALUES (?, ?, ?, ?)', [sessionId, 'user', userContent, imageUrl]);
    }
  } catch { }

  const db = await getPerfumeDatabase();
  const perfumeListForAI = db.map((p) => ({
    id: p.id, name: p.name, brand: p.brand, family: p.scent_family || '',
    occasion: p.best_occasion || '', mood: p.mood || '',
    notes: [p.top_notes, p.middle_notes].filter(Boolean).join(', '),
  }));

  const perfumeJson2 = JSON.stringify(perfumeListForAI);
  const visionContext = visionResult || 'No description available.';
  const systemPrompt = 'You are L\'ORE-AI, an expert AI Fragrance Concierge.\nAVAILABLE PERFUMES DATABASE:\n' + perfumeJson2 + '\nRULES:\n1. LANGUAGE — THIS IS THE MOST IMPORTANT RULE: Analyze the user\'s latest message and identify its language. Your ENTIRE response MUST be written in EXACTLY that same language. NEVER mix languages.\n2. The user uploaded a photo of a perfume. Use this context: "' + visionContext + '"\n3. You MUST ALWAYS select TOP 3 perfumes from the database. If the uploaded image shows a specific perfume, recommend similar perfumes from the database.\n4. For each recommendation, explain why it matches the user\'s preferences.\n5. OUTPUT FORMAT: Return ONLY valid JSON.\n{"text": "Brief transition...", "ready": true, "recommendations": [{"id": ID, "reason": "3-4 sentences explaining the match", "detailed_analysis": "2-3 sentences breaking down notes & fit", "who_is_it_for": "1 sentence", "popularity_score": 0-10, "niche_score": 0-10, "projection": "Soft/Medium/Strong", "odor_safe": true/false, "odor_safe_reason": "Short reason"}]}\n6. Keep "text" under 2 sentences. Be luxurious, concise, and conversational.';

  let finalOutput: any = { text: '', ready: false, recommendations: [], session_id: sessionId, vision_analysis: visionResult };

  const raw = await callLLM([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ]);

  if (raw) {
    const BT = String.fromCharCode(96);
    const codeFence = BT + BT + BT;
    let cleaned = raw.trim();
    if (cleaned.startsWith(codeFence + 'json')) cleaned = cleaned.slice(7).trim();
    if (cleaned.endsWith(codeFence)) cleaned = cleaned.slice(0, -3).trim();
    try {
      const aiData = JSON.parse(cleaned) as AiResponse;
      if (aiData.text) {
        finalOutput.text = aiData.text;
        finalOutput.ready = !!aiData.ready;
        if (finalOutput.ready && aiData.recommendations?.length) {
          const dbMap = new Map(db.map((p) => [p.id, p]));
          for (const rec of aiData.recommendations.slice(0, 3)) {
            const p = dbMap.get(rec.id);
            if (p) {
              finalOutput.recommendations.push({
                id: p.id, brand: p.brand || 'Unknown', name: p.name || 'Unknown', image_url: p.image_url || '',
                scent_family: p.scent_family || '-', best_occasion: p.best_occasion || '-',
                reason: rec.reason || 'A unique match.',
                detailed_analysis: rec.detailed_analysis || 'Matches your style.',
                who_is_it_for: rec.who_is_it_for || 'Everyone.',
                popularity_score: rec.popularity_score ?? 5, niche_score: rec.niche_score ?? 5,
                projection: rec.projection || 'Medium',
                odor_safe: rec.odor_safe ?? true, odor_safe_reason: rec.odor_safe_reason || 'Safe choice.',
                longevity: p.longevity || '-', top_notes: p.top_notes || '-',
                middle_notes: p.middle_notes || '-', base_notes: p.base_notes || '-', mood: p.mood || '-',
              });
            }
          }
        }
      }
    } catch { }
  }

  if (finalOutput.ready && !finalOutput.recommendations.length) {
    const fallbacks = db.slice(0, 3);
    for (const p of fallbacks) {
      finalOutput.recommendations.push({
        id: p.id, brand: p.brand || 'Unknown', name: p.name || 'Unknown', image_url: p.image_url || '',
        scent_family: p.scent_family || '-', best_occasion: p.best_occasion || '-',
        reason: 'A standout choice from our collection. ' + p.name + ' by ' + p.brand + ' features ' + (p.top_notes || 'carefully selected notes') + '.',
        detailed_analysis: p.name + ' opens with ' + (p.top_notes || 'a captivating blend') + '.',
        who_is_it_for: 'Anyone who appreciates distinctive fragrances.',
        popularity_score: 7, niche_score: 6, projection: 'Medium',
        odor_safe: true, odor_safe_reason: 'Well-tolerated in most settings.',
        longevity: p.longevity || '-', top_notes: p.top_notes || '-',
        middle_notes: p.middle_notes || '-', base_notes: p.base_notes || '-', mood: p.mood || '-',
      });
    }
  }

  try {
    if (sessionId) {
      await execute("INSERT INTO chat_messages (session_id, role, content) VALUES (?, 'assistant', ?)", [sessionId, finalOutput.text]);
      await execute('UPDATE chat_sessions SET updated_at = NOW() WHERE id = ?', [sessionId]);
    }
  } catch { }

  return c.json(finalOutput);
});

chat.get('/sessions', async (c) => {
  try {
    const rows = await query<any>('SELECT s.id, s.title, s.created_at, s.updated_at, COUNT(m.id) as message_count FROM chat_sessions s LEFT JOIN chat_messages m ON m.session_id = s.id GROUP BY s.id ORDER BY s.updated_at DESC LIMIT 50');
    return c.json({ sessions: rows });
  } catch {
    return c.json({ sessions: [] });
  }
});

chat.get('/sessions/:id/messages', async (c) => {
  const id = parseInt(c.req.param('id'));
  try {
    const rows = await query<any>('SELECT role, content, image_url, created_at FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC', [id]);
    return c.json({ messages: rows });
  } catch {
    return c.json({ messages: [] });
  }
});

chat.delete('/sessions/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  try {
    await execute('DELETE FROM chat_messages WHERE session_id = ?', [id]);
    await execute('DELETE FROM chat_sessions WHERE id = ?', [id]);
  } catch { }
  return c.json({ ok: true });
});

export default chat;
