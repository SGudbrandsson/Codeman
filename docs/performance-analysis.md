# Performance Analysis & Optimization Opportunities

**Date**: 2026-03-07
**Scope**: Full-stack performance analysis — backend PTY handling, SSE broadcasting, frontend terminal rendering, local echo overlay, DOM updates, config/scaling limits.
**Constraint**: All recommendations preserve existing functionality including local echo, backpressure, anti-flicker pipeline, and mobile support.

---

## Executive Summary

The codebase is already well-optimized in critical paths. The multi-layer backpressure system, adaptive terminal batching, DEC 2026 sync markers, and incremental state serialization are strong. The main opportunities are in **reducing unnecessary work** (SSE filtering, DOM rebuilds, lazy terminal init) rather than algorithmic changes.

**Top 5 high-impact opportunities:**

| # | Optimization | Impact | Risk | Effort |
|---|-------------|--------|------|--------|
| 1 | Session-scoped SSE subscriptions | Bandwidth -60-80%, CPU -40% | Medium | Medium |
| 2 | Lazy xterm.js for minimized subagent windows | Memory -3.5MB at 50 agents | Low | Low |
| 3 | Targeted badge update (skip full tab rebuild) | Eliminates O(n) reflow on badge change | Low | Low |
| 4 | Conditional SSE padding (tunnel-only, terminal-only) | Bandwidth -70% when tunneled | Low | Low |
| 5 | Canvas renderer on mobile | GPU pressure reduction, battery savings | Low | Low |

---

## 1. SSE Broadcasting

### Current State
- **92 event types** broadcast to all connected clients (max 100)
- Single `JSON.stringify()` per event, shared across all clients (efficient)
- **No per-client filtering** — every client receives every event regardless of which session they're viewing
- 8KB padding appended to **every** event when tunnel is active (forces Cloudflare proxy flush)
- Backpressure: clients marked as backpressured if `reply.raw.write()` returns false; recovery via `session:needsRefresh`

### Bottlenecks

**B1: No session-scoped SSE subscriptions** (`server.ts:1986`)
- Client viewing session A still receives all events for sessions B through T
- With 20 active sessions, ~95% of terminal events are irrelevant to any given client
- Cost: wasted bandwidth, CPU for JSON parsing, and event handler dispatch on client

**B2: Unconditional 8KB padding** (`server.ts:1977`)
- Every event gets 8KB comment padding when tunnel is active
- A `task:updated` event (~200 bytes payload) becomes ~8.2KB
- High-frequency events like `session:terminal` need the padding; low-frequency events like `session:created` don't

### Recommendations

**R1: Session-scoped SSE subscriptions** (High impact)
- Add `?sessions=id1,id2` query param to `/api/events` SSE endpoint
- Server filters events by session ID before broadcasting
- Client subscribes to active session + "global" events (session lifecycle, system)
- Re-subscribes on tab switch (or subscribe to all with client-side filter as fallback)
- **Savings**: ~80% bandwidth reduction for single-session viewers; ~60% for multi-session dashboards

**R2: Tiered SSE padding** (Medium impact)
- Only pad `session:terminal` events and SSE heartbeats (the two that need proxy flush)
- Skip padding for low-frequency structural events (`session:created`, `task:updated`, etc.)
- **Savings**: ~70% padding overhead reduction; terminal events already large enough to flush

---

## 2. Terminal Rendering

### Current State (Well-Optimized)
- **6-layer anti-flicker pipeline**: Server batching (adaptive 16-50ms) → DEC 2026 sync wrap → single JSON serialize → client rAF batching → sync segment parser → chunked buffer loading (32KB/frame)
- **64KB/frame write budget** with DEC 2026 sync-segment awareness (prevents 141KB single-frame freezes)
- **3-layer backpressure**: SSE cap (128KB queued → drop + refresh), frame budget (64KB/frame), chunked restore (32KB/frame)
- WebGL renderer enabled by default with canvas fallback on context loss
- Typical latency: 16-32ms; worst case: ~115ms (50ms server batch + 50ms sync wait + 16ms rAF)

### Bottlenecks

**B3: WebGL on mobile** (`app.js:627-637`)
- Mobile GPUs are weaker; WebGL context loss more likely on low-end devices
- Canvas renderer is sufficient for mobile (typically 1 session, smaller viewport)

**B4: Static scrollback for all sessions** (`app.js:572`)
- Default 5000 lines scrollback for all sessions regardless of activity level
- Heavy output sessions (build logs, test runners) accumulate large scroll buffers

