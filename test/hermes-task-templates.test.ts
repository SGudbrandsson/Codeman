import { describe, it, expect } from 'vitest';
import { renderTaskMd, WORKTREE_CLAUDE_MD } from '../src/web/hermes/task-templates.js';

describe('renderTaskMd', () => {
  it('emits canonical TASK.md format for a feature', () => {
    const md = renderTaskMd('feature', { title: 'Dark mode', description: 'Add a toggle.' });
    expect(md).toContain('type: feature');
    expect(md).toContain('status: analysis');
    expect(md).toContain('title: Dark mode');
    expect(md).toContain('Add a toggle.');
    expect(md).toContain('constraints: none specified');
  });

  it('emits canonical TASK.md format for a fix with acceptance', () => {
    const md = renderTaskMd('fix', { title: 'T', description: 'D', acceptance: 'Must do X' });
    expect(md).toContain('type: fix');
    expect(md).toContain('constraints: Must do X');
  });
});

describe('WORKTREE_CLAUDE_MD', () => {
  it('tells the worktree Claude to read TASK.md and run the task-runner skill', () => {
    expect(WORKTREE_CLAUDE_MD).toContain('TASK.md');
    expect(WORKTREE_CLAUDE_MD).toContain('codeman-task-runner');
  });
});
