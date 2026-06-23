export interface TaskSpec {
  title: string;
  description: string;
  acceptance?: string;
}

export const WORKTREE_CLAUDE_MD =
  'You are working autonomously in a Codeman worktree.\n' +
  'Before doing ANYTHING else, re-read `TASK.md` in this directory\n' +
  'and resume from the phase in `status`.\n' +
  'Do not rely on conversation history.\n' +
  'Then invoke the codeman-task-runner skill.\n';

export function renderTaskMd(kind: 'feature' | 'fix', spec: TaskSpec): string {
  const constraints = spec.acceptance?.trim() || 'none specified';
  return [
    '# Task',
    '',
    `type: ${kind}`,
    'status: analysis',
    `title: ${spec.title}`,
    `description: ${spec.description.trim()}`,
    `constraints: ${constraints}`,
    'affected_area: unknown',
    'work_item_id: none',
    'fix_cycles: 0',
    'test_fix_cycles: 0',
    '',
    '## Root Cause / Spec',
    '<!-- filled by analysis subagent -->',
    '',
    '## Fix / Implementation Notes',
    '<!-- filled by implement subagent -->',
    '',
    '## Review History',
    '<!-- appended by each review subagent — never overwrite -->',
    '',
    '## Test Gap Analysis',
    '<!-- filled by test gap analysis subagent -->',
    '',
    '## Test Writing Notes',
    '<!-- filled by test writing subagent -->',
    '',
    '## Test Review History',
    '<!-- appended by each Opus test review subagent — never overwrite -->',
    '',
    '## QA Results',
    '<!-- filled by QA subagent -->',
    '',
    '## Decisions & Context',
    '<!-- append-only log of key decisions made during the workflow -->',
    '',
  ].join('\n');
}