**B5: No addon lazy loading**
- FitAddon, Unicode11Addon, and WebGLAddon all loaded at terminal init
- Unicode11Addon only needed for CJK content; WebGLAddon is large

### Recommendations

**R3: Force canvas renderer on mobile** (Low risk)
- Detect `MobileDetection.isMobile()` and skip WebGL addon loading
- Reduces GPU memory pressure, prevents context loss crashes
- Mobile typically has 1-2 sessions — canvas performance is more than adequate

**R4: Dynamic scrollback based on session activity** (Low risk)
- Active sessions (working state): 5000 lines (current default)
- Inactive/idle sessions: reduce to 2000 lines
- Restore on session select (fetch from server buffer)
- **Savings**: ~60% scrollback memory for idle sessions

**R5: Lazy-load Unicode11Addon** (Low risk)
- Only load when CJK content is detected in terminal output
- Detection: check for characters in CJK Unicode ranges during ANSI stripping (already iterating)
- Most sessions never need it

---

## 3. DOM & Session Tab Rendering

### Current State
- Session tabs use **intelligent incremental updates** with debounced 100ms rendering
- Incremental path: only updates changed properties (classes, textContent, badges) when session list is stable
- Full rebuild path: triggered when sessions added/removed **or badge count changes**
- Subagent windows: per-window xterm.js instances, even when minimized

### Bottlenecks

**B6: Badge count change triggers full tab rebuild** (`app.js:3207-3209`)
- A single subagent badge increment on one tab triggers `_fullRenderSessionTabs()` — rebuilds entire sidebar HTML via `innerHTML =`
- With 20 sessions, this is an O(n) reflow for a single badge number change
- Badge changes are frequent during active subagent work

**B7: Minimized subagent windows retain xterm.js instances** (`subagent-windows.js`)
- 50 subagent windows × ~75KB per xterm.js instance = ~3.75MB DOM memory
- Minimized windows are invisible but their terminals remain in DOM
- xterm.js instances continue processing resize events even when hidden

**B8: `backdrop-filter: blur()` on overlays** (`styles.css:2246-2247, 3098`)
- Forces new stacking context, disables browser compositing optimizations
- 50-100ms layout thrashing on modal open/close
- Only 2 uses, but they're on frequently toggled overlays

### Recommendations

**R6: Targeted badge update without full rebuild** (Low risk)
- When badge count changes but session list is stable, update only the badge `<span>` textContent
- Keep incremental path for badge changes; only use full rebuild for structural changes (add/remove sessions)
- **Savings**: Eliminates O(n) reflow per badge change; reduces to O(1) targeted update

**R7: Lazy xterm.js initialization for subagent windows** (Medium impact)
- Only create xterm.js Terminal instance when window is restored/maximized
- On minimize: serialize terminal buffer, dispose Terminal instance, keep buffer in memory
- On restore: create new Terminal, write buffer back
- **Savings**: ~3.5MB DOM reduction at 50 minimized agents; eliminates hidden resize processing
- **Trade-off**: ~200-500ms restore delay (buffer write), mitigated by chunked loading

**R8: Replace `backdrop-filter: blur()` with `background: rgba()`** (Low risk)
- Use semi-transparent background instead of blur effect
- Or use `will-change: transform` hint if blur is kept
- **Savings**: Eliminates forced recomposition layer; 50-100ms faster overlay open

---

## 4. Backend PTY & State Management

### Current State (Excellent)
- **BufferAccumulator**: Array-based chunking with lazy join on read — avoids O(n) string concatenation
- **ANSI stripping**: Throttled at 150ms intervals with lazy evaluation (not per-chunk)
- **State persistence**: 500ms debounce + incremental JSON caching per session (only dirty sessions re-serialized)
- **Expensive parsers**: Throttled to 150ms window, accumulated data capped at 64KB
- **Memory**: All buffers have hard limits (2MB terminal, 1MB text, 1000 messages, 64KB line buffer)

### Bottlenecks

**B9: Pending clean data cap at 64KB** (`session.ts:1097-1133`)
- Between 150ms processing windows, raw PTY data accumulates in `_pendingCleanData`
- Capped at 64KB — excess data rolls off (old data discarded)
- During heavy output (large build logs), this means parsers may miss content
- Acceptable trade-off for performance, but worth documenting

