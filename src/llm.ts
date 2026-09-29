// LORE-AI LLM layer.
// Chat / vision run through a provider chain: Kenari -> Groq -> Hugging Face.
// Audio transcription runs through Groq Whisper -> Hugging Face Whisper.

// ── Kenari (primary) ──
// OpenAI-compatible gateway. https://kenari.id/v1
const KENARI_API_KEY = process.env.KENARI_API_KEY || '';
const KENARI_BASE_URL = process.env.KENARI_BASE_URL || 'https://kenari.id/v1';
const LORE_MODEL = process.env.LORE_MODEL || 'deepseek-v4-1-flash';
// Kenari exposes reasoning_options low/high/max. Sent as reasoning_effort and
// retried without if the gateway rejects the field.
const LORE_REASONING_EFFORT = process.env.LORE_REASONING_EFFORT || 'low';

// ── Groq (fallback) ──
// Note: the old default llama-3.3-70b-versatile was shut down 2026-08-16.
// openai/gpt-oss-120b is live as of 2026-09.
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const GROQ_API_URL = process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_WHISPER_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

// ── Hugging Face Inference API (final fallback) ──
const HF_TOKEN = process.env.HF_TOKEN || '';
const HF_API_URL = 'https://router.huggingface.co/v1/chat/completions';
const HF_CHAT_MODEL = 'Qwen/Qwen2.5-7B-Instruct-1M';
const HF_VISION_MODEL = 'meta-llama/Llama-3.2-11B-Vision-Instruct';
const HF_WHISPER_URL = 'https://api-inference.huggingface.co/models/openai/whisper-large-v3';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ── Shared OpenAI-compatible response reader ──
// Tolerates both a normal JSON body and an SSE stream (some gateways stream by
// default). Prefers `content`; falls back to `reasoning_content` for reasoning
// models that may return the answer there.
async function readChatCompletion(res: Response, timeout: number): Promise<string | null> {
  const ctype = res.headers.get('content-type') || '';
  if (!ctype.includes('text/event-stream')) {
    const data = await res.json() as any;
    const msg = data?.choices?.[0]?.message;
    return msg?.content || msg?.reasoning_content || null;
  }

  // SSE: accumulate content deltas across `data:` frames, stop at [DONE].
  const reader = res.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n');
    buffer = frames.pop() || '';
    for (const frame of frames) {
      const line = frame.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') {
        await reader.cancel();
        return content || reasoning || null;
      }
      try {
        const delta = JSON.parse(payload)?.choices?.[0]?.delta;
        if (delta?.content) content += delta.content;
        if (delta?.reasoning_content) reasoning += delta.reasoning_content;
      } catch { /* ignore malformed frame */ }
    }
  }
  return content || reasoning || null;
}

async function postChat(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  timeout: number,
  label: string
): Promise<string | null> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) {
      console.error(`[${label}] HTTP ${res.status}: ${await res.text()}`);
      return null;
    }
    return readChatCompletion(res, timeout);
  } catch (err) {
    console.error(`[${label}] Error:`, err);
    return null;
  }
}

async function callKenari(messages: unknown[], timeout: number, maxTokens?: number): Promise<string | null> {
  if (!KENARI_API_KEY) return null;
  const url = `${KENARI_BASE_URL.replace(/\/+$/, '')}/chat/completions`;

  const base: Record<string, unknown> = { model: LORE_MODEL, messages };
  if (maxTokens) base.max_tokens = maxTokens;
  base.reasoning_effort = LORE_REASONING_EFFORT;

  let out = await postChat(url, KENARI_API_KEY, base, timeout, 'KENARI');
  if (out === null && LORE_REASONING_EFFORT) {
    // Gateway rejected the body (e.g. reasoning_effort unsupported). Retry minimal.
    console.warn('[KENARI] retrying without reasoning_effort');
    const retry: Record<string, unknown> = { model: LORE_MODEL, messages };
    if (maxTokens) retry.max_tokens = maxTokens;
    out = await postChat(url, KENARI_API_KEY, retry, timeout, 'KENARI');
  }
  return out;
}

async function callGroq(messages: unknown[], timeout: number): Promise<string | null> {
  if (!GROQ_API_KEY) return null;
  return postChat(GROQ_API_URL, GROQ_API_KEY, { model: GROQ_MODEL, messages }, timeout, 'GROQ');
}

async function callHF(messages: unknown[], model: string, timeout: number): Promise<string | null> {
  if (!HF_TOKEN) return null;
  return postChat(HF_API_URL, HF_TOKEN, { model, messages }, timeout, 'HF');
}

export async function callLLM(messages: LLMMessage[], timeout = 25000): Promise<string | null> {
  // 1) Kenari (primary)
  const kenari = await callKenari(messages, timeout);
  if (kenari) return kenari;

  // 2) Groq (fallback)
  console.warn('[LLM] Kenari unavailable, falling back to Groq');
  const groq = await callGroq(messages, timeout);
  if (groq) return groq;

  // 3) Hugging Face (final fallback)
  console.warn('[LLM] Groq unavailable, falling back to HF Inference API');
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

export async function callVision(text: string, imageBase64: string, systemPrompt = '', timeout = 30000): Promise<string | null> {
  const messages: any[] = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
    ],
  });

  // 1) Kenari — deepseek-v4-1-flash accepts text + image input.
  //    (Groq's former vision model llama-4-scout was shut down 2026-07-17,
  //    so there is no live Groq vision provider left in the chain.)
  const kenari = await callKenari(messages, timeout, 500);
  if (kenari) return kenari;

  // 2) Hugging Face vision (final fallback)
  if (!HF_TOKEN) return null;
  console.warn('[VISION] Kenari unavailable, falling back to HF Inference API');
  return callHF(messages, HF_VISION_MODEL, timeout);
}
