# Context Window Visualization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add three complementary context window UI components — a stacked segment bar in the session header (A), a dismissible warning banner at 80% (C), and a context chip + detail panel (D) — all fed by passive token tracking from JSON result messages with 60s background `/context` refreshes for full category breakdown.

**Architecture:** `session.ts` emits a `contextUpdate` event on every result message (passive) and every 60s while idle (refresh with full breakdown). `server.ts` listens and broadcasts `SseEvent.ContextUsage`. Frontend `ContextBar` singleton stores per-session data and renders all three components.

**Tech Stack:** TypeScript (strict), Node.js, Fastify, SSE, vanilla JS, CSS transitions, inline SVG donut

---

### Task 1: SSE event type + frontend constant

**Files:**
- Modify: `src/web/sse-events.ts` (add after last event entry)
- Modify: `src/web/public/constants.js` (add to SSE_EVENTS object around line 285)

**Step 1: Add ContextUsage to sse-events.ts**

Open `src/web/sse-events.ts`. Find the last event entry before the closing `}` of the event map. Add:

```typescript
  /** Session context window usage update */
  ContextUsage: 'session:contextUsage',
```

Also add the TypeScript payload type. Find where other event payload types are defined (search for `SessionCompletion` type). Add alongside them:

```typescript
export interface ContextUsagePayload {
  id: string;
  pct: number;
  inputTokens: number;
  maxTokens: number;
  system?: number;
  conversation?: number;
  tools?: number;
}
```

**Step 2: Add SESSION_CONTEXT_USAGE to constants.js**

Open `src/web/public/constants.js`. Find the `SSE_EVENTS` object (around line 186). After the `SESSION_CLI_INFO` line (line 203), add:

```javascript
  SESSION_CONTEXT_USAGE: 'session:contextUsage',
```

**Step 3: Verify TypeScript compiles**

```bash
cd /home/siggi/sources/Codeman-feat-ui-overhaul
tsc --noEmit 2>&1 | head -20
```
Expected: no errors

**Step 4: Commit**

```bash
git add src/web/sse-events.ts src/web/public/constants.js
git commit -m "feat(context): add ContextUsage SSE event type and frontend constant"
```

---

### Task 2: Passive token tracking in session.ts + SSE broadcast in server.ts

**Files:**
- Modify: `src/session.ts` (lines ~1697 and new helper method)
- Modify: `src/web/server.ts` (registerSessionListeners area, around line 1188)

**Step 1: Add context window size helper to session.ts**

In `src/session.ts`, find the area around line 100–150 where constants and small helpers are defined (before the class body). Add this constant and helper after the existing constants:

```typescript
/** Context window size by model. All current Claude models: 200k. */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  default: 200_000,
};

function getModelContextWindow(model: string): number {
  for (const [key, size] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (model.includes(key)) return size;
  }
  return 200_000;
}
```

**Step 2: Emit contextUpdate after passive token tracking**

In `src/session.ts`, find line 1699 (after `this._autoOps.checkAutoClear()`). The surrounding code is:

```typescript
              // Check if we should auto-compact or auto-clear
              this._autoOps.checkAutoCompact();
              this._autoOps.checkAutoClear();
            }
          }
```

Replace with:

```typescript
              // Check if we should auto-compact or auto-clear
              this._autoOps.checkAutoCompact();
              this._autoOps.checkAutoClear();

              // Emit passive context usage update
              if (inputDelta > 0 && this._totalInputTokens > 0) {
                const maxTokens = getModelContextWindow(this._config?.model ?? '');
                this.emit('contextUpdate', {
                  inputTokens: this._totalInputTokens,
                  maxTokens,
                  pct: Math.min(100, Math.round((this._totalInputTokens / maxTokens) * 100)),
                });
              }
            }
          }
```

Note: Check what field holds the model name. Search `this._config` or `this.config` in session.ts to find the correct model property. The field is likely `this.config.model` or `this._modelId`. Adjust accordingly.

**Step 3: Add contextUpdate listener in server.ts**

In `src/web/server.ts`, find `registerSessionListeners()` (around line 1168). Find the `completion:` handler block (around line 1189):

```typescript
      completion: (result, cost) => {
        this.broadcast(SseEvent.SessionCompletion, { id: session.id, result, cost });
```

Add a new listener AFTER the `idle:` block (around line 1333). Look for a pattern like `.on('idle', ...)` or `idle: () => {`. Immediately after the idle handler closes, add:

