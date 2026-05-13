// ── Groq ──
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const GROQ_API_URL = process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_WHISPER_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';

// ── Hugging Face Inference API (fallback) ──
const HF_TOKEN = process.env.HF_TOKEN || '';
const HF_API_URL = 'https://router.huggingface.co/v1/chat/completions';
const HF_CHAT_MODEL = 'Qwen/Qwen2.5-7B-Instruct-1M';
const HF_VISION_MODEL = 'meta-llama/Llama-3.2-11B-Vision-Instruct';
const HF_WHISPER_URL = 'https://api-inference.huggingface.co/models/openai/whisper-large-v3';

export interface GroqMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

async function callHF(messages: GroqMessage[], model: string, timeout: number): Promise<string | null> {
  if (!HF_TOKEN) return null;
  try {
    const res = await fetch(HF_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${HF_TOKEN}`,
      },
      body: JSON.stringify({ model, messages }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) {
      console.error(`[HF] HTTP ${res.status}: ${await res.text()}`);
      return null;
    }
    const data = await res.json() as any;
    return data?.choices?.[0]?.message?.content || null;
  } catch (err) {
    console.error('[HF] Error:', err);
    return null;
  }
}

export async function callGroq(messages: GroqMessage[], timeout = 25000): Promise<string | null> {
  // Try Groq first
  try {
    const res = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({ model: GROQ_MODEL, messages }),
      signal: AbortSignal.timeout(timeout),
    });
    if (res.ok) {
      const data = await res.json() as any;
      return data?.choices?.[0]?.message?.content || null;
    }
    console.error(`[GROQ] HTTP ${res.status}: ${await res.text()}`);
  } catch (err) {
    console.error('[GROQ] Error:', err);
  }

  // Fallback to Hugging Face
  console.warn('[GROQ] Falling back to HF Inference API');
  return callHF(messages, HF_CHAT_MODEL, timeout);
}

export async function transcribeAudio(audioBuffer: ArrayBuffer, mimeType: string, timeout = 30000): Promise<string | null> {
  // Try Groq Whisper first
  try {
    const form = new FormData();
    const blob = new Blob([audioBuffer], { type: mimeType });
    form.append('file', blob, 'audio.wav');
    form.append('model', 'whisper-large-v3');
    form.append('response_format', 'json');

    const res = await fetch(GROQ_WHISPER_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(timeout),
    });
    if (res.ok) {
      const data = await res.json() as any;
      return data?.text || null;
    }
    console.error(`[WHISPER] Groq HTTP ${res.status}: ${await res.text()}`);
  } catch (err) {
    console.error('[WHISPER] Groq Error:', err);
  }

  // Fallback to HF Whisper
  if (!HF_TOKEN) return null;
  console.warn('[WHISPER] Falling back to HF Inference API');
  try {
    const form = new FormData();
    const blob = new Blob([audioBuffer], { type: mimeType });
    form.append('file', blob, 'audio.wav');

    const res = await fetch(HF_WHISPER_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${HF_TOKEN}` },
      body: form,
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) {
      console.error(`[WHISPER] HF HTTP ${res.status}: ${await res.text()}`);
      return null;
    }
    const data = await res.json() as any;
    return data?.text || null;
  } catch (err) {
    console.error('[WHISPER] HF Error:', err);
    return null;
  }
}

export async function callGroqVision(text: string, imageBase64: string, systemPrompt = '', timeout = 30000): Promise<string | null> {
  // Try Groq Vision first
  try {
    const messages: any[] = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
      ],
    });
    const res = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({ model: GROQ_VISION_MODEL, messages, max_tokens: 500 }),
      signal: AbortSignal.timeout(timeout),
    });
    if (res.ok) {
      const data = await res.json() as any;
      return data?.choices?.[0]?.message?.content || null;
    }
    console.error(`[VISION] Groq HTTP ${res.status}: ${await res.text()}`);
  } catch (err) {
    console.error('[VISION] Groq Error:', err);
  }

  // Fallback to HF Vision
  if (!HF_TOKEN) return null;
  console.warn('[VISION] Falling back to HF Inference API');
  try {
    const messages: any[] = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
      ],
    });
    const res = await fetch(HF_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${HF_TOKEN}`,
      },
      body: JSON.stringify({ model: HF_VISION_MODEL, messages, max_tokens: 500 }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) {
      console.error(`[VISION] HF HTTP ${res.status}: ${await res.text()}`);
      return null;
    }
    const data = await res.json() as any;
    return data?.choices?.[0]?.message?.content || null;
  } catch (err) {
    console.error('[VISION] HF Error:', err);
    return null;
  }
}
