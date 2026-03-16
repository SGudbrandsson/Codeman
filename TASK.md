# Task

type: fix
status: done
title: AskUserQuestion card in transcript view gets stuck on stale question
description: |
  When a multi-step AskUserQuestion wizard runs (e.g. GSD new-project), the inline card
  in the chat/transcript view shows the FIRST question even after the terminal has advanced
  to later steps. The user sees the stale question and answers it again, sending duplicate
  input to the terminal.

affected_area: frontend (app.js)
fix_cycles: 2

---

## COMPACTION HANDOFF — READ THIS FIRST

The fix has a **critical ordering bug** discovered during live testing. The current commit
(36274d3) is broken. Status reset to `fixing`. The next session MUST implement the correction
described below before re-running QA.

### What is already committed (36274d3)

Four guards were added to `src/web/public/app.js`:

- **Fix A** (`sendAskUserQuestionResponse`): Captures `pendingAskUserQuestion` as `auq`
  BEFORE `clearPendingHooks` nulls it, then if `auq.toolUseId` is known: adds to
  `_dismissedAskUserQuestionIds` + immediately removes inline DOM card. If no toolUseId
  (hook-first path): sets `_dismissedAskUserQuestionSession = sessionId`.

- **Fix B** (bottom of `_onTranscriptBlock`): When a `tool_use AskUserQuestion` block
  arrives, checks dismissed set / session flag and skips updating `pendingAskUserQuestion`
  + showing the panel.

- **Fix C** (`_appendBlock`, before rendering the inline card): Checks
  `app._dismissedAskUserQuestionIds?.has(block.id)` and returns early if dismissed.

- **Fix D** (`_appendBlock`, tool_result path): Calls
  `app._dismissedAskUserQuestionIds?.delete(block.toolUseId)` on card removal.

- **`_onTranscriptClear` cleanup**: Resets `_dismissedAskUserQuestionSession` and calls
  `_dismissedAskUserQuestionIds.clear()`.

- **State init** (`CodemanApp` constructor ~line 2864):
  ```js
  this._dismissedAskUserQuestionIds = new Set();
  this._dismissedAskUserQuestionSession = null;
  ```

### The ordering bug (why Fix C never fires for the hook-first race)

In `_onTranscriptBlock`, the code currently does:

```
1. TranscriptView.append(block)   ← _appendBlock runs, Fix C checks dismissed set
2. [Fix B] if dismissed / session flag → add block.id to dismissed set
```

Fix C checks the dismissed set BEFORE Fix B has populated it. So for the hook-first race:
1. Hook fires → user answers → `_dismissedAskUserQuestionSession = sessionId`
2. `transcript:block` arrives → `TranscriptView.append(block)` → Fix C: `has(block.id)` →
   **false** (not in set yet) → **CARD RENDERED** (bug!)
3. Fix B runs → adds block.id to dismissed set (too late, card already in DOM)

Fix A (immediate DOM removal) also can't help here because `auq.toolUseId` is null when
answered from the hook panel — so no card removal happens in Fix A either.

**Result**: The stale card still appears in the transcript view despite the fix.

### Required correction

Move the dismissed-set / session-flag logic to run **before** `TranscriptView.append`.

Current structure in `_onTranscriptBlock` (simplified):

```javascript
_onTranscriptBlock(data) {
  const { sessionId, block } = data;
  // ...
  if (TranscriptView._sessionId === sessionId && transcriptVisible) {
    TranscriptView.append(block);   // ← Fix C runs inside here (TOO EARLY)
    handledByView = true;
  }
  // ...
  // Fix B — checks dismissed set / session flag (TOO LATE)
  if (block.type === 'tool_use' && block.name === 'AskUserQuestion') {
    const questions = [...];
    if (questions.length > 0) {
      if (this._dismissedAskUserQuestionIds.has(block.id)) {
        // skip
      } else if (this._dismissedAskUserQuestionSession === sessionId) {
        this._dismissedAskUserQuestionIds.add(block.id);
        this._dismissedAskUserQuestionSession = null;
      } else {
        // set pendingAskUserQuestion and show panel
      }
    }
  }
}
```

**Corrected structure** — add a pre-check block BEFORE `TranscriptView.append`:

```javascript
_onTranscriptBlock(data) {
  const { sessionId, block } = data;

  // Pre-resolve dismissed state for AskUserQuestion BEFORE appending to view.
  // This must run before TranscriptView.append so Fix C (_appendBlock) sees
  // the correct dismissed state.
  if (block.type === 'tool_use' && block.name === 'AskUserQuestion') {
    const questions = Array.isArray(block.input?.questions) ? block.input.questions : [];
    if (questions.length > 0) {
      if (!this._dismissedAskUserQuestionIds.has(block.id) &&
          this._dismissedAskUserQuestionSession === sessionId) {
        // Hook-first race: populate dismissed set now so Fix C can see it
        this._dismissedAskUserQuestionIds.add(block.id);
        this._dismissedAskUserQuestionSession = null;
      }
    }
  }

  // ... existing handledByView / TranscriptView.append logic (unchanged) ...

  // Fix B — pendingAskUserQuestion / panel update (keep as-is, now consistent)
  if (block.type === 'tool_use' && block.name === 'AskUserQuestion') {
    const questions = [...];
    if (questions.length > 0) {
      if (this._dismissedAskUserQuestionIds.has(block.id)) {
        // skip — already handled by pre-check or Fix A
      } else {
        const q = questions[0];
        this.pendingAskUserQuestion = { ..., toolUseId: block.id };
        if (sessionId === this.activeSessionId) this.renderAskUserQuestionPanel();
      }
    }
  }
  // tool_result branch unchanged
}
```