```typescript
      contextUpdate: (data: { inputTokens: number; maxTokens: number; pct: number; system?: number; conversation?: number; tools?: number }) => {
        this.broadcast(SseEvent.ContextUsage, { id: session.id, ...data });
      },
```

Note: The exact registration style (`.on('contextUpdate', ...)` vs an object key) must match what the rest of the listeners use. Read the registerSessionListeners function to determine whether session events are registered via `session.on(eventName, cb)` or via a callbacks map. Follow the same pattern.

**Step 4: Verify TypeScript compiles**

```bash
tsc --noEmit 2>&1 | head -20
```
Expected: no errors

**Step 5: Manual smoke test**

Start the dev server:
```bash
npx tsx src/index.ts web --port 3003 &
```

Open a session and run a prompt. Then check SSE stream:
```bash
curl -N http://localhost:3003/api/events 2>/dev/null | grep contextUsage
```
Expected: lines containing `session:contextUsage` with `pct` and `inputTokens` after Claude responds.

Kill the dev server after testing.

**Step 6: Commit**

```bash
git add src/session.ts src/web/server.ts
git commit -m "feat(context): passive token tracking emits contextUpdate SSE event"
```

---

### Task 3: Background /context refresh (full category breakdown)

**Files:**
- Modify: `src/session.ts` (add `_refreshContext()` method, `_awaitingContext` state, timer)

**Step 1: Add state fields to Session class**

In `src/session.ts`, find the private field declarations of the Session class (search for `private _isStopped`). Add these fields in the same block:

```typescript
  private _awaitingContext = false;
  private _contextOutputLines: string[] = [];
  private _contextRefreshTimer: ReturnType<typeof setTimeout> | null = null;
```

**Step 2: Add context parse helper**

Add this private method to the Session class (good place: just before `processOutput()`):

```typescript
  /** Parse lines of /context command output into structured data. Returns null if incomplete. */
  private _tryParseContextOutput(lines: string[]): {
    inputTokens: number; maxTokens: number; pct: number;
    system?: number; conversation?: number; tools?: number;
  } | null {
    const text = lines.join('\n');
    const totalMatch = text.match(/Total:\s+([\d,]+)\s*\/\s*([\d,]+)/i);
    if (!totalMatch) return null;
    const parse = (s: string) => parseInt(s.replace(/,/g, ''), 10);
    const total = parse(totalMatch[1]);
    const max = parse(totalMatch[2]);
    const sysMatch = text.match(/System(?:\s+prompt)?:\s+([\d,]+)\s+tokens/i);
    const convMatch = text.match(/Conversation:\s+([\d,]+)\s+tokens/i);
    const toolsMatch = text.match(/Tools:\s+([\d,]+)\s+tokens/i);
    return {
      inputTokens: total,
      maxTokens: max,
      pct: Math.min(100, Math.round((total / max) * 100)),
      system: sysMatch ? parse(sysMatch[1]) : undefined,
      conversation: convMatch ? parse(convMatch[1]) : undefined,
      tools: toolsMatch ? parse(toolsMatch[1]) : undefined,
    };
  }
```

**Step 3: Add `_refreshContext()` method**

Add this method to the Session class:

```typescript
  /** Send /context, parse output, emit contextUpdate with full category breakdown. */
  private _refreshContext(): void {
    if (this._isStopped || this._awaitingContext) return;
    this._awaitingContext = true;
    this._contextOutputLines = [];
    void this.writeViaMux('/context\r');
    // Safety timeout — clear flag after 8s regardless
    setTimeout(() => {
      if (this._awaitingContext) {
        this._awaitingContext = false;
        this._contextOutputLines = [];
      }
    }, 8_000);
  }
```

**Step 4: Consume context output lines in processOutput()**

In `processOutput()`, find the text output path. The lines that are NOT JSON fall into `this._textOutput.append(line + '\n')` (around line 1715). Just before appending, add context capture:

```typescript
      } else if (trimmed) {
        // Capture /context output if awaiting refresh
        if (this._awaitingContext) {
          this._contextOutputLines.push(cleanLine);
          const parsed = this._tryParseContextOutput(this._contextOutputLines);
          if (parsed) {
            this._awaitingContext = false;
            this._contextOutputLines = [];
            this.emit('contextUpdate', parsed);
          }
        }
        this._textOutput.append(line + '\n');
      }
```

**Step 5: Schedule refresh after completion**

