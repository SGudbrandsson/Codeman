/**
 * @fileoverview Global test setup for Claudeman tests
 *
 * Provides:
 * - Screen session concurrency limiter (max 10)
 * - Orphaned Claude/screen process cleanup
 * - Global beforeAll/afterAll hooks
 */

import { execSync, exec } from 'node:child_process';
import { beforeAll, afterAll, afterEach } from 'vitest';

/** Maximum concurrent screen sessions allowed during tests */
const MAX_CONCURRENT_SCREENS = 10;

/** Track active screen sessions created during tests */
const activeTestScreens = new Set<string>();

/** Semaphore for controlling concurrent screen creation */
let currentScreenCount = 0;
const screenWaiters: Array<() => void> = [];

/**
 * Get list of claudeman screen sessions
 */
function getClaudemanScreens(): string[] {
  try {
    const output = execSync('screen -ls 2>/dev/null || true', { encoding: 'utf-8' });
    const lines = output.split('\n');
    const screens: string[] = [];
    for (const line of lines) {
      const match = line.match(/\d+\.(claudeman-[^\s]+)/);
      if (match) {
        screens.push(match[1]);
      }
    }
    return screens;
  } catch {
    return [];
  }
}

/**
 * Get list of Claude CLI processes
 */
function getClaudeProcesses(): number[] {
  try {
    const output = execSync('pgrep -f "claude.*--dangerously-skip-permissions" 2>/dev/null || true', {
      encoding: 'utf-8',
    });
    return output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(pid => parseInt(pid, 10))
      .filter(pid => !isNaN(pid));
  } catch {
    return [];
  }
}

/**
 * Kill orphaned claudeman screen sessions
 */
function killOrphanedScreens(): void {
  const screens = getClaudemanScreens();
  for (const screenName of screens) {
    try {
      execSync(`screen -S ${screenName} -X quit 2>/dev/null || true`, { encoding: 'utf-8' });
    } catch {
      // Ignore errors
    }
  }
}

/**
 * Kill orphaned Claude CLI processes
 */
function killOrphanedClaudeProcesses(): void {
  const pids = getClaudeProcesses();
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Process may already be gone
    }
  }

  // Wait a bit, then SIGKILL any remaining
  if (pids.length > 0) {
    setTimeout(() => {
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Process may already be gone
        }
      }
    }, 500);
  }
}

/**
 * Acquire a screen slot (blocks if at capacity)
 */
export async function acquireScreenSlot(): Promise<void> {
  if (currentScreenCount < MAX_CONCURRENT_SCREENS) {
    currentScreenCount++;
    return;
  }

  // Wait for a slot to become available
  return new Promise<void>(resolve => {
    screenWaiters.push(resolve);
  });
}

/**
 * Release a screen slot
 */
export function releaseScreenSlot(): void {
  currentScreenCount = Math.max(0, currentScreenCount - 1);

  // Wake up a waiter if any
  const waiter = screenWaiters.shift();
  if (waiter) {
    currentScreenCount++;
    waiter();
  }
}

/**
 * Register a screen session for tracking
 */
export function registerTestScreen(screenName: string): void {
  activeTestScreens.add(screenName);
}

/**
 * Unregister a screen session
 */
export function unregisterTestScreen(screenName: string): void {
  activeTestScreens.delete(screenName);
}

/**
 * Get current screen count for debugging
 */
export function getScreenStats(): { current: number; max: number; waiting: number } {
  return {
    current: currentScreenCount,
    max: MAX_CONCURRENT_SCREENS,
    waiting: screenWaiters.length,
  };
}

/**
 * Force cleanup all test screens (emergency cleanup)
 */
export function forceCleanupAllScreens(): void {
  // Kill all tracked test screens
  for (const screenName of activeTestScreens) {
    try {
      execSync(`screen -S ${screenName} -X quit 2>/dev/null || true`);
    } catch {
      // Ignore
    }
  }
  activeTestScreens.clear();

  // Also kill any orphaned claudeman screens
  killOrphanedScreens();

  // Reset semaphore
  currentScreenCount = 0;
  screenWaiters.length = 0;
}

// =============================================================================
// Global Hooks
// =============================================================================

beforeAll(async () => {
  // Clean up any orphaned processes from previous test runs
  console.log('[Test Setup] Cleaning up orphaned processes...');

  killOrphanedScreens();
  killOrphanedClaudeProcesses();

  // Wait for cleanup to complete
  await new Promise(resolve => setTimeout(resolve, 1000));

  const remainingScreens = getClaudemanScreens();
  const remainingClaude = getClaudeProcesses();

  if (remainingScreens.length > 0) {
    console.log(`[Test Setup] Warning: ${remainingScreens.length} screen sessions still exist`);
  }
  if (remainingClaude.length > 0) {
    console.log(`[Test Setup] Warning: ${remainingClaude.length} Claude processes still exist`);
  }

  console.log('[Test Setup] Cleanup complete, starting tests...');
});

afterAll(async () => {
  console.log('[Test Setup] Final cleanup...');

  // Force cleanup all screens
  forceCleanupAllScreens();

  // Kill any remaining Claude processes
  killOrphanedClaudeProcesses();

  // Wait for cleanup
  await new Promise(resolve => setTimeout(resolve, 1000));

  const remainingScreens = getClaudemanScreens();
  const remainingClaude = getClaudeProcesses();

  if (remainingScreens.length > 0) {
    console.warn(`[Test Setup] Warning: ${remainingScreens.length} orphaned screens after tests`);
    // Force kill them
    for (const screen of remainingScreens) {
      try {
        execSync(`screen -S ${screen} -X quit 2>/dev/null || true`);
      } catch {
        // Ignore
      }
    }
  }

  if (remainingClaude.length > 0) {
    console.warn(`[Test Setup] Warning: ${remainingClaude.length} orphaned Claude processes after tests`);
    for (const pid of remainingClaude) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Ignore
      }
    }
  }

  console.log('[Test Setup] Final cleanup complete');
});

// Export utilities for tests that need them
export {
  getClaudemanScreens,
  getClaudeProcesses,
  killOrphanedScreens,
  killOrphanedClaudeProcesses,
  MAX_CONCURRENT_SCREENS,
};
