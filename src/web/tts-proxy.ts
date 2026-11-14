/**
 * @fileoverview Server-side text-to-speech for the read-aloud feature.
 *
 * Provider chain, first success wins:
 *   1. ElevenLabs — when ELEVENLABS_API_KEY is set. The key stays on the
 *      server, so every device (phone included) gets the same natural voice
 *      without storing a key in its browser.
 *   2. Edge TTS   — the local OpenAI-compatible shim (CODEMAN_TTS_URL).
 *
 * Environment:
 *   ELEVENLABS_API_KEY   enables ElevenLabs
 *   ELEVENLABS_VOICE_ID  voice (default: Adam)
 *   ELEVENLABS_MODEL_ID  model (default: eleven_turbo_v2_5 — low latency)
 *   CODEMAN_TTS_URL / CODEMAN_TTS_KEY / CODEMAN_TTS_VOICE  Edge shim settings
 */

export const ELEVENLABS_DEFAULT_VOICE = 'pNInz6obpgDQGcFmaJgB';
export const ELEVENLABS_DEFAULT_MODEL = 'eleven_turbo_v2_5';

export interface TtsAudio {
  audio: Buffer;
  contentType: string;
  provider: 'elevenlabs' | 'edge';
}

type Env = Record<string, string | undefined>;
type FetchFn = typeof fetch;

/** Which providers this server can use, in the order it will try them. */
export function ttsProviders(env: Env = process.env): Array<'elevenlabs' | 'edge'> {
  return (env.ELEVENLABS_API_KEY || '').trim() ? ['elevenlabs', 'edge'] : ['edge'];
}

async function synthesizeElevenLabs(text: string, env: Env, fetchFn: FetchFn): Promise<TtsAudio> {
  const key = (env.ELEVENLABS_API_KEY || '').trim();
  const voiceId = (env.ELEVENLABS_VOICE_ID || '').trim() || ELEVENLABS_DEFAULT_VOICE;
  const modelId = (env.ELEVENLABS_MODEL_ID || '').trim() || ELEVENLABS_DEFAULT_MODEL;
  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}` + `?output_format=mp3_44100_128`;
  const resp = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'audio/mpeg', 'xi-api-key': key },
    body: JSON.stringify({ text, model_id: modelId }),
  });
  if (!resp.ok) throw new Error(`elevenlabs returned ${resp.status}`);
  return {
    audio: Buffer.from(await resp.arrayBuffer()),
    contentType: resp.headers.get('content-type') || 'audio/mpeg',
    provider: 'elevenlabs',
  };
}

async function synthesizeEdge(text: string, voice: string | undefined, env: Env, fetchFn: FetchFn): Promise<TtsAudio> {
  const ttsUrl = env.CODEMAN_TTS_URL || 'http://127.0.0.1:8091/v1/audio/speech';
  const ttsKey = env.CODEMAN_TTS_KEY || 'local-edge-tts';
  const ttsVoice = voice || env.CODEMAN_TTS_VOICE || 'en-US-AriaNeural';
  const resp = await fetchFn(ttsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ttsKey}` },
    body: JSON.stringify({ model: 'edge-tts', input: text, voice: ttsVoice }),
  });
  if (!resp.ok) throw new Error(`edge tts returned ${resp.status}`);
  return {
    audio: Buffer.from(await resp.arrayBuffer()),
    contentType: resp.headers.get('content-type') || 'audio/mpeg',
    provider: 'edge',
  };
}

/**
 * Synthesizes `text`, trying each configured provider in order.
 * Throws with every provider's failure reason when none succeeds.
 */
export async function synthesizeSpeech(
  text: string,
  opts: { voice?: string; env?: Env; fetchFn?: FetchFn } = {}
): Promise<TtsAudio> {
  const env = opts.env || process.env;
  const fetchFn = opts.fetchFn || fetch;
  const errors: string[] = [];
  for (const provider of ttsProviders(env)) {
    try {
      return provider === 'elevenlabs'
        ? await synthesizeElevenLabs(text, env, fetchFn)
        : await synthesizeEdge(text, opts.voice, env, fetchFn);
    } catch (err) {
      errors.push(`${provider}: ${(err as Error).message}`);
    }
  }
  throw new Error(errors.join('; '));
}