In `processOutput()`, find where `msg.type === 'result'` is handled (around line 1703):

```typescript
          if (msg.type === 'result' && msg.total_cost_usd) {
            this._totalCost = msg.total_cost_usd;
          }
```

After the closing `}` of this block (still inside the `try`), add the timer:

```typescript
          if (msg.type === 'result') {
            // Schedule a background /context refresh 60s after completion (if still idle)
            if (this._contextRefreshTimer) clearTimeout(this._contextRefreshTimer);
            this._contextRefreshTimer = setTimeout(() => {
              this._contextRefreshTimer = null;
              if (!this._isStopped) this._refreshContext();
            }, 60_000);
          }
```

**Step 6: Cancel timer in stop()**

Find the `stop()` method in session.ts. Inside it, where other timers/cleanup happen, add:

```typescript
    if (this._contextRefreshTimer) {
      clearTimeout(this._contextRefreshTimer);
      this._contextRefreshTimer = null;
    }
    this._awaitingContext = false;
```

**Step 7: Verify TypeScript compiles**

```bash
tsc --noEmit 2>&1 | head -20
```
Expected: no errors

**Step 8: Commit**

```bash
git add src/session.ts
git commit -m "feat(context): background /context refresh with category breakdown"
```

---

### Task 4: On-demand context API route

**Files:**
- Modify: `src/web/routes/system-routes.ts` (add GET /api/sessions/:id/context around line 810, before closing `}`)

**Step 1: Add the route**

Open `src/web/routes/system-routes.ts`. Find the last route before the closing `}` of `registerSystemRoutes` (around line 810). Add before the closing brace:

```typescript
  app.get('/api/sessions/:id/context', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = app.sessionManager.getSession(id);
    if (!session) {
      reply.status(404);
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
    }

    // Trigger immediate refresh and wait for result (up to 8s)
    return new Promise<object>((resolve) => {
      const timeout = setTimeout(() => {
        resolve({ id, pct: null, inputTokens: null, maxTokens: null });
      }, 8_000);

      session.once('contextUpdate', (data: object) => {
        clearTimeout(timeout);
        resolve({ id, ...(data as Record<string, unknown>) });
      });

      // Trigger the refresh — _refreshContext is private, expose via public wrapper
      (session as unknown as { _refreshContext: () => void })._refreshContext();
    });
  });
```

Note: If direct access to `_refreshContext` feels wrong, add a public `refreshContext()` method to the Session class that calls `this._refreshContext()`. Update the route to call `session.refreshContext()` instead.

**Step 2: Add public refreshContext() wrapper to session.ts**

In `src/session.ts`, add a public method near `writeViaMux`:

```typescript
  /** Trigger an immediate /context refresh. Result arrives via 'contextUpdate' event. */
  refreshContext(): void {
    this._refreshContext();
  }
```

**Step 3: Update the route to use the public method**

Replace the cast line in the route:
```typescript
      (session as unknown as { _refreshContext: () => void })._refreshContext();
```
with:
```typescript
      session.refreshContext();
```

**Step 4: Verify TypeScript compiles**

```bash
tsc --noEmit 2>&1 | head -20
```
Expected: no errors

**Step 5: Smoke test the route**

```bash
npx tsx src/index.ts web --port 3003 &
sleep 3
# Get a session ID first:
SESSION_ID=$(curl -s http://localhost:3003/api/sessions | jq -r '.[0].id')
echo "Session: $SESSION_ID"
curl -s http://localhost:3003/api/sessions/$SESSION_ID/context | jq
```
Expected: JSON with `id`, `pct`, `inputTokens`, `maxTokens` fields (pct may be null if no session active).

Kill dev server.

**Step 6: Commit**

```bash
git add src/session.ts src/web/routes/system-routes.ts
git commit -m "feat(context): add GET /api/sessions/:id/context on-demand refresh route"
```

---

### Task 5: HTML scaffold

**Files:**
- Modify: `src/web/public/index.html`

**Step 1: Add CTX chip button**

Find line 98 in `index.html` (the closing `</button>` of `pluginsChipBtn`). After it, add:

```html
        <button id="ctxChipBtn" class="mcp-chip ctx-chip" title="Context Window" style="display:none" aria-label="Context window usage">
          <span class="mcp-chip-icon">&#x25a1;</span>
          <span class="mcp-chip-label">CTX</span>
          <span class="mcp-chip-badge" id="ctxChipBadge" style="display:none"></span>
        </button>
```

