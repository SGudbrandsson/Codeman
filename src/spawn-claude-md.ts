/**
 * @fileoverview Agent CLAUDE.md Generator for spawn1337 protocol.
 *
 * Generates a comprehensive CLAUDE.md for each spawned agent that tells it:
 * - What its task is
 * - How to communicate progress
 * - How to signal completion
 * - What constraints it has
 * - How to read/write messages
 *
 * @module spawn-claude-md
 */

import type { SpawnTask } from './spawn-types.js';

/**
 * Generate a CLAUDE.md file for a spawned agent.
 *
 * This CLAUDE.md gives the agent full context about:
 * - Its identity and task
 * - Communication protocol (progress, messages, result)
 * - Resource constraints (timeout, tokens, cost)
 * - Working directory and available context files
 *
 * @param task - The full parsed task specification
 * @param commsDir - Absolute path to the communication directory
 * @param agentWorkingDir - Absolute path to the agent's working directory
 * @returns The generated CLAUDE.md content
 */
export function generateAgentClaudeMd(task: SpawnTask, commsDir: string, agentWorkingDir: string): string {
  const spec = task.spec;

  const constraintLines: string[] = [];
  constraintLines.push(`- Timeout: ${spec.timeoutMinutes} minutes`);
  if (spec.maxTokens) constraintLines.push(`- Token budget: ${spec.maxTokens.toLocaleString()} tokens`);
  if (spec.maxCost) constraintLines.push(`- Cost budget: $${spec.maxCost.toFixed(2)}`);
  if (!spec.canModifyParentFiles) {
    constraintLines.push('- DO NOT modify files outside your workspace');
  } else {
    constraintLines.push('- You MAY modify files in the parent project directory');
  }
  constraintLines.push(`- Output format: ${spec.outputFormat}`);

  const contextSection = spec.contextFiles && spec.contextFiles.length > 0
    ? `\nContext files available in workspace:\n${spec.contextFiles.map(f => `- ${f}`).join('\n')}`
    : '';

  const progressSection = spec.progressIntervalSeconds > 0
    ? `### Progress Reporting

Update \`${commsDir}/progress.json\` every ~${spec.progressIntervalSeconds} seconds with your current status:

\`\`\`json
{
  "phase": "current phase description",
  "percentComplete": 45,
  "currentAction": "What you are doing right now",
  "subtasks": [
    {"description": "Subtask 1", "status": "completed"},
    {"description": "Subtask 2", "status": "in_progress"}
  ],
  "filesModified": ["file1.ts", "file2.ts"],
  "tokensUsed": 0,
  "costSoFar": 0,
  "updatedAt": ${Date.now()}
}
\`\`\``
    : '### Progress Reporting\n\nProgress reporting is disabled for this task.';

  return `# Agent: ${spec.name}

## Your Identity

You are an autonomous agent (ID: \`${spec.agentId}\`) spawned by a parent Claude session.
You are running in your own screen session with full Claude Code capabilities.
Type: ${spec.type} | Priority: ${spec.priority} | Depth: ${task.depth}

## Task

${task.instructions}

## Success Criteria

${spec.successCriteria || 'Complete the task as described above.'}

## Communication Protocol

${progressSection}

### Check for Messages

Periodically check \`${commsDir}/messages/\` for instructions from the parent.
Files are named \`NNN-parent.md\` (from parent) or \`NNN-agent.md\` (from you).
Read any new \`*-parent.md\` files for additional instructions or clarifications.

To send a message back to the parent, create a file like:
\`${commsDir}/messages/002-agent.md\`

### Write Result

When complete, write your final result to \`${commsDir}/result.md\` with YAML frontmatter:

\`\`\`markdown
---
status: completed
summary: "Brief 1-3 sentence summary of what you accomplished"
filesChanged:
  - path: relative/path/to/file.ts
    action: modified
    summary: "What was changed"
---

## Detailed Output

Your full output, analysis, or report here.
\`\`\`

Valid status values: \`completed\`, \`failed\`

### Signal Completion

After writing result.md, output this EXACT phrase to signal you are done:

<promise>${spec.completionPhrase}</promise>

**IMPORTANT**: Only output the completion phrase AFTER you have written result.md.
The completion phrase triggers the orchestrator to read your result and clean up.

## Constraints

${constraintLines.join('\n')}

## Working Directory

Your workspace is: \`${agentWorkingDir}\`
${contextSection}

## Important Notes

- Work autonomously - do not ask for user input
- Focus exclusively on the task described above
- If you encounter errors, document them in result.md with status: failed
- Do not modify this CLAUDE.md file
- Stay within your resource constraints
`;
}

/**
 * Build the initial prompt injected into the agent session via writeViaScreen().
 * Intentionally brief - all detail is in the CLAUDE.md.
 */
export function buildInitialPrompt(task: SpawnTask): string {
  return `Read your CLAUDE.md file for complete task instructions, communication protocol, and constraints. Begin working on the task immediately. Report progress to spawn-comms/progress.json periodically. When complete, write your result to spawn-comms/result.md and then output your completion phrase: <promise>${task.spec.completionPhrase}</promise>`;
}
