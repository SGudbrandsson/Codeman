/**
 * @fileoverview Persistent store for dormant (kept) worktrees.
 * Saves to ~/.codeman/worktrees.json. Synchronous reads, synchronous writes
 * (file is small, infrequently written).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface DormantWorktree {
  id: string;
  path: string;
  branch: string;
  originSessionId: string;
  projectName: string;
  createdAt: string;
}

export class WorktreeStore {
  private readonly filePath: string;
  private worktrees: DormantWorktree[] = [];

  constructor(filePath?: string) {
    this.filePath = filePath ?? join(homedir(), '.codeman', 'worktrees.json');
    this._load();
  }

  private _load(): void {
    try {
      if (existsSync(this.filePath)) {
        this.worktrees = JSON.parse(readFileSync(this.filePath, 'utf8')) as DormantWorktree[];
      }
    } catch {
      this.worktrees = [];
    }
  }

  private _save(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.worktrees, null, 2), 'utf8');
  }

  getAll(): DormantWorktree[] {
    return [...this.worktrees];
  }

  get(id: string): DormantWorktree | undefined {
    return this.worktrees.find((w) => w.id === id);
  }

  add(entry: Omit<DormantWorktree, 'id' | 'createdAt'>): DormantWorktree {
    const w: DormantWorktree = { id: randomUUID(), createdAt: new Date().toISOString(), ...entry };
    this.worktrees.push(w);
    this._save();
    return w;
  }

  remove(id: string): boolean {
    const before = this.worktrees.length;
    this.worktrees = this.worktrees.filter((w) => w.id !== id);
    if (this.worktrees.length !== before) {
      this._save();
      return true;
    }
    return false;
  }
}

let _instance: WorktreeStore | null = null;
export function getWorktreeStore(): WorktreeStore {
  if (!_instance) _instance = new WorktreeStore();
  return _instance;
}
