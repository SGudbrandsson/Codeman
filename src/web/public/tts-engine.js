/**
 * @fileoverview Chunked text-to-speech engine with a Deepgram → server → browser
 * provider chain, block-level position tracking and transport controls.
 *
 * Two levels of granularity, and keeping them straight is the whole design:
 *
 *   - A BLOCK is one rendered element (a paragraph, heading, list item, table
 *     cell). Blocks are what the caller highlights, what the playback bar
 *     counts, and what seeking targets. Blocks are never merged — the pause
 *     between two paragraphs is the pause you hear.
 *   - A SEGMENT is one synthesis request. Normally a block is one segment; an
 *     over-long block splits into several, ONLY at sentence boundaries, all
 *     pointing back at the same block. So a long paragraph still streams
 *     without a mid-sentence cut, and the highlight stays put while it does.
 *
 * The first segment is deliberately tiny: it alone decides how long the user
 * waits before hearing anything.
 *
 * Providers, in order:
 *   1. Deepgram Aura  — direct browser → api.deepgram.com, reusing the API key
 *      already stored for voice input (localStorage `codeman-voice-settings`).
 *   2. /api/tts       — server proxy to edge-tts.
 *   3. Web Speech     — always available offline fallback, no network at all.
 *
 * The chosen provider is pinned after the first success so a missing/expired
 * Deepgram key costs one failed request per session, not one per segment.
 *
 * @globals {object} TtsEngine
 * @dependency none (standalone; app.js consumes it)
 * @loadorder before voice-input.js and app.js
 */

