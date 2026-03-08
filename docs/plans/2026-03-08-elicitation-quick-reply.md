# Elicitation Quick-Reply Panel Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When Claude Code shows a numbered-option elicitation dialog (e.g. "1: Bad  2: Fine  3: Good  0: Dismiss"), display tappable buttons above the mobile accessory bar so the user can respond without typing.

**Architecture:** Frontend-only change. `_onHookElicitationDialog` already fires via SSE. We parse the last 20 lines of the active xterm buffer for `N: Label` option pairs, store them in `this.pendingElicitation`, and render a strip of tappable buttons in a new `#elicitationPanel` div (a flex item inside `.main`, same pattern as `#terminalStatusStrip`). Tapping a button calls `sendInput(value + '\r')`. Falls back to a text input + Send for free-text questions. Clears when `clearPendingHooks` is called or user responds.

**Tech Stack:** Vanilla JS (`app.js`), CSS (`styles.css`, `mobile.css`), HTML (`index.html`). No backend changes.

---

### Task 1: Add HTML

**Files:**
- Modify: `src/web/public/index.html:243` (after `#terminalStatusStrip`)

**Step 1: Insert the panel div**

After line 243 (`<div class="terminal-status-strip" id="terminalStatusStrip" ...>`), add:

```html
      <!-- Elicitation quick-reply panel — shown when Claude asks a numbered question -->
      <div class="elicitation-panel" id="elicitationPanel" style="display:none;" aria-label="Quick reply"></div>
```

**Step 2: Verify**

```bash
grep -n "elicitationPanel\|terminalStatusStrip" src/web/public/index.html
```
Expected: both IDs appear, `elicitationPanel` is on the line after `terminalStatusStrip`.

---

### Task 2: Add CSS

**Files:**
- Modify: `src/web/public/styles.css` (after `.terminal-status-strip { display:none; }` at line ~6151)
- Modify: `src/web/public/mobile.css` (inside `@media (max-width: 768px)` block, after `.terminal-status-strip` block ending at ~line 2065)

**Step 1: Add base rule to `styles.css`** after the `.terminal-status-strip` block:

```css
.elicitation-panel {
  display: none;
}
```

**Step 2: Add mobile rules to `mobile.css`** after the `.terminal-status-strip` closing brace inside the `@media (max-width: 768px)` block:

```css
  .elicitation-panel {
    background: #111;
    border-top: 1px solid rgba(255,255,255,0.12);
    padding: 6px 8px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .elicitation-panel[style*="display:none"] {
    display: none !important;
  }

  .elicitation-question {
    font-size: 12px;
    color: rgba(255,255,255,0.6);
    padding: 0 2px 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .elicitation-options {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .elicitation-btn {
    flex: 1;
    min-width: 60px;
    padding: 8px 6px;
    background: #1e1e1e;
    border: 1px solid rgba(255,255,255,0.15);
    border-radius: 6px;
    color: #fff;
    font-size: 13px;
    font-family: inherit;
    cursor: pointer;
    text-align: center;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
  }

  .elicitation-btn:active {
    background: #2a2a2a;
    border-color: rgba(255,255,255,0.3);
  }

  .elicitation-free-row {
    display: flex;
    gap: 6px;
  }

  .elicitation-free-input {
    flex: 1;
    background: #1e1e1e;
    border: 1px solid rgba(255,255,255,0.15);
    border-radius: 6px;
    color: #fff;
    font-size: 13px;
    padding: 8px 10px;
    font-family: inherit;
  }

  .elicitation-send-btn {
    padding: 8px 14px;
    background: #2563eb;
    border: none;
    border-radius: 6px;
    color: #fff;
    font-size: 13px;
    cursor: pointer;
    touch-action: manipulation;
  }
```

**Step 3: Verify**

```bash
grep -n "elicitation-panel\|elicitation-btn" src/web/public/styles.css src/web/public/mobile.css
```
Expected: `styles.css` has base rule, `mobile.css` has full mobile rules.

---

### Task 3: Add JS to `app.js`

**Files:**
- Modify: `src/web/public/app.js`

**Step 1: Add `pendingElicitation` state to the constructor**

Find where `this.pendingHooks` is initialized (around line 367). Add after it:

```javascript
    // Elicitation quick-reply state: { sessionId, question, options: [{val,label}] } | null
    this.pendingElicitation = null;
```

