# Manual Playwright Tests

These tests are **not part of the default test suite** (`npm test` / vitest). They require a running dev server and are meant to be run manually to verify specific UI behaviours or regression fixes.

## Prerequisites

```bash
# Playwright must be installed (it is listed in devDependencies)
npx playwright install chromium

# Start a dev server on port 3099 before running any test:
nohup npx tsx src/index.ts web --port 3099 > /tmp/codeman-3099.log 2>&1 &
sleep 6 && curl -s http://localhost:3099/api/status | jq .version
```

Set `PORT=<n>` to target a different port. Default is **3099** for all tests.

## Running a test

```bash
node test/manual/<test-name>.mjs
# or with a different port:
PORT=3001 node test/manual/<test-name>.mjs
```

---

## Tests

### `test-image-send-race.mjs` — Mobile image send race condition

**What it tests:** Verifies that the Send button (`#composeSendBtn`) is disabled while image uploads are in flight, preventing the race condition where `send()` fires before `fetch('/api/screenshots')` resolves and silently drops the image from the message.

**Background:** `InputPanel.send()` reads `this._images.filter(img => img.path)`. The path is set only after the upload fetch resolves. Without a guard, tapping Send during a slow upload drops any in-flight image silently. The fix uses an `_uploadingCount` counter that disables the Send button during uploads.

**How to run:**
```bash
PORT=3099 node test/manual/test-image-send-race.mjs
```

**What it does:** Injects a 1500ms delay into every `/api/screenshots` response (guaranteeing a 100% race window), attaches 1–2 images, immediately tries to click Send, and verifies the button is disabled. Repeats 5 times alternating 1 and 2 images.

**Expected output:**
- Against fixed server: `5/5 passed`
- Against unfixed server: `0/5 passed` (useful for confirming the bug is present before a fix)

---

### `test-verify-fix.mjs` — Local echo overlay vertical alignment

**What it tests:** Verifies the local echo overlay renders text at the correct vertical position within terminal cells (char top + centering correction). Checks that the `top`, `height`, `lineHeight`, and `transform` styles on overlay spans match expected values.

**How to run:**
```bash
PORT=3099 node test/manual/test-verify-fix.mjs
```

Saves a screenshot of the terminal to `/tmp/fix-verify-term.png`.

---

### `test-verify-no-overhang.mjs` — Local echo overlay no character overhang

**What it tests:** Verifies that local echo overlay characters do not overhang into adjacent cells. Checks that character width does not exceed cell width.

**How to run:**
```bash
PORT=3099 node test/manual/test-verify-no-overhang.mjs
```

---

### `test-dims.mjs` — Terminal dimension inspection

**What it tests:** Dumps xterm.js render service dimensions (cell size, char metrics, canvas size) to stdout. Diagnostic tool for debugging terminal rendering issues — not a pass/fail test.

**How to run:**
```bash
PORT=3099 node test/manual/test-dims.mjs
```

---

### `test-overlay2.mjs` — Local echo overlay creation and rendering

**What it tests:** Creates a fresh session, enables local echo, and verifies the overlay renders correctly. Checks for console errors during overlay initialization.

**How to run:**
```bash
PORT=3099 node test/manual/test-overlay2.mjs
```

---

### `test-line-artifact.mjs` — Local echo line rendering artifacts

**What it tests:** Renders the local echo overlay at 2× device pixel ratio and captures a zoomed screenshot to inspect for sub-pixel line artifacts. Uses `deviceScaleFactor: 2` to simulate a retina/HiDPI display.

**How to run:**
```bash
PORT=3099 node test/manual/test-line-artifact.mjs
```

---

### `test-sc.mjs` — Local echo single-character rendering

**What it tests:** Forces the local echo overlay to render a single character at a realistic prompt position and inspects the resulting span styles. Diagnostic for character alignment issues.

**How to run:**
```bash
PORT=3099 node test/manual/test-sc.mjs
```

---

### `test-pixel.mjs` — Local echo pixel-level inspection

**What it tests:** Samples pixel colors from the xterm canvas and overlay to verify that local echo characters are rendered at the correct pixel position. Cross-references canvas pixels with overlay span positions.

**How to run:**
```bash
PORT=3099 node test/manual/test-pixel.mjs
```

---

### `test-bg-deep.mjs` — Terminal background color stack inspection

**What it tests:** Inspects all background colors in the xterm.js rendering stack (element styles, theme, canvas). Diagnostic for background color mismatch issues.

**How to run:**
```bash
PORT=3099 node test/manual/test-bg-deep.mjs
```

---

### `test-bg-mismatch.mjs` — Terminal background pixel vs CSS color mismatch

**What it tests:** Samples actual canvas pixel color at an empty terminal area and compares it against the CSS background color. Detects mismatches between the WebGL renderer's background and the page background.

**How to run:**
```bash
PORT=3099 node test/manual/test-bg-mismatch.mjs
```