const TtsEngine = {
  // ── Tunables ──────────────────────────────────────────────────────────────
  // Deepgram's /v1/speak caps a request at 2000 chars; we stay well under so a
  // segment is a natural speech unit rather than a size-limit artifact.
  MAX_SEGMENT: 600,
  // Time-to-first-audio is a function of this number alone.
  FIRST_SEGMENT: 200,
  // How many segments to fetch ahead of the one playing. 2 covers a ~1s request
  // during a ~10s segment without stampeding the API.
  PREFETCH: 2,
  // Web Speech sometimes ignores resume(); if it has not restarted by now,
  // treat the utterance as dead and re-speak the current segment.
  RESUME_GRACE_MS: 350,

  DEFAULT_VOICE: 'aura-2-thalia-en',

  /** Rendered elements that count as their own spoken block. */
  BLOCK_SELECTOR: 'h1,h2,h3,h4,h5,h6,p,li,blockquote,td',

  supported: typeof window !== 'undefined'
    && ('speechSynthesis' in window || typeof window.Audio !== 'undefined'),

  // ── State ─────────────────────────────────────────────────────────────────
  _gen: 0,
  _playing: false,
  _paused: false,
  _blocks: [],           // [{ el, text }]
  _segments: [],         // [{ blockIndex, text }]
  _blockStarts: [],      // blockIndex → first segment index
  _segIndex: 0,
  _audios: [],           // two alternating elements; see _unlockAudio()
  _which: 0,
  _urls: new Map(),      // segment index → Promise<objectURL>
  _pinned: null,         // 'deepgram' | 'server' — set after the first success
  _provider: null,       // 'deepgram' | 'server' | 'web' — active this session
  _title: '',
  _visBound: false,
  _onBlockStart: null,
  _onStateChange: null,
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

  apiKey() { return (this.config().apiKey || '').trim(); },

  voice() { return (this.config().ttsVoice || '').trim() || this.DEFAULT_VOICE; },

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
  // DOM → blocks
  // ═══════════════════════════════════════════════════════════════

  /**
   * Collects spoken blocks from a rendered container, in document order.
   *
   * Rendered text, not raw markdown: that is what makes inline code audible
   * (it is just text inside the block), fenced code skippable (it lives in a
   * <pre>), and block highlighting possible at all.
   *
   * @param {Element} root - rendered container (.tv-markdown, .files-md-preview)
   * @param {Element} [startEl] - begin at the block containing this element
   * @returns {Array<{el: Element, text: string}>}
   */
  collectBlocks(root, startEl) {
    const out = [];
    if (!root) return out;
    const els = root.querySelectorAll(this.BLOCK_SELECTOR);
    let started = !startEl;
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      // Code is skipped per spec — reading punctuation aloud is noise.
      if (el.closest('pre')) continue;
      if (!started) {
        if (el === startEl || el.contains(startEl) || startEl.contains(el)) started = true;
        else continue;
      }
      const text = this._ownText(el);
      if (!text) continue;
      out.push({ el, text });
    }
    return out;
  },

  /**
   * textContent minus anything belonging to a nested block (visited separately)
   * or to a code block (never read aloud). Inline <code> is NOT excluded — it
   * reads as part of the sentence, which is the point.
   */
  _ownText(el) {
    let out = '';
    const visit = (node) => {
      const kids = node.childNodes;
      for (let i = 0; i < kids.length; i++) {
        const child = kids[i];
        if (child.nodeType === 3) { out += child.data; continue; }
        if (child.nodeType !== 1) continue;
        if (child.tagName === 'PRE' || child.matches(this.BLOCK_SELECTOR)) continue;
        visit(child);
      }
    };
    visit(el);
    return out.replace(/\s+/g, ' ').trim();
  },

  // ═══════════════════════════════════════════════════════════════
  // Blocks → segments
  // ═══════════════════════════════════════════════════════════════

  /**
   * Expands blocks into synthesis segments. Blocks are never merged and never
   * cut mid-sentence; only a block longer than MAX_SEGMENT is split, and only
   * between sentences.
   *
   * @returns {{segments: Array<{blockIndex:number, text:string}>, blockStarts: number[]}}
   */
  buildSegments(blocks) {
    const segments = [];
    const blockStarts = [];
    blocks.forEach((block, blockIndex) => {
      blockStarts.push(segments.length);
      let text = block.text;
      // The session's opening segment is capped harder than the rest so
      // playback starts fast. The cut still lands between sentences; only the
      // opening slice is small, the remainder of that block is normal-sized.
      if (segments.length === 0) {
        // hardCap Infinity: the opening carve may only take a whole sentence.
        // Without it, a first block that is one long unpunctuated sentence gets
        // word-sliced at 2x FIRST_SEGMENT — a mid-sentence cut in the one place
        // the user is guaranteed to hear it.
        const opening = this._splitSentences(text, this.FIRST_SEGMENT, Infinity);
        if (opening.length > 1) {
          segments.push({ blockIndex, text: opening[0] });
          text = opening.slice(1).join(' ');
        }
      }
      for (const part of this._splitSentences(text, this.MAX_SEGMENT)) {
        if (part) segments.push({ blockIndex, text: part });
      }
    });
    return { segments, blockStarts };
  },

  /**
   * Splits `text` into parts of at most `max` chars at sentence boundaries.
   *
   * Written without lookbehind assertions: older iOS Safari throws on those at
   * parse time, which would take the whole bundle down.
   */
  _splitSentences(text, max, hardCap) {
    if (text.length <= max) return [text];
    const limit = hardCap == null ? max * 2 : hardCap;
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
      // A single sentence over the cap is kept whole rather than cut in half —
      // going over is better than splitting mid-thought.
      if (buf && (buf + ' ' + s).length > max) { parts.push(buf); buf = s; }
      else buf = buf ? buf + ' ' + s : s;
    }
    if (buf) parts.push(buf);

    // Last resort: a punctuation-free run (a URL-stuffed line) that no sentence
    // rule can break. Slice on word boundaries so at least no word is severed.
    const out = [];
    for (const part of parts) {
      if (part.length <= limit) { out.push(part); continue; }
      let rest = part;
      while (rest.length > limit) {
        let cut = rest.lastIndexOf(' ', limit);
        if (cut < limit * 0.5) cut = limit;
        out.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      if (rest) out.push(rest);
    }
    return out.filter(Boolean);
  },

  // ═══════════════════════════════════════════════════════════════
  // Transport
  // ═══════════════════════════════════════════════════════════════

  isPlaying() { return this._playing; },
  isPaused() { return this._paused; },
  activeProvider() { return this._provider; },

  /** Current position as blocks, which is what the UI counts in. */
  position() {
    const seg = this._segments[this._segIndex];
    return {
      index: seg ? seg.blockIndex : 0,
      total: this._blocks.length,
      playing: this._playing,
      paused: this._paused,
      provider: this._provider,
    };
  },

  /**
   * Starts a playback session.
   *
   * MUST be called synchronously from a user gesture: the audio elements are
   * unlocked (and, on the browser path, the first utterance is queued) before
   * this function awaits anything, because iOS only grants playback permission
   * inside the gesture that triggered it.
   *
   * @param {object} opts
   * @param {Array<{el?: Element, text: string}>} opts.blocks
   * @param {number} [opts.startIndex] - block to begin at
   * @param {string} [opts.title] - shown in OS media controls
   * @param {function({el?:Element,text:string}, number)} [opts.onBlockStart]
   * @param {function(object)} [opts.onStateChange] - receives position()
   * @param {function(boolean)} [opts.onEnd]
   * @returns {boolean} false if there was nothing to say
   */
  play(opts) {
    const blocks = (opts && opts.blocks) || [];
    if (!this.supported || !blocks.length) return false;
    this.stop();

    const built = this.buildSegments(blocks);
    if (!built.segments.length) return false;

    const gen = ++this._gen;
    this._blocks = blocks;
    this._segments = built.segments;
    this._blockStarts = built.blockStarts;
    this._segIndex = built.blockStarts[Math.min(Math.max(opts.startIndex || 0, 0), blocks.length - 1)] || 0;
    this._playing = true;
    this._paused = false;
    this._title = (opts && opts.title) || 'Codeman';
    this._onBlockStart = (opts && opts.onBlockStart) || null;
    this._onStateChange = (opts && opts.onStateChange) || null;
    this._onEnd = (opts && opts.onEnd) || null;
    this._provider = this.preferredProvider();
    // Pinning is a within-session optimisation: settings (a newly added or
    // corrected Deepgram key) can change between sessions, so a fallback must
    // not be sticky for the lifetime of the page.
    this._pinned = null;
    this._bindVisibility();

    if (this._provider === 'web') {
      this._speakWeb(gen);
    } else {
      // Both of these are synchronous — no await may precede them.
      this._unlockAudio();
      this._pumpRemote(gen);
    }
    this._setupMediaSession();
    this._emitState();
    // Not `true`: the browser path speaks synchronously, so a speak() that
    // throws has already run stop() by now. Reporting success there would leave
    // the caller showing transport controls for a session that never started.
    return this._playing;
  },

  stop() {
    const was = this._playing;
    this._gen++;
    this._playing = false;
    this._paused = false;
    this._blocks = [];
    this._segments = [];
    this._blockStarts = [];
    this._segIndex = 0;
    this._provider = null;
    this._releaseUrls();
    this._audios.forEach((a) => {
      try { a.pause(); } catch (_e) { /* ignore */ }
      a.onended = null;
      a.onerror = null;
      try { a.removeAttribute('src'); a.load(); } catch (_e) { /* ignore */ }
    });
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try { window.speechSynthesis.cancel(); } catch (_e) { /* ignore */ }
    }
    this._clearMediaSession();
    const onEnd = this._onEnd;
    const onState = this._onStateChange;
    this._onBlockStart = null;
    this._onEnd = null;
    this._onStateChange = null;
    if (was && onState) { try { onState(this.position()); } catch (_e) { /* ignore */ } }
    if (was && onEnd) { try { onEnd(false); } catch (_e) { /* ignore */ } }
  },

  pause() {
    if (!this._playing || this._paused) return;
    this._paused = true;
    if (this._provider === 'web') {
      try { window.speechSynthesis.pause(); } catch (_e) { /* ignore */ }
    } else {
      const a = this._audios[this._which];
      if (a) { try { a.pause(); } catch (_e) { /* ignore */ } }
    }
    this._updateMediaState();
    this._emitState();
  },

  resume() {
    if (!this._playing || !this._paused) return;
    this._paused = false;
    const gen = this._gen;
    if (this._provider === 'web') {
      try { window.speechSynthesis.resume(); } catch (_e) { /* ignore */ }
      // speechSynthesis.pause()/resume() is unreliable across engines: some
      // ignore resume, some drop the utterance entirely. If nothing is speaking
      // shortly after, restart the current segment rather than sit there mute.
      setTimeout(() => {
        if (gen !== this._gen || !this._playing || this._paused) return;
        const ss = window.speechSynthesis;
        if (ss && !ss.speaking && !ss.pending) this._speakWeb(gen);
      }, this.RESUME_GRACE_MS);
    } else {
      const a = this._audios[this._which];
      if (a && a.play) {
        const p = a.play();
        if (p && p.catch) p.catch(() => { /* user must re-tap */ });
      }
    }
    this._updateMediaState();
    this._emitState();
  },

  toggle() {
    if (!this._playing) return;
    if (this._paused) this.resume();
    else this.pause();
  },

  /**
   * Jumps to a block. Block-granular by design: we have no per-block duration
   * until each one has been fetched, so an arbitrary time offset is not
   * something the engine can honestly offer.
   */
  seek(blockIndex) {
    if (!this._playing) return false;
    const clamped = Math.min(Math.max(blockIndex, 0), this._blocks.length - 1);
    const segIndex = this._blockStarts[clamped];
    if (segIndex == null) return false;

    // A new generation cancels in-flight audio and any queued utterance, but
    // must NOT tear the session down — the bar, callbacks and unlocked audio
    // elements all stay live across a seek.
    const gen = ++this._gen;
    this._releaseUrls();
    if (this._provider === 'web') {
      try { window.speechSynthesis.cancel(); } catch (_e) { /* ignore */ }
    } else {
      this._audios.forEach((a) => {
        a.onended = null;
        a.onerror = null;
        try { a.pause(); } catch (_e) { /* ignore */ }
        // Drop the loaded clip too. The new one only arrives after an await, so
        // a resume() in that window would otherwise replay the block the user
        // just seeked away from.
        try { a.removeAttribute('src'); a.load(); } catch (_e) { /* ignore */ }
      });
    }
    this._segIndex = segIndex;
    const wasPaused = this._paused;
    this._paused = false;
    if (this._provider === 'web') this._speakWeb(gen);
    else this._pumpRemote(gen);
    // Seeking while paused lands on the new block and stays paused, which is
    // what a scrub-then-look-at-it gesture expects.
    if (wasPaused) this.pause();
    else this._emitState();
    return true;
  },

  next() {
    const at = this.position().index;
    if (at + 1 >= this._blocks.length) { this.stop(); return; }
    this.seek(at + 1);
  },

  prev() { this.seek(Math.max(this.position().index - 1, 0)); },

  /** The block at an index, for callers re-anchoring after a re-render. */
  blockAt(index) { return this._blocks[index] || null; },

  /**
   * Index of a rendered element in the live session, or -1. Lets a caller turn
   * "play from this block" into a seek when the block is already part of what
   * is playing, instead of tearing the session down and starting again.
   */
  indexOfBlock(el) {
    if (!this._playing || !el) return -1;
    for (let i = 0; i < this._blocks.length; i++) {
      if (this._blocks[i].el === el) return i;
    }
    return -1;
  },

  /**
   * Swaps in freshly collected blocks after the container was re-rendered.
   * Refuses unless the text sequence is identical — if the document actually
   * changed underneath, keeping the stale element refs is safer than jumping
   * the highlight to unrelated content.
   *
   * @returns {boolean} whether the swap was accepted
   */
  rebindBlocks(blocks) {
    if (!this._playing || !blocks || blocks.length !== this._blocks.length) return false;
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].text !== this._blocks[i].text) return false;
    }
    this._blocks = blocks;
    return true;
  },

  _text(seg) { return (seg && seg.text) || ''; },

  _emitState() {
    if (!this._onStateChange) return;
    try { this._onStateChange(this.position()); } catch (_e) { /* ignore */ }
  },

  /** Announces the block a segment belongs to, but only when it changes. */
  _announce(gen, segIndex) {
    if (gen !== this._gen) return;
    const seg = this._segments[segIndex];
    if (!seg) return;
    // A block start is always the first segment of its block, so comparing with
    // the previous segment is enough — including right after a seek.
    const prev = this._segments[segIndex - 1];
    const isNewBlock = !prev || prev.blockIndex !== seg.blockIndex;
    if (isNewBlock && this._onBlockStart) {
      try { this._onBlockStart(this._blocks[seg.blockIndex], seg.blockIndex); } catch (_e) { /* ignore */ }
    }
    if (isNewBlock) this._emitState();
  },

  _advance(gen) {
    if (gen !== this._gen || !this._playing) return false;
    this._segIndex++;
    if (this._segIndex >= this._segments.length) { this.stop(); return false; }
    return true;
  },

  // ── Remote providers (Deepgram / server proxy) ────────────────────────────

  /**
   * iOS refuses `audio.play()` outside a user gesture, and our first real audio
   * only exists after a network round-trip. So we claim the permission during
   * the gesture with a silent clip on REUSED elements, then swap `src` per
   * segment — the elements stay "blessed" for the rest of the session.
   *
   * Two of them, alternating: the next segment is decoded in the idle element
   * while the current one plays, so the seam between blocks is a few
   * milliseconds instead of a load-and-decode stall.
   */
  _unlockAudio() {
    if (!this._audios.length) {
      for (let i = 0; i < 2; i++) {
        try {
          const a = new Audio();
          a.preload = 'auto';
          this._audios.push(a);
        } catch (_e) { return; }
      }
    }
    this._audios.forEach((a) => {
      a.onended = null;
      a.onerror = null;
      try {
        a.src = 'data:audio/mpeg;base64,'
          + '//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCA';
        const p = a.play();
        if (p && p.catch) p.catch(() => { /* silent clip may be rejected; harmless */ });
      } catch (_e) { /* ignore */ }
    });
  },

  async _pumpRemote(gen) {
    let url;
    try {
      // Deliberately NOT prefetching before this resolves: the first request is
      // what pins the provider, and firing three concurrent requests at a dead
      // Deepgram key would burn three 401s instead of one.
      url = await this._urlFor(gen, this._segIndex);
    } catch (_e) {
      // Every network provider failed — degrade the rest of the session to the
      // browser engine rather than dropping the user's request.
      if (gen !== this._gen || !this._playing) return;
      this._provider = 'web';
      this._releaseUrls();
      this._speakWeb(gen);
      return;
    }
    if (gen !== this._gen || !this._playing) return;
    this._prefetch(gen);

    const audio = this._audios[this._which];
    if (!audio) { this.stop(); return; }
    // A failed clip can report itself through `onerror` AND a rejected play()
    // promise; without this latch the session would skip two segments.
    let settled = false;
    const next = () => {
      if (settled || gen !== this._gen) return;
      settled = true;
      this._revoke(this._segIndex);
      this._which ^= 1;
      if (this._advance(gen)) this._pumpRemote(gen);
    };
    audio.onended = next;
    audio.onerror = next;
    audio.src = url;
    this._announce(gen, this._segIndex);
    this._preloadNext(gen);
    if (this._paused) return; // seeked into a paused session; wait for resume
    try {
      await audio.play();
    } catch (err) {
      if (gen !== this._gen || settled) return;
      // NotAllowedError means the gesture was lost, and Web Speech is under the
      // same restriction — nothing left to fall back to. Anything else (a
      // truncated or undecodable response) is this clip's problem alone.
      if (err && err.name === 'NotAllowedError') { this.stop(); return; }
      next();
    }
  },

  /** Loads the following segment into the idle element so the swap is instant. */
  _preloadNext(gen) {
    const nextIndex = this._segIndex + 1;
    if (nextIndex >= this._segments.length) return;
    const idle = this._audios[this._which ^ 1];
    if (!idle) return;
    this._urlFor(gen, nextIndex).then((url) => {
      if (gen !== this._gen) return;
      // Guard against a seek having reassigned the elements in the meantime.
      if (this._segIndex + 1 !== nextIndex) return;
      try { idle.src = url; idle.load(); } catch (_e) { /* ignore */ }
    }).catch(() => { /* handled at play time */ });
  },

  /** Kicks off fetches for the current segment and the next PREFETCH ones. */
  _prefetch(gen) {
    for (let i = this._segIndex; i <= this._segIndex + this.PREFETCH; i++) {
      if (i >= this._segments.length) break;
      this._urlFor(gen, i).catch(() => { /* handled at play time */ });
    }
  },

  _urlFor(gen, index) {
    if (this._urls.has(index)) return this._urls.get(index);
    const text = this._text(this._segments[index]);
    const promise = this._synthesize(text, gen).then((blob) => {
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
   * Deepgram key costs one failed request per session rather than one per
   * segment.
   */
  async _synthesize(text, gen) {
    const order = this._pinned
      ? [this._pinned]
      : (this.preferredProvider() === 'deepgram' ? ['deepgram', 'server'] : ['server']);
    let lastErr = null;
    for (const provider of order) {
      try {
        const blob = provider === 'deepgram'
          ? await this._fetchDeepgram(text)
          : await this._fetchServer(text);
        // Only the live generation may repoint the session. A request left over
        // from a stopped session resolving here would otherwise flip _provider
        // to a remote value mid browser-speech playback, and pause() would then
        // pause a silent <audio> element while the speech kept going.
        if (gen == null || gen === this._gen) {
          this._pinned = provider;
          this._provider = provider;
        }
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
   * One utterance per segment, chained via onend. This is deliberately NOT one
   * big utterance: iOS Safari truncates long ones and drops queued ones when
   * the tab is backgrounded.
   */
  _speakWeb(gen) {
    if (gen !== this._gen || !this._playing) return;
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) { this.stop(); return; }
    const seg = this._segments[this._segIndex];
    if (!seg) { this.stop(); return; }
    const u = new SpeechSynthesisUtterance(seg.text);
    u.onend = () => { if (this._advance(gen)) this._speakWeb(gen); };
    // A single failed utterance must not strand the rest of the text.
    u.onerror = () => { if (this._advance(gen)) this._speakWeb(gen); };
    // Announced at queue time rather than from `onstart`: only one utterance is
    // ever outstanding, and some engines never fire onstart at all — which
    // would leave the caller's progress highlight stuck on the first block.
    this._announce(gen, this._segIndex);
    try {
      window.speechSynthesis.speak(u);
    } catch (_e) {
      this.stop();
    }
  },

  // ── OS media controls ─────────────────────────────────────────────────────

  /**
   * Hardware keys, the lock screen and Chrome's media popup, wired to the same
   * actions as the in-app bar. Audio path only — Web Speech has no media
   * element for the browser to attach controls to.
   */
  _setupMediaSession() {
    const ms = typeof navigator !== 'undefined' && navigator.mediaSession;
    if (!ms || this._provider === 'web') return;
    try {
      if (typeof MediaMetadata !== 'undefined') {
        ms.metadata = new MediaMetadata({ title: this._title, artist: 'Codeman', album: 'Read aloud' });
      }
      ms.setActionHandler('play', () => this.resume());
      ms.setActionHandler('pause', () => this.pause());
      ms.setActionHandler('previoustrack', () => this.prev());
      ms.setActionHandler('nexttrack', () => this.next());
      ms.setActionHandler('stop', () => this.stop());
      ms.playbackState = 'playing';
    } catch (_e) { /* not all browsers accept every action */ }
  },

  _updateMediaState() {
    const ms = typeof navigator !== 'undefined' && navigator.mediaSession;
    if (!ms) return;
    try { ms.playbackState = this._paused ? 'paused' : 'playing'; } catch (_e) { /* ignore */ }
  },

  _clearMediaSession() {
    const ms = typeof navigator !== 'undefined' && navigator.mediaSession;
    if (!ms) return;
    try {
      ms.playbackState = 'none';
      ms.metadata = null;
      ['play', 'pause', 'previoustrack', 'nexttrack', 'stop'].forEach((a) => ms.setActionHandler(a, null));
    } catch (_e) { /* ignore */ }
  },

  // iOS kills speech when the tab is hidden; Chrome auto-pauses ~15s in.
  // Only the Web Speech path needs this babysitting — a media element plays
  // happily in the background, which is the entire point of MediaSession.
  _bindVisibility() {
    if (this._visBound || typeof document === 'undefined') return;
    this._visBound = true;
    document.addEventListener('visibilitychange', () => {
      if (!this._playing || this._provider !== 'web' || this._paused) return;
      if (document.hidden) {
        try { window.speechSynthesis.pause(); } catch (_e) { /* ignore */ }
        return;
      }
      try { window.speechSynthesis.resume(); } catch (_e) { /* ignore */ }
      setTimeout(() => {
        if (!this._playing || this._provider !== 'web' || this._paused) return;
        const ss = window.speechSynthesis;
        if (ss && !ss.speaking && !ss.pending && !ss.paused) this.stop();
      }, 600);
    });
  },
};

if (typeof window !== 'undefined') window.TtsEngine = TtsEngine;
