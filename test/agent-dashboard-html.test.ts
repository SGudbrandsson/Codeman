/**
 * @fileoverview Validates that the Agent Dashboard HTML structure exists in index.html.
 *
 * This is a Node-environment test (no jsdom needed) — it reads the source file
 * and asserts on expected element IDs and ordering.
 *
 * Run: npx vitest run test/agent-dashboard-html.test.ts
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function getIndexHtml(): string {
  return readFileSync(join(repoRoot, 'src/web/public/index.html'), 'utf8');
}

describe('Agent Dashboard HTML structure in index.html', () => {
  it('#agentDashboardSection exists with stats badge, body, and refresh button', () => {
    const html = getIndexHtml();

    expect(html).toContain('id="agentDashboardSection"');
    expect(html).toContain('id="agentDashboardStats"');
    expect(html).toContain('id="agentDashboardBody"');
    expect(html).toContain('app.refreshAgentDashboard()');
  });

  it('#agentDashboardSection appears before #orchestratorSection', () => {
    const html = getIndexHtml();

    const dashboardPos = html.indexOf('id="agentDashboardSection"');
    const orchestratorPos = html.indexOf('id="orchestratorSection"');
    expect(dashboardPos).toBeGreaterThan(-1);
    expect(orchestratorPos).toBeGreaterThan(-1);
    expect(dashboardPos).toBeLessThan(orchestratorPos);
  });
});
