import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export class ClaudeActivityMonitor extends EventEmitter {
  private readonly _filePath: string;
  private _offset: number = 0;
  private _pendingBuffer: string = '';
  private _isBusy: boolean = false;
  private _watcher: fs.FSWatcher | null = null;
  private _creationPoller: ReturnType<typeof setInterval> | null = null;
  private _crashRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private _stopped: boolean = false;

  constructor(sessionId: string, workingDir: string) {
    super();
    const projectHash = workingDir.replace(/\//g, '-');
    this._filePath = path.join(os.homedir(), '.claude', 'projects', projectHash, `${sessionId}.jsonl`);
  }

  async start(): Promise<void> {
    if (this._stopped) return;
    if (fs.existsSync(this._filePath)) {
      this._determineInitialState();
      this._offset = fs.statSync(this._filePath).size;
      this._armWatcher();
    } else {
      this._creationPoller = setInterval(() => {
        if (fs.existsSync(this._filePath)) {
          this._onFileCreated();
        }
      }, 2000);
    }
  }

  stop(): void {
    this._stopped = true;
    this._watcher?.close();
    this._watcher = null;
    if (this._creationPoller) {
      clearInterval(this._creationPoller);
      this._creationPoller = null;
    }
    if (this._crashRecoveryTimer) {
      clearTimeout(this._crashRecoveryTimer);
      this._crashRecoveryTimer = null;
    }
  }

  private _determineInitialState(): void {
    let fileContent: string;
    try {
      fileContent = fs.readFileSync(this._filePath, 'utf8');
    } catch {
      return; // file gone between existence check and read — stay idle
    }
    const lines = fileContent.split('\n');
    let lastUserIdx = -1;
    let lastTurnDurationIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'user' && obj.isSidechain === false && this._isHumanTurn(obj)) {
          lastUserIdx = i;
        } else if (obj.type === 'system' && obj.subtype === 'turn_duration') {
          lastTurnDurationIdx = i;
        }
      } catch {
        /* skip malformed lines */
      }
    }
    if (lastUserIdx > lastTurnDurationIdx) {
      // Claude was mid-turn when we last saw this file — treat as busy
      this._isBusy = true;
      this.emit('working');
      this._startCrashRecoveryTimer();
    }
    // else: idle (turn_duration after user, or neither) — emit nothing
  }

  private _isHumanTurn(obj: Record<string, unknown>): boolean {
    const msg = obj.message as { content?: unknown } | undefined;
    if (!msg) return false;
    const content = msg.content;
    if (!Array.isArray(content)) return typeof content === 'string';
    return content.some(
      (c: unknown) => typeof c === 'object' && c !== null && (c as Record<string, unknown>).type !== 'tool_result'
    );
  }

  private _onFileCreated(): void {
    if (this._creationPoller) {
      clearInterval(this._creationPoller);
      this._creationPoller = null;
    }
    this._determineInitialState();
    this._offset = fs.statSync(this._filePath).size;
    this._armWatcher();
  }

  private _armWatcher(): void {
    try {
      this._watcher = fs.watch(this._filePath, { persistent: false }, (event) => {
        if (event === 'change') this._onFileChange();
      });
    } catch {
      /* file gone */
    }
  }

  private _onFileChange(): void {
    // TODO — Task 3
    void this._offset;
    void this._pendingBuffer;
  }

  private _startCrashRecoveryTimer(): void {
    if (this._crashRecoveryTimer) clearTimeout(this._crashRecoveryTimer);
    this._crashRecoveryTimer = setTimeout(
      () => {
        if (this._isBusy && !this._stopped) {
          this._isBusy = false;
          this.emit('idle');
        }
      },
      5 * 60 * 1000
    );
  }
}
