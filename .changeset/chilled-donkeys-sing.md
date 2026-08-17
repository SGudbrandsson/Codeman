---
"aicodeman": minor
---

Read-aloud now streams paragraph by paragraph instead of synthesising the whole
reply up front, so the transcript play button starts speaking almost
immediately on long answers. Synthesis moved to a shared `TtsEngine` with a
Deepgram Aura → edge-tts → browser-speech fallback chain; the Deepgram key
already stored for dictation is reused, and the voice is selectable under
Settings → Voice. The files-sheet document reader uses the same engine.
