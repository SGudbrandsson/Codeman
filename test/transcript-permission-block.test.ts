/**
 * Transcript Permission Block — functional test suite
 *
 * Tests the inline permission prompt rendering added by fix/transcript-permission-prompts.
 * Covers five gaps identified in TASK.md Test Gap Analysis:
 *
 * 1. _renderPermissionBlock(data) — injects .tv-permission-block into transcript container
 * 2. _removePermissionBlock() — removes the permission block when hooks are cleared
 * 3. sendPermissionResponse(sessionId, key) — clicking buttons sends correct input via API
 * 4. Thinking indicator suppression — setWorking(false) is called when permission prompt arrives
 * 5. CSS smoke — .tv-permission-block classes exist in loaded stylesheets
 *
 * Port: 3261
 *
 * Run: npx vitest run test/transcript-permission-block.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3261;
const BASE_URL = `http://localhost:${PORT}`;

// ─── Helpers ────────────────────────────────────────────────────────────────

let server: WebServer;
let browser: Browser;

async function freshPage(): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  return { context, page };
}

async function navigateTo(page: Page): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.classList.contains('app-loaded'), { timeout: 8000 });
  await page.waitForTimeout(500);
}

async function createSession(page: Page): Promise<string> {
  const id = await page.evaluate(async () => {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDir: '/tmp', name: 'test-permission-block' }),
    });
    const data = await res.json();
    return (data.id ?? data.session?.id) as string;
  });
  return id;
}

async function selectSession(page: Page, sessionId: string): Promise<void> {
  await page.evaluate((id) => {
    (window as unknown as { app: { selectSession: (id: string) => void } }).app.selectSession(id);
  }, sessionId);
  await page.waitForTimeout(800);
}

async function deleteSession(page: Page, sessionId: string): Promise<void> {
  await page.evaluate(async (id) => {
    await fetch('/api/sessions/' + id, { method: 'DELETE' });
  }, sessionId);
}

// ─── Setup / Teardown ───────────────────────────────────────────────────────

beforeAll(async () => {
  server = new WebServer(PORT, false, true);
  await server.start();
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
}, 30_000);

// ─── Gap 5: CSS smoke tests ────────────────────────────────────────────────

describe('CSS smoke — .tv-permission-* classes are defined in the stylesheet', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  const expectedSelectors = [
    '.tv-permission-block',
    '.tv-permission-header',
    '.tv-permission-desc',
    '.tv-permission-actions',
    '.tv-permission-btn',
    '.tv-permission-btn--yes',
    '.tv-permission-btn--no',
    '.tv-permission-btn--always',
  ];

  for (const selector of expectedSelectors) {
    it(`${selector} rule exists in a loaded stylesheet`, async () => {
      const found = await page.evaluate((sel) => {
        for (const sheet of Array.from(document.styleSheets)) {
          try {
            const rules = Array.from(sheet.cssRules ?? []);
            if (rules.some((r) => r instanceof CSSStyleRule && r.selectorText === sel)) {
              return true;
            }
          } catch {
            // cross-origin sheet — skip
          }
        }
        return false;
      }, selector);
      expect(found, `Expected CSS rule for "${selector}" to be present`).toBe(true);
    });
  }
});

// ─── Gap 1: _renderPermissionBlock injects .tv-permission-block ──────────

describe('_renderPermissionBlock — injects .tv-permission-block into transcript container', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await selectSession(page, sessionId);

    // Call _renderPermissionBlock directly with test data
    await page.evaluate(
      ({ sid }) => {
        const tv = (
          window as unknown as {
            TranscriptView: {
              _sessionId: string;
              _renderPermissionBlock: (data: { tool: string; command: string; sessionId: string }) => void;
            };
          }
        ).TranscriptView;
        tv._sessionId = sid;
        tv._renderPermissionBlock({ tool: 'Bash', command: 'rm -rf /tmp/test', sessionId: sid });
      },
      { sid: sessionId }
    );
    await page.waitForTimeout(200);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('.tv-permission-block is injected inside #transcriptView', async () => {
    const isInside = await page.evaluate(() => {
      const block = document.querySelector('.tv-permission-block');
      return block !== null && block.closest('#transcriptView') !== null;
    });
    expect(isInside).toBe(true);
  });

  it('block contains "Permission Required" header', async () => {
    const headerText = await page.evaluate(() => {
      const hdr = document.querySelector('.tv-permission-header');
      return hdr?.textContent ?? null;
    });
    expect(headerText).toBe('Permission Required');
  });

  it('block displays tool and command info', async () => {
    const descText = await page.evaluate(() => {
      const desc = document.querySelector('.tv-permission-desc');
      return desc?.textContent ?? null;
    });
    expect(descText).toContain('Bash');
    expect(descText).toContain('rm -rf /tmp/test');
  });

  it('block has Yes, No, and Always Allow buttons', async () => {
    const buttons = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.tv-permission-btn'));
      return btns.map((b) => ({
        text: b.textContent,
        hasYes: b.classList.contains('tv-permission-btn--yes'),
        hasNo: b.classList.contains('tv-permission-btn--no'),
        hasAlways: b.classList.contains('tv-permission-btn--always'),
      }));
    });
    expect(buttons).toHaveLength(3);
    expect(buttons[0].text).toBe('Yes');
    expect(buttons[0].hasYes).toBe(true);
    expect(buttons[1].text).toBe('No');
    expect(buttons[1].hasNo).toBe(true);
    expect(buttons[2].text).toBe('Always Allow');
    expect(buttons[2].hasAlways).toBe(true);
  });

  it('block has data-session-id attribute matching the session', async () => {
    const attr = await page.evaluate(() => {
      const block = document.querySelector('.tv-permission-block');
      return block?.getAttribute('data-session-id') ?? null;
    });
    expect(attr).toBe(sessionId);
  });
});

// ─── Gap 1b: _renderPermissionBlock with file instead of command ─────────

describe('_renderPermissionBlock — displays file path when command is absent', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await selectSession(page, sessionId);

    await page.evaluate(
      ({ sid }) => {
        const tv = (
          window as unknown as {
            TranscriptView: {
              _sessionId: string;
              _renderPermissionBlock: (data: { tool: string; file: string; sessionId: string }) => void;
            };
          }
        ).TranscriptView;
        tv._sessionId = sid;
        tv._renderPermissionBlock({ tool: 'Write', file: '/home/user/.mcp.json', sessionId: sid });
      },
      { sid: sessionId }
    );
    await page.waitForTimeout(200);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('block displays tool name and file path', async () => {
    const descText = await page.evaluate(() => {
      const desc = document.querySelector('.tv-permission-desc');
      return desc?.textContent ?? null;
    });
    expect(descText).toContain('Write');
    expect(descText).toContain('/home/user/.mcp.json');
  });
});

// ─── Gap 2: _removePermissionBlock removes the block ────────────────────

describe('_removePermissionBlock — removes the permission block from the DOM', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await selectSession(page, sessionId);

    // First render a permission block
    await page.evaluate(
      ({ sid }) => {
        const tv = (
          window as unknown as {
            TranscriptView: {
              _sessionId: string;
              _renderPermissionBlock: (data: { tool: string; command: string; sessionId: string }) => void;
              _removePermissionBlock: () => void;
            };
          }
        ).TranscriptView;
        tv._sessionId = sid;
        tv._renderPermissionBlock({ tool: 'Bash', command: 'echo test', sessionId: sid });
      },
      { sid: sessionId }
    );
    await page.waitForTimeout(200);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('.tv-permission-block exists before removal', async () => {
    const count = await page.locator('.tv-permission-block').count();
    expect(count).toBe(1);
  });

  it('.tv-permission-block is removed after _removePermissionBlock()', async () => {
    await page.evaluate(() => {
      (
        window as unknown as {
          TranscriptView: { _removePermissionBlock: () => void };
        }
      ).TranscriptView._removePermissionBlock();
    });
    await page.waitForTimeout(200);

    const count = await page.locator('.tv-permission-block').count();
    expect(count).toBe(0);
  });

  it('_permissionBlockEl is null after removal', async () => {
    const isNull = await page.evaluate(() => {
      return (
        (
          window as unknown as {
            TranscriptView: { _permissionBlockEl: unknown };
          }
        ).TranscriptView._permissionBlockEl === null
      );
    });
    expect(isNull).toBe(true);
  });
});

// ─── Gap 2b: clearPendingHooks removes permission block ─────────────────

describe('clearPendingHooks — removes permission block when permission_prompt hook is cleared', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await selectSession(page, sessionId);

    // Render a permission block
    await page.evaluate(
      ({ sid }) => {
        const tv = (
          window as unknown as {
            TranscriptView: {
              _sessionId: string;
              _renderPermissionBlock: (data: { tool: string; command: string; sessionId: string }) => void;
            };
          }
        ).TranscriptView;
        tv._sessionId = sid;
        tv._renderPermissionBlock({ tool: 'Bash', command: 'ls', sessionId: sid });
      },
      { sid: sessionId }
    );
    await page.waitForTimeout(200);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('.tv-permission-block is removed after clearPendingHooks(sessionId, "permission_prompt")', async () => {
    // Verify block exists first
    let count = await page.locator('.tv-permission-block').count();
    expect(count).toBe(1);

    // Set the pending hook so clearPendingHooks doesn't bail out early
    await page.evaluate((sid) => {
      (
        window as unknown as {
          app: {
            setPendingHook: (sessionId: string, hookType: string) => void;
            clearPendingHooks: (sessionId: string, hookType: string) => void;
          };
        }
      ).app.setPendingHook(sid, 'permission_prompt');
    }, sessionId);

    // Call clearPendingHooks
    await page.evaluate((sid) => {
      (
        window as unknown as {
          app: { clearPendingHooks: (sessionId: string, hookType: string) => void };
        }
      ).app.clearPendingHooks(sid, 'permission_prompt');
    }, sessionId);
    await page.waitForTimeout(200);

    count = await page.locator('.tv-permission-block').count();
    expect(count).toBe(0);
  });
});

// ─── Gap 3: sendPermissionResponse sends correct input ──────────────────

describe('sendPermissionResponse — sends correct input via POST /api/sessions/:id/input', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await selectSession(page, sessionId);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  for (const { label, key, expectedInput } of [
    { label: 'Yes', key: 'y', expectedInput: 'y\r' },
    { label: 'No', key: 'n', expectedInput: 'n\r' },
    { label: 'Always Allow', key: 'a', expectedInput: 'a\r' },
  ]) {
    it(`clicking ${label} button sends "${expectedInput}" with useMux: true`, async () => {
      // Render the permission block
      await page.evaluate(
        ({ sid }) => {
          const tv = (
            window as unknown as {
              TranscriptView: {
                _sessionId: string;
                _renderPermissionBlock: (data: { tool: string; command: string; sessionId: string }) => void;
              };
            }
          ).TranscriptView;
          tv._sessionId = sid;
          tv._renderPermissionBlock({ tool: 'Bash', command: 'test', sessionId: sid });
        },
        { sid: sessionId }
      );
      await page.waitForTimeout(200);

      // Intercept fetch to capture the API call
      await page.evaluate(() => {
        (window as any).__permFetchCalls = [];
        const originalFetch = window.fetch;
        (window as any).__origFetch = originalFetch;
        window.fetch = async function (...args: any[]) {
          const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
          if (url && url.includes('/api/sessions/') && url.includes('/input')) {
            const opts = args[1];
            const body = opts?.body ? JSON.parse(opts.body) : null;
            (window as any).__permFetchCalls.push({ url, body, method: opts?.method });
          }
          return originalFetch.apply(window, args as any);
        };
      });

      // Click the button via sendPermissionResponse
      await page.evaluate(
        ({ sid, k }) => {
          (
            window as unknown as {
              app: { sendPermissionResponse: (sessionId: string, key: string) => void };
            }
          ).app.sendPermissionResponse(sid, k);
        },
        { sid: sessionId, k: key }
      );
      await page.waitForTimeout(300);

      // Check the captured fetch call
      const calls = await page.evaluate(() => (window as any).__permFetchCalls);
      expect(calls.length).toBeGreaterThanOrEqual(1);

      const inputCall = calls.find((c: any) => c.url.includes(sessionId));
      expect(inputCall).toBeDefined();
      expect(inputCall.body.input).toBe(expectedInput);
      expect(inputCall.body.useMux).toBe(true);
      expect(inputCall.method).toBe('POST');

      // Restore fetch and clean up
      await page.evaluate(() => {
        if ((window as any).__origFetch) {
          window.fetch = (window as any).__origFetch;
          delete (window as any).__origFetch;
        }
        delete (window as any).__permFetchCalls;
      });
    });
  }

  it('sendPermissionResponse removes the permission block from the DOM', async () => {
    // Render a block
    await page.evaluate(
      ({ sid }) => {
        const tv = (
          window as unknown as {
            TranscriptView: {
              _sessionId: string;
              _renderPermissionBlock: (data: { tool: string; command: string; sessionId: string }) => void;
            };
          }
        ).TranscriptView;
        tv._sessionId = sid;
        tv._renderPermissionBlock({ tool: 'Bash', command: 'test', sessionId: sid });
      },
      { sid: sessionId }
    );
    await page.waitForTimeout(200);

    let count = await page.locator('.tv-permission-block').count();
    expect(count).toBe(1);

    // Call sendPermissionResponse
    await page.evaluate((sid) => {
      (
        window as unknown as {
          app: { sendPermissionResponse: (sessionId: string, key: string) => void };
        }
      ).app.sendPermissionResponse(sid, 'y');
    }, sessionId);
    await page.waitForTimeout(200);

    count = await page.locator('.tv-permission-block').count();
    expect(count).toBe(0);
  });
});

// ─── Gap 3b: Button click wiring — clicking DOM buttons triggers sendPermissionResponse ──

describe('Button click wiring — clicking rendered buttons calls sendPermissionResponse', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await selectSession(page, sessionId);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('clicking the Yes button calls sendPermissionResponse with key "y"', async () => {
    // Render block
    await page.evaluate(
      ({ sid }) => {
        const tv = (
          window as unknown as {
            TranscriptView: {
              _sessionId: string;
              _renderPermissionBlock: (data: { tool: string; command: string; sessionId: string }) => void;
            };
          }
        ).TranscriptView;
        tv._sessionId = sid;
        tv._renderPermissionBlock({ tool: 'Bash', command: 'echo click-test', sessionId: sid });
      },
      { sid: sessionId }
    );
    await page.waitForTimeout(200);

    // Intercept sendPermissionResponse
    await page.evaluate(() => {
      (window as any).__permResponseCalls = [];
      (window as any).app.sendPermissionResponse = (sid: string, key: string) => {
        (window as any).__permResponseCalls.push({ sid, key });
      };
    });

    // Click the Yes button
    await page.evaluate(() => {
      const btn = document.querySelector('.tv-permission-btn--yes') as HTMLButtonElement | null;
      if (btn) btn.click();
    });

    const calls = await page.evaluate(() => (window as any).__permResponseCalls);
    expect(calls.length).toBe(1);
    expect(calls[0].key).toBe('y');
    expect(calls[0].sid).toBe(sessionId);

    await page.evaluate(() => {
      delete (window as any).__permResponseCalls;
    });
  });
});

// ─── Gap 4: Thinking indicator suppression ──────────────────────────────

describe('Thinking indicator suppression — setWorking(false) when permission prompt arrives', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await selectSession(page, sessionId);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('setWorking(false) is called when _onHookPermissionPrompt fires for the active session', async () => {
    // First set the thinking indicator to active
    await page.evaluate(() => {
      (
        window as unknown as {
          TranscriptView: { setWorking: (v: boolean) => void };
        }
      ).TranscriptView.setWorking(true);
    });
    await page.waitForTimeout(200);

    // Track setWorking calls
    await page.evaluate(() => {
      const tv = (window as unknown as { TranscriptView: { setWorking: (v: boolean) => void } }).TranscriptView;
      (window as any).__setWorkingCalls = [];
      const orig = tv.setWorking.bind(tv);
      tv.setWorking = (v: boolean) => {
        (window as any).__setWorkingCalls.push(v);
        orig(v);
      };
    });

    // Fire _onHookPermissionPrompt for the active session
    await page.evaluate((sid) => {
      (
        window as unknown as {
          app: {
            _onHookPermissionPrompt: (data: { sessionId: string; tool: string; command: string }) => void;
          };
        }
      ).app._onHookPermissionPrompt({
        sessionId: sid,
        tool: 'Bash',
        command: 'echo thinking-test',
      });
    }, sessionId);
    await page.waitForTimeout(300);

    // Verify setWorking(false) was called
    const calls = await page.evaluate(() => (window as any).__setWorkingCalls);
    expect(calls).toContain(false);

    await page.evaluate(() => {
      delete (window as any).__setWorkingCalls;
    });
  });
});

// ─── Gap 6: load() nulls _permissionBlockEl ────────────────────────────

describe('load() — nulls _permissionBlockEl and removes .tv-permission-block from DOM', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;
  let sessionId2: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    sessionId2 = await createSession(page);
    await selectSession(page, sessionId);

    // Render a permission block for sessionId
    await page.evaluate(
      ({ sid }) => {
        const tv = (
          window as unknown as {
            TranscriptView: {
              _sessionId: string;
              _renderPermissionBlock: (data: { tool: string; command: string; sessionId: string }) => void;
            };
          }
        ).TranscriptView;
        tv._sessionId = sid;
        tv._renderPermissionBlock({ tool: 'Bash', command: 'echo load-test', sessionId: sid });
      },
      { sid: sessionId }
    );
    await page.waitForTimeout(200);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await deleteSession(page, sessionId2);
    await context?.close();
  });

  it('.tv-permission-block exists before load()', async () => {
    const count = await page.locator('.tv-permission-block').count();
    expect(count).toBe(1);
  });

  it('_permissionBlockEl is not null before load()', async () => {
    const isNull = await page.evaluate(() => {
      return (
        (
          window as unknown as {
            TranscriptView: { _permissionBlockEl: unknown };
          }
        ).TranscriptView._permissionBlockEl === null
      );
    });
    expect(isNull).toBe(false);
  });

  it('after load(newSessionId), _permissionBlockEl is null', async () => {
    // Call load() with a different session to trigger the reset
    await page.evaluate(
      ({ sid2 }) => {
        const tv = (
          window as unknown as {
            TranscriptView: {
              load: (sessionId: string) => Promise<void>;
            };
          }
        ).TranscriptView;
        tv.load(sid2);
      },
      { sid2: sessionId2 }
    );
    await page.waitForTimeout(800);

    const isNull = await page.evaluate(() => {
      return (
        (
          window as unknown as {
            TranscriptView: { _permissionBlockEl: unknown };
          }
        ).TranscriptView._permissionBlockEl === null
      );
    });
    expect(isNull).toBe(true);
  });

  it('.tv-permission-block is no longer in the DOM after load()', async () => {
    const count = await page.locator('.tv-permission-block').count();
    expect(count).toBe(0);
  });
});

// ─── Gap 7: _renderPermissionBlock deduplication ───────────────────────

describe('_renderPermissionBlock deduplication — only one block in DOM after double call', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await selectSession(page, sessionId);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('calling _renderPermissionBlock twice results in exactly one .tv-permission-block', async () => {
    await page.evaluate(
      ({ sid }) => {
        const tv = (
          window as unknown as {
            TranscriptView: {
              _sessionId: string;
              _renderPermissionBlock: (data: { tool: string; command: string; sessionId: string }) => void;
            };
          }
        ).TranscriptView;
        tv._sessionId = sid;
        tv._renderPermissionBlock({ tool: 'Bash', command: 'echo first', sessionId: sid });
        tv._renderPermissionBlock({ tool: 'Write', command: 'echo second', sessionId: sid });
      },
      { sid: sessionId }
    );
    await page.waitForTimeout(200);

    const count = await page.locator('.tv-permission-block').count();
    expect(count).toBe(1);
  });

  it('the surviving block shows the second call data', async () => {
    const descText = await page.evaluate(() => {
      const desc = document.querySelector('.tv-permission-desc');
      return desc?.textContent ?? null;
    });
    expect(descText).toContain('Write');
    expect(descText).toContain('echo second');
  });
});

// ─── Gap 8: _renderPermissionBlock with no tool info ───────────────────

describe('_renderPermissionBlock with no tool — desc omitted, block and buttons still render', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await selectSession(page, sessionId);

    await page.evaluate(
      ({ sid }) => {
        const tv = (
          window as unknown as {
            TranscriptView: {
              _sessionId: string;
              _renderPermissionBlock: (data: { sessionId: string }) => void;
            };
          }
        ).TranscriptView;
        tv._sessionId = sid;
        tv._renderPermissionBlock({ sessionId: sid });
      },
      { sid: sessionId }
    );
    await page.waitForTimeout(200);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('.tv-permission-block is rendered', async () => {
    const count = await page.locator('.tv-permission-block').count();
    expect(count).toBe(1);
  });

  it('.tv-permission-desc is NOT rendered when tool is absent', async () => {
    const count = await page.locator('.tv-permission-desc').count();
    expect(count).toBe(0);
  });

  it('buttons are still present', async () => {
    const btnCount = await page.locator('.tv-permission-btn').count();
    expect(btnCount).toBe(3);
  });

  it('header is still present', async () => {
    const headerText = await page.evaluate(() => {
      const hdr = document.querySelector('.tv-permission-header');
      return hdr?.textContent ?? null;
    });
    expect(headerText).toBe('Permission Required');
  });
});

// ─── Gap 9: _onHookPermissionPrompt inactive session guard ─────────────

describe('_onHookPermissionPrompt — does NOT render block for inactive session', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await selectSession(page, sessionId);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('firing _onHookPermissionPrompt with a non-active sessionId does not create .tv-permission-block', async () => {
    // Fire with a fake session ID that is NOT the active session
    await page.evaluate(() => {
      (
        window as unknown as {
          app: {
            _onHookPermissionPrompt: (data: { sessionId: string; tool: string; command: string }) => void;
          };
        }
      ).app._onHookPermissionPrompt({
        sessionId: 'non-existent-session-id-12345',
        tool: 'Bash',
        command: 'echo should-not-render',
      });
    });
    await page.waitForTimeout(200);

    const count = await page.locator('.tv-permission-block').count();
    expect(count).toBe(0);
  });
});
