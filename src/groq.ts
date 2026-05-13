const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const GROQ_API_URL = process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_WHISPER_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';

export interface GroqMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export async function callGroq(messages: GroqMessage[], timeout = 25000): Promise<string | null> {
  try {
    const res = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages,
      }),
      signal: AbortSignal.timeout(timeout),
    });

    if (!res.ok) {
      console.error(`[GROQ] HTTP ${res.status}: ${await res.text()}`);
      return null;
    }

    const data = await res.json() as any;
    return data?.choices?.[0]?.message?.content || null;
  } catch (err) {
    console.error('[GROQ] Error:', err);
    return null;
  }
}

export async function transcribeAudio(audioBuffer: ArrayBuffer, mimeType: string, timeout = 30000): Promise<string | null> {
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

    if (!res.ok) {
      console.error(`[WHISPER] HTTP ${res.status}: ${await res.text()}`);
      return null;
    }

    const data = await res.json() as any;
    return data?.text || null;
  } catch (err) {
    console.error('[WHISPER] Error:', err);
    return null;
  }
}

export async function callGroqVision(text: string, imageBase64: string, systemPrompt = '', timeout = 30000): Promise<string | null> {
  try {
    const messages: any[] = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
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
      body: JSON.stringify({
        model: GROQ_VISION_MODEL,
        messages,
        max_tokens: 500,
      }),
      signal: AbortSignal.timeout(timeout),
    });

    if (!res.ok) {
      console.error(`[VISION] HTTP ${res.status}: ${await res.text()}`);
      return null;
    }

    const data = await res.json() as any;
    return data?.choices?.[0]?.message?.content || null;
  } catch (err) {
    console.error('[VISION] Error:', err);
    return null;
  }
}