**Step 2: Add context bar**

Find the `<header>` closing area in index.html. Search for `id="headerTokens"` (line 105). After that `<div>` and before `</div>` that closes the header content row, add:

```html
        <div id="contextBar" class="ctx-bar" style="display:none" aria-label="Context usage bar">
          <div class="ctx-bar-seg ctx-seg-system" id="ctxSegSystem" style="width:0%"></div>
          <div class="ctx-bar-seg ctx-seg-conv" id="ctxSegConv" style="width:0%"></div>
          <div class="ctx-bar-seg ctx-seg-tools" id="ctxSegTools" style="width:0%"></div>
          <div class="ctx-bar-seg ctx-seg-free" id="ctxSegFree" style="width:100%"></div>
        </div>
```

Note: The bar must be placed OUTSIDE the flex row (it spans full width). Look for a containing `<div>` that wraps the header content. Place `#contextBar` as a sibling to that row, inside `<header>`.

**Step 3: Add warning banner**

Search for `id="timerBanner"` or the first banner element after `<header>`. Place the context banner immediately after the header closing tag (or near other banners):

```html
    <!-- Context Warning Banner -->
    <div id="contextBanner" class="ctx-banner" style="display:none" role="alert" aria-live="polite">
      <span class="ctx-banner-text" id="contextBannerText">Context ~0% full — consider /clear</span>
      <button class="ctx-banner-clear" id="contextBannerClear" title="Send /clear to session">Clear</button>
      <button class="ctx-banner-dismiss" id="contextBannerDismiss" aria-label="Dismiss">&#x00d7;</button>
    </div>
```

**Step 4: Add context detail panel**

Find the `#pluginsPanel` closing `</div>` in index.html. After it, add the context panel:

```html
    <!-- Context Detail Panel -->
    <div id="contextPanel" class="mcp-panel ctx-panel" style="display:none" role="dialog" aria-label="Context window details">
      <div class="mcp-panel-header">
        <span class="mcp-panel-title">Context Window</span>
        <button class="mcp-panel-close" id="contextPanelClose" aria-label="Close context panel">&#x00d7;</button>
      </div>
      <div class="mcp-panel-body">
        <div class="ctx-donut-wrap">
          <svg class="ctx-donut" viewBox="0 0 100 100" width="96" height="96" aria-hidden="true">
            <circle cx="50" cy="50" r="40" fill="none" stroke="#1e293b" stroke-width="12"/>
            <circle cx="50" cy="50" r="40" fill="none" stroke="#22d3ee" stroke-width="12"
              stroke-dasharray="251.2" stroke-dashoffset="251.2"
              stroke-linecap="round" transform="rotate(-90 50 50)"
              id="ctxDonutArc"/>
          </svg>
          <div class="ctx-donut-label" id="ctxDonutPct">--</div>
        </div>
        <table class="ctx-table" id="ctxTable">
          <tbody>
            <tr><td class="ctx-swatch ctx-swatch-system"></td><td>System</td><td class="ctx-val" id="ctxValSystem">--</td><td class="ctx-pct" id="ctxPctSystem"></td></tr>
            <tr><td class="ctx-swatch ctx-swatch-conv"></td><td>Conversation</td><td class="ctx-val" id="ctxValConv">--</td><td class="ctx-pct" id="ctxPctConv"></td></tr>
            <tr><td class="ctx-swatch ctx-swatch-tools"></td><td>Tools</td><td class="ctx-val" id="ctxValTools">--</td><td class="ctx-pct" id="ctxPctTools"></td></tr>
            <tr><td class="ctx-swatch ctx-swatch-free"></td><td>Free</td><td class="ctx-val" id="ctxValFree">--</td><td class="ctx-pct" id="ctxPctFree"></td></tr>
          </tbody>
        </table>
        <div class="ctx-suggestion" id="ctxSuggestion" style="display:none">
          Consider <code>/clear</code> or <code>/compact</code> to free context.
        </div>
      </div>
    </div>
```

**Step 5: Bump version strings**

Find the `styles.css?v=` reference in index.html and increment by 1 (e.g. `0.1681` → `0.1682`).
Find the `app.js?v=` reference and increment patch digit (e.g. `0.4.92` → `0.4.93`).

**Step 6: Commit**

```bash
git add src/web/public/index.html
git commit -m "feat(context): add CTX chip, context bar, banner, and detail panel HTML"
```

---

### Task 6: CSS styling

