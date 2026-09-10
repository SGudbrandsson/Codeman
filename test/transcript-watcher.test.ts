import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TranscriptWatcher, TranscriptState } from '../src/transcript-watcher.js';
import { writeFileSync, unlinkSync, mkdirSync, existsSync, appendFileSync, mkdtempSync, renameSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('TranscriptWatcher', () => {
  let watcher: TranscriptWatcher;
  let testDir: string;
  let testFile: string;

  beforeEach(() => {
    watcher = new TranscriptWatcher();
    testDir = join(tmpdir(), `transcript-test-${Date.now()}`);
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
    testFile = join(testDir, 'test-transcript.jsonl');
  });

  afterEach(() => {
    watcher.stop();
    // Clean up test file
    try {
      if (existsSync(testFile)) {
        unlinkSync(testFile);
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Initialization', () => {
    it('should start in stopped state', () => {
      expect(watcher.isRunning()).toBe(false);
    });

    it('should have initial state with defaults', () => {
      const state = watcher.getState();
      expect(state.isComplete).toBe(false);
      expect(state.toolExecuting).toBe(false);
      expect(state.currentTool).toBeNull();
      expect(state.hasError).toBe(false);
      expect(state.planModeDetected).toBe(false);
      expect(state.entryCount).toBe(0);
    });
  });

  describe('File Watching', () => {
    it('should start watching an existing file', () => {
      writeFileSync(testFile, '');
      watcher.start(testFile);
      expect(watcher.isRunning()).toBe(true);
    });

    it('should handle non-existent file by polling', () => {
      const nonExistent = join(testDir, 'nonexistent.jsonl');
      watcher.start(nonExistent);
      expect(watcher.isRunning()).toBe(true);
    });

    it('should stop watching on stop()', () => {
      writeFileSync(testFile, '');
      watcher.start(testFile);
      expect(watcher.isRunning()).toBe(true);
      watcher.stop();
      expect(watcher.isRunning()).toBe(false);
    });

    it('should update path with updatePath()', () => {
      const file1 = join(testDir, 'file1.jsonl');
      const file2 = join(testDir, 'file2.jsonl');
      writeFileSync(file1, '');
      writeFileSync(file2, '');

      watcher.start(file1);
      expect(watcher.isRunning()).toBe(true);

      watcher.updatePath(file2);
      expect(watcher.isRunning()).toBe(true);
    });
  });

  describe('Entry Processing', () => {
    it('should process user entry and reset state', async () => {
      // Start with some state
      writeFileSync(testFile, '');
      watcher.start(testFile);

      // Add user entry
      const userEntry = {
        type: 'user',
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'test' },
      };
      appendFileSync(testFile, JSON.stringify(userEntry) + '\n');

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      const state = watcher.getState();
      expect(state.entryCount).toBeGreaterThanOrEqual(1);
    });

    it('should emit transcript:complete on result entry', async () => {
      writeFileSync(testFile, '');
      watcher.start(testFile);

      const completeHandler = vi.fn();
      watcher.on('transcript:complete', completeHandler);

      // Add result entry
      const resultEntry = { type: 'result', timestamp: new Date().toISOString() };
      appendFileSync(testFile, JSON.stringify(resultEntry) + '\n');

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(completeHandler).toHaveBeenCalled();
      const state = watcher.getState();
      expect(state.isComplete).toBe(true);
    });

    it('should track tool execution', async () => {
      writeFileSync(testFile, '');
      watcher.start(testFile);

      const toolStartHandler = vi.fn();
      watcher.on('transcript:tool_start', toolStartHandler);

      // Add assistant entry with tool_use
      const assistantEntry = {
        type: 'assistant',
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/test.txt' } }],
        },
      };
      appendFileSync(testFile, JSON.stringify(assistantEntry) + '\n');

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(toolStartHandler).toHaveBeenCalledWith('Read');
      const state = watcher.getState();
      expect(state.toolExecuting).toBe(true);
      expect(state.currentTool).toBe('Read');
    });

    it('should detect plan mode from AskUserQuestion tool', async () => {
      writeFileSync(testFile, '');
      watcher.start(testFile);

      const planModeHandler = vi.fn();
      watcher.on('transcript:plan_mode', planModeHandler);

      // Add assistant entry with AskUserQuestion
      const assistantEntry = {
        type: 'assistant',
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { question: 'test?' } }],
        },
      };
      appendFileSync(testFile, JSON.stringify(assistantEntry) + '\n');

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(planModeHandler).toHaveBeenCalled();
      const state = watcher.getState();
      expect(state.planModeDetected).toBe(true);
    });

    it('should detect errors in result entry', async () => {
      writeFileSync(testFile, '');
      watcher.start(testFile);

      // Add result entry with error
      const resultEntry = {
        type: 'result',
        timestamp: new Date().toISOString(),
        error: { type: 'api_error', message: 'Rate limited' },
      };
      appendFileSync(testFile, JSON.stringify(resultEntry) + '\n');

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 200));

      const state = watcher.getState();
      expect(state.hasError).toBe(true);
      expect(state.errorMessage).toContain('Rate limited');
    });
  });

  describe('State Management', () => {
    it('should return a copy of state', () => {
      const state1 = watcher.getState();
      const state2 = watcher.getState();
      expect(state1).not.toBe(state2); // Different objects
      expect(state1).toEqual(state2); // Same content
    });

    it('should reset state on stop()', () => {
      writeFileSync(testFile, '');
      watcher.start(testFile);
      watcher.stop();
      const state = watcher.getState();
      expect(state.entryCount).toBe(0);
    });
  });
});

