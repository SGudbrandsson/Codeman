---
"aicodeman": minor
---

Read-aloud gains transport controls and reads what you actually see. A playback
bar (play/pause, prev/next block, click-to-seek, block counter) appears while
reading, and OS media controls are wired up via MediaSession. Playback now
works on rendered blocks rather than raw markdown, so inline code is spoken,
fenced code is skipped, the spoken block is highlighted in the transcript as
well as the files sheet, and selecting text before pressing play starts from
there. Blocks are never merged and never cut mid-sentence, so paragraph pauses
are real pauses. YAML frontmatter is stripped before markdown rendering, fixing
both the oversized heading it produced in the preview and the metadata being
read aloud.