**Step 2: Add `_parseElicitationOptions(sessionId)` method**

Add this new method right before `_onHookElicitationDialog` (around line 2479):

```javascript
  /**
   * Reads the last 20 lines of the given session's xterm buffer and extracts
   * numbered options of the form "N: Label" plus the question text above them.
   * Returns { question, options: [{val, label}] } or null if nothing found.
   */
  _parseElicitationOptions(sessionId) {
    const terminal = this.terminals?.get(sessionId) ?? this.terminal;
    if (!terminal) return null;
    const buf = terminal.buffer.active;
    const lineCount = buf.length;
    const start = Math.max(0, lineCount - 20);
    const lines = [];
    for (let i = start; i < lineCount; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true).trimEnd());
    }
    const text = lines.join('\n');

    // Extract all "N: Label" pairs — single digit, label up to 20 chars, separated by 2+ spaces or newline
    const optionRe = /\b(\d):\s*([A-Za-z][A-Za-z /\-]{0,18}?)(?=\s{2,}|\s*\d:|$|\n)/g;
    const options = [];
    let m;
    while ((m = optionRe.exec(text)) !== null) {
      options.push({ val: m[1], label: m[2].trim() });
    }
    if (options.length === 0) return null;

    // Find the question: last non-empty line before first option match
    const firstOptionIdx = text.indexOf(options[0].val + ':');
    const beforeOptions = text.slice(0, firstOptionIdx);
    const questionLines = beforeOptions.split('\n')
      .map(l => l.replace(/^[\u2022\s]+/, '').trim())
      .filter(Boolean);
    const question = questionLines[questionLines.length - 1] || '';

    return { question, options };
  }
```

**Step 3: Add `renderElicitationPanel()` method**

Add directly after `_parseElicitationOptions`:

```javascript
  /** Renders or hides the elicitation quick-reply panel based on this.pendingElicitation. */
  renderElicitationPanel() {
    const panel = document.getElementById('elicitationPanel');
    if (!panel) return;
    const pe = this.pendingElicitation;
    if (!pe || pe.sessionId !== this.activeSessionId) {
      panel.style.display = 'none';
      return;
    }
    panel.style.display = '';
    if (pe.options && pe.options.length > 0) {
      const btns = pe.options.map(o =>
        `<button class="elicitation-btn" ` +
        `onclick="app.sendElicitationResponse('${pe.sessionId}','${o.val}')" ` +
        `ontouchend="event.preventDefault();app.sendElicitationResponse('${pe.sessionId}','${o.val}')"` +
        `>${o.val}: ${o.label}</button>`
      ).join('');
      panel.innerHTML =
        (pe.question ? `<div class="elicitation-question">${pe.question}</div>` : '') +
        `<div class="elicitation-options">${btns}</div>`;
    } else {
      // Free-text fallback
      panel.innerHTML =
        (pe.question ? `<div class="elicitation-question">${pe.question}</div>` : '') +
        `<div class="elicitation-free-row">` +
        `<input class="elicitation-free-input" id="elicitationInput" type="text" ` +
        `placeholder="Type your answer\u2026" autocomplete="off">` +
        `<button class="elicitation-send-btn" ` +
        `onclick="app.sendElicitationResponse('${pe.sessionId}',document.getElementById('elicitationInput').value)">Send</button>` +
        `</div>`;
    }
  }
```

**Step 4: Add `sendElicitationResponse(sessionId, value)` method**

Add directly after `renderElicitationPanel`:

```javascript
  /** Sends a response to the active elicitation dialog and clears the panel. */
  sendElicitationResponse(sessionId, value) {
    if (value === null || value === undefined || value === '') return;
    this.clearPendingHooks(sessionId, 'elicitation_dialog');
    this.pendingElicitation = null;
    this.renderElicitationPanel();
    fetch(`/api/sessions/${sessionId}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: String(value) + '\r', useMux: true }),
    }).catch(() => {});
  }