**Files:**
- Modify: `src/web/public/styles.css` (add new section at the end, before final `*/`)

**Step 1: Add context visualization styles**

Open `src/web/public/styles.css`. Scroll to the very end. After the last rule, add:

```css
/* ── Context Bar ──────────────────────────────────────────── */

/* Full-width 3px bar below header, hidden until first data */
.ctx-bar {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 3px;
  display: flex;
  overflow: hidden;
  pointer-events: none;
}
.ctx-bar-seg {
  height: 100%;
  transition: width 0.4s ease;
  flex-shrink: 0;
}
.ctx-seg-system  { background: #c084fc; }
.ctx-seg-conv    { background: #22d3ee; }
.ctx-seg-tools   { background: #fbbf24; }
.ctx-seg-free    { background: #1e293b; flex: 1; min-width: 0; }

/* CTX chip — mirrors .plugins-chip styling */
.ctx-chip { }
.ctx-chip.ctx-green .mcp-chip-badge { background: rgba(74,222,128,0.2); color: #4ade80; }
.ctx-chip.ctx-amber .mcp-chip-badge { background: rgba(251,191,36,0.2); color: #fbbf24; }
.ctx-chip.ctx-red   .mcp-chip-badge { background: rgba(248,113,113,0.2); color: #f87171; }
.ctx-chip.ctx-amber { border-color: rgba(251,191,36,0.35); }
.ctx-chip.ctx-red   { border-color: rgba(248,113,113,0.35); }

/* Warning banner */
.ctx-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  background: rgba(251,191,36,0.10);
  border-top: 1px solid rgba(251,191,36,0.25);
  border-bottom: 1px solid rgba(251,191,36,0.18);
  font-size: 12px;
  color: #fbbf24;
  animation: ctx-banner-in 0.25s ease;
  flex-shrink: 0;
}
@keyframes ctx-banner-in {
  from { transform: translateY(-100%); opacity: 0; }
  to   { transform: translateY(0);     opacity: 1; }
}
.ctx-banner-text { flex: 1; }
.ctx-banner-clear {
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid rgba(251,191,36,0.4);
  background: rgba(251,191,36,0.12);
  color: #fbbf24;
  font-size: 11px;
  cursor: pointer;
  transition: background 0.15s ease;
}
.ctx-banner-clear:hover { background: rgba(251,191,36,0.25); }
.ctx-banner-dismiss {
  background: none;
  border: none;
  color: rgba(251,191,36,0.7);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
}
.ctx-banner-dismiss:hover { color: #fbbf24; }

/* Context detail panel */
.ctx-panel { z-index: 602; }

.ctx-donut-wrap {
  position: relative;
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 16px 0 8px;
}
.ctx-donut { display: block; }
#ctxDonutArc { transition: stroke-dashoffset 0.4s ease, stroke 0.3s ease; }
.ctx-donut-label {
  position: absolute;
  font-size: 18px;
  font-weight: 600;
  color: #e2e8f0;
  pointer-events: none;
}

.ctx-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  margin: 8px 0;
}
.ctx-table td {
  padding: 5px 8px;
  color: #94a3b8;
  vertical-align: middle;
}
.ctx-table tr:hover td { background: rgba(255,255,255,0.04); }
.ctx-val { color: #e2e8f0; font-variant-numeric: tabular-nums; text-align: right; }
.ctx-pct { color: #64748b; font-size: 11px; text-align: right; width: 36px; }

.ctx-swatch {
  width: 10px;
  padding: 0 !important;
}
.ctx-swatch::before {
  content: '';
  display: block;
  width: 10px;
  height: 10px;
  border-radius: 2px;
}
.ctx-swatch-system::before { background: #c084fc; }
.ctx-swatch-conv::before   { background: #22d3ee; }
.ctx-swatch-tools::before  { background: #fbbf24; }
.ctx-swatch-free::before   { background: #334155; }

.ctx-suggestion {
  margin: 8px;
  padding: 8px 10px;
  background: rgba(251,191,36,0.08);
  border: 1px solid rgba(251,191,36,0.2);
  border-radius: 6px;
  font-size: 12px;
  color: #94a3b8;
}
.ctx-suggestion code {
  color: #fbbf24;
  background: rgba(251,191,36,0.12);
  padding: 1px 4px;
  border-radius: 3px;
}
```

**Step 2: Verify CSS parses**

```bash
npx tsx src/index.ts web --port 3003 &
sleep 2
curl -s http://localhost:3003/styles.css | head -5
```
Expected: CSS content loads without 404.
Kill server.