**B10: `LRUMap.delete()` is O(n) worst case** (`utils/lru-map.ts:137-138`)
- When deleting the newest entry, iterates all keys to find new newest
- Rare in practice (delete is uncommon; set/get are hot paths)
- Could matter during mass cleanup of 500 agents

### Recommendations

**R9: Consider adaptive pending data cap** (Low priority)
- During idle detection (critical to get right), increase cap to 128KB
- During active working state, keep at 64KB (parsers less critical)
- **Benefit**: More accurate idle detection during heavy output

**R10: Track second-newest in LRUMap** (Low priority)
- Maintain a `_secondNewestKey` alongside `_newestKey`
- On delete of newest, promote second-newest without iteration
- Only matters at scale (500+ agents with frequent eviction)

---

## 5. Local Echo & Input Path

### Current State (Well-Designed)
- **DOM overlay approach** — `<span>` elements in `.xterm-screen` at z-index 7, completely independent of `terminal.write()`
- **Render caching**: `_lastRenderKey` includes text, position, column offsets — skips redundant re-renders
- **Input flow**: Char accumulation → Enter triggers flush → 80ms delay before `\r` (ensures text reaches PTY first)
- **Tab completion**: Baseline snapshot → detect buffer change → 300ms fallback timer
- **CJK support**: Per-character width detection with `terminal.unicode.getStringCellWidth()` preferred, manual fallback
- **Prompt detection**: Bottom-up line scan, O(rows) — cached position, column-lock prevents jitter

### Bottlenecks

**B11: tmux send-keys latency** (~50-100ms per input)
- Each `writeViaMux()` spawns a child process (`tmux send-keys`)
- Text and Enter sent separately with 50ms delay between
- For rapid typing: characters batch before Enter, so overhead is per-command not per-keystroke
- **Acceptable trade-off** for session persistence (tmux survives server restarts)

**B12: 80ms delay between text flush and Enter** (`app.js:872-875`)
- Intentional: ensures text reaches PTY before Enter, preventing Ink from processing empty input
- Adds 80ms to perceived Enter-to-response latency
- Could potentially be reduced with acknowledgment-based approach

**B13: Scroll listener on terminal viewport** (`zerolag-input-addon.ts:139`)
- 50ms debounced re-render on scroll — acceptable but fires frequently during heavy output
- Overlay hidden when scrolled up (correct behavior), shown when at bottom

### Recommendations

