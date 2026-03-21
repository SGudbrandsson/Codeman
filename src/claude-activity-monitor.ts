import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export class ClaudeActivityMonitor extends EventEmitter {
  readonly _filePath: string;
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
    // TODO: file tail, event parsing (_offset, _pendingBuffer, _isBusy used in subsequent tasks)
    void this._offset;
    void this._pendingBuffer;
    void this._isBusy;
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
}
