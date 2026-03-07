# Android Mobile Layout Fix List

## Status
- `index.html` viewport meta: added `interactive-widget=resizes-content` ✅ (deployed)

## Still To Do

### 1. Fix `updateLayoutForKeyboard()` in `mobile-handlers.js`

**Root cause:** On Android, `window.innerHeight` shrinks when the keyboard opens. This makes `keyboardOffset = innerHeight - (offsetTop + visualHeight) = 0`. The safety check at line 253 incorrectly fires, calling `onKeyboardHide()` which only sets `paddingBottom = 44px` — far too little. The terminal extends behind the keyboard.

**Fix:** Detect Android resize mode. When `keyboardOffset <= 0`, check if `initialViewportHeight - window.innerHeight > 100` (viewport shrank = Android). If so, use the shrinkage as the effective keyboardOffset and skip transforms (browser auto-positions fixed elements). Only apply the iOS dismiss logic when the viewport did NOT shrink.

Replace the `if (this.keyboardVisible)` block in `updateLayoutForKeyboard()` (lines ~244-278):

```js
if (this.keyboardVisible) {
  const layoutHeight = window.innerHeight;
  const visualBottom = window.visualViewport.offsetTop + window.visualViewport.height;
  let keyboardOffset = layoutHeight - visualBottom;

  if (keyboardOffset <= 0) {
    const viewportShrinkage = this.initialViewportHeight - window.innerHeight;
    if (viewportShrinkage > 100) {
      // Android resize mode: browser already shrank innerHeight for keyboard.
      // Use shrinkage as keyboard height; fixed elements auto-position, no transforms needed.
      keyboardOffset = viewportShrinkage;
      if (toolbar) toolbar.style.transform = '';
      if (accessoryBar) accessoryBar.style.transform = '';
    } else {
      // iOS: keyboard-visible flag is stale, keyboard is actually gone.
      this.keyboardVisible = false;
      document.body.classList.remove('keyboard-visible');
      this.onKeyboardHide();
      return;
    }
  } else {
    // iOS / Android pan mode: translate bars up above keyboard.
    if (toolbar) toolbar.style.transform = `translateY(${-keyboardOffset}px)`;
    if (accessoryBar) accessoryBar.style.transform = `translateY(${-keyboardOffset}px)`;
  }

  if (main) {
    main.style.paddingBottom = `${keyboardOffset + 94}px`;
  }
} else {
  this.resetLayout();
}
```

---

### 2. Fix `resetLayout()` in `mobile-handlers.js`

**Root cause:** `resetLayout()` sets `paddingBottom = 44px` (accessory bar height only). The toolbar is also 40px tall, sitting below the accessory bar. The terminal content overlaps the accessory bar by 40px — the bottom rows are hidden behind it.

**Fix:** Change `44px` → `84px` (toolbar 40px + accessory bar 44px).

```js
// line ~292
main.style.paddingBottom = accessoryBar?.classList.contains('visible') ? '84px' : '';
```

---

### 3. Bump `mobile-handlers.js` version in `index.html`

```html
<!-- line ~1792 -->
<script defer src="mobile-handlers.js?v=0.4.4"></script>
```

---

### 4. Build and deploy

```bash
npm run build
cp -r dist /home/siggi/.codeman/app/
cp package.json /home/siggi/.codeman/app/package.json
systemctl --user restart codeman-web
git add -A && git commit -m "fix: Android keyboard layout — correct paddingBottom and resize-mode detection"
git push
```

---

## Issue Summary

| # | Symptom | Root Cause | Fix |
|---|---------|-----------|-----|
| 1 | Top pushed up when keyboard opens | Android sets keyboardOffset=0, safety check incorrectly fires onKeyboardHide | Fix updateLayoutForKeyboard() to detect Android resize mode |
| 2 | Bottom lines hidden behind accessory bar | resetLayout() only reserves 44px (bar), missing 40px (toolbar) | Change resetLayout() to 84px |
| 3 | Scroll flash when tapping xterm | Android pans visual viewport when textarea focused | `interactive-widget=resizes-content` (already deployed) |
| 4 | Bottom hidden when scrolling | Same as #2 | Same fix as #2 |
