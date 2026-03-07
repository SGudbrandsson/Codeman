# Compose Panel Redesign — Design Doc

**Date:** 2026-03-07
**Status:** Approved

## Summary

Redesign the mobile compose/input panel to match the UX pattern of Claude.ai and ChatGPT mobile: a clean floating panel with a full-width auto-growing textarea, send button and plus button inset inside the textarea, multiple image attachments with thumbnail previews, and slash command popup support. Replace the lock icon trigger with a pencil icon.

## 1. Panel Structure & Layout

The new `#mobileInputPanel` is a full-width floating panel (same `position: fixed` above the accessory bar as today), with two vertical sections:

```
┌─────────────────────────────────────────┐
│ [img] [img] [img]                       │  thumbnail strip (hidden until used)
├─────────────────────────────────────────┤
│                                         │
│  Type a message…                        │  auto-growing textarea
│                                         │
│  [+]                        [↑ send]   │  buttons overlaid inside, bottom edge
└─────────────────────────────────────────┘
```

- **Textarea** grows with content. Min height: ~2 lines. Max height: `calc(100dvh - keyboard_height - accessory_bar_height - safe_area_bottom)`.
- **Send button** (`↑` circle, filled accent colour) overlaid at bottom-right inside the textarea border.
- **Plus button** overlaid at bottom-left inside the textarea border — opens an action sheet with three options: Take Photo, Photo Library, Attach File.
- **No separate bottom toolbar row** — no mic button.
- The thumbnail strip sits above the textarea and is hidden (`display:none`) until at least one image is attached.

## 2. Image Thumbnails

- Each attached image renders as a ~60×60px rounded thumbnail in a horizontally scrollable strip.
- Each thumbnail has a small `×` badge (top-right) to remove that image.
- Tapping a thumbnail opens a full-screen preview (existing image popup).
- Long-pressing or tapping a second time offers a **Replace** option (re-opens the file picker for that slot).
- No hard cap on image count. Each image is uploaded via `POST /api/screenshots` and its saved file path is appended to the message on send (same mechanism as today, extended to support multiple).

## 3. Slash Command Popup

- Typing `/` in the textarea triggers a popup that appears **above the compose panel**.
- The popup lists commands available to the current session, filtered in real time as the user continues typing.
- Each row: command name + short description/hint.
- Tapping a row inserts the full command into the textarea and closes the popup.
- Deleting the `/` (Backspace to empty the trigger) dismisses the popup.
- Data source: same slash command list already used by the session's command picker.

## 4. Accessory Bar Icon

- The lock SVG in the accessory bar is replaced with a **pencil SVG** (standard edit icon).
- Button `aria-label` changes from "Toggle input panel" to "Compose".
- When the panel is open, the pencil button shows the same active/highlighted state as other active accessory buttons.

## Files to Modify

| File | Change |
|------|--------|
| `src/web/public/index.html` | Replace `#mobileInputPanel` HTML; bump JS/CSS `?v=` query strings |
| `src/web/public/keyboard-accessory.js` | Replace lock SVG with pencil SVG; add active state logic |
| `src/web/public/app.js` | Update `InputPanel` object: thumbnail strip, multi-image upload, slash command popup trigger |
| `src/web/public/mobile.css` (or inline styles) | New compose panel styles: growing textarea, overlaid buttons, thumbnail strip |

## Out of Scope

- Desktop UI changes
- Voice input (mic removed from panel; mic already available in accessory bar if needed)
- Changes to the slash command data source or backend