**Step 3: Commit**

```bash
git add src/web/public/styles.css
git commit -m "feat(context): add CSS for context bar, chip, banner, and detail panel"
```

---

### Task 7: ContextBar singleton in app.js

**Files:**
- Modify: `src/web/public/app.js` (add singleton after PluginsPanel, wire up init and SSE handler)

**Step 1: Add ContextBar singleton**

Open `src/web/public/app.js`. Find the end of the PluginsPanel definition (around line 1170 where PluginsPanel ends with `};`). After that closing `};`, add the ContextBar singleton:

```javascript
// Context Bar / Chip / Banner / Panel
// ===================================================================
const ContextBar = {
  _data: new Map(),          // sessionId -> latest ContextUsagePayload
  _dismissed80: new Set(),   // sessionIds dismissed at 80% threshold
  _dismissed90: new Set(),   // sessionIds dismissed at 90% threshold

  init() {
    this._bar       = document.getElementById('contextBar');
    this._chip      = document.getElementById('ctxChipBtn');
    this._badge     = document.getElementById('ctxChipBadge');
    this._banner    = document.getElementById('contextBanner');
    this._bannerTxt = document.getElementById('contextBannerText');
    this._bannerClr = document.getElementById('contextBannerClear');
    this._bannerDis = document.getElementById('contextBannerDismiss');
    this._panel     = document.getElementById('contextPanel');
    this._donutArc  = document.getElementById('ctxDonutArc');
    this._donutPct  = document.getElementById('ctxDonutPct');

    this._chip?.addEventListener('click', () => this.toggle());
    document.getElementById('contextPanelClose')?.addEventListener('click', () => this.close());

    this._bannerClr?.addEventListener('click', () => {
      if (app.activeSessionId) app.sendInput('/clear');
    });
    this._bannerDis?.addEventListener('click', () => {
      const sid = app.activeSessionId;
      if (!sid) return;
      const d = this._data.get(sid);
      if (d) {
        if (d.pct >= 90) this._dismissed90.add(sid);
        else this._dismissed80.add(sid);
      }
      if (this._banner) this._banner.style.display = 'none';
    });
  },

  onContextUsage(data) {
    this._data.set(data.id, data);
    const sid = app.activeSessionId;
    if (data.id === sid) {
      this._updateBar(data);
      this._checkBanner(data);
      this._updateChip(data);
      if (this._panel?.classList.contains('open')) this._renderPanel(data);
    }
  },

  onSessionSelected(sessionId) {
    const data = this._data.get(sessionId);
    if (data) {
      this._updateBar(data);
      this._checkBanner(data);
      this._updateChip(data);
    } else {
      this._clearBar();
      if (this._banner) this._banner.style.display = 'none';
      this._clearChip();
    }
  },

  _updateBar(data) {
    if (!this._bar) return;
    this._bar.style.display = '';
    const max = data.maxTokens || 200000;
    const total = data.inputTokens || 0;
    const sys   = data.system      || 0;
    const conv  = data.conversation|| 0;
    const tools = data.tools       || 0;

    if (sys || conv || tools) {
      // Full breakdown available
      const free = Math.max(0, max - sys - conv - tools);
      document.getElementById('ctxSegSystem').style.width = (sys   / max * 100).toFixed(2) + '%';
      document.getElementById('ctxSegConv').style.width   = (conv  / max * 100).toFixed(2) + '%';
      document.getElementById('ctxSegTools').style.width  = (tools / max * 100).toFixed(2) + '%';
      document.getElementById('ctxSegFree').style.width   = (free  / max * 100).toFixed(2) + '%';
    } else {
      // Passive only — single cyan segment
      document.getElementById('ctxSegSystem').style.width = '0%';
      document.getElementById('ctxSegTools').style.width  = '0%';
      document.getElementById('ctxSegConv').style.width   = (total / max * 100).toFixed(2) + '%';
      document.getElementById('ctxSegFree').style.width   = (Math.max(0, max - total) / max * 100).toFixed(2) + '%';
    }
  },

  _clearBar() {
    if (!this._bar) return;
    this._bar.style.display = 'none';
  },

  _checkBanner(data) {
    if (!this._banner) return;
    const sid = data.id;
    const pct = data.pct;

    // Re-show at 90% even if dismissed at 80%
    if (pct >= 90 && !this._dismissed90.has(sid)) {
      this._bannerTxt.textContent = `Context ~${pct}% full — consider /clear or /compact`;
      this._banner.style.display = '';
    } else if (pct >= 80 && !this._dismissed80.has(sid) && !this._dismissed90.has(sid)) {
      this._bannerTxt.textContent = `Context ~${pct}% full — consider /clear`;
      this._banner.style.display = '';
    } else if (pct < 80) {
      this._banner.style.display = 'none';
      // Reset dismissal state when context drops below threshold
      this._dismissed80.delete(sid);
      this._dismissed90.delete(sid);
    }
  },

  _updateChip(data) {
    if (!this._chip || !this._badge) return;
    this._chip.style.display = '';
    this._badge.style.display = '';
    this._badge.textContent = data.pct + '%';
    this._chip.classList.remove('ctx-green', 'ctx-amber', 'ctx-red');
    if (data.pct >= 85) this._chip.classList.add('ctx-red');
    else if (data.pct >= 60) this._chip.classList.add('ctx-amber');
    else this._chip.classList.add('ctx-green');
  },

  _clearChip() {
    if (!this._chip) return;
    this._chip.style.display = 'none';
  },

  open(sessionId) {
    if (!this._panel) return;
    // Close other panels
    if (McpPanel._panel?.classList.contains('open')) McpPanel.close();
    if (typeof PluginsPanel !== 'undefined' && PluginsPanel._panel?.classList.contains('open')) PluginsPanel.close();

    this._panel.style.display = '';
    requestAnimationFrame(() => this._panel.classList.add('open'));
    this._chip?.classList.add('active');

    // Fetch fresh data on open
    const sid = sessionId || app.activeSessionId;
    if (sid) {
      const cached = this._data.get(sid);
      if (cached) this._renderPanel(cached);
      fetch(`/api/sessions/${encodeURIComponent(sid)}/context`)
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d && d.pct != null) { this._data.set(sid, d); this._renderPanel(d); } })
        .catch(() => {});
    }
  },

  close() {
    if (!this._panel) return;
    this._panel.classList.remove('open');
    this._chip?.classList.remove('active');
    const panel = this._panel;
    setTimeout(() => { if (!panel.classList.contains('open')) panel.style.display = 'none'; }, 260);
  },

  toggle() {
    if (this._panel?.classList.contains('open')) this.close();
    else this.open(app.activeSessionId);
  },

  _renderPanel(data) {
    if (!this._donutArc || !this._donutPct) return;
    const CIRC = 251.2;
    const pct = data.pct || 0;
    this._donutArc.style.strokeDashoffset = (CIRC * (1 - pct / 100)).toFixed(2);
    // Color the arc by fill level
    if (pct >= 85) this._donutArc.style.stroke = '#f87171';
    else if (pct >= 60) this._donutArc.style.stroke = '#fbbf24';
    else this._donutArc.style.stroke = '#22d3ee';

    this._donutPct.textContent = pct + '%';

    const max = data.maxTokens || 200000;
    const fmt = n => n != null ? n.toLocaleString() : '--';
    const fpct = n => n != null ? `${(n / max * 100).toFixed(1)}%` : '';

    const sys  = data.system;
    const conv = data.conversation;
    const tools= data.tools;
    const free = (sys != null && conv != null && tools != null)
      ? Math.max(0, max - sys - conv - tools) : null;

    document.getElementById('ctxValSystem').textContent  = fmt(sys);
    document.getElementById('ctxValConv').textContent    = fmt(conv);
    document.getElementById('ctxValTools').textContent   = fmt(tools);
    document.getElementById('ctxValFree').textContent    = fmt(free);
    document.getElementById('ctxPctSystem').textContent  = fpct(sys);
    document.getElementById('ctxPctConv').textContent    = fpct(conv);
    document.getElementById('ctxPctTools').textContent   = fpct(tools);
    document.getElementById('ctxPctFree').textContent    = fpct(free);

    const suggestion = document.getElementById('ctxSuggestion');
    if (suggestion) suggestion.style.display = pct >= 90 ? '' : 'none';
  },
};
```

