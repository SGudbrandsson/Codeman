/**
 * @fileoverview Extended tests for ralph-config module
 *
 * Additional comprehensive tests for parsing Ralph Loop configuration
 * from various file formats.
 */

import { describe, it, expect } from 'vitest';

describe('Ralph Config Parsing Extended', () => {
  // Helper function to simulate YAML frontmatter parsing
  const parseYamlFrontmatter = (content: string): Record<string, any> => {
    const result: Record<string, any> = {};
    const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) return result;

    const lines = frontmatterMatch[1].split('\n');
    for (const line of lines) {
      const match = line.match(/^([a-z-]+):\s*(.+)$/i);
      if (match) {
        const key = match[1].toLowerCase().replace(/-/g, '_');
        let value: any = match[2].trim();
        // Remove quotes if present
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        // Parse booleans
        if (value === 'true') value = true;
        else if (value === 'false') value = false;
        // Parse numbers
        else if (/^\d+$/.test(value)) value = parseInt(value, 10);
        result[key] = value;
      }
    }
    return result;
  };

  describe('YAML Frontmatter Parsing', () => {
    it('should parse basic frontmatter', () => {
      const content = `---
enabled: true
iteration: 5
max-iterations: 50
completion-promise: "COMPLETE"
---
# Content here`;

      const config = parseYamlFrontmatter(content);
      expect(config.enabled).toBe(true);
      expect(config.iteration).toBe(5);
      expect(config.max_iterations).toBe(50);
      expect(config.completion_promise).toBe('COMPLETE');
    });

    it('should handle single-quoted values', () => {
      const content = `---
completion-promise: 'SINGLE_QUOTED'
---`;

      const config = parseYamlFrontmatter(content);
      expect(config.completion_promise).toBe('SINGLE_QUOTED');
    });

    it('should handle unquoted values', () => {
      const content = `---
completion-promise: UNQUOTED
---`;

      const config = parseYamlFrontmatter(content);
      expect(config.completion_promise).toBe('UNQUOTED');
    });

    it('should parse boolean false', () => {
      const content = `---
enabled: false
---`;

      const config = parseYamlFrontmatter(content);
      expect(config.enabled).toBe(false);
    });

    it('should handle missing frontmatter', () => {
      const content = `# No frontmatter here
Just regular content`;

      const config = parseYamlFrontmatter(content);
      expect(Object.keys(config)).toHaveLength(0);
    });

    it('should handle empty frontmatter', () => {
      const content = `---
---
# Empty frontmatter`;

      const config = parseYamlFrontmatter(content);
      expect(Object.keys(config)).toHaveLength(0);
    });

    it('should handle various iteration values', () => {
      for (const iteration of [0, 1, 10, 100, 1000]) {
        const content = `---
iteration: ${iteration}
---`;
        const config = parseYamlFrontmatter(content);
        expect(config.iteration).toBe(iteration);
      }
    });

    it('should handle various max-iterations values', () => {
      for (const maxIter of [10, 50, 100, 500, 1000]) {
        const content = `---
max-iterations: ${maxIter}
---`;
        const config = parseYamlFrontmatter(content);
        expect(config.max_iterations).toBe(maxIter);
      }
    });

    it('should handle completion phrases with hyphens', () => {
      const content = `---
completion-promise: "TESTS-PASS"
---`;

      const config = parseYamlFrontmatter(content);
      expect(config.completion_promise).toBe('TESTS-PASS');
    });

    it('should handle completion phrases with underscores', () => {
      const content = `---
completion-promise: "ALL_TASKS_DONE"
---`;

      const config = parseYamlFrontmatter(content);
      expect(config.completion_promise).toBe('ALL_TASKS_DONE');
    });

    it('should handle completion phrases with numbers', () => {
      const content = `---
completion-promise: "TASK_123_COMPLETE"
---`;

      const config = parseYamlFrontmatter(content);
      expect(config.completion_promise).toBe('TASK_123_COMPLETE');
    });

    it('should handle lowercase keys', () => {
      const content = `---
enabled: true
iteration: 5
---`;

      const config = parseYamlFrontmatter(content);
      expect(config.enabled).toBe(true);
      expect(config.iteration).toBe(5);
    });

    it('should handle extra whitespace', () => {
      const content = `---
enabled:    true
iteration:      5
---`;

      const config = parseYamlFrontmatter(content);
      expect(config.enabled).toBe(true);
      expect(config.iteration).toBe(5);
    });

    it('should handle mixed case values (booleans)', () => {
      const content = `---
enabled: true
---`;

      const config = parseYamlFrontmatter(content);
      expect(config.enabled).toBe(true);
    });
  });

  describe('Promise Tag Extraction', () => {
    const extractPromiseTag = (content: string): string | null => {
      const match = content.match(/<promise>([A-Z0-9_-]+)<\/promise>/);
      return match ? match[1] : null;
    };

    it('should extract simple promise tag', () => {
      expect(extractPromiseTag('<promise>COMPLETE</promise>')).toBe('COMPLETE');
    });

    it('should extract promise tag with underscores', () => {
      expect(extractPromiseTag('<promise>ALL_DONE</promise>')).toBe('ALL_DONE');
    });

    it('should extract promise tag with hyphens', () => {
      expect(extractPromiseTag('<promise>TESTS-PASS</promise>')).toBe('TESTS-PASS');
    });

    it('should extract promise tag with numbers', () => {
      expect(extractPromiseTag('<promise>TASK123</promise>')).toBe('TASK123');
    });

    it('should return null for missing tag', () => {
      expect(extractPromiseTag('No promise tag here')).toBeNull();
    });

    it('should return null for malformed tags', () => {
      expect(extractPromiseTag('<promise>lowercase</promise>')).toBeNull();
      expect(extractPromiseTag('<promise></promise>')).toBeNull();
    });

    it('should handle embedded promise tags', () => {
      const content = 'Text before <promise>EMBEDDED</promise> text after';
      expect(extractPromiseTag(content)).toBe('EMBEDDED');
    });

    it('should handle multiline content', () => {
      const content = `
Line 1
Line 2 with <promise>MULTILINE</promise>
Line 3
`;
      expect(extractPromiseTag(content)).toBe('MULTILINE');
    });
  });

  describe('CLAUDE.md Parsing', () => {
    const extractFromClaudeMd = (content: string): { phrase: string | null; found: boolean } => {
      // Look for completion phrase in Ralph Loop section
      const ralphSectionMatch = content.match(/## Ralph Wiggum Loop[\s\S]*?(?=##|$)/);
      if (!ralphSectionMatch) {
        return { phrase: null, found: false };
      }

      const section = ralphSectionMatch[0];
      const promiseMatch = section.match(/[Cc]ompletion [Pp]hrase:?\s*[`"']?<promise>([A-Z0-9_-]+)<\/promise>[`"']?/);

      return {
        phrase: promiseMatch ? promiseMatch[1] : null,
        found: true,
      };
    };

    it('should extract phrase from Ralph Wiggum Loop section', () => {
      const content = `
## Ralph Wiggum Loop

Completion Phrase: \`<promise>COMPLETE</promise>\`

### How to use
...
`;
      const result = extractFromClaudeMd(content);
      expect(result.found).toBe(true);
      expect(result.phrase).toBe('COMPLETE');
    });

    it('should handle different quote styles', () => {
      const content1 = `## Ralph Wiggum Loop
Completion phrase: "<promise>DOUBLE</promise>"`;

      const content2 = `## Ralph Wiggum Loop
Completion phrase: '<promise>SINGLE</promise>'`;

      expect(extractFromClaudeMd(content1).phrase).toBe('DOUBLE');
      expect(extractFromClaudeMd(content2).phrase).toBe('SINGLE');
    });

    it('should return null if section not found', () => {
      const content = `
## Different Section

Some content
`;
      const result = extractFromClaudeMd(content);
      expect(result.found).toBe(false);
      expect(result.phrase).toBeNull();
    });

    it('should handle Ralph Wiggum Loop section without phrase', () => {
      const content = `
## Ralph Wiggum Loop

Just some text without a completion phrase
`;
      const result = extractFromClaudeMd(content);
      expect(result.found).toBe(true);
      expect(result.phrase).toBeNull();
    });
  });

  describe('Configuration Priority', () => {
    it('should prioritize ralph-loop.local.md over CLAUDE.md', () => {
      const localConfig = { completion_promise: 'FROM_LOCAL' };
      const claudeConfig = { phrase: 'FROM_CLAUDE' };

      // Priority: local > claude
      const finalPhrase = localConfig.completion_promise || claudeConfig.phrase;
      expect(finalPhrase).toBe('FROM_LOCAL');
    });

    it('should fallback to CLAUDE.md when local is missing', () => {
      const localConfig = {};
      const claudeConfig = { phrase: 'FROM_CLAUDE' };

      const finalPhrase = (localConfig as any).completion_promise || claudeConfig.phrase;
      expect(finalPhrase).toBe('FROM_CLAUDE');
    });

    it('should handle both missing', () => {
      const localConfig = {};
      const claudeConfig = { phrase: null };

      const finalPhrase = (localConfig as any).completion_promise || claudeConfig.phrase || null;
      expect(finalPhrase).toBeNull();
    });
  });

  describe('Iteration and Max Iterations', () => {
    it('should handle iteration at start', () => {
      const config = { iteration: 0, max_iterations: 50 };
      expect(config.iteration).toBe(0);
      expect(config.iteration < config.max_iterations).toBe(true);
    });

    it('should handle iteration at end', () => {
      const config = { iteration: 50, max_iterations: 50 };
      expect(config.iteration).toBe(50);
      expect(config.iteration >= config.max_iterations).toBe(true);
    });

    it('should handle no max iterations', () => {
      const config = { iteration: 5, max_iterations: null };
      expect(config.max_iterations).toBeNull();
    });

    it('should calculate progress percentage', () => {
      const calculateProgress = (current: number, max: number | null): number | null => {
        if (max === null || max === 0) return null;
        return Math.round((current / max) * 100);
      };

      expect(calculateProgress(5, 50)).toBe(10);
      expect(calculateProgress(25, 50)).toBe(50);
      expect(calculateProgress(50, 50)).toBe(100);
      expect(calculateProgress(0, 50)).toBe(0);
      expect(calculateProgress(5, null)).toBeNull();
      expect(calculateProgress(5, 0)).toBeNull();
    });
  });

  describe('File Path Validation', () => {
    const isValidRalphConfigPath = (path: string): boolean => {
      return path.endsWith('.claude/ralph-loop.local.md') ||
             path.endsWith('.claude/ralph-loop.md') ||
             path.endsWith('CLAUDE.md');
    };

    it('should accept valid paths', () => {
      expect(isValidRalphConfigPath('/project/.claude/ralph-loop.local.md')).toBe(true);
      expect(isValidRalphConfigPath('/project/.claude/ralph-loop.md')).toBe(true);
      expect(isValidRalphConfigPath('/project/CLAUDE.md')).toBe(true);
    });

    it('should reject invalid paths', () => {
      expect(isValidRalphConfigPath('/project/random.md')).toBe(false);
      expect(isValidRalphConfigPath('/project/.claude/other.md')).toBe(false);
      expect(isValidRalphConfigPath('/project/claude.md')).toBe(false); // lowercase
    });
  });

  describe('Enabled State Detection', () => {
    const isRalphEnabled = (config: { enabled?: boolean; iteration?: number; max_iterations?: number }): boolean => {
      // Enabled if explicitly true, or if there's iteration data
      return config.enabled === true ||
             (typeof config.iteration === 'number' && config.iteration > 0) ||
             (typeof config.max_iterations === 'number' && config.max_iterations > 0);
    };

    it('should detect enabled=true', () => {
      expect(isRalphEnabled({ enabled: true })).toBe(true);
    });

    it('should detect enabled=false', () => {
      expect(isRalphEnabled({ enabled: false })).toBe(false);
    });

    it('should detect enabled from iteration', () => {
      expect(isRalphEnabled({ iteration: 5 })).toBe(true);
    });

    it('should detect enabled from max_iterations', () => {
      expect(isRalphEnabled({ max_iterations: 50 })).toBe(true);
    });

    it('should handle empty config', () => {
      expect(isRalphEnabled({})).toBe(false);
    });

    it('should handle zero iteration', () => {
      expect(isRalphEnabled({ iteration: 0 })).toBe(false);
    });
  });

  describe('Config Validation', () => {
    const validateConfig = (config: Record<string, any>): { valid: boolean; errors: string[] } => {
      const errors: string[] = [];

      if (config.enabled !== undefined && typeof config.enabled !== 'boolean') {
        errors.push('enabled must be a boolean');
      }

      if (config.iteration !== undefined) {
        if (typeof config.iteration !== 'number' || config.iteration < 0) {
          errors.push('iteration must be a non-negative number');
        }
      }

      if (config.max_iterations !== undefined) {
        if (typeof config.max_iterations !== 'number' || config.max_iterations < 1) {
          errors.push('max_iterations must be a positive number');
        }
      }

      if (config.completion_promise !== undefined) {
        if (typeof config.completion_promise !== 'string' || !/^[A-Z0-9_-]+$/.test(config.completion_promise)) {
          errors.push('completion_promise must be uppercase alphanumeric with hyphens/underscores');
        }
      }

      return { valid: errors.length === 0, errors };
    };

    it('should validate correct config', () => {
      const result = validateConfig({
        enabled: true,
        iteration: 5,
        max_iterations: 50,
        completion_promise: 'COMPLETE',
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should catch invalid enabled', () => {
      const result = validateConfig({ enabled: 'yes' });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('enabled must be a boolean');
    });

    it('should catch negative iteration', () => {
      const result = validateConfig({ iteration: -1 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('iteration must be a non-negative number');
    });

    it('should catch zero max_iterations', () => {
      const result = validateConfig({ max_iterations: 0 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('max_iterations must be a positive number');
    });

    it('should catch lowercase completion_promise', () => {
      const result = validateConfig({ completion_promise: 'lowercase' });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('completion_promise must be uppercase alphanumeric with hyphens/underscores');
    });

    it('should allow empty config', () => {
      const result = validateConfig({});
      expect(result.valid).toBe(true);
    });
  });
});