**R11: Reduce Enter delay from 80ms to 50ms** (Low risk, test carefully)
- The tmux `send-keys` already has 50ms internal delay
- Combined with network latency, 80ms client-side may be excessive
- Test with Ink-heavy sessions (Claude Code's status bar) — if text arrives before Enter at 50ms, reduce
- **Savings**: 30ms perceived latency reduction per command

**R12: Batch tmux send-keys via stdin pipe** (Medium effort, high impact for rapid input)
- Instead of spawning `tmux send-keys` per input, maintain a persistent connection
- Use `tmux -C` (control mode) for programmatic interaction without child process spawning
- **Savings**: Eliminate ~50-100ms process spawn overhead per input
- **Risk**: Control mode has different semantics; needs careful testing with session persistence

**R13: Skip overlay re-render during heavy output scroll** (Low risk)
- When terminal is receiving >10KB/s output, hide overlay entirely (user isn't typing during heavy output)
- Re-show overlay after 500ms of output silence
- **Savings**: Eliminates unnecessary DOM overlay re-renders during build logs / test output

---

## 6. Polling & File Watchers

### Current State
- **SubagentWatcher**: 1s base poll, full scan throttled to every 5s, fs.watch() on known directories
- **TranscriptWatcher**: 1 per session, fs.watch() primary with 1s poll fallback
- **ImageWatcher**: chokidar per session with 100ms stability poll, burst limit 20/10s
- **TeamWatcher**: chokidar primary with 30s poll fallback, LRU caches (50 teams, 200 tasks)
- **RalphTracker**: Todo cleanup every 5 minutes

### Scaling Profile (20 sessions)
| Component | Instances | Frequency | Total ops/sec |
|-----------|-----------|-----------|---------------|
| SubagentWatcher | 1 (global) | Full scan every 5s | 0.2/s |
| TranscriptWatcher | 20 | 1s poll (fallback) | 20/s max |
| ImageWatcher | 20 | 100ms poll (during writes only) | 200/s burst |
| TeamWatcher | 1 (global) | 30s poll (fallback) | 0.03/s |
| SSE heartbeat | 1 (global) | 15s | 0.07/s |
| SSE dead client check | 1 (global) | 30s | 0.03/s |
| Mux stats collection | 1 (global) | 2s | 0.5/s |
| **Total steady-state** | | | **~21/s** |

### Recommendations

**R14: Increase TranscriptWatcher poll interval to 2s** (Low risk)
- Transcript changes are infrequent (new messages every few seconds at most)
- fs.watch() is the primary mechanism; polling is fallback
- **Savings**: Halves fallback filesystem checks (20/s → 10/s for 20 sessions)

**R15: Share chokidar instances for co-located session directories** (Medium effort)
- Sessions in the same parent directory could share a single chokidar watcher with depth:3
- Common case: multiple sessions in `~/projects/foo/` — one watcher covers all
- **Savings**: Reduce chokidar instances from 20 to ~5-10 for typical workloads

---

## 7. Frontend Asset Delivery

### Current State
- **app.js**: 12,027 lines (source) → esbuild minified → gzip/brotli compressed (~30-40KB gzipped)
- **Static caching**: `maxAge: '1y'` via `@fastify/static`
- **Service worker**: Push notification handler only — no asset caching
- **No code splitting**: Single monolithic app.js bundle

### Bottlenecks

**B14: No cache-busting mechanism**
- `maxAge: '1y'` means browsers cache aggressively
- After deployment, users need `Ctrl+Shift+R` to see updates
- No content hash in filenames or ETags for automatic invalidation

**B15: Monolithic app.js**
- All 12K lines loaded on initial page load regardless of which features are used
- Ralph wizard, plan orchestrator UI, team management — all loaded upfront
- Mobile loads the same bundle as desktop

### Recommendations

**R16: Add content hash to asset filenames** (Medium impact)
- Build step: rename `app.js` → `app.[hash].js`
- Generate a manifest or inject hash into HTML template
- Keep `maxAge: '1y'` — cache invalidation happens via filename change
- **Savings**: Eliminates stale cache issues after deployment; removes need for manual hard refresh

**R17: Code-split app.js into core + feature modules** (High effort, medium impact)
- Core (~4K lines): terminal, SSE, session management, tabs, input handling
- Deferred (~8K lines): Ralph wizard, plan UI, team management, subagent windows, image viewer
- Load deferred modules on first use via dynamic `import()` or lazy `<script>` injection
- **Savings**: ~60% reduction in initial load size; faster time-to-interactive
- **Risk**: Complexity increase; need to handle loading states for deferred features
- **Note**: May not be worth the effort given the app is already gzipped to ~30-40KB

---

## 8. CSS Performance

### Current State
- **styles.css**: 7,153 lines with ~45 box-shadow uses, 2 backdrop-filter uses
- Animations: GPU-accelerated keyframes for pulsing alerts, loading spinners
- Z-index layering: well-organized (subagent 1000, plan 1100, log 2000, image 3000, overlay 7)

### Recommendations

**R18: Replace backdrop-filter with opaque overlay** (Low risk, covered in R8)

**R19: Use `contain: content` on subagent windows** (Low risk)
- Add CSS containment to subagent window containers
- Prevents layout changes inside windows from triggering reflow on parent
- Especially valuable with 50 windows: changes in one window won't invalidate others
- ```css
  .subagent-window { contain: content; }
  ```
- **Savings**: Reduces layout recalculation scope from global to per-window

**R20: Use `content-visibility: auto` on off-screen subagent windows** (Low risk)
- Browser skips rendering of off-screen windows entirely
- Combined with `contain-intrinsic-size` to prevent layout shift
- ```css
  .subagent-window.minimized { content-visibility: hidden; }
  ```
- **Savings**: Browser skips paint/layout for minimized windows; complements R7

---

## 9. Memory & Scaling Limits

### Current Budget (20 sessions)
| Component | Per Session | Total | Status |
|-----------|-----------|-------|--------|
| Terminal buffer | 2MB | 40MB | Hard-limited, auto-trim |
| Text output | 1MB | 20MB | Hard-limited, auto-trim |
| Messages | ~1MB | 20MB | Capped at 1000, trims to 800 |
| Respawn buffer | 1MB | 20MB | Hard-limited |
| **Buffers total** | | **100MB** | Acceptable |
| TranscriptWatcher | ~100KB | 2MB | |
| ImageWatcher | ~50KB | 1MB | |
| SubagentWatcher | ~500KB | 500KB | Global |
| Frontend terminal cache | ~256KB | 5MB | LRU, max 20 entries |
| **Total estimated** | | **~110MB** | Comfortable |

### At Max Scale (50 sessions)
- Buffers: ~250MB
- Watchers: ~5MB
- **Total: ~255MB** + Node.js overhead — acceptable on modern hardware

### Potential Leak Vectors (All Mitigated)
- `_shortIdCache` in server — unbounded Map, but entries are tiny (string→string); grows at O(sessions created), not O(events)
- All CleanupManager-registered resources tracked and disposed on session stop
- `isStopped` guard prevents new timers after session cleanup

---

## 10. Implementation Priority Matrix

### Phase 1 — Quick Wins (1-2 hours each, low risk)
| # | Optimization | Files to Change |
|---|-------------|-----------------|
| R6 | Targeted badge update | `app.js` (3207-3209) |
| R3 | Canvas renderer on mobile | `app.js` (627-637) |
| R8 | Replace backdrop-filter blur | `styles.css` (2246, 3098) |
| R19 | CSS containment on subagent windows | `styles.css` |
| R20 | `content-visibility: hidden` on minimized windows | `styles.css` |

### Phase 2 — Medium Effort (half-day each)
| # | Optimization | Files to Change |
|---|-------------|-----------------|
| R2 | Tiered SSE padding | `server.ts` (broadcast function) |
| R7 | Lazy xterm.js for minimized subagents | `subagent-windows.js` |
| R11 | Reduce Enter delay to 50ms | `app.js` (872-875), test with Ink |
| R14 | TranscriptWatcher 2s poll | `transcript-watcher.ts` |
| R16 | Content-hash asset filenames | `build.mjs`, `server.ts` |

### Phase 3 — Larger Initiatives (1-2 days each)
| # | Optimization | Files to Change |
|---|-------------|-----------------|
| R1 | Session-scoped SSE subscriptions | `server.ts`, `app.js` (SSE connect) |
| R5 | Lazy Unicode11Addon loading | `app.js`, build pipeline |
| R12 | Persistent tmux control mode | `tmux-manager.ts` |
| R17 | Code-split app.js | `app.js`, `build.mjs`, HTML template |

### Not Recommended (Low ROI or High Risk)
| # | Why Not |
|---|---------|
| R4 | Dynamic scrollback adds complexity; memory savings marginal vs total budget |
| R9 | Adaptive pending data cap adds state; current 64KB cap rarely matters |
| R10 | LRUMap.delete() O(n) is theoretical; never triggered at current scale |
| R15 | Shared chokidar instances add directory-matching complexity for minimal gain |

---

## Appendix: Key File Locations

| Area | File | Key Lines |
|------|------|-----------|
| SSE broadcast | `src/web/server.ts` | 1961-1989 (broadcast), 1934-1959 (backpressure) |
| Terminal batching | `src/web/server.ts` | 1994-2048 (per-session adaptive batching) |
| Frame budget | `src/web/public/app.js` | 1370-1478 (flushPendingWrites, 64KB cap) |
| Flicker filter | `src/web/public/app.js` | 1176-1255 (50ms sync wait, 256KB safety) |
| Tab rendering | `src/web/public/app.js` | 3108-3357 (incremental + full rebuild) |
| Tab switching | `src/web/public/app.js` | 3560-3760 (cache + chunked load + deferred UI) |
| Local echo | `packages/xterm-zerolag-input/src/` | All files (overlay, prompt, CJK) |
| Local echo integration | `src/web/public/app.js` | 640, 815-988 (input flow) |
| Subagent windows | `src/web/public/subagent-windows.js` | Full file (window mgmt, drag, minimize) |
| State persistence | `src/state-store.ts` | 161-250 (debounced save, incremental JSON) |
| Buffer accumulator | `src/utils/buffer-accumulator.ts` | Full file (array chunks, lazy join) |
| PTY handling | `src/session.ts` | 1046-1133 (data flow), 1173-1230 (parsing) |
| Config limits | `src/config/` | 9 files (buffer, map, timing, auth, etc.) |
| Anti-flicker docs | `docs/terminal-anti-flicker.md` | Architecture reference |
| CSS | `src/web/public/styles.css` | 2246 (backdrop-filter), full file |
| Build pipeline | `scripts/build.mjs` | 59-68 (minify + compress) |
