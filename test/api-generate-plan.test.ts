/**
 * @fileoverview Tests for /api/generate-plan endpoint validation
 *
 * Tests request validation for the plan generation API.
 * Port: 3191
 */

import { describe, it, expect } from 'vitest';

describe('Generate Plan API Validation', () => {
  // Validation logic extracted from server.ts for unit testing
  const validateGeneratePlanRequest = (req: {
    taskDescription?: unknown;
    detailLevel?: unknown;
  }): { valid: boolean; error?: string } => {
    const { taskDescription, detailLevel } = req;

    if (!taskDescription || typeof taskDescription !== 'string') {
      return { valid: false, error: 'Task description is required' };
    }

    if (taskDescription.length === 0) {
      return { valid: false, error: 'Task description is required' };
    }

    if (taskDescription.length > 10000) {
      return { valid: false, error: 'Task description too long (max 10000 chars)' };
    }

    // Detail level validation (optional, defaults to 'standard')
    if (detailLevel !== undefined) {
      const validLevels = ['brief', 'standard', 'detailed'];
      if (!validLevels.includes(detailLevel as string)) {
        return { valid: false, error: 'Invalid detail level. Must be: brief, standard, or detailed' };
      }
    }

    return { valid: true };
  };

  describe('taskDescription validation', () => {
    it('should reject missing taskDescription', () => {
      const result = validateGeneratePlanRequest({});
      expect(result.valid).toBe(false);
      expect(result.error).toContain('required');
    });

    it('should reject null taskDescription', () => {
      const result = validateGeneratePlanRequest({ taskDescription: null });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('required');
    });

    it('should reject empty string taskDescription', () => {
      const result = validateGeneratePlanRequest({ taskDescription: '' });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('required');
    });

    it('should reject non-string taskDescription', () => {
      const result = validateGeneratePlanRequest({ taskDescription: 123 });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('required');
    });

    it('should reject taskDescription over 10000 chars', () => {
      const longDescription = 'a'.repeat(10001);
      const result = validateGeneratePlanRequest({ taskDescription: longDescription });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('too long');
    });

    it('should accept taskDescription at exactly 10000 chars', () => {
      const maxDescription = 'a'.repeat(10000);
      const result = validateGeneratePlanRequest({ taskDescription: maxDescription });
      expect(result.valid).toBe(true);
    });

    it('should accept valid taskDescription', () => {
      const result = validateGeneratePlanRequest({
        taskDescription: 'Implement user authentication with JWT tokens',
      });
      expect(result.valid).toBe(true);
    });

    it('should accept multi-line taskDescription', () => {
      const result = validateGeneratePlanRequest({
        taskDescription: `Fix the Ralph Loop wizard issues:
1. Two Skip buttons confusing
2. Modal height overflow
3. Dead code references`,
      });
      expect(result.valid).toBe(true);
    });
  });

  describe('detailLevel validation', () => {
    it('should accept brief detail level', () => {
      const result = validateGeneratePlanRequest({
        taskDescription: 'Build a feature',
        detailLevel: 'brief',
      });
      expect(result.valid).toBe(true);
    });

    it('should accept standard detail level', () => {
      const result = validateGeneratePlanRequest({
        taskDescription: 'Build a feature',
        detailLevel: 'standard',
      });
      expect(result.valid).toBe(true);
    });

    it('should accept detailed detail level', () => {
      const result = validateGeneratePlanRequest({
        taskDescription: 'Build a feature',
        detailLevel: 'detailed',
      });
      expect(result.valid).toBe(true);
    });

    it('should accept missing detailLevel (defaults to standard)', () => {
      const result = validateGeneratePlanRequest({
        taskDescription: 'Build a feature',
      });
      expect(result.valid).toBe(true);
    });

    it('should reject invalid detailLevel', () => {
      const result = validateGeneratePlanRequest({
        taskDescription: 'Build a feature',
        detailLevel: 'verbose',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid detail level');
    });

    it('should reject numeric detailLevel', () => {
      const result = validateGeneratePlanRequest({
        taskDescription: 'Build a feature',
        detailLevel: 3,
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid detail level');
    });
  });

  describe('edge cases', () => {
    it('should handle taskDescription with only whitespace', () => {
      // Whitespace-only is technically a valid non-empty string
      // The API accepts it (server-side trim could be added if needed)
      const result = validateGeneratePlanRequest({ taskDescription: '   ' });
      expect(result.valid).toBe(true);
    });

    it('should handle taskDescription with unicode characters', () => {
      const result = validateGeneratePlanRequest({
        taskDescription: 'Implement 日本語 support with emoji 🎉',
      });
      expect(result.valid).toBe(true);
    });

    it('should handle taskDescription with special characters', () => {
      const result = validateGeneratePlanRequest({
        taskDescription: 'Fix bug: user@example.com fails with <script>alert(1)</script>',
      });
      expect(result.valid).toBe(true);
    });

    it('should handle array as taskDescription', () => {
      const result = validateGeneratePlanRequest({
        taskDescription: ['item1', 'item2'],
      });
      expect(result.valid).toBe(false);
    });

    it('should handle object as taskDescription', () => {
      const result = validateGeneratePlanRequest({
        taskDescription: { text: 'description' },
      });
      expect(result.valid).toBe(false);
    });
  });
});
