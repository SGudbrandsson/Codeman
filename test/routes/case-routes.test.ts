/**
 * @fileoverview Tests for case-routes route handlers.
 *
 * Uses app.inject() — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerCaseRoutes } from '../../src/web/routes/case-routes.js';

// Mock filesystem modules
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    rmSync: vi.fn(),
  };
});

vi.mock('node:fs/promises', () => ({
  default: {
    readdir: vi.fn(async () => []),
    readFile: vi.fn(async () => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }),
    writeFile: vi.fn(async () => {}),
  },
}));

vi.mock('../../src/templates/claude-md.js', () => ({
  generateClaudeMd: vi.fn(() => '# CLAUDE.md\nGenerated content'),
}));

vi.mock('../../src/hooks-config.js', () => ({
  writeHooksConfig: vi.fn(async () => {}),
}));

// Import mocked modules for test control
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';

const mockedExistsSync = vi.mocked(existsSync);
const mockedMkdirSync = vi.mocked(mkdirSync);
const mockedReaddirSync = vi.mocked(readdirSync);
const mockedRmSync = vi.mocked(rmSync);
const mockedReaddir = vi.mocked(fs.readdir);
const mockedReadFile = vi.mocked(fs.readFile);

describe('case-routes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerCaseRoutes);
    vi.clearAllMocks();

    // Default: existsSync returns false, readFile throws ENOENT
    mockedExistsSync.mockReturnValue(false);
    mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  });

  afterEach(async () => {
    await harness.app.close();
  });

  // ========== GET /api/cases ==========

  describe('GET /api/cases', () => {
    it('returns empty array when no cases exist', async () => {
      mockedReaddir.mockRejectedValue(new Error('ENOENT'));

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual([]);
    });

    it('returns cases from CASES_DIR', async () => {
      mockedReaddir.mockResolvedValue([
        { name: 'my-case', isDirectory: () => true },
        { name: 'other-case', isDirectory: () => true },
        { name: 'readme.txt', isDirectory: () => false },
      ] as never);
      // No CLAUDE.md exists
      mockedExistsSync.mockReturnValue(false);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveLength(2);
      expect(body[0].name).toBe('my-case');
      expect(body[1].name).toBe('other-case');
      expect(body[0].hasClaudeMd).toBe(false);
    });

    it('includes hasClaudeMd flag', async () => {
      mockedReaddir.mockResolvedValue([{ name: 'case-with-md', isDirectory: () => true }] as never);
      mockedExistsSync.mockReturnValue(true);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body[0].hasClaudeMd).toBe(true);
    });

    it('includes linked cases from linked-cases.json', async () => {
      // CASES_DIR readdir returns one case
      mockedReaddir.mockResolvedValue([{ name: 'regular-case', isDirectory: () => true }] as never);
      // linked-cases.json is read second (after CASES_DIR readdir)
      let readCallCount = 0;
      mockedReadFile.mockImplementation(async () => {
        readCallCount++;
        if (readCallCount === 1) {
          return JSON.stringify({ 'linked-project': '/home/user/projects/linked' });
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      // existsSync: path exists for linked case, CLAUDE.md check
      mockedExistsSync.mockImplementation((p: string) => {
        if (typeof p === 'string' && p.includes('linked')) return true;
        return false;
      });

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Should have both regular and linked cases
      expect(body.length).toBeGreaterThanOrEqual(1);
      // The linked case should have linked: true
      const linkedCase = body.find((c: { name: string }) => c.name === 'linked-project');
      expect(linkedCase).toBeDefined();
      expect(linkedCase.linked).toBe(true);
    });
  });

  // ========== POST /api/cases ==========

  describe('POST /api/cases', () => {
    it('rejects invalid case name', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cases',
        payload: { name: 'invalid case name!!' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects missing name', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cases',
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects path traversal in name', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cases',
        payload: { name: '../etc' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects duplicate case name', async () => {
      mockedExistsSync.mockReturnValue(true);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cases',
        payload: { name: 'existing-case' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('already exists');
    });

    it('creates case directory with CLAUDE.md and hooks config', async () => {
      mockedExistsSync.mockReturnValue(false);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cases',
        payload: { name: 'new-case', description: 'A new test case' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.case.name).toBe('new-case');
      expect(body.data.case.path).toContain('new-case');

      // Verify directory creation
      expect(mockedMkdirSync).toHaveBeenCalled();

      // Verify broadcast
      expect(harness.ctx.broadcast).toHaveBeenCalledWith('case:created', expect.objectContaining({ name: 'new-case' }));
    });

    it('creates case at customPath when path does not exist', async () => {
      mockedExistsSync.mockReturnValue(false);
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cases',
        payload: { name: 'custom-case', customPath: '/home/user/projects/custom-case' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.case.name).toBe('custom-case');
      expect(body.data.case.path).toBe('/home/user/projects/custom-case');

      // Should create directory at the custom path (no src/ subdir)
      expect(mockedMkdirSync).toHaveBeenCalledWith('/home/user/projects/custom-case', { recursive: true });

      // Should broadcast case:created
      expect(harness.ctx.broadcast).toHaveBeenCalledWith(
        'case:created',
        expect.objectContaining({ name: 'custom-case' })
      );
    });

    it('rejects customPath when path already exists', async () => {
      mockedExistsSync.mockReturnValue(true);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cases',
        payload: { name: 'custom-case', customPath: '/home/user/projects/existing' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('already exists');
    });

    it('rejects customPath with relative path', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cases',
        payload: { name: 'custom-case', customPath: 'relative/path/project' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects customPath containing path traversal', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cases',
        payload: { name: 'custom-case', customPath: '/home/user/../../../etc/passwd' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects customPath containing shell metacharacters', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cases',
        payload: { name: 'custom-case', customPath: '/home/user/projects/$(evil)' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== DELETE /api/cases/:name ==========

  describe('DELETE /api/cases/:name', () => {
    it('mode=untrack on a linked case removes entry and broadcasts case:deleted', async () => {
      mockedReadFile.mockResolvedValue(JSON.stringify({ 'my-project': '/home/user/projects/my-project' }) as never);
      mockedExistsSync.mockReturnValue(false); // native path does not exist

      const res = await harness.app.inject({
        method: 'DELETE',
        url: '/api/cases/my-project?mode=untrack',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.name).toBe('my-project');
      expect(harness.ctx.broadcast).toHaveBeenCalledWith(
        'case:deleted',
        expect.objectContaining({ name: 'my-project', mode: 'untrack' })
      );
    });

    it('mode=untrack on a native case returns error', async () => {
      // Not in linked-cases.json
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      // Exists natively
      mockedExistsSync.mockReturnValue(true);

      const res = await harness.app.inject({
        method: 'DELETE',
        url: '/api/cases/native-project?mode=untrack',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('mode=delete');
      expect(body.error).toContain('local project');
    });

    it('mode=delete on a linked case calls rmSync on the linked path and broadcasts case:deleted', async () => {
      mockedReadFile.mockResolvedValue(JSON.stringify({ 'linked-proj': '/home/user/projects/linked-proj' }) as never);
      mockedExistsSync.mockReturnValue(false); // not in CASES_DIR

      const res = await harness.app.inject({
        method: 'DELETE',
        url: '/api/cases/linked-proj?mode=delete',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(mockedRmSync).toHaveBeenCalledWith(
        '/home/user/projects/linked-proj',
        expect.objectContaining({ recursive: true })
      );
      expect(harness.ctx.broadcast).toHaveBeenCalledWith(
        'case:deleted',
        expect.objectContaining({ name: 'linked-proj', mode: 'delete' })
      );
    });

    it('mode=delete on a native case calls rmSync on the CASES_DIR path and broadcasts case:deleted', async () => {
      // Not in linked-cases.json
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      // Exists natively
      mockedExistsSync.mockReturnValue(true);

      const res = await harness.app.inject({
        method: 'DELETE',
        url: '/api/cases/native-proj?mode=delete',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(mockedRmSync).toHaveBeenCalled();
      const rmCall = mockedRmSync.mock.calls[0][0] as string;
      expect(rmCall).toContain('native-proj');
      expect(harness.ctx.broadcast).toHaveBeenCalledWith(
        'case:deleted',
        expect.objectContaining({ name: 'native-proj', mode: 'delete' })
      );
    });

    it('returns NOT_FOUND when case is neither linked nor native', async () => {
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      mockedExistsSync.mockReturnValue(false);

      const res = await harness.app.inject({
        method: 'DELETE',
        url: '/api/cases/nonexistent',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('not found');
      expect(body.error).toContain('Project');
    });

    it('returns INVALID_INPUT for an invalid mode value', async () => {
      const res = await harness.app.inject({
        method: 'DELETE',
        url: '/api/cases/some-project?mode=obliterate',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('mode');
    });

    it('returns INVALID_INPUT for path traversal in case name', async () => {
      const res = await harness.app.inject({
        method: 'DELETE',
        url: '/api/cases/..%2F..%2Fetc',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('returns OPERATION_FAILED when rmSync throws', async () => {
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      mockedExistsSync.mockReturnValue(true);
      mockedRmSync.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      const res = await harness.app.inject({
        method: 'DELETE',
        url: '/api/cases/locked-proj?mode=delete',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Permission denied');
    });
  });

  // ========== POST /api/cases/link ==========

  describe('POST /api/cases/link', () => {
    it('rejects invalid request body', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cases/link',
        payload: { name: 'bad name!' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects missing fields', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cases/link',
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('returns not found when folder does not exist', async () => {
      mockedExistsSync.mockReturnValue(false);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cases/link',
        payload: { name: 'my-project', path: '/nonexistent/path' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('not found');
    });

    it('rejects when case name already exists in CASES_DIR', async () => {
      // First call (expandedPath check) returns true, second (casePath check) also returns true
      mockedExistsSync.mockReturnValue(true);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cases/link',
        payload: { name: 'existing-case', path: '/home/user/project' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('already exists');
    });

    it('links folder successfully', async () => {
      // expandedPath exists (first call), casePath does not (second call)
      let callIdx = 0;
      mockedExistsSync.mockImplementation(() => {
        callIdx++;
        return callIdx === 1; // first: folder exists, second: case dir doesn't
      });
      // linked-cases.json doesn't exist yet
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cases/link',
        payload: { name: 'linked-project', path: '/home/user/project' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.case.name).toBe('linked-project');
      expect(harness.ctx.broadcast).toHaveBeenCalledWith(
        'case:linked',
        expect.objectContaining({ name: 'linked-project' })
      );
    });
  });

  // ========== GET /api/cases/:name ==========

  describe('GET /api/cases/:name', () => {
    it('returns linked case info', async () => {
      mockedReadFile.mockResolvedValue(JSON.stringify({ 'my-case': '/home/user/my-case' }) as never);
      mockedExistsSync.mockReturnValue(true);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases/my-case',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.name).toBe('my-case');
      expect(body.linked).toBe(true);
    });

    it('returns CASES_DIR case when no linked case found', async () => {
      // linked-cases.json read fails
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      // case dir exists
      mockedExistsSync.mockReturnValue(true);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases/regular-case',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.name).toBe('regular-case');
    });

    it('returns error when case not found anywhere', async () => {
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      mockedExistsSync.mockReturnValue(false);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases/nonexistent',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('not found');
    });
  });

  // ========== GET /api/cases/:name/fix-plan ==========

  describe('GET /api/cases/:name/fix-plan', () => {
    it('returns exists=false when no fix plan file', async () => {
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      mockedExistsSync.mockReturnValue(false);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases/my-case/fix-plan',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.exists).toBe(false);
      expect(body.content).toBeNull();
      expect(body.todos).toEqual([]);
    });

    it('parses fix plan with todos and stats', async () => {
      const fixPlanContent = [
        '# Fix Plan',
        '## High Priority',
        '- [ ] Fix critical bug',
        '- [-] Working on auth',
        '- [x] Setup database',
        '## Standard',
        '- [ ] Add logging',
        '## Completed',
        '- [x] Initial setup',
      ].join('\n');

      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      mockedExistsSync.mockImplementation((p: string) => {
        if (typeof p === 'string' && p.includes('fix_plan')) return true;
        return false;
      });

      // Override readFile for the fix plan read
      mockedReadFile.mockImplementation(async (p: string) => {
        if (typeof p === 'string' && p.includes('fix_plan')) {
          return fixPlanContent as never;
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases/my-case/fix-plan',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.exists).toBe(true);
      expect(body.todos.length).toBeGreaterThan(0);
      expect(body.stats.total).toBeGreaterThan(0);
    });
  });

  // ========== GET /api/cases/:caseName/ralph-wizard/files ==========

  describe('GET /api/cases/:caseName/ralph-wizard/files', () => {
    it('returns error when wizard directory not found', async () => {
      mockedExistsSync.mockReturnValue(false);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases/my-case/ralph-wizard/files',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('not found');
    });

    it('rejects path traversal in case name', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases/..%2F..%2Fetc/ralph-wizard/files',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('returns wizard files when directory exists', async () => {
      mockedExistsSync.mockImplementation((p: string) => {
        if (typeof p === 'string' && p.includes('ralph-wizard')) return true;
        if (typeof p === 'string' && p.includes('prompt.md')) return true;
        if (typeof p === 'string' && p.includes('result.json')) return true;
        return false;
      });
      mockedReaddirSync.mockReturnValue([
        { name: 'research', isDirectory: () => true },
        { name: 'planner', isDirectory: () => true },
      ] as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases/my-case/ralph-wizard/files',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.files).toHaveLength(2);
      expect(body.data.files[0].agentType).toBe('research');
    });
  });

  // ========== GET /api/cases/:caseName/ralph-wizard/file/:filePath ==========

  describe('GET /api/cases/:caseName/ralph-wizard/file/:filePath', () => {
    it('returns error for missing file', async () => {
      mockedExistsSync.mockReturnValue(false);
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases/my-case/ralph-wizard/file/research%2Fprompt.md',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('returns markdown file content', async () => {
      mockedExistsSync.mockReturnValue(false);
      mockedReadFile.mockResolvedValue('# Research Prompt\nContent here' as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases/my-case/ralph-wizard/file/research%2Fprompt.md',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.content).toContain('Research Prompt');
      expect(body.data.isJson).toBe(false);
    });

    it('parses JSON file content', async () => {
      mockedExistsSync.mockReturnValue(false);
      const jsonContent = JSON.stringify({ plan: 'test plan', steps: [1, 2, 3] });
      mockedReadFile.mockResolvedValue(jsonContent as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases/my-case/ralph-wizard/file/planner%2Fresult.json',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.isJson).toBe(true);
      expect(body.data.parsed.plan).toBe('test plan');
    });

    it('sets no-cache headers', async () => {
      mockedExistsSync.mockReturnValue(false);
      mockedReadFile.mockResolvedValue('content' as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases/my-case/ralph-wizard/file/research%2Fprompt.md',
      });
      expect(res.headers['cache-control']).toContain('no-store');
    });
  });
});
