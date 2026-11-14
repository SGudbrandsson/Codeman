/**
 * Server-side TTS provider chain (src/web/tts-proxy.ts): ElevenLabs first when
 * ELEVENLABS_API_KEY is set, Edge TTS shim as the fallback.
 *
 * Run: npx vitest run test/tts-proxy.test.ts
 */
import { describe, it, expect, vi } from 'vitest';
import {
  synthesizeSpeech,
  ttsProviders,
  ELEVENLABS_DEFAULT_MODEL,
  ELEVENLABS_DEFAULT_VOICE,
} from '../src/web/tts-proxy.js';

function audioResponse(bytes: string, contentType = 'audio/mpeg') {
  return new Response(Buffer.from(bytes), { status: 200, headers: { 'content-type': contentType } });
}

describe('ttsProviders()', () => {
  it('is Edge only without an ElevenLabs key', () => {
    expect(ttsProviders({})).toEqual(['edge']);
    expect(ttsProviders({ ELEVENLABS_API_KEY: '   ' })).toEqual(['edge']);
  });

  it('puts ElevenLabs first when a key is set', () => {
    expect(ttsProviders({ ELEVENLABS_API_KEY: 'xi' })).toEqual(['elevenlabs', 'edge']);
  });
});

describe('synthesizeSpeech()', () => {
  it('calls ElevenLabs with the key header, default voice and model', async () => {
    const fetchFn = vi.fn(async () => audioResponse('eleven'));
    const out = await synthesizeSpeech('Hello there', { env: { ELEVENLABS_API_KEY: 'xi-key' }, fetchFn });

    expect(out.provider).toBe('elevenlabs');
    expect(out.audio.toString()).toBe('eleven');
    expect(out.contentType).toBe('audio/mpeg');
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain(`/v1/text-to-speech/${ELEVENLABS_DEFAULT_VOICE}`);
    expect((init.headers as Record<string, string>)['xi-api-key']).toBe('xi-key');
    expect(JSON.parse(init.body as string)).toEqual({ text: 'Hello there', model_id: ELEVENLABS_DEFAULT_MODEL });
  });

  it('honours ELEVENLABS_VOICE_ID and ELEVENLABS_MODEL_ID', async () => {
    const fetchFn = vi.fn(async () => audioResponse('x'));
    await synthesizeSpeech('Hi', {
      env: { ELEVENLABS_API_KEY: 'k', ELEVENLABS_VOICE_ID: 'voice123', ELEVENLABS_MODEL_ID: 'eleven_v3' },
      fetchFn,
    });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/v1/text-to-speech/voice123');
    expect(JSON.parse(init.body as string).model_id).toBe('eleven_v3');
  });

  it('falls back to the Edge shim when ElevenLabs fails', async () => {
    const fetchFn = vi.fn(async (url: string) =>
      url.includes('elevenlabs') ? new Response('quota', { status: 401 }) : audioResponse('edge')
    );
    const out = await synthesizeSpeech('Hi', {
      env: { ELEVENLABS_API_KEY: 'k', CODEMAN_TTS_URL: 'http://edge.local/speech' },
      fetchFn,
    });
    expect(out.provider).toBe('edge');
    expect(out.audio.toString()).toBe('edge');
    expect(fetchFn.mock.calls.map((c) => c[0])).toEqual([
      expect.stringContaining('elevenlabs'),
      'http://edge.local/speech',
    ]);
  });

  it('sends the requested voice to the Edge shim', async () => {
    const fetchFn = vi.fn(async () => audioResponse('edge'));
    await synthesizeSpeech('Hi', { env: {}, fetchFn, voice: 'en-GB-SoniaNeural' });
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ input: 'Hi', voice: 'en-GB-SoniaNeural' });
  });

  it('throws with every provider failure when none succeeds', async () => {
    const fetchFn = vi.fn(async (url: string) =>
      url.includes('elevenlabs') ? new Response('', { status: 401 }) : new Response('', { status: 500 })
    );
    await expect(synthesizeSpeech('Hi', { env: { ELEVENLABS_API_KEY: 'k' }, fetchFn })).rejects.toThrow(
      /elevenlabs: elevenlabs returned 401; edge: edge tts returned 500/
    );
  });

  it('survives a network error from ElevenLabs', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('elevenlabs')) throw new Error('ECONNRESET');
      return audioResponse('edge');
    });
    const out = await synthesizeSpeech('Hi', { env: { ELEVENLABS_API_KEY: 'k' }, fetchFn });
    expect(out.provider).toBe('edge');
  });
});
