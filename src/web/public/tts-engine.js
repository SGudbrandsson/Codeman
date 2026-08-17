/**
 * @fileoverview Chunked text-to-speech engine with a Deepgram → server → browser
 * provider chain.
 *
 * The old transcript player synthesised a whole assistant reply as ONE request,
 * so a long answer meant many seconds of silence before anything played. This
 * engine instead splits the text into paragraph-sized chunks and pipelines them:
 * chunk 0 starts playing as soon as its audio lands while chunks 1..N are still
 * being fetched. Time-to-first-audio becomes a function of the first paragraph,
 * not the whole reply.
 *
 * Providers, in order:
 *   1. Deepgram Aura  — direct browser → api.deepgram.com, reusing the API key
 *      already stored for voice input (localStorage `codeman-voice-settings`).
 *   2. /api/tts       — server proxy to edge-tts.
 *   3. Web Speech     — always available offline fallback, no network at all.
 *
 * The chosen provider is pinned after the first success so a missing/expired
 * Deepgram key costs one failed request per session, not one per chunk.
 *
 * @globals {object} TtsEngine
 * @dependency none (standalone; app.js and voice-input.js consume it)
 * @loadorder before voice-input.js and app.js
 */

const TtsEngine = {
  // ── Tunables ──────────────────────────────────────────────────────────────
  // Deepgram's /v1/speak caps a request at 2000 chars; we stay well under so a
  // chunk is a natural speech unit rather than a size limit artifact.
  MAX_CHUNK: 600,
  // The first chunk is deliberately tiny — it alone determines how long the
  // user stares at a spinning button before hearing anything.
  FIRST_CHUNK: 200,
  // Short paragraphs (list items!) are merged up to this size so a 30-bullet
  // answer is not 30 HTTP round-trips.
  MERGE_TARGET: 400,
  // How many chunks to fetch ahead of the one playing. 2 is enough to cover a
  // ~1s request while a ~10s chunk plays, without stampeding the API.
  PREFETCH: 2,

  DEFAULT_VOICE: 'aura-2-thalia-en',

  supported: typeof window !== 'undefined'
    && ('speechSynthesis' in window || typeof window.Audio !== 'undefined'),

  // ── State ─────────────────────────────────────────────────────────────────
  _gen: 0,
  _playing: false,
  _items: [],
  _index: 0,
  _audio: null,
  _urls: new Map(),      // index → Promise<objectURL>
  _pinned: null,         // 'deepgram' | 'server' — set after the first success
  _provider: null,       // 'deepgram' | 'server' | 'web' — active this session
  _visBound: false,
  _onChunkStart: null,
  _onEnd: null,

  // ═══════════════════════════════════════════════════════════════
  // Configuration
  // ═══════════════════════════════════════════════════════════════

  /** Voice settings live in the same localStorage blob as speech-to-text. */
  config() {
    try {
      return JSON.parse(localStorage.getItem('codeman-voice-settings') || '{}') || {};
    } catch (_e) {
      return {};
    }
  },

  apiKey() {
    return (this.config().apiKey || '').trim();
  },

  voice() {
    return (this.config().ttsVoice || '').trim() || this.DEFAULT_VOICE;
  },

  /**
   * Which provider a session would use right now, without starting one.
   * `ttsProvider: 'browser'` is an explicit opt-out of any network synthesis.
   */
  preferredProvider() {
    const cfg = this.config();
    if (cfg.ttsProvider === 'browser') return 'web';
    if (cfg.ttsProvider === 'server') return 'server';
    if (this.apiKey()) return 'deepgram';
    return 'server';
  },

  /** Human-readable name for the settings screen. */
  providerName() {
    const p = this.preferredProvider();
    if (p === 'deepgram') return 'Deepgram ' + this.voice().replace(/^aura-2?-/, '').replace(/-en$/, '');
    if (p === 'server') return 'Edge TTS (server)';
    return 'Browser speech';
  },

  // ═══════════════════════════════════════════════════════════════
  // Text → chunks
  // ═══════════════════════════════════════════════════════════════

  /**
   * Strips Markdown syntax but — unlike the old single-shot stripper — keeps
   * blank lines intact, because those blank lines ARE the chunk boundaries.
   */
  stripMarkdown(text) {
    let s = String(text == null ? '' : text);
    // Fenced code blocks: never read raw code aloud. Leave a paragraph break
    // behind so the prose either side does not get glued together.
    s = s.replace(/```[\s\S]*?```/g, '\n\n');
    s = s.replace(/`[^`]*`/g, '');
    s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
    s = s.replace(/__([^_]+)__/g, '$1');
    s = s.replace(/\*([^*]+)\*/g, '$1');
    s = s.replace(/_([^_]+)_/g, '$1');
    s = s.replace(/^#{1,6}\s+/gm, '');
    s = s.replace(/^[-*_]{3,}\s*$/gm, '');
    s = s.replace(/^\s*[-*+]\s+/gm, '');
    s = s.replace(/^\s*\d+\.\s+/gm, '');
    // Markdown links and images — keep the label only.
    s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
    s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    // Collapse runs of spaces/tabs, but not newlines.
    s = s.replace(/[ \t]{2,}/g, ' ');
    // Trim each line, then collapse 3+ blank lines down to a single break.
    s = s.split('\n').map((line) => line.trim()).join('\n');
    s = s.replace(/\n{3,}/g, '\n\n');
    return s.trim();
  },

  /**
   * Markdown → speakable chunks. Paragraphs are the unit; oversized ones are
   * split on sentence boundaries and undersized ones merged, so every chunk is
   * a sane request size. Chunk 0 is capped hard for time-to-first-audio.
   *
   * @returns {string[]}
   */
  segment(rawText) {
    const clean = this.stripMarkdown(rawText);
    if (!clean) return [];

    // 1. Paragraphs, each split down to MAX_CHUNK on sentence boundaries.
    const pieces = [];
    for (const para of clean.split(/\n{2,}/)) {
      const p = para.replace(/\n/g, ' ').trim();
      if (p) for (const part of this._splitLong(p, this.MAX_CHUNK)) pieces.push(part);
    }
    if (!pieces.length) return [];

    // 2. Merge short neighbours so a bullet list is not one request per bullet.
    const merged = [];
    for (const piece of pieces) {
      const last = merged.length ? merged[merged.length - 1] : null;
      if (last !== null && (last.length + 1 + piece.length) <= this.MERGE_TARGET) {
        merged[merged.length - 1] = last + ' ' + piece;
      } else {
        merged.push(piece);
      }
    }

    // 3. Shrink chunk 0: the whole point is to start talking fast.
    if (merged[0].length > this.FIRST_CHUNK) {
      const head = this._splitLong(merged[0], this.FIRST_CHUNK);
      merged.splice(0, 1, ...head);
    }
    return merged;
  },

  /**
   * Splits `text` into parts of at most `max` chars, preferring sentence ends.
   * Written without lookbehind assertions: older iOS Safari throws on those at
   * parse time, which would take the whole bundle down.
   */
  _splitLong(text, max) {
    if (text.length <= max) return [text];
    const sentences = [];
    let sentence = '';
    for (let i = 0; i < text.length; i++) {
      sentence += text[i];
      const isEnd = '.!?…'.indexOf(text[i]) !== -1;
      if (isEnd && (i + 1 >= text.length || /\s/.test(text[i + 1]))) {
        sentences.push(sentence.trim());
        sentence = '';
      }
    }
    if (sentence.trim()) sentences.push(sentence.trim());

    const parts = [];
    let buf = '';
    for (const s of sentences) {
      if (buf && (buf + ' ' + s).length > max) { parts.push(buf); buf = s; }
      else buf = buf ? buf + ' ' + s : s;
    }
    if (buf) parts.push(buf);

    // A single sentence can still exceed max (no punctuation at all) — fall
    // back to word-boundary slicing rather than cutting mid-word.
    const out = [];
    for (const part of parts) {
      if (part.length <= max) { out.push(part); continue; }
      let rest = part;
      while (rest.length > max) {
        let cut = rest.lastIndexOf(' ', max);
        if (cut < max * 0.5) cut = max;
        out.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      if (rest) out.push(rest);
    }
    return out.filter(Boolean);
  },

  // ═══════════════════════════════════════════════════════════════
  // Playback
  // ═══════════════════════════════════════════════════════════════

  isPlaying() { return this._playing; },
  activeProvider() { return this._provider; },

  /**
   * Starts a playback session.
   *
   * MUST be called synchronously from a user gesture: the audio element is
   * unlocked (and, on the browser path, the first utterance is queued) before
   * this function awaits anything, because iOS only grants playback permission
   * inside the gesture that triggered it.
   *
   * @param {object} opts
   * @param {Array<string|{text:string}>} opts.items - chunks to speak
   * @param {function(any, number)} [opts.onChunkStart] - (item, index)
   * @param {function(boolean)} [opts.onEnd] - called once when playback stops
   * @returns {boolean} false if there was nothing to say
   */
  play(opts) {
    const items = (opts && opts.items) || [];
    if (!this.supported || !items.length) return false;
    this.stop();

    const gen = ++this._gen;
    this._items = items;
    this._index = 0;
    this._playing = true;
    this._onChunkStart = (opts && opts.onChunkStart) || null;
    this._onEnd = (opts && opts.onEnd) || null;
    this._provider = this.preferredProvider();
    this._bindVisibility();

    if (this._provider === 'web') {
      this._speakWeb(gen);
    } else {
      // Both of these are synchronous — no await may precede them.
      this._unlockAudio();
      this._pumpRemote(gen);
    }
    return true;
  },

  stop() {
    const was = this._playing;
    this._gen++;
    this._playing = false;
    this._items = [];
    this._index = 0;
    this._provider = null;
    this._releaseUrls();
    if (this._audio) {
      try { this._audio.pause(); } catch (_e) { /* ignore */ }
      this._audio.onended = null;
      this._audio.onerror = null;
      try { this._audio.removeAttribute('src'); this._audio.load(); } catch (_e) { /* ignore */ }
    }
    if ('speechSynthesis' in window) {
      try { window.speechSynthesis.cancel(); } catch (_e) { /* ignore */ }
    }
    const cb = this._onEnd;
    this._onChunkStart = null;
    this._onEnd = null;
    if (was && cb) { try { cb(false); } catch (_e) { /* ignore */ } }
  },

  pause() {
    if (!this._playing) return;
    if (this._provider === 'web') {
      try { window.speechSynthesis.pause(); } catch (_e) { /* ignore */ }
    } else if (this._audio) {
      try { this._audio.pause(); } catch (_e) { /* ignore */ }
    }
  },

  resume() {
    if (!this._playing) return;
    if (this._provider === 'web') {
      try { window.speechSynthesis.resume(); } catch (_e) { /* ignore */ }
    } else if (this._audio) {
      this._audio.play().catch(() => { /* user must re-tap */ });
    }
  },

  _text(item) { return typeof item === 'string' ? item : (item && item.text) || ''; },

  _announce(gen, item, index) {
    if (gen !== this._gen || !this._onChunkStart) return;
    try { this._onChunkStart(item, index); } catch (_e) { /* ignore */ }
  },

  _advance(gen) {
    if (gen !== this._gen || !this._playing) return false;
    this._index++;
    if (this._index >= this._items.length) { this.stop(); return false; }
    return true;
  },

  // ── Remote providers (Deepgram / server proxy) ────────────────────────────

  /**
   * iOS refuses `audio.play()` outside a user gesture, and our first real audio
   * only exists after a network round-trip. So we claim the permission during
   * the gesture with a silent clip on a REUSED element, then swap `src` per
   * chunk — the element stays "blessed" for the rest of the session.
   */
  _unlockAudio() {
    if (!this._audio) {
      try { this._audio = new Audio(); } catch (_e) { return; }
      this._audio.preload = 'auto';
    }
    this._audio.onended = null;
    this._audio.onerror = null;
    try {
      this._audio.src = 'data:audio/mpeg;base64,'
        + '//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCA';
      const p = this._audio.play();
      if (p && p.catch) p.catch(() => { /* silent clip may be rejected; harmless */ });
    } catch (_e) { /* ignore */ }
  },

  async _pumpRemote(gen) {
    let url;
    try {
      // Deliberately NOT prefetching before this resolves: the first request
      // is what pins the provider, and firing three concurrent requests at a
      // dead Deepgram key would burn three 401s instead of one.
      url = await this._urlFor(gen, this._index);
    } catch (_e) {
      // Every network provider failed for this chunk — degrade the rest of the
      // session to the browser engine rather than dropping the user's request.
      if (gen !== this._gen || !this._playing) return;
      this._provider = 'web';
      this._releaseUrls();
      this._speakWeb(gen);
      return;
    }
    if (gen !== this._gen || !this._playing) return;
    this._prefetch(gen);

    const item = this._items[this._index];
    const audio = this._audio || (this._audio = new Audio());
    // A failed clip can report itself through `onerror` AND a rejected play()
    // promise; without this latch the session would skip two chunks instead of
    // one.
    let settled = false;
    const next = () => {
      if (settled || gen !== this._gen) return;
      settled = true;
      this._revoke(this._index);
      if (this._advance(gen)) this._pumpRemote(gen);
    };
    audio.onended = next;
    audio.onerror = next;
    audio.src = url;
    this._announce(gen, item, this._index);
    try {
      await audio.play();
    } catch (err) {
      if (gen !== this._gen || settled) return;
      // NotAllowedError means the gesture was lost, and Web Speech is under the
      // same restriction — nothing left to fall back to. Anything else (a
      // truncated or undecodable response) is this clip's problem alone, so
      // skip it rather than stranding the rest of the text.
      if (err && err.name === 'NotAllowedError') { this.stop(); return; }
      next();
    }
  },

  /** Kicks off fetches for the current chunk and the next PREFETCH ones. */
  _prefetch(gen) {
    for (let i = this._index; i <= this._index + this.PREFETCH; i++) {
      if (i >= this._items.length) break;
      this._urlFor(gen, i).catch(() => { /* handled at play time */ });
    }
  },

  _urlFor(gen, index) {
    if (this._urls.has(index)) return this._urls.get(index);
    const text = this._text(this._items[index]);
    const promise = this._synthesize(text).then((blob) => {
      if (gen !== this._gen) {
        // Session ended mid-flight — do not leak an unreferenced object URL.
        throw new Error('stale');
      }
      return URL.createObjectURL(blob);
    });
    this._urls.set(index, promise);
    return promise;
  },

  _revoke(index) {
    const p = this._urls.get(index);
    this._urls.delete(index);
    if (p) p.then((url) => URL.revokeObjectURL(url)).catch(() => { /* never created */ });
  },

  _releaseUrls() {
    const urls = this._urls;
    this._urls = new Map();
    urls.forEach((p) => p.then((url) => URL.revokeObjectURL(url)).catch(() => { /* ignore */ }));
  },

  /**
   * Tries each remote provider in turn and pins the first that works, so a bad
   * Deepgram key costs one failed request per session rather than one per chunk.
   */
  async _synthesize(text) {
    const order = this._pinned
      ? [this._pinned]
      : (this.preferredProvider() === 'deepgram' ? ['deepgram', 'server'] : ['server']);
    let lastErr = null;
    for (const provider of order) {
      try {
        const blob = provider === 'deepgram'
          ? await this._fetchDeepgram(text)
          : await this._fetchServer(text);
        this._pinned = provider;
        this._provider = provider;
        return blob;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('no tts provider');
  },

  async _fetchDeepgram(text) {
    const key = this.apiKey();
    if (!key) throw new Error('no deepgram key');
    const url = 'https://api.deepgram.com/v1/speak?model=' + encodeURIComponent(this.voice());
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Token ' + key },
      body: JSON.stringify({ text }),
    });
    if (!resp.ok) throw new Error('deepgram ' + resp.status);
    return resp.blob();
  },

  async _fetchServer(text) {
    const resp = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!resp.ok) throw new Error('tts ' + resp.status);
    return resp.blob();
  },

  // ── Browser Web Speech fallback ───────────────────────────────────────────

  /**
   * One utterance per chunk, chained via onend. This is deliberately NOT one
   * big utterance: iOS Safari truncates long ones and drops queued ones when
   * the tab is backgrounded.
   */
  _speakWeb(gen) {
    if (gen !== this._gen || !this._playing) return;
    if (!('speechSynthesis' in window)) { this.stop(); return; }
    const item = this._items[this._index];
    if (!item) { this.stop(); return; }
    const u = new SpeechSynthesisUtterance(this._text(item));
    u.onend = () => { if (this._advance(gen)) this._speakWeb(gen); };
    // A single failed utterance must not strand the rest of the text.
    u.onerror = () => { if (this._advance(gen)) this._speakWeb(gen); };
    // Announced at queue time rather than from `onstart`: only one utterance is
    // ever outstanding, and some engines never fire onstart at all — which
    // would leave the caller's progress highlight stuck on the first block.
    this._announce(gen, item, this._index);
    try {
      window.speechSynthesis.speak(u);
    } catch (_e) {
      this.stop();
    }
  },

  // iOS kills speech when the tab is hidden; Chrome auto-pauses ~15s in.
  // Resume on return, and if the engine really is dead, reset rather than
  // leaving a Stop button that stops nothing.
  _bindVisibility() {
    if (this._visBound || typeof document === 'undefined') return;
    this._visBound = true;
    document.addEventListener('visibilitychange', () => {
      if (!this._playing) return;
      if (document.hidden) { this.pause(); return; }
      this.resume();
      if (this._provider !== 'web') return;
      setTimeout(() => {
        if (!this._playing || this._provider !== 'web') return;
        const ss = window.speechSynthesis;
        if (ss && !ss.speaking && !ss.pending && !ss.paused) this.stop();
      }, 600);
    });
  },
};

if (typeof window !== 'undefined') window.TtsEngine = TtsEngine;
