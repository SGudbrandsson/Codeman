/**
 * @fileoverview Global test setup for Claudeman tests
 *
 * Provides:
 * - Screen session concurrency limiter (max 10)
 * - Tracked resource cleanup (only kills what tests create)
 * - Global beforeAll/afterAll hooks
 *
 * SAFETY: This setup ONLY cleans up resources that the test suite itself creates.
 * It will NEVER kill Claude processes or screens that weren't spawned by tests.
 * This makes it safe to run tests from within a Claudeman-managed session.
 */

import { execSync } from 'node:child_process';
import { beforeAll, afterAll, afterEach } from 'vitest';

/** Maximum concurrent screen sessions allowed during tests */
const MAX_CONCURRENT_SCREENS = 10;

/** Track active screen sessions created during tests */
const activeTestScreens = new Set<string>();

/** Track Claude PIDs spawned by tests (for cleanup) */
const activeTestClaudePids = new Set<number>();

/** Semaphore for controlling concurrent screen creation */
let currentScreenCount = 0;
const screenWaiters: Array<() => void> = [];

/**
 * Kill only the screens that tests have registered via registerTestScreen()
 */
function killTrackedTestScreens(): void {
  for (const screenName of activeTestScreens) {
    try {
      execSync(`screen -S ${screenName} -X quit 2>/dev/null || true`, { encoding: 'utf-8' });
    } catch {
      // Ignore errors
    }
  }
  activeTestScreens.clear();
}

/**
 * Kill only the Claude processes that tests have registered via registerTestClaudePid()
 */
function killTrackedTestClaudeProcesses(): void {
  for (const pid of activeTestClaudePids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Process may already be gone
    }
  }

  // Wait a bit, then SIGKILL any remaining
  if (activeTestClaudePids.size > 0) {
    setTimeout(() => {
      for (const pid of activeTestClaudePids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Process may already be gone
        }
      }
      activeTestClaudePids.clear();
    }, 500);
  } else {
    activeTestClaudePids.clear();
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
 * Register a Claude PID for tracking (so it gets cleaned up after tests)
 */
export function registerTestClaudePid(pid: number): void {
  activeTestClaudePids.add(pid);
}

/**
 * Unregister a Claude PID
 */
export function unregisterTestClaudePid(pid: number): void {
  activeTestClaudePids.delete(pid);
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
 * Force cleanup all test-created resources (emergency cleanup)
 * Only kills resources that tests have registered - never kills external processes
 */
export function forceCleanupAllTestResources(): void {
  // Kill all tracked test screens
  killTrackedTestScreens();

  // Kill all tracked Claude processes
  killTrackedTestClaudeProcesses();

  // Reset semaphore
  currentScreenCount = 0;
  screenWaiters.length = 0;
}

// =============================================================================
// Global Hooks
// =============================================================================

/** Screens that existed before tests started (never killed by cleanup) */
const preExistingScreens = new Set<string>();

/**
 * List all current claudeman-* screen session names
 */
function listClaudemanScreens(): string[] {
  try {
    const output = execSync('screen -ls 2>/dev/null || true', { encoding: 'utf-8' });
    const screens: string[] = [];
    for (const line of output.split('\n')) {
      const match = line.match(/\d+\.(claudeman-\S+)/);
      if (match) screens.push(match[1]);
    }
    return screens;
  } catch {
    return [];
  }
}

/**
 * Kill detached claudeman screens that were created during the test run
 */
function killOrphanedTestScreens(): number {
  let killed = 0;
  try {
    const output = execSync('screen -ls 2>/dev/null || true', { encoding: 'utf-8' });
    for (const line of output.split('\n')) {
      // Only kill detached screens (never attached/user sessions)
      if (!line.includes('Detached')) continue;
      const match = line.match(/(\d+\.(claudeman-\S+))/);
      if (!match) continue;
      const fullName = match[1];
      const screenName = match[2];
      // Skip screens that existed before tests started
      if (preExistingScreens.has(screenName)) continue;
      try {
        execSync(`screen -S ${fullName} -X quit 2>/dev/null || true`, { encoding: 'utf-8' });
        killed++;
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return killed;
}

beforeAll(async () => {
  // Record pre-existing screens so we never kill them
  for (const name of listClaudemanScreens()) {
    preExistingScreens.add(name);
  }
  console.log(`[Test Setup] ${preExistingScreens.size} pre-existing screens preserved`);
});

afterAll(async () => {
  console.log('[Test Setup] Final cleanup of test-created resources...');

  // Only cleanup resources that tests have registered
  forceCleanupAllTestResources();

  // Kill orphaned screens created during the test run (not registered but detached)
  const orphansKilled = killOrphanedTestScreens();
  if (orphansKilled > 0) {
    console.log(`[Test Setup] Killed ${orphansKilled} orphaned test screens`);
  }

  // Wait for cleanup
  await new Promise(resolve => setTimeout(resolve, 500));

  // Report any tracked resources that weren't cleaned up
  if (activeTestScreens.size > 0) {
    console.warn(`[Test Setup] Warning: ${activeTestScreens.size} test screens weren't properly unregistered`);
  }
  if (activeTestClaudePids.size > 0) {
    console.warn(`[Test Setup] Warning: ${activeTestClaudePids.size} test Claude PIDs weren't properly unregistered`);
  }

  console.log('[Test Setup] Final cleanup complete');
});

// Export utilities for tests that need them
export {
  killTrackedTestScreens,
  killTrackedTestClaudeProcesses,
  MAX_CONCURRENT_SCREENS,
};
