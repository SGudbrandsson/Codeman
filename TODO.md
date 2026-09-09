# TODO

## Open Issues

### Issue 2 — Mobile spacebar re-inserts deleted text
**Status:** Not implemented — needs investigation

When typing on mobile, using the native iOS/Android swipe-to-delete-word gesture (hold spacebar and drag left) or selecting text and deleting it, then pressing spacebar re-pastes the deleted text. The user is stuck until they send the current buffer and start fresh.

**Suspected cause:** iOS IME composition events (`compositionstart`/`compositionend`) interacting with the local echo overlay (`LocalEchoOverlay` / `xterm-zerolag-input`). When the OS-level text selection + delete gesture fires, the browser may emit composition events that the overlay doesn't handle correctly — allowing the undo system or autocorrect to re-insert text on the next spacebar press.

**Where to look:**
- `src/web/public/vendor/xterm-zerolag-input.js` (compiled) — source in `packages/xterm-zerolag-input/src/`
- `src/web/public/app.js` — `onData` handler around line 828–990 (local echo mode block)

**Approach:**
1. Reproduce on a real iOS device or Safari with mobile emulation
2. Add `compositionstart`/`compositionend` / `input` event listeners around the terminal container to detect and cancel unwanted composition-triggered insertions
3. Consider disabling local echo during active IME composition, then re-enabling after `compositionend`

---

## Actionables

- [ ] **Remove the ralph loop entirely.** Unused. The harness registry already marks it
      `caps.ralph`, so removal is now: delete the ralph modules, drop the capability from
      `src/harnesses/types.ts` and every harness definition, and delete
      `src/web/routes/ralph-routes.ts`. See
      `docs/superpowers/specs/2026-09-09-harness-registry-design.md`.

- [ ] **Codex session discovery uses ~550 inotify watch descriptors per session.**
      `src/harnesses/codex-session-discovery.ts` watches `~/.codex/sessions` recursively
      until the rollout file for a session appears. Measured at 761 → 1317 → 761 watch
      descriptors across one session's create/stop cycle (no leak), so many concurrent
      codex sessions can approach `fs.inotify.max_user_watches` (65536 by default, shared
      with every other watcher). Mitigations if it bites: watch only the current day's
      shard, or share one non-recursive watch across all codex sessions.