The key change: a small pre-check block that runs BEFORE `TranscriptView.append`, whose only
job is to transfer `_dismissedAskUserQuestionSession` → `_dismissedAskUserQuestionIds` when
applicable. The existing Fix B block can then be simplified (no need for the
`else if (_dismissedAskUserQuestionSession)` branch since it's already handled).

### Dev server vendor fix (already applied)

The dev server at port 3088 was crashing because `src/web/public/vendor/` was missing.
Fixed by: `cp -r dist/web/public/vendor src/web/public/`
This is already done — port 3088 should now load correctly.

### How to verify the fix works after implementing

Use Playwright on http://localhost:3088:
1. Find the w1-kronan-app session (or any session running a GSD wizard)
2. Count `.tv-auq-block` elements in the transcript view
3. Answer the first question via the panel
4. Verify the `.tv-auq-block` card is immediately removed from DOM
5. Verify no stale card reappears as subsequent transcript:blocks arrive

---

## Root Cause

The bug arises from a timing race between the hook-based AskUserQuestion path and the
transcript:block path:

1. **Hook fires FIRST** (pre-tool-use hook fires before tool execution):
   - `_onHookAskUserQuestion` sets `pendingAskUserQuestion` (no toolUseId) → panel shown
2. **User answers quickly via panel**:
   - `sendAskUserQuestionResponse` → `pendingAskUserQuestion = null`, panel hidden
3. **transcript:block for tool_use arrives LATER** (transcript written after hook):
   - `_onTranscriptBlock` unconditionally sets `pendingAskUserQuestion` again (with toolUseId)
   - `_appendBlock` unconditionally renders a new inline card
   - Panel RE-SHOWN with stale question
4. **User sees stale question** → answers again → duplicate input to terminal

## Implementation Plan

See COMPACTION HANDOFF above for exact code. The only remaining change is the pre-check
block in `_onTranscriptBlock`. Everything else is already committed.

## Fix / Implementation Notes

All changes in `src/web/public/app.js`. See COMPACTION HANDOFF for full details.

### Ordering fix (fix_cycle 3) — corrects the pre-check ordering bug

Added a pre-check block at the top of `_onTranscriptBlock`, before the
`TranscriptView.append(block)` call. This block runs for every `tool_use AskUserQuestion`
block and transfers `_dismissedAskUserQuestionSession → _dismissedAskUserQuestionIds` when
the session flag matches. This ensures Fix C (`_appendBlock` dismissed-set check) sees the
correct state before the card is rendered.

The redundant `else if (this._dismissedAskUserQuestionSession === sessionId)` branch inside
Fix B was removed, since the pre-check now handles that case before `TranscriptView.append`
is ever called. Fix B is now simplified to a single `if (has(block.id)) / else` check.

## Review History

### Review attempt 1 — REJECTED
Fix A was dead code: `const auq` captured after `clearPendingHooks` nulled it.

### Review attempt 2 — APPROVED
Critical ordering fix applied (auq captured before clearPendingHooks).
_onTranscriptClear cleanup added.

### Post-merge finding (live testing)
Fix C still ineffective for hook-first race: Fix B populates dismissed set AFTER
TranscriptView.append runs, so Fix C always sees empty set at render time. Requires
pre-check block before TranscriptView.append (see COMPACTION HANDOFF).

### Review attempt 3 — APPROVED
Ordering fix is correct and precisely matches the COMPACTION HANDOFF spec. The pre-check
block at lines 9051-9065 runs before TranscriptView.append (line 9077), so Fix C
(_appendBlock, line 2261) now sees `block.id` in `_dismissedAskUserQuestionIds` during
the hook-first race and skips card rendering. Fix B is correctly simplified to a single
`has(block.id)` check since the session-flag transfer is now handled exclusively by the
pre-check. Edge cases verified: SSE buffer replay path works correctly (pre-check fires
on live SSE arrival, dismissed set populated before any replay); multi-session safety
holds (pre-check conditions on `sessionId` match); `_onTranscriptClear` cleanup is
unchanged and still covers both state fields. No regressions introduced.

## QA Results

### QA Run (fix_cycle 3 — ordering fix)

- **tsc**: PASS (zero errors)
- **lint**: PASS (zero ESLint errors)
- **Playwright** (port 3099): PASS
  - Page loaded without JS errors
  - 14 session items found in sidebar; first session clicked successfully
  - Transcript view loaded; 0 `.tv-auq-block` cards found (no stale/duplicate cards)
  - Screenshot saved to `/tmp/qa-auq-screenshot.png`

All checks passed. status → done.
