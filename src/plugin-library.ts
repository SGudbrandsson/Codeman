/**
 * @fileoverview Curated plugin library.
 * Static list served at GET /api/plugins/library.
 * To add a plugin: append an entry and commit.
 */

export interface PluginLibraryEntry {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  installName: string; // passed to `claude plugin install`
}

export const PLUGIN_LIBRARY: PluginLibraryEntry[] = [
  {
    id: 'superpowers',
    name: 'superpowers',
    description: 'Core skills library — TDD, debugging, planning, git worktrees and more',
    keywords: ['skills', 'tdd', 'debugging', 'planning'],
    installName: 'superpowers',
  },
  {
    id: 'gsd',
    name: 'gsd',
    description: 'Get Stuff Done — structured project planning and execution workflow',
    keywords: ['workflow', 'planning', 'project'],
    installName: 'gsd',
  },
  {
    id: 'claude-plugins-official',
    name: 'claude-plugins-official',
    description: 'Official Claude plugin collection — frontend-design, playwright, and more',
    keywords: ['official', 'design', 'playwright'],
    installName: 'claude-plugins-official',
  },
];
