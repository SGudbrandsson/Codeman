import { describe, it, expect } from 'vitest';
import {
  parseYamlFrontmatter,
  parseTaskSpecFile,
  createDefaultSpawnTaskSpec,
  createEmptyAgentProgress,
  createInitialSpawnTrackerState,
  createDefaultOrchestratorConfig,
  serializeSpawnResult,
  parseSpawnResult,
  AGENT_NAME_MAX_LENGTH,
} from '../src/spawn-types.js';

describe('spawn-types', () => {
  describe('parseYamlFrontmatter', () => {
    it('should parse basic frontmatter', () => {
      const content = `---
name: Test Agent
type: explore
priority: high
---

# Task Body

Do something useful.`;

      const result = parseYamlFrontmatter(content);
      expect(result).not.toBeNull();
      expect(result!.frontmatter.name).toBe('Test Agent');
      expect(result!.frontmatter.type).toBe('explore');
      expect(result!.frontmatter.priority).toBe('high');
      expect(result!.body).toContain('# Task Body');
      expect(result!.body).toContain('Do something useful.');
    });

    it('should parse numbers', () => {
      const content = `---
timeoutMinutes: 30
maxCost: 0.50
maxTokens: 150000
---
body`;

      const result = parseYamlFrontmatter(content);
      expect(result!.frontmatter.timeoutMinutes).toBe(30);
      expect(result!.frontmatter.maxCost).toBe(0.5);
      expect(result!.frontmatter.maxTokens).toBe(150000);
    });

    it('should parse booleans', () => {
      const content = `---
canModifyParentFiles: true
enabled: false
---
body`;

      const result = parseYamlFrontmatter(content);
      expect(result!.frontmatter.canModifyParentFiles).toBe(true);
      expect(result!.frontmatter.enabled).toBe(false);
    });

    it('should parse inline arrays', () => {
      const content = `---
dependsOn: [agent-1, agent-2]
---
body`;

      const result = parseYamlFrontmatter(content);
      expect(result!.frontmatter.dependsOn).toEqual(['agent-1', 'agent-2']);
    });

    it('should parse block arrays', () => {
      const content = `---
contextFiles:
  - src/auth.ts
  - src/middleware.ts
  - src/types.ts
---
body`;

      const result = parseYamlFrontmatter(content);
      expect(result!.frontmatter.contextFiles).toEqual(['src/auth.ts', 'src/middleware.ts', 'src/types.ts']);
    });

    it('should parse empty arrays', () => {
      const content = `---
dependsOn: []
---
body`;

      const result = parseYamlFrontmatter(content);
      expect(result!.frontmatter.dependsOn).toEqual([]);
    });

    it('should parse quoted strings', () => {
      const content = `---
name: "Test Agent"
completionPhrase: 'AUTH_DONE'
---
body`;

      const result = parseYamlFrontmatter(content);
      expect(result!.frontmatter.name).toBe('Test Agent');
      expect(result!.frontmatter.completionPhrase).toBe('AUTH_DONE');
    });

    it('should handle null values', () => {
      const content = `---
value1: null
value2: ~
---
body`;

      const result = parseYamlFrontmatter(content);
      expect(result!.frontmatter.value1).toBeNull();
      expect(result!.frontmatter.value2).toBeNull();
    });

    it('should handle comments', () => {
      const content = `---
# This is a comment
name: Test
# Another comment
type: explore
---
body`;

      const result = parseYamlFrontmatter(content);
      expect(result!.frontmatter.name).toBe('Test');
      expect(result!.frontmatter.type).toBe('explore');
    });

    it('should return null if no frontmatter delimiters', () => {
      const content = `No frontmatter here\nJust plain text`;
      expect(parseYamlFrontmatter(content)).toBeNull();
    });

    it('should return null if missing closing delimiter', () => {
      const content = `---\nname: Test\nNo closing delimiter`;
      expect(parseYamlFrontmatter(content)).toBeNull();
    });

    it('should handle nested objects', () => {
      const content = `---
env:
  NODE_ENV: production
  DEBUG: true
---
body`;

      const result = parseYamlFrontmatter(content);
      expect(result!.frontmatter.env).toEqual({ NODE_ENV: 'production', DEBUG: true });
    });
  });

  describe('parseTaskSpecFile', () => {
    it('should parse a complete task spec', () => {
      const content = `---
agentId: auth-explorer-001
name: Authentication Explorer
type: explore
priority: high
canModifyParentFiles: false
maxTokens: 150000
maxCost: 0.50
timeoutMinutes: 15
resultDelivery: both
completionPhrase: AUTH_EXPLORE_DONE
progressIntervalSeconds: 30
outputFormat: structured
successCriteria: "Document all auth patterns"
---

# Task: Explore Authentication

Analyze the auth system.`;

      const result = parseTaskSpecFile(content, 'fallback-id');
      expect(result).not.toBeNull();
      expect(result!.spec.agentId).toBe('auth-explorer-001');
      expect(result!.spec.name).toBe('Authentication Explorer');
      expect(result!.spec.type).toBe('explore');
      expect(result!.spec.priority).toBe('high');
      expect(result!.spec.canModifyParentFiles).toBe(false);
      expect(result!.spec.maxTokens).toBe(150000);
      expect(result!.spec.maxCost).toBe(0.5);
      expect(result!.spec.timeoutMinutes).toBe(15);
      expect(result!.spec.completionPhrase).toBe('AUTH_EXPLORE_DONE');
      expect(result!.spec.outputFormat).toBe('structured');
      expect(result!.instructions).toContain('# Task: Explore Authentication');
    });

    it('should use defaults for missing fields', () => {
      const content = `---
name: Simple Agent
---
Do something.`;

      const result = parseTaskSpecFile(content, 'my-fallback');
      expect(result).not.toBeNull();
      expect(result!.spec.agentId).toBe('my-fallback');
      expect(result!.spec.type).toBe('general');
      expect(result!.spec.priority).toBe('normal');
      expect(result!.spec.timeoutMinutes).toBe(30);
      expect(result!.spec.resultDelivery).toBe('both');
      expect(result!.spec.outputFormat).toBe('markdown');
      expect(result!.spec.canModifyParentFiles).toBe(false);
    });

    it('should truncate long names', () => {
      const longName = 'A'.repeat(100);
      const content = `---
name: ${longName}
---
body`;

      const result = parseTaskSpecFile(content, 'id');
      expect(result!.spec.name.length).toBe(AGENT_NAME_MAX_LENGTH);
    });

    it('should validate type values', () => {
      const content = `---
type: invalid_type
---
body`;

      const result = parseTaskSpecFile(content, 'id');
      expect(result!.spec.type).toBe('general'); // Falls back to default
    });

    it('should validate priority values', () => {
      const content = `---
priority: super_high
---
body`;

      const result = parseTaskSpecFile(content, 'id');
      expect(result!.spec.priority).toBe('normal'); // Falls back to default
    });

    it('should return null for content without frontmatter', () => {
      const content = 'No frontmatter at all';
      expect(parseTaskSpecFile(content, 'id')).toBeNull();
    });

    it('should parse contextFiles array', () => {
      const content = `---
contextFiles:
  - src/auth.ts
  - src/types.ts
---
body`;

      const result = parseTaskSpecFile(content, 'id');
      expect(result!.spec.contextFiles).toEqual(['src/auth.ts', 'src/types.ts']);
    });

    it('should parse dependsOn array', () => {
      const content = `---
dependsOn:
  - agent-1
  - agent-2
---
body`;

      const result = parseTaskSpecFile(content, 'id');
      expect(result!.spec.dependsOn).toEqual(['agent-1', 'agent-2']);
    });
  });

  describe('Factory Functions', () => {
    it('createDefaultSpawnTaskSpec should generate valid defaults', () => {
      const spec = createDefaultSpawnTaskSpec('my-agent');
      expect(spec.agentId).toBe('my-agent');
      expect(spec.name).toBe('my-agent');
      expect(spec.type).toBe('general');
      expect(spec.priority).toBe('normal');
      expect(spec.timeoutMinutes).toBe(30);
      expect(spec.completionPhrase).toContain('MY_AGENT');
      expect(spec.completionPhrase).toContain('DONE');
    });

    it('createDefaultSpawnTaskSpec should sanitize agent ID for completion phrase', () => {
      const spec = createDefaultSpawnTaskSpec('my-agent-123');
      expect(spec.completionPhrase).toBe('AGENT_MY_AGENT_123_DONE');
    });

    it('createEmptyAgentProgress should create valid progress', () => {
      const progress = createEmptyAgentProgress();
      expect(progress.phase).toBe('initializing');
      expect(progress.percentComplete).toBe(0);
      expect(progress.filesModified).toEqual([]);
      expect(progress.tokensUsed).toBe(0);
    });

    it('createInitialSpawnTrackerState should create valid state', () => {
      const state = createInitialSpawnTrackerState();
      expect(state.enabled).toBe(false);
      expect(state.activeCount).toBe(0);
      expect(state.agents).toEqual([]);
    });

    it('createDefaultOrchestratorConfig should create valid config', () => {
      const config = createDefaultOrchestratorConfig();
      expect(config.maxConcurrentAgents).toBe(5);
      expect(config.maxSpawnDepth).toBe(3);
      expect(config.defaultTimeoutMinutes).toBe(30);
      expect(config.maxTimeoutMinutes).toBe(120);
      expect(config.progressPollIntervalMs).toBe(5000);
    });
  });

  describe('serializeSpawnResult', () => {
    it('should serialize a completed result', () => {
      const result = {
        status: 'completed' as const,
        durationMs: 60000,
        tokens: { input: 1000, output: 500, total: 1500 },
        cost: 0.05,
        summary: 'Task completed successfully',
        output: '## Result\n\nDetailed output here.',
        filesChanged: [
          { path: 'src/auth.ts', action: 'modified' as const, summary: 'Added validation' },
        ],
        agentId: 'test-agent',
        completedAt: 1700000000000,
      };

      const serialized = serializeSpawnResult(result);
      expect(serialized).toContain('status: completed');
      expect(serialized).toContain('summary: "Task completed successfully"');
      expect(serialized).toContain('agentId: test-agent');
      expect(serialized).toContain('path: src/auth.ts');
      expect(serialized).toContain('## Result');
    });

    it('should handle empty filesChanged', () => {
      const result = {
        status: 'failed' as const,
        error: 'Something went wrong',
        durationMs: 5000,
        tokens: { input: 100, output: 50, total: 150 },
        cost: 0.01,
        summary: 'Failed',
        output: 'Error details',
        filesChanged: [],
        agentId: 'test',
        completedAt: Date.now(),
      };

      const serialized = serializeSpawnResult(result);
      expect(serialized).toContain('status: failed');
      expect(serialized).toContain('filesChanged: []');
    });
  });

  describe('parseSpawnResult', () => {
    it('should parse a result file', () => {
      const content = `---
status: completed
summary: "Found 3 auth patterns"
cost: 0.25
---

## Analysis

Detailed findings here.`;

      const result = parseSpawnResult(content, 'agent-001', 60000);
      expect(result).not.toBeNull();
      expect(result!.status).toBe('completed');
      expect(result!.summary).toBe('Found 3 auth patterns');
      expect(result!.cost).toBe(0.25);
      expect(result!.output).toContain('## Analysis');
      expect(result!.agentId).toBe('agent-001');
    });

    it('should handle missing fields with defaults', () => {
      const content = `---
status: completed
---
output`;

      const result = parseSpawnResult(content, 'agent', 30000);
      expect(result!.durationMs).toBe(30000);
      expect(result!.cost).toBe(0);
      expect(result!.summary).toBe('No summary provided');
      expect(result!.filesChanged).toEqual([]);
    });

    it('should return null for invalid content', () => {
      expect(parseSpawnResult('no frontmatter', 'id', 0)).toBeNull();
    });
  });
});
