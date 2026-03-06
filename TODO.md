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
