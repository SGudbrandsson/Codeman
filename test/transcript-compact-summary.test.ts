/**
 * Compaction summaries: the parser flags entries Claude Code marks isCompactSummary, so the
 * web view can collapse them even when the text no longer starts with the legacy marker
 * (newer versions prepend a preamble such as <artifact-content-authored-by-others/>).
 *
 * Run: npx vitest run test/transcript-compact-summary.test.ts
 */
import { describe, it, expect } from 'vitest';
import { parseTranscriptEntry, type TranscriptEntry } from '../src/types/transcript-blocks.js';

const SUMMARY =
  '<artifact-content-authored-by-others/>\nThe summarized conversation included Artifact content...\n' +
  'This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n1. ...';

describe('parseTranscriptEntry compact summary flag', () => {
  it('flags string-content compact summaries', () => {
    const blocks = parseTranscriptEntry({
      type: 'user',
      isCompactSummary: true,
      message: { role: 'user', content: SUMMARY },
    } as TranscriptEntry);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'text', role: 'user', compactSummary: true, text: SUMMARY });
  });

  it('flags array-content compact summaries', () => {
    const blocks = parseTranscriptEntry({
      type: 'user',
      isCompactSummary: true,
      message: { role: 'user', content: [{ type: 'text', text: SUMMARY }] },
    } as TranscriptEntry);
    expect(blocks[0]).toMatchObject({ compactSummary: true });
  });

  it('leaves ordinary user messages unflagged', () => {
    const blocks = parseTranscriptEntry({ type: 'user', message: { role: 'user', content: 'hi' } });
    expect(blocks[0]).not.toHaveProperty('compactSummary');
  });
});
