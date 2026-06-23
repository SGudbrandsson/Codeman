import { describe, it, expect } from 'vitest';
import { slugifyBranch } from '../src/web/hermes/branch-slug.js';

describe('slugifyBranch', () => {
  it('slugs a normal title', () => {
    expect(slugifyBranch('Add dark mode toggle to settings panel', 'feat')).toBe(
      'feat/add-dark-mode-toggle-to-settings'
    );
  });
  it('uses the fix prefix', () => {
    expect(slugifyBranch('Fix the login crash', 'fix')).toBe('fix/fix-the-login-crash');
  });
  it('collapses punctuation and whitespace', () => {
    expect(slugifyBranch('  Rate-limit   API!! endpoints  ', 'feat')).toBe('feat/rate-limit-api-endpoints');
  });
  it('caps the body at 37 chars with no trailing hyphen', () => {
    const out = slugifyBranch('a'.repeat(60), 'feat');
    expect(out.startsWith('feat/')).toBe(true);
    expect(out.slice('feat/'.length).length).toBeLessThanOrEqual(37);
    expect(out.endsWith('-')).toBe(false);
  });
  it('falls back to "task" for empty/garbage', () => {
    expect(slugifyBranch('!!!', 'feat')).toBe('feat/task');
    expect(slugifyBranch('', 'fix')).toBe('fix/task');
  });
});
