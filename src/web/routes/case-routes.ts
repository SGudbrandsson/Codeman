/**
 * @fileoverview Case management routes.
 * Handles CRUD for cases (directories under ~/codeman-cases and linked folders),
 * fix-plan reading, and ralph-wizard file serving.
 */

import { FastifyInstance } from 'fastify';
import { existsSync, mkdirSync, writeFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import type { ApiResponse, CaseInfo } from '../../types.js';
import { ApiErrorCode, createErrorResponse, getErrorMessage } from '../../types.js';
import { CreateCaseSchema, LinkCaseSchema, CloneCaseSchema } from '../schemas.js';
import { gitClone } from '../../utils/git-utils.js';
import { generateClaudeMd } from '../../templates/claude-md.js';
import { writeHooksConfig } from '../../hooks-config.js';
import { CASES_DIR } from '../route-helpers.js';
import { SseEvent } from '../sse-events.js';
import type { EventPort, ConfigPort } from '../ports/index.js';
import { type LinkedCasesMap, resolveLinkedCasePath } from '../utils/linked-cases.js';

export function registerCaseRoutes(app: FastifyInstance, ctx: EventPort & ConfigPort): void {
  // ═══════════════════════════════════════════════════════════════
  // Case CRUD (list, create, link, detail, fix-plan)
  // ═══════════════════════════════════════════════════════════════

  // ========== List Cases ==========

  app.get('/api/cases', async (): Promise<CaseInfo[]> => {
    const cases: CaseInfo[] = [];

    // Get cases from CASES_DIR
    try {
      const entries = await fs.readdir(CASES_DIR, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) {
          let orchestrationEnabled = false;
          try {
            const caseConfigPath = join(CASES_DIR, e.name, 'case-config.json');
            const caseConfig = JSON.parse(await fs.readFile(caseConfigPath, 'utf-8')) as Record<string, unknown>;
            orchestrationEnabled = caseConfig.orchestrationEnabled === true;
          } catch {
            /* no case-config.json */
          }
          cases.push({
            name: e.name,
            path: join(CASES_DIR, e.name),
            hasClaudeMd: existsSync(join(CASES_DIR, e.name, 'CLAUDE.md')),
            orchestrationEnabled,
          });
        }
      }
    } catch {
      // CASES_DIR may not exist yet
    }

    // Get linked cases
    const linkedCasesFile = join(homedir(), '.codeman', 'linked-cases.json');
    try {
      const linkedCases: LinkedCasesMap = JSON.parse(await fs.readFile(linkedCasesFile, 'utf-8'));
      for (const [name, entry] of Object.entries(linkedCases)) {
        const path = resolveLinkedCasePath(entry);
        const orchestrationEnabled = typeof entry === 'object' ? (entry.orchestrationEnabled ?? false) : false;
        // Linked cases override native cases with the same name (explicit user config wins)
        if (existsSync(path)) {
          const existingIdx = cases.findIndex((c) => c.name === name);
          const caseEntry: CaseInfo = {
            name,
            path,
            hasClaudeMd: existsSync(join(path, 'CLAUDE.md')),
            linked: true,
            orchestrationEnabled,
          };
          if (existingIdx >= 0) {
            cases[existingIdx] = caseEntry;
          } else {
            cases.push(caseEntry);
          }
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[Server] Failed to read linked cases:', err);
      }
    }

    return cases;
  });

  app.post('/api/cases', async (req): Promise<ApiResponse<{ case: { name: string; path: string } }>> => {
    const result = CreateCaseSchema.safeParse(req.body);
    if (!result.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, result.error.issues[0]?.message ?? 'Validation failed');
    }
    const { name, description, customPath } = result.data;

    let casePath: string;
    let isCustomPath = false;

    if (customPath) {
      // customPath has already had tilde expanded by safePathOrTildeSchema.
      // If the caller supplied an existing directory, treat it as a parent folder
      // and append the project name so the project is created inside it.
      let resolvedCustomPath = customPath;
      if (existsSync(customPath)) {
        try {
          if (statSync(customPath).isDirectory()) {
            resolvedCustomPath = join(customPath, name);
          }
        } catch {
          // statSync failed — fall through and let the existsSync check handle it
        }
      }

      casePath = resolvedCustomPath;
      isCustomPath = true;
    } else {
      casePath = join(CASES_DIR, name);

      // Security: Path traversal protection - use relative path check
      const resolvedPath = resolve(casePath);
      const resolvedBase = resolve(CASES_DIR);
      const relPath = relative(resolvedBase, resolvedPath);
      if (relPath.startsWith('..') || isAbsolute(relPath)) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case path');
      }
    }

    if (existsSync(casePath)) {
      return createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'Case already exists');
    }

    try {
      mkdirSync(casePath, { recursive: true });
      if (!isCustomPath) {
        mkdirSync(join(casePath, 'src'), { recursive: true });
      }

      // Read settings to get custom template path
      const templatePath = await ctx.getDefaultClaudeMdPath();
      const claudeMd = generateClaudeMd(name, description || '', templatePath);
      writeFileSync(join(casePath, 'CLAUDE.md'), claudeMd);

      // Write .claude/settings.local.json with hooks for desktop notifications
      await writeHooksConfig(casePath);

      if (isCustomPath) {
        // Register as a linked case so the custom path is tracked
        const linkedCasesFile = join(homedir(), '.codeman', 'linked-cases.json');
        let linkedCases: Record<string, string> = {};
        try {
          linkedCases = JSON.parse(await fs.readFile(linkedCasesFile, 'utf-8'));
        } catch {
          /* no file yet */
        }
        linkedCases[name] = casePath;
        const codemanDir = join(homedir(), '.codeman');
        if (!existsSync(codemanDir)) {
          mkdirSync(codemanDir, { recursive: true });
        }
        await fs.writeFile(linkedCasesFile, JSON.stringify(linkedCases, null, 2));
      }

      ctx.broadcast(SseEvent.CaseCreated, { name, path: casePath });

      return { success: true, data: { case: { name, path: casePath } } };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  // Clone a git repo and register it as a case
  app.post('/api/cases/clone', async (req): Promise<ApiResponse<{ case: { name: string; path: string } }>> => {
    const result = CloneCaseSchema.safeParse(req.body);
    if (!result.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, result.error.issues[0]?.message ?? 'Validation failed');
    }
    // Normalize SCP-style SSH URLs (git@host:user/repo.git → ssh://git@host/user/repo.git)
    const rawUrl = result.data.url;
    const scpMatch = rawUrl.match(/^([\w.-]+@[\w.-]+):(.+)$/);
    const url = scpMatch ? `ssh://${scpMatch[1]}/${scpMatch[2]}` : rawUrl;

    // Derive name from URL if not provided
    const urlName =
      url
        .split('/')
        .pop()
        ?.replace(/\.git$/, '') ?? '';
    const name = result.data.name || urlName.replace(/[^a-zA-Z0-9_-]/g, '-') || 'cloned-project';

    // Target directory: use provided or default to ~/sources/<name>
    const targetDir = result.data.targetDir ?? join(homedir(), 'sources', name);

    if (existsSync(targetDir)) {
      return createErrorResponse(ApiErrorCode.ALREADY_EXISTS, `Directory already exists: ${targetDir}`);
    }

    try {
      await gitClone(url, targetDir);
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Git clone failed: ${getErrorMessage(err)}`);
    }

    // Register as a linked case
    const linkedCasesFile = join(homedir(), '.codeman', 'linked-cases.json');
    let linkedCases: Record<string, string> = {};
    try {
      linkedCases = JSON.parse(await fs.readFile(linkedCasesFile, 'utf-8'));
    } catch {
      /* no file yet */
    }

    linkedCases[name] = targetDir;
    await fs.writeFile(linkedCasesFile, JSON.stringify(linkedCases, null, 2));
    ctx.broadcast(SseEvent.CaseLinked, { name, path: targetDir });

    return { success: true, data: { case: { name, path: targetDir } } };
  });

  // Link an existing folder as a case
  app.post('/api/cases/link', async (req): Promise<ApiResponse<{ case: { name: string; path: string } }>> => {
    const lcResult = LinkCaseSchema.safeParse(req.body);
    if (!lcResult.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid request body');
    }
    const { name, path: folderPath } = lcResult.data;

    // Expand ~ to home directory
    const expandedPath = folderPath.startsWith('~') ? join(homedir(), folderPath.slice(1)) : folderPath;

    // Validate the folder exists
    if (!existsSync(expandedPath)) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, `Folder not found: ${expandedPath}`);
    }

    // Check if case name already exists in CASES_DIR
    const casePath = join(CASES_DIR, name);
    if (existsSync(casePath)) {
      return createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'A case with this name already exists in codeman-cases.');
    }

    // Load existing linked cases
    const linkedCasesFile = join(homedir(), '.codeman', 'linked-cases.json');
    let linkedCases: Record<string, string> = {};
    try {
      linkedCases = JSON.parse(await fs.readFile(linkedCasesFile, 'utf-8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[Server] Failed to read linked cases:', err);
      }
    }

    // Check if name is already linked
    if (linkedCases[name]) {
      return createErrorResponse(
        ApiErrorCode.ALREADY_EXISTS,
        `Case "${name}" is already linked to ${linkedCases[name]}`
      );
    }

    // Save the linked case
    linkedCases[name] = expandedPath;
    try {
      const codemanDir = join(homedir(), '.codeman');
      if (!existsSync(codemanDir)) {
        mkdirSync(codemanDir, { recursive: true });
      }
      await fs.writeFile(linkedCasesFile, JSON.stringify(linkedCases, null, 2));
      ctx.broadcast(SseEvent.CaseLinked, { name, path: expandedPath });
      return { success: true, data: { case: { name, path: expandedPath } } };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  app.get('/api/cases/:name', async (req) => {
    const { name } = req.params as { name: string };

    // Security: Path traversal protection
    const resolvedPath = resolve(join(CASES_DIR, name));
    const resolvedBase = resolve(CASES_DIR);
    const relPath = relative(resolvedBase, resolvedPath);
    if (relPath.startsWith('..') || isAbsolute(relPath)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case name');
    }

    // First check linked cases
    const linkedCasesFile = join(homedir(), '.codeman', 'linked-cases.json');
    try {
      const linkedCases: LinkedCasesMap = JSON.parse(await fs.readFile(linkedCasesFile, 'utf-8'));
      if (linkedCases[name]) {
        const entry = linkedCases[name];
        const linkedPath = resolveLinkedCasePath(entry);
        return {
          name,
          path: linkedPath,
          hasClaudeMd: existsSync(join(linkedPath, 'CLAUDE.md')),
          linked: true,
        };
      }
    } catch {
      // ENOENT or parse errors - fall through to CASES_DIR check
    }

    // Then check CASES_DIR
    const casePath = join(CASES_DIR, name);

    if (!existsSync(casePath)) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Case not found');
    }

    return {
      name,
      path: casePath,
      hasClaudeMd: existsSync(join(casePath, 'CLAUDE.md')),
    };
  });

  // Delete or untrack a case
  // Query param: ?mode=untrack (default) | delete
  //   untrack — removes from linked-cases.json only; native cases cannot be untracked
  //   delete  — rm -rf the resolved path; also removes from linked-cases.json if present
  app.delete('/api/cases/:name', async (req): Promise<ApiResponse<{ name: string }>> => {
    const { name } = req.params as { name: string };
    const { mode = 'untrack' } = req.query as { mode?: string };

    if (mode !== 'untrack' && mode !== 'delete') {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'mode must be "untrack" or "delete"');
    }

    // Security: validate name (same guard as GET /api/cases/:name)
    const resolvedPath = resolve(join(CASES_DIR, name));
    const resolvedBase = resolve(CASES_DIR);
    const relPath = relative(resolvedBase, resolvedPath);
    if (relPath.startsWith('..') || isAbsolute(relPath)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case name');
    }

    const linkedCasesFile = join(homedir(), '.codeman', 'linked-cases.json');
    let linkedCases: Record<string, string> = {};
    try {
      linkedCases = JSON.parse(await fs.readFile(linkedCasesFile, 'utf-8'));
    } catch {
      /* no file yet */
    }

    const isLinked = Boolean(linkedCases[name]);
    const linkedPath = linkedCases[name] as string | undefined;
    const nativePath = join(CASES_DIR, name);
    const isNative = existsSync(nativePath);

    if (!isLinked && !isNative) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, `Project "${name}" not found`);
    }

    if (mode === 'untrack') {
      if (!isLinked) {
        return createErrorResponse(
          ApiErrorCode.INVALID_INPUT,
          `"${name}" is a local project. Use mode=delete to remove it from disk.`
        );
      }
      // Remove from linked-cases.json
      delete linkedCases[name];
      await fs.writeFile(linkedCasesFile, JSON.stringify(linkedCases, null, 2));
      ctx.broadcast(SseEvent.CaseDeleted, { name, mode: 'untrack' });
      return { success: true, data: { name } };
    }

    // mode === 'delete'
    const targetPath = isLinked ? (linkedPath as string) : nativePath;
    try {
      rmSync(targetPath, { recursive: true, force: true });
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to delete: ${getErrorMessage(err)}`);
    }

    // Remove from linked-cases.json if present
    if (isLinked) {
      delete linkedCases[name];
      try {
        await fs.writeFile(linkedCasesFile, JSON.stringify(linkedCases, null, 2));
      } catch {
        /* best-effort */
      }
    }

    ctx.broadcast(SseEvent.CaseDeleted, { name, mode: 'delete' });
    return { success: true, data: { name } };
  });

  // Update case configuration (e.g. orchestration toggle)
  app.patch('/api/cases/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    const body = req.body as { orchestrationEnabled?: boolean };

    // Security: Path traversal protection
    const resolvedPath = resolve(join(CASES_DIR, name));
    const resolvedBase = resolve(CASES_DIR);
    const relPath = relative(resolvedBase, resolvedPath);
    if (relPath.startsWith('..') || isAbsolute(relPath)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case name');
    }

    // Check native case
    const nativePath = join(CASES_DIR, name);
    if (existsSync(nativePath)) {
      if (typeof body.orchestrationEnabled === 'boolean') {
        const configPath = join(nativePath, 'case-config.json');
        let config: Record<string, unknown> = {};
        try {
          config = JSON.parse(await fs.readFile(configPath, 'utf-8')) as Record<string, unknown>;
        } catch {
          /* no existing config */
        }
        config.orchestrationEnabled = body.orchestrationEnabled;
        await fs.writeFile(configPath, JSON.stringify(config, null, 2));
      }
      return { success: true, data: { name, orchestrationEnabled: body.orchestrationEnabled } };
    }

    // Check linked case
    const linkedCasesFile = join(homedir(), '.codeman', 'linked-cases.json');
    let linkedCases: Record<string, string | { path: string; orchestrationEnabled?: boolean }> = {};
    try {
      linkedCases = JSON.parse(await fs.readFile(linkedCasesFile, 'utf-8')) as typeof linkedCases;
    } catch {
      /* no file */
    }

    const entry = linkedCases[name];
    if (!entry) {
      reply.code(404);
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Case not found');
    }

    if (typeof body.orchestrationEnabled === 'boolean') {
      const path = typeof entry === 'string' ? entry : entry.path;
      linkedCases[name] = { path, orchestrationEnabled: body.orchestrationEnabled };
      await fs.writeFile(linkedCasesFile, JSON.stringify(linkedCases, null, 2));
    }

    return { success: true, data: { name, orchestrationEnabled: body.orchestrationEnabled } };
  });

  // Read @fix_plan.md from a case directory (for wizard to detect existing plans)
  app.get('/api/cases/:name/fix-plan', async (req) => {
    const { name } = req.params as { name: string };

    // Security: Path traversal protection
    const resolvedPath = resolve(join(CASES_DIR, name));
    const resolvedBase = resolve(CASES_DIR);
    const relPath = relative(resolvedBase, resolvedPath);
    if (relPath.startsWith('..') || isAbsolute(relPath)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case name');
    }

    // Get case path (check linked cases first, then CASES_DIR)
    let casePath: string | null = null;

    const linkedCasesFile = join(homedir(), '.codeman', 'linked-cases.json');
    try {
      const linkedCases: Record<string, string> = JSON.parse(await fs.readFile(linkedCasesFile, 'utf-8'));
      if (linkedCases[name]) {
        casePath = linkedCases[name];
      }
    } catch {
      // ENOENT or parse errors - fall through to CASES_DIR
    }

    if (!casePath) {
      casePath = join(CASES_DIR, name);
    }

    const fixPlanPath = join(casePath, '@fix_plan.md');

    if (!existsSync(fixPlanPath)) {
      return { success: true, exists: false, content: null, todos: [] };
    }

    try {
      const content = await fs.readFile(fixPlanPath, 'utf-8');

      // Parse todos from the content (similar to ralph-tracker's importFixPlanMarkdown)
      const todos: Array<{
        content: string;
        status: 'pending' | 'in_progress' | 'completed';
        priority: string | null;
      }> = [];
      const todoPattern = /^-\s*\[([ xX-])\]\s*(.+)$/;
      const p0HeaderPattern = /^##\s*(High Priority|Critical|P0|Critical Path)/i;
      const p1HeaderPattern = /^##\s*(Standard|P1|Medium Priority)/i;
      const p2HeaderPattern = /^##\s*(Nice to Have|P2|Low Priority)/i;
      const completedHeaderPattern = /^##\s*Completed/i;

      let currentPriority: string | null = null;
      let inCompletedSection = false;

      for (const line of content.split('\n')) {
        const trimmed = line.trim();

        if (p0HeaderPattern.test(trimmed)) {
          currentPriority = 'P0';
          inCompletedSection = false;
          continue;
        }
        if (p1HeaderPattern.test(trimmed)) {
          currentPriority = 'P1';
          inCompletedSection = false;
          continue;
        }
        if (p2HeaderPattern.test(trimmed)) {
          currentPriority = 'P2';
          inCompletedSection = false;
          continue;
        }
        if (completedHeaderPattern.test(trimmed)) {
          inCompletedSection = true;
          continue;
        }

        const match = trimmed.match(todoPattern);
        if (match) {
          const [, checkboxState, taskContent] = match;
          let status: 'pending' | 'in_progress' | 'completed';

          if (inCompletedSection || checkboxState === 'x' || checkboxState === 'X') {
            status = 'completed';
          } else if (checkboxState === '-') {
            status = 'in_progress';
          } else {
            status = 'pending';
          }

          todos.push({
            content: taskContent.trim(),
            status,
            priority: inCompletedSection ? null : currentPriority,
          });
        }
      }

      // Calculate stats in a single pass for better performance
      let pending = 0,
        inProgress = 0,
        completed = 0;
      for (const t of todos) {
        if (t.status === 'pending') pending++;
        else if (t.status === 'in_progress') inProgress++;
        else if (t.status === 'completed') completed++;
      }
      const stats = { total: todos.length, pending, inProgress, completed };

      return {
        success: true,
        exists: true,
        content,
        todos,
        stats,
      };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to read @fix_plan.md: ${err}`);
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // Ralph Wizard Files (per-case prompt/result serving)
  // ═══════════════════════════════════════════════════════════════

  // ========== List Wizard Files ==========

  app.get('/api/cases/:caseName/ralph-wizard/files', async (req) => {
    const { caseName } = req.params as { caseName: string };
    let casePath = join(CASES_DIR, caseName);

    // Security: Path traversal protection - use relative path check
    const resolvedCase = resolve(casePath);
    const resolvedBase = resolve(CASES_DIR);
    const relPath = relative(resolvedBase, resolvedCase);
    if (relPath.startsWith('..') || isAbsolute(relPath)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case name');
    }

    // Check linked cases if path doesn't exist
    if (!existsSync(casePath)) {
      const linkedCasesFile = join(homedir(), '.codeman', 'linked-cases.json');
      try {
        const linkedCases: Record<string, string> = JSON.parse(await fs.readFile(linkedCasesFile, 'utf-8'));
        if (linkedCases[caseName]) {
          casePath = linkedCases[caseName];
        }
      } catch {
        // No linked cases file
      }
    }

    const wizardDir = join(casePath, 'ralph-wizard');

    if (!existsSync(wizardDir)) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Ralph wizard directory not found');
    }

    // List all subdirectories and their files
    const files: Array<{ agentType: string; promptFile?: string; resultFile?: string }> = [];
    const entries = readdirSync(wizardDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const agentDir = join(wizardDir, entry.name);
        const agentFiles: { agentType: string; promptFile?: string; resultFile?: string } = {
          agentType: entry.name,
        };

        if (existsSync(join(agentDir, 'prompt.md'))) {
          agentFiles.promptFile = `${entry.name}/prompt.md`;
        }
        if (existsSync(join(agentDir, 'result.json'))) {
          agentFiles.resultFile = `${entry.name}/result.json`;
        }

        if (agentFiles.promptFile || agentFiles.resultFile) {
          files.push(agentFiles);
        }
      }
    }

    return { success: true, data: { files, caseName } };
  });

  // Read a specific ralph-wizard file
  // Cache disabled to ensure fresh prompts when starting new plan generations
  app.get('/api/cases/:caseName/ralph-wizard/file/:filePath', async (req, reply) => {
    const { caseName, filePath } = req.params as { caseName: string; filePath: string };
    let casePath = join(CASES_DIR, caseName);

    // Prevent browser caching - prompts change between plan generations
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    reply.header('Pragma', 'no-cache');
    reply.header('Expires', '0');

    // Security: Path traversal protection for case name - use relative path check
    const resolvedCase = resolve(casePath);
    const resolvedBase = resolve(CASES_DIR);
    const relPath = relative(resolvedBase, resolvedCase);
    if (relPath.startsWith('..') || isAbsolute(relPath)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case name');
    }

    // Check linked cases if path doesn't exist
    if (!existsSync(casePath)) {
      const linkedCasesFile = join(homedir(), '.codeman', 'linked-cases.json');
      try {
        const linkedCases: Record<string, string> = JSON.parse(await fs.readFile(linkedCasesFile, 'utf-8'));
        if (linkedCases[caseName]) {
          casePath = linkedCases[caseName];
        }
      } catch {
        // No linked cases file
      }
    }

    const wizardDir = join(casePath, 'ralph-wizard');

    // Decode the file path (it may be URL encoded)
    const decodedPath = decodeURIComponent(filePath);
    const fullPath = join(wizardDir, decodedPath);

    // Security: ensure path is within wizard directory
    const resolvedPath = resolve(fullPath);
    const resolvedWizard = resolve(wizardDir);
    if (!resolvedPath.startsWith(resolvedWizard)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid file path');
    }

    let content: string;
    try {
      content = await fs.readFile(fullPath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'File not found');
      }
      throw err;
    }
    const isJson = filePath.endsWith('.json');

    // Parse JSON content safely (may contain invalid JSON or unescaped control characters)
    let parsed: unknown = null;
    if (isJson) {
      try {
        parsed = JSON.parse(content);
      } catch {
        // Try repairing common JSON issues (unescaped control characters, trailing commas)
        try {
          let repaired = content;
          // Fix trailing commas before closing brackets
          repaired = repaired.replace(/,(\s*[\]}])/g, '$1');
          // Fix unescaped control characters within JSON strings
          repaired = repaired.replace(/"([^"\\]|\\.)*"/g, (match) => {
            return match
              .replace(/\n/g, '\\n')
              .replace(/\r/g, '\\r')
              .replace(/\t/g, '\\t')
              .replace(
                // eslint-disable-next-line no-control-regex
                /[\x00-\x1f]/g,
                (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
              );
          });
          parsed = JSON.parse(repaired);
        } catch {
          // Still invalid - return null for parsed, content available as raw string
        }
      }
    }

    return {
      success: true,
      data: {
        content,
        filePath: decodedPath,
        isJson,
        parsed,
      },
    };
  });
}