describe('TranscriptWatcher — fromOffset, transcriptId and replacement', () => {
  let watcher: TranscriptWatcher;
  let dir: string;
  let file: string;

  const userLine = (text: string) =>
    JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: text } }) +
    '\n';
  const texts = (blocks: Array<{ text?: string }>) => blocks.map((b) => b.text);
  const waitFor = async (cond: () => boolean, ms = 4000) => {
    for (let t = 0; t < ms && !cond(); t += 25) await new Promise((r) => setTimeout(r, 25));
  };

  beforeEach(() => {
    watcher = new TranscriptWatcher();
    dir = mkdtempSync(join(tmpdir(), 'tw-replace-'));
    file = join(dir, 't.jsonl');
  });

  afterEach(() => {
    vi.useRealTimers();
    watcher.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('start(existing, { fromOffset: 0 }) emits the existing blocks', async () => {
    writeFileSync(file, userLine('one') + userLine('two'));
    const blocks: Array<{ text?: string }> = [];
    watcher.on('transcript:block', (b) => blocks.push(b));
    watcher.start(file, { fromOffset: 0 });
    await waitFor(() => blocks.length >= 2);
    expect(texts(blocks)).toEqual(['one', 'two']);
  });

  it('start(existing) still starts at EOF by default', async () => {
    writeFileSync(file, userLine('old'));
    const blocks: Array<{ text?: string }> = [];
    watcher.on('transcript:block', (b) => blocks.push(b));
    watcher.start(file);
    await new Promise((r) => setTimeout(r, 150));
    appendFileSync(file, userLine('new'));
    await waitFor(() => blocks.length >= 1);
    expect(texts(blocks)).toEqual(['new']);
  });

  it('a new transcriptId on start and on updatePath to a different path; none for the same path', () => {
    writeFileSync(file, '');
    const other = join(dir, 'other.jsonl');
    writeFileSync(other, '');
    watcher.start(file);
    const first = watcher.transcriptId;
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    watcher.updatePath(file);
    expect(watcher.transcriptId).toBe(first);
    watcher.updatePath(other);
    expect(watcher.transcriptId).not.toBe(first);
  });

  it('updatePath emits transcript:clear carrying the NEW transcriptId', () => {
    writeFileSync(file, '');
    const other = join(dir, 'other.jsonl');
    watcher.start(file);
    const ids: string[] = [];
    watcher.on('transcript:clear', () => ids.push(watcher.transcriptId));
    watcher.updatePath(other, { fromOffset: 0 });
    expect(ids).toEqual([watcher.transcriptId]);
    expect(watcher.transcriptPath).toBe(other);
  });

  it('equal-size replacement (rename over) emits transcript:clear with a new id and re-reads from 0', async () => {
    writeFileSync(file, userLine('AAAA'));
    const blocks: Array<{ text?: string }> = [];
    const clears: string[] = [];
    watcher.on('transcript:block', (b) => blocks.push(b));
    watcher.on('transcript:clear', () => clears.push(watcher.transcriptId));
    watcher.start(file, { fromOffset: 0 });
    await waitFor(() => blocks.length >= 1);
    const before = watcher.transcriptId;

    const tmp = join(dir, 'replacement.tmp');
    writeFileSync(tmp, userLine('BBBB'));
    renameSync(tmp, file);

    await waitFor(() => blocks.length >= 2);
    expect(texts(blocks)).toEqual(['AAAA', 'BBBB']);
    expect(clears).toHaveLength(1);
    expect(clears[0]).not.toBe(before);
    expect(watcher.transcriptId).toBe(clears[0]);

    // The watcher follows the replacement file: later appends still arrive.
    appendFileSync(file, userLine('CCCC'));
    await waitFor(() => blocks.length >= 3);
    expect(texts(blocks)).toEqual(['AAAA', 'BBBB', 'CCCC']);
  });

  it('truncation emits transcript:clear with a new id', async () => {
    writeFileSync(file, userLine('long line one') + userLine('long line two'));
    const clears: string[] = [];
    const blocks: Array<{ text?: string }> = [];
    watcher.on('transcript:block', (b) => blocks.push(b));
    watcher.on('transcript:clear', () => clears.push(watcher.transcriptId));
    watcher.start(file, { fromOffset: 0 });
    await waitFor(() => blocks.length >= 2);
    const before = watcher.transcriptId;
    writeFileSync(file, userLine('x'));
    await waitFor(() => blocks.length >= 3);
    expect(clears).toHaveLength(1);
    expect(clears[0]).not.toBe(before);
    expect(texts(blocks).at(-1)).toBe('x');
  });

  it('a missing file is picked up from offset 0 once created', async () => {
    const blocks: Array<{ text?: string }> = [];
    watcher.on('transcript:block', (b) => blocks.push(b));
    watcher.start(file, { fromOffset: 0 });
    writeFileSync(file, userLine('first turn'));
    await waitFor(() => blocks.length >= 1);
    expect(texts(blocks)).toEqual(['first turn']);
  });

  it('stop() clears the stat-poll interval and updatePath() does not stack a second one', () => {
    vi.useFakeTimers();
    writeFileSync(file, '');
    const other = join(dir, 'other.jsonl');
    writeFileSync(other, '');

    watcher.start(file);
    expect(vi.getTimerCount()).toBe(1);

    watcher.updatePath(other);
    expect(vi.getTimerCount()).toBe(1);

    watcher.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a deleted file falls back to polling and a recreated file is read from offset 0', async () => {
    writeFileSync(file, userLine('before delete'));
    const blocks: Array<{ text?: string }> = [];
    watcher.on('transcript:block', (b) => blocks.push(b));
    watcher.start(file, { fromOffset: 0 });
    await waitFor(() => blocks.length >= 1);

    unlinkSync(file);
    const pollInterval = () => (watcher as unknown as { pollInterval: NodeJS.Timeout | null }).pollInterval;
    await waitFor(() => pollInterval() !== null);
    expect(pollInterval()).not.toBeNull();
    expect(watcher.isRunning()).toBe(true);

    // Longer than the deleted file, so a stale offset would skip or split the new line.
    writeFileSync(file, userLine('after recreate, a longer first line'));
    await waitFor(() => blocks.length >= 2);
    expect(texts(blocks)).toEqual(['before delete', 'after recreate, a longer first line']);

    // Watching resumes on the new file.
    appendFileSync(file, userLine('appended'));
    await waitFor(() => blocks.length >= 3);
    expect(texts(blocks)).toEqual(['before delete', 'after recreate, a longer first line', 'appended']);
  });
});