**Step 2: Wire init() into app startup**

Find line 2223 in app.js where `PluginsPanel.init()` is called:
```javascript
    PluginsPanel.init();
```

After it, add:
```javascript
    ContextBar.init();
```

**Step 3: Wire SSE event handler**

In app.js, find the SSE handler map (around line 80 per the fileoverview). It maps event name strings to handler methods. Add an entry for `session:contextUsage`:

```javascript
  [SSE_EVENTS.SESSION_CONTEXT_USAGE]: (data) => ContextBar.onContextUsage(data),
```

The exact location is where other SSE_EVENTS entries are (e.g., near `SESSION_COMPLETION` or `SESSION_IDLE` handlers). Follow the existing map pattern exactly.

**Step 4: Wire onSessionSelected**

Find line 5847 where `PluginsPanel.showChip()` is called during session selection:
```javascript
    PluginsPanel.showChip();
```

After it, add:
```javascript
    ContextBar.onSessionSelected(sessionId);
```

**Step 5: Close context panel when MCP/Plugins open**

In McpPanel.open() (around line 376 area), find where PluginsPanel is closed:
```javascript
    if (typeof PluginsPanel !== 'undefined' && PluginsPanel._panel?.classList.contains('open'))
      PluginsPanel.close();
```

Add alongside it:
```javascript
    if (typeof ContextBar !== 'undefined' && ContextBar._panel?.classList.contains('open'))
      ContextBar.close();
```

