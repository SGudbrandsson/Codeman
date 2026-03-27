// @vitest-environment jsdom

/**
 * @fileoverview Unit tests for OverlayHistory singleton (browser History API integration).
 *
 * OverlayHistory lives in src/web/public/app.js (a browser script). These tests
 * replicate the singleton logic and run it against jsdom with mocked
 * history.pushState / history.back / history.go / history.replaceState.
 *
 * Strategy:
 * - Build a thin OverlayHistory replica matching the real method bodies
 * - Mock history methods and manually dispatch popstate events
 * - Assert on stack state, history calls, and close callback invocations
 *
 * Run: npx vitest run test/overlay-history.test.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── OverlayHistory replica ─────────────────────────────────────────────────

interface StackEntry {
  id: string;
  close: () => void;
}

/**
 * Reproduces the OverlayHistory singleton from app.js verbatim.
 * Returns a fresh instance per test to avoid cross-test leakage.
 */
function makeOverlayHistory() {
  const oh = {
    _stack: [] as StackEntry[],
    _ignorePopstate: false,

    init() {
      history.replaceState({ overlay: null }, '');
      window.addEventListener('popstate', (e: PopStateEvent) => this._onPopState(e));
    },

    push(id: string, closeFn: () => void) {
      if (this._stack.length && this._stack[this._stack.length - 1].id === id) return;
      this._stack.push({ id, close: closeFn });
      history.pushState({ overlay: id }, '');
    },

    pop(id: string) {
      const idx = this._stack.findIndex((e) => e.id === id);
      if (idx === -1) return;
      this._stack.splice(idx, 1);
      this._ignorePopstate = true;
      history.back();
    },

    _onPopState(_e: PopStateEvent) {
      if (this._ignorePopstate) {
        this._ignorePopstate = false;
        return;
      }
      const entry = this._stack.pop();
      if (entry) {
        entry.close();
      }
    },

    has(id: string) {
      return this._stack.some((e) => e.id === id);
    },

    clear() {
      const count = this._stack.length;
      this._stack = [];
      if (count > 0) {
        this._ignorePopstate = true;
        history.go(-count);
      }
    },
  };
  return oh;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('OverlayHistory', () => {
  let oh: ReturnType<typeof makeOverlayHistory>;
  let pushStateSpy: ReturnType<typeof vi.spyOn>;
  let replaceStateSpy: ReturnType<typeof vi.spyOn>;
  let backSpy: ReturnType<typeof vi.spyOn>;
  let goSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Spy on history methods
    pushStateSpy = vi.spyOn(history, 'pushState').mockImplementation(() => {});
    replaceStateSpy = vi.spyOn(history, 'replaceState').mockImplementation(() => {});
    backSpy = vi.spyOn(history, 'back').mockImplementation(() => {});
    goSpy = vi.spyOn(history, 'go').mockImplementation(() => {});

    oh = makeOverlayHistory();

    return () => {
      // Cleanup: remove popstate listeners by replacing window listeners
      // (jsdom creates a fresh window per environment, but we clean up spies)
      pushStateSpy.mockRestore();
      replaceStateSpy.mockRestore();
      backSpy.mockRestore();
      goSpy.mockRestore();
    };
  });

  describe('init()', () => {
    it('calls replaceState with base state', () => {
      oh.init();
      expect(replaceStateSpy).toHaveBeenCalledWith({ overlay: null }, '');
    });

    it('registers popstate listener that delegates to _onPopState', () => {
      const spy = vi.spyOn(oh, '_onPopState');
      oh.init();
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe('push()', () => {
    it('adds entry to stack and calls pushState', () => {
      const closeFn = vi.fn();
      oh.push('settings', closeFn);

      expect(oh._stack).toHaveLength(1);
      expect(oh._stack[0].id).toBe('settings');
      expect(pushStateSpy).toHaveBeenCalledWith({ overlay: 'settings' }, '');
    });

    it('allows pushing different ids', () => {
      oh.push('board', vi.fn());
      oh.push('board-detail', vi.fn());

      expect(oh._stack).toHaveLength(2);
      expect(pushStateSpy).toHaveBeenCalledTimes(2);
    });

    it('prevents duplicate push of same id consecutively', () => {
      const closeFn = vi.fn();
      oh.push('command', closeFn);
      oh.push('command', closeFn);

      expect(oh._stack).toHaveLength(1);
      expect(pushStateSpy).toHaveBeenCalledTimes(1);
    });

    it('allows re-push of same id if not on top of stack', () => {
      oh.push('board', vi.fn());
      oh.push('board-detail', vi.fn());
      oh.push('board', vi.fn()); // board is not on top, so this is allowed

      expect(oh._stack).toHaveLength(3);
      expect(pushStateSpy).toHaveBeenCalledTimes(3);
    });
  });

  describe('pop()', () => {
    it('removes entry from stack and calls history.back()', () => {
      oh.push('settings', vi.fn());
      oh.pop('settings');

      expect(oh._stack).toHaveLength(0);
      expect(backSpy).toHaveBeenCalledTimes(1);
    });

    it('sets _ignorePopstate flag', () => {
      oh.push('settings', vi.fn());
      oh.pop('settings');

      expect(oh._ignorePopstate).toBe(true);
    });

    it('is idempotent — unknown id is a no-op', () => {
      oh.push('settings', vi.fn());
      oh.pop('nonexistent');

      expect(oh._stack).toHaveLength(1);
      expect(backSpy).not.toHaveBeenCalled();
      expect(oh._ignorePopstate).toBe(false);
    });

    it('removes the correct entry from middle of stack', () => {
      oh.push('board', vi.fn());
      oh.push('board-detail', vi.fn());
      oh.push('settings', vi.fn());

      oh.pop('board-detail');

      expect(oh._stack).toHaveLength(2);
      expect(oh._stack[0].id).toBe('board');
      expect(oh._stack[1].id).toBe('settings');
    });
  });

  describe('has()', () => {
    it('returns true when id is in stack', () => {
      oh.push('board', vi.fn());
      expect(oh.has('board')).toBe(true);
    });

    it('returns false when id is not in stack', () => {
      expect(oh.has('board')).toBe(false);
    });

    it('returns false after id is popped', () => {
      oh.push('board', vi.fn());
      oh.pop('board');
      expect(oh.has('board')).toBe(false);
    });
  });

  describe('clear()', () => {
    it('empties the stack and calls history.go(-count)', () => {
      oh.push('board', vi.fn());
      oh.push('board-detail', vi.fn());
      oh.push('settings', vi.fn());

      oh.clear();

      expect(oh._stack).toHaveLength(0);
      expect(goSpy).toHaveBeenCalledWith(-3);
      expect(oh._ignorePopstate).toBe(true);
    });

    it('is safe on empty stack — no history.go call', () => {
      oh.clear();

      expect(oh._stack).toHaveLength(0);
      expect(goSpy).not.toHaveBeenCalled();
      expect(oh._ignorePopstate).toBe(false);
    });

    it('clears a single-entry stack correctly', () => {
      oh.push('command', vi.fn());
      oh.clear();

      expect(oh._stack).toHaveLength(0);
      expect(goSpy).toHaveBeenCalledWith(-1);
    });
  });

  describe('_onPopState()', () => {
    it('calls close function of top stack entry', () => {
      const closeFn = vi.fn();
      oh.push('settings', closeFn);

      oh._onPopState(new PopStateEvent('popstate'));

      expect(closeFn).toHaveBeenCalledTimes(1);
      expect(oh._stack).toHaveLength(0);
    });

    it('does nothing when stack is empty', () => {
      // Should not throw
      oh._onPopState(new PopStateEvent('popstate'));
      expect(oh._stack).toHaveLength(0);
    });

    it('skips when _ignorePopstate is true and resets the flag', () => {
      const closeFn = vi.fn();
      oh.push('settings', closeFn);
      oh._ignorePopstate = true;

      oh._onPopState(new PopStateEvent('popstate'));

      expect(closeFn).not.toHaveBeenCalled();
      expect(oh._ignorePopstate).toBe(false);
      expect(oh._stack).toHaveLength(1); // entry not removed
    });
  });

  describe('_ignorePopstate flag integration', () => {
    it('pop() sets flag so next popstate is skipped', () => {
      const closeFn = vi.fn();
      oh.push('settings', closeFn);
      oh.init();

      oh.pop('settings');
      // Simulate the popstate that history.back() would fire
      window.dispatchEvent(new PopStateEvent('popstate'));

      // closeFn should NOT be called — the flag suppressed it
      expect(closeFn).not.toHaveBeenCalled();
      expect(oh._ignorePopstate).toBe(false); // flag was reset
    });

    it('flag only suppresses one popstate event', () => {
      const closeA = vi.fn();
      const closeB = vi.fn();
      oh.push('board', closeA);
      oh.push('settings', closeB);
      oh.init();

      oh.pop('settings');
      // First popstate — suppressed by flag
      window.dispatchEvent(new PopStateEvent('popstate'));
      expect(closeA).not.toHaveBeenCalled();

      // Second popstate — NOT suppressed, closes board
      window.dispatchEvent(new PopStateEvent('popstate'));
      expect(closeA).toHaveBeenCalledTimes(1);
    });
  });

  describe('nested overlay stack (LIFO)', () => {
    it('popstate closes overlays in reverse order', () => {
      const closeOrder: string[] = [];
      oh.push('board', () => closeOrder.push('board'));
      oh.push('board-detail', () => closeOrder.push('board-detail'));
      oh.init();

      // First back — closes board-detail (top of stack)
      window.dispatchEvent(new PopStateEvent('popstate'));
      expect(closeOrder).toEqual(['board-detail']);
      expect(oh._stack).toHaveLength(1);

      // Second back — closes board
      window.dispatchEvent(new PopStateEvent('popstate'));
      expect(closeOrder).toEqual(['board-detail', 'board']);
      expect(oh._stack).toHaveLength(0);
    });

    it('three-deep stack unwinds correctly', () => {
      const closeOrder: string[] = [];
      oh.push('board', () => closeOrder.push('board'));
      oh.push('board-detail', () => closeOrder.push('board-detail'));
      oh.push('settings', () => closeOrder.push('settings'));

      // Simulate three popstate events
      oh._onPopState(new PopStateEvent('popstate'));
      oh._onPopState(new PopStateEvent('popstate'));
      oh._onPopState(new PopStateEvent('popstate'));

      expect(closeOrder).toEqual(['settings', 'board-detail', 'board']);
      expect(oh._stack).toHaveLength(0);
    });

    it('pop middle entry does not affect LIFO order of remaining', () => {
      const closeOrder: string[] = [];
      oh.push('board', () => closeOrder.push('board'));
      oh.push('command', () => closeOrder.push('command'));
      oh.push('settings', () => closeOrder.push('settings'));

      // Remove middle entry programmatically
      oh.pop('command');

      // Now popstate unwinds settings then board
      oh._ignorePopstate = false; // reset after pop
      oh._onPopState(new PopStateEvent('popstate'));
      oh._onPopState(new PopStateEvent('popstate'));

      expect(closeOrder).toEqual(['settings', 'board']);
    });
  });

  describe('mutual-exclusion pattern', () => {
    it('popping sibling before pushing new entry keeps stack consistent', () => {
      oh.push('mcp', vi.fn());

      // Simulate CommandPanel.open() closing MCP then pushing itself
      oh.pop('mcp');
      oh.push('command', vi.fn());

      expect(oh._stack).toHaveLength(1);
      expect(oh._stack[0].id).toBe('command');
      expect(oh.has('mcp')).toBe(false);
    });

    it('popping nonexistent sibling is safe before push', () => {
      // No panel open, CommandPanel opens and tries to close siblings
      oh.pop('mcp');
      oh.pop('plugins');
      oh.pop('context');
      oh.push('command', vi.fn());

      expect(oh._stack).toHaveLength(1);
      expect(oh._stack[0].id).toBe('command');
    });
  });
});