```

**Step 5: Update `_onHookElicitationDialog` to trigger the panel**

Find the method at line ~2479. Replace its entire body with:

```javascript
  _onHookElicitationDialog(data) {
    const session = this.sessions.get(data.sessionId);
    // Always track pending hook - action alerts need user interaction to clear
    if (data.sessionId) {
      this.setPendingHook(data.sessionId, 'elicitation_dialog');
    }
    this.notificationManager?.notify({
      urgency: 'critical',
      category: 'hook-elicitation',
      sessionId: data.sessionId,
      sessionName: session?.name || data.sessionId,
      title: 'Question Asked',
      message: data.question || 'Claude is asking a question and waiting for your answer',
    });
    // Parse options from terminal output and show quick-reply panel
    const parsed = this._parseElicitationOptions(data.sessionId);
    this.pendingElicitation = {
      sessionId: data.sessionId,
      question: parsed?.question || '',
      options: parsed?.options || [],
    };
    this.renderElicitationPanel();
  }
```

**Step 6: Update `clearPendingHooks` to clear the panel**

Find `clearPendingHooks` at line ~472. After the `this.updateTabAlertFromHooks(sessionId)` call, add:

```javascript
    if (this.pendingElicitation?.sessionId === sessionId &&
        (!hookType || hookType === 'elicitation_dialog')) {
      this.pendingElicitation = null;
      this.renderElicitationPanel();
    }
```

**Step 7: Update `selectSession` to refresh the panel on tab switch**

Find `selectSession` at line 3632. Inside the method, after `this.activeSessionId` has been updated (look for the first assignment to `this.activeSessionId`), add:

```javascript
    this.renderElicitationPanel();
```

**Step 8: Verify no TypeScript errors**

```bash
npx tsc --noEmit 2>&1 | head -20
```
Expected: no output.

---

### Task 4: Bump versions and deploy

**Files:**
- Modify: `src/web/public/index.html`

**Step 1: Bump the three version strings**

- `styles.css?v=0.1634` → `styles.css?v=0.1635`
- `mobile.css?v=0.1642` → `mobile.css?v=0.1643`
- `app.js?v=0.4.14` → `app.js?v=0.4.15`

**Step 2: Build and deploy**

```bash
npm run build
cp -r dist /home/siggi/.codeman/app/
cp package.json /home/siggi/.codeman/app/package.json
systemctl --user restart codeman-web
```

**Step 3: Verify service is running**

```bash
systemctl --user status codeman-web --no-pager | head -5
```
Expected: `Active: active (running)`.

---

### Task 5: Test with Playwright (headless)

**Step 1: Write and run test**

```javascript
// /tmp/playwright-test-elicitation.js
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://localhost:3001', { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 2000));

  // Panel should be hidden by default
  const hiddenByDefault = await page.evaluate(() => {
    const p = document.getElementById('elicitationPanel');
    return p && p.style.display === 'none';
  });
  console.log('Hidden by default:', hiddenByDefault ? 'PASS' : 'FAIL');

  // Simulate elicitation with options
  await page.evaluate(() => {
    const id = app.activeSessionId;
    if (!id) return;
    app.pendingElicitation = {
      sessionId: id,
      question: 'How is Claude doing this session?',
      options: [
        { val: '1', label: 'Bad' },
        { val: '2', label: 'Fine' },
        { val: '3', label: 'Good' },
        { val: '0', label: 'Dismiss' },
      ],
    };
    app.renderElicitationPanel();
  });
  await new Promise(r => setTimeout(r, 300));

  const panelVisible = await page.locator('#elicitationPanel').isVisible();
  console.log('Panel visible after trigger:', panelVisible ? 'PASS' : 'FAIL');

  const btnCount = await page.locator('.elicitation-btn').count();
  console.log('Button count (expect 4):', btnCount === 4 ? 'PASS' : 'FAIL - got ' + btnCount);

  await page.screenshot({ path: '/tmp/elicitation-test.png' });
  console.log('Screenshot saved to /tmp/elicitation-test.png');

  await browser.close();
})();
```

```bash
cd /home/siggi/.claude/plugins/cache/playwright-skill/playwright-skill/4.1.0/skills/playwright-skill && node run.js /tmp/playwright-test-elicitation.js
```

Expected: all three checks show `PASS`.

---

### Task 6: Commit

```bash
cd /home/siggi/sources/Codeman
git add src/web/public/index.html src/web/public/app.js src/web/public/styles.css src/web/public/mobile.css
git commit -m "feat: elicitation quick-reply panel with tappable option buttons

When Claude Code shows a numbered-option elicitation dialog, Codeman
parses the terminal buffer and renders tappable buttons above the
accessory bar. Falls back to a text input for free-text questions.
Panel auto-clears when hooks resolve or user responds."
```