Do the same in PluginsPanel.open() (around line 824):
```javascript
    if (McpPanel._panel?.classList.contains('open')) McpPanel.close();
```

Add after it:
```javascript
    if (typeof ContextBar !== 'undefined' && ContextBar._panel?.classList.contains('open'))
      ContextBar.close();
```

**Step 6: Commit**

```bash
git add src/web/public/app.js
git commit -m "feat(context): ContextBar singleton — bar, chip, banner, and detail panel"
```

---

### Task 8: End-to-end verification

**Files:** No new files — verification only

**Step 1: Start dev server**

```bash
npx tsx src/index.ts web --port 3003 &
sleep 3
```

**Step 2: Playwright smoke test**

```bash
cat > /tmp/test-context.mjs << 'EOF'
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage();
await p.goto('http://localhost:3003', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(2000);

// Check context bar exists in DOM
const bar = await p.locator('#contextBar').count();
console.log('contextBar in DOM:', bar > 0 ? 'PASS' : 'FAIL');

// Check CTX chip hidden initially (no session selected)
const chip = await p.locator('#ctxChipBtn').isVisible();
console.log('ctxChip hidden initially:', !chip ? 'PASS' : 'FAIL (should be hidden)');

// Check context panel in DOM but hidden
const panel = await p.locator('#contextPanel').count();
console.log('contextPanel in DOM:', panel > 0 ? 'PASS' : 'FAIL');

// Check banner hidden initially
const banner = await p.locator('#contextBanner').isVisible();
console.log('banner hidden initially:', !banner ? 'PASS' : 'FAIL (should be hidden)');

console.log('All checks done');
await b.close();
EOF
node /tmp/test-context.mjs
```

Expected: all 4 checks PASS.

**Step 3: Test with active session**

If a session is running, select it in the UI and verify via Playwright:
```bash
cat > /tmp/test-context-session.mjs << 'EOF'
import { chromium } from 'playwright';
const b = await chromium.launch({ headless: false });
const p = await b.newPage();
await p.goto('http://localhost:3003', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(4000);

// If a session tab is visible, click it
const tab = p.locator('.session-tab').first();
if (await tab.count() > 0) {
  await tab.click();
  await p.waitForTimeout(1000);
  const chipVisible = await p.locator('#ctxChipBtn').isVisible();
  console.log('CTX chip visible after session select:', chipVisible ? 'PASS' : 'FAIL');
}

// Click CTX chip if visible
const chip = p.locator('#ctxChipBtn');
if (await chip.isVisible()) {
  await chip.click();
  await p.waitForTimeout(500);
  const panelOpen = await p.locator('#contextPanel.open').count();
  console.log('Context panel opens on chip click:', panelOpen > 0 ? 'PASS' : 'FAIL');
}
await b.close();
EOF
node /tmp/test-context-session.mjs
```

**Step 4: Kill dev server**

```bash
pkill -f "tsx src/index.ts web --port 3003" 2>/dev/null || true
```

**Step 5: Lint check**

```bash
npm run lint 2>&1 | tail -5
```
Expected: no errors (warnings OK).

**Step 6: TypeScript final check**

```bash
tsc --noEmit 2>&1 | head -20
```
Expected: no errors.

**Step 7: Final commit if any cleanup needed**

```bash
git add -p  # stage only intentional changes
git commit -m "fix(context): verification fixes"
```
