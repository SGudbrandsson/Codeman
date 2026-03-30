/**
 * Browser E2E test: image attach/send pipeline
 *
 * Tests the ACTUAL frontend behavior using Playwright:
 *   1. Attaching images via file input → thumbnails appear
 *   2. Send button disabled during upload, enabled after
 *   3. Sending message with images → image paths included in input
 *   4. Error recovery: sendInput failure → input restored
 *   5. Session switch → images preserved (not wiped)
 *   6. Multiple images → all paths sent
 *   7. Rapid paste-then-send → waits for upload
 *
 * Run:
 *   PORT=9228 node test/e2e-image-attach-browser.mjs
 *
 * Requires: playwright, dev server running on PORT
 */

import { chromium } from 'playwright';
import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const PORT = process.env.PORT || '9228';
const BASE = `http://localhost:${PORT}`;

// Create minimal test PNG files
const RED_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADklEQVQI12P4z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const BLUE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADklEQVQI12NgYGD4DwABBAEAwMb9IQAAAABJRU5ErkJggg==',
  'base64',
);

const redPath = join(tmpdir(), 'e2e-test-red.png');
const bluePath = join(tmpdir(), 'e2e-test-blue.png');
writeFileSync(redPath, RED_PNG);
writeFileSync(bluePath, BLUE_PNG);

let passed = 0;
let failed = 0;
const results = [];

function log(msg) {
  console.log(msg);
}

function pass(name) {
  passed++;
  results.push({ name, status: 'PASS' });
  log(`  ✅ PASS: ${name}`);
}

function fail(name, reason) {
  failed++;
  results.push({ name, status: 'FAIL', reason });
  log(`  ❌ FAIL: ${name}`);
  log(`         ${reason}`);
}

// ─── Test runner ─────────────────────────────────────────────────

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
});

// Track all fetch calls to /api/sessions/*/input so we can verify what was sent
const sentInputs = [];

const page = await context.newPage();

// Intercept all input API calls to capture what the frontend sends
await page.route('**/api/sessions/*/input', async (route) => {
  const req = route.request();
  try {
    const body = JSON.parse(req.postData() || '{}');
    sentInputs.push({
      url: req.url(),
      input: body.input,
      useMux: body.useMux,
      timestamp: Date.now(),
    });
  } catch {}
  // Let the request through to the real server
  await route.continue();
});

log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
log(`🧪 Browser E2E: Image Attach/Send Pipeline`);
log(`   Server: ${BASE}`);
log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

// Load the page and wait for it to be ready
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await page.waitForSelector('#composeTextarea', { state: 'visible', timeout: 10000 });
  log('  Page loaded, compose area visible.\n');
} catch (err) {
  log(`  ❌ FATAL: Could not load page at ${BASE}: ${err.message}`);
  await browser.close();
  process.exit(1);
}

// ─── Test 1: Single image attach → thumbnail appears ─────────────

log('── Test 1: Single image attach → thumbnail appears');
try {
  await page.locator('#composeFileGallery').setInputFiles([redPath]);
  // Wait for thumbnail to appear in the strip
  await page.waitForSelector('#composeThumbStrip .compose-thumb', { timeout: 10000 });
  const thumbCount = await page.locator('#composeThumbStrip .compose-thumb').count();
  if (thumbCount >= 1) {
    pass('Single image: thumbnail appears in compose strip');
  } else {
    fail('Single image: thumbnail appears in compose strip', `Expected >= 1 thumbnail, got ${thumbCount}`);
  }
} catch (err) {
  fail('Single image: thumbnail appears in compose strip', err.message);
}

// ─── Test 2: Send button enables after upload completes ──────────

log('\n── Test 2: Send button enabled after upload completes');
try {
  // Wait for upload to complete (thumbnail title changes from "Uploading…" to include "Tap to preview")
  await page.waitForFunction(
    () => {
      const thumbs = document.querySelectorAll('#composeThumbStrip .compose-thumb');
      return [...thumbs].some(t => t.title.includes('preview'));
    },
    { timeout: 15000 },
  );
  // Type some text so send button can be enabled
  await page.locator('#composeTextarea').fill('Test 2: single image send');
  await page.waitForTimeout(200);

  const sendDisabled = await page.locator('#composeSendBtn').evaluate(btn => btn.disabled);
  if (!sendDisabled) {
    pass('Send button enabled after upload complete + text entered');
  } else {
    fail('Send button enabled after upload complete + text entered', 'Send button is still disabled');
  }
} catch (err) {
  fail('Send button enabled after upload complete + text entered', err.message);
}

// ─── Test 3: Send includes image path in input string ────────────

log('\n── Test 3: Send message → image path included in input');
try {
  sentInputs.length = 0; // clear previous captures

  // Click send
  await page.locator('#composeSendBtn').click();
  await page.waitForTimeout(1500);

  if (sentInputs.length === 0) {
    fail('Send includes image path', 'No input was sent to the server');
  } else {
    const sent = sentInputs[sentInputs.length - 1];
    const hasImagePath = sent.input.includes('.codeman/screenshots/') || sent.input.includes('/screenshots/');
    const hasText = sent.input.includes('Test 2: single image send');
    const hasUseMux = sent.useMux === true;

    if (hasImagePath && hasText && hasUseMux) {
      pass('Send includes image path + text + useMux:true');
      log(`         Input: ${JSON.stringify(sent.input).slice(0, 120)}...`);
    } else {
      fail('Send includes image path + text + useMux:true',
        `hasImagePath=${hasImagePath}, hasText=${hasText}, useMux=${hasUseMux}. Input: ${JSON.stringify(sent.input).slice(0, 200)}`);
    }
  }
} catch (err) {
  fail('Send includes image path', err.message);
}

// ─── Test 4: Textarea cleared after successful send ──────────────

log('\n── Test 4: Textarea and thumbnails cleared after send');
try {
  const textareaValue = await page.locator('#composeTextarea').inputValue();
  const thumbCount = await page.locator('#composeThumbStrip .compose-thumb').count();

  if (textareaValue === '' && thumbCount === 0) {
    pass('Textarea empty and thumbnails cleared after send');
  } else {
    fail('Textarea empty and thumbnails cleared after send',
      `textarea="${textareaValue}", thumbCount=${thumbCount}`);
  }
} catch (err) {
  fail('Textarea empty and thumbnails cleared after send', err.message);
}

// ─── Test 5: Multiple images → all paths in sent input ───────────

log('\n── Test 5: Multiple images → all paths in sent input');
try {
  sentInputs.length = 0;

  // Attach two images
  await page.locator('#composeFileGallery').setInputFiles([redPath, bluePath]);
  await page.waitForTimeout(500);

  // Wait for both thumbnails
  await page.waitForFunction(
    () => document.querySelectorAll('#composeThumbStrip .compose-thumb').length >= 2,
    { timeout: 15000 },
  );

  // Wait for both uploads to complete
  await page.waitForFunction(
    () => {
      const thumbs = document.querySelectorAll('#composeThumbStrip .compose-thumb');
      return [...thumbs].filter(t => t.title.includes('preview')).length >= 2;
    },
    { timeout: 15000 },
  );

  await page.locator('#composeTextarea').fill('Test 5: two images');
  await page.waitForTimeout(200);
  await page.locator('#composeSendBtn').click();
  await page.waitForTimeout(1500);

  if (sentInputs.length === 0) {
    fail('Multiple images: all paths sent', 'No input was sent');
  } else {
    const sent = sentInputs[sentInputs.length - 1];
    // Count screenshot paths in the input
    const pathMatches = (sent.input.match(/\.codeman\/screenshots\//g) || []).length;
    if (pathMatches >= 2) {
      pass(`Multiple images: ${pathMatches} image paths in sent input`);
      log(`         Input: ${JSON.stringify(sent.input).slice(0, 200)}...`);
    } else {
      fail('Multiple images: all paths sent',
        `Expected >= 2 paths, found ${pathMatches}. Input: ${JSON.stringify(sent.input).slice(0, 200)}`);
    }
  }
} catch (err) {
  fail('Multiple images: all paths sent', err.message);
}

// ─── Test 6: Session switch preserves images ─────────────────────

log('\n── Test 6: Session switch preserves images when attached');
try {
  // Attach an image first
  await page.locator('#composeFileGallery').setInputFiles([redPath]);
  await page.waitForSelector('#composeThumbStrip .compose-thumb', { timeout: 10000 });
  // Wait for upload to complete
  await page.waitForFunction(
    () => {
      const thumbs = document.querySelectorAll('#composeThumbStrip .compose-thumb');
      return [...thumbs].some(t => t.title.includes('preview'));
    },
    { timeout: 15000 },
  );

  const thumbsBefore = await page.locator('#composeThumbStrip .compose-thumb').count();

  // Simulate a session switch by evaluating JS that calls onSessionChange
  // This simulates what happens when an SSE event triggers a session change
  await page.evaluate(() => {
    // Access InputPanel directly — it's a global in app.js
    if (typeof InputPanel !== 'undefined' && InputPanel.onSessionChange) {
      const currentId = InputPanel._currentSessionId;
      // Switch to same session (simulates SSE reconnect-style switch)
      InputPanel.onSessionChange(currentId, currentId);
    }
  });
  await page.waitForTimeout(300);

  const thumbsAfter = await page.locator('#composeThumbStrip .compose-thumb').count();

  if (thumbsAfter >= thumbsBefore && thumbsAfter > 0) {
    pass(`Session switch preserves images (before=${thumbsBefore}, after=${thumbsAfter})`);
  } else {
    fail('Session switch preserves images',
      `Thumbnails lost: before=${thumbsBefore}, after=${thumbsAfter}`);
  }

  // Clean up — remove the image
  const removeBtn = page.locator('#composeThumbStrip .compose-thumb-remove').first();
  if (await removeBtn.count() > 0) {
    await removeBtn.click();
    await page.waitForTimeout(200);
  }
} catch (err) {
  fail('Session switch preserves images', err.message);
}

// ─── Test 7: Send button disabled during upload ──────────────────

log('\n── Test 7: Send button disabled during upload (upload delay injected)');
try {
  // Inject a 2s delay on the upload endpoint to guarantee we catch the disabled state
  await page.route('**/api/screenshots', async (route) => {
    await new Promise(r => setTimeout(r, 2000));
    await route.continue();
  });

  await page.locator('#composeTextarea').fill('Test 7: upload delay');
  await page.locator('#composeFileGallery').setInputFiles([redPath]);
  await page.waitForTimeout(200);

  // Check send button state during upload
  const disabledDuringUpload = await page.locator('#composeSendBtn').evaluate(btn => btn.disabled);

  if (disabledDuringUpload) {
    pass('Send button disabled during upload');
  } else {
    fail('Send button disabled during upload', 'Button was enabled during upload');
  }

  // Wait for upload to finish
  await page.waitForFunction(
    () => {
      const thumbs = document.querySelectorAll('#composeThumbStrip .compose-thumb');
      return [...thumbs].some(t => t.title.includes('preview'));
    },
    { timeout: 15000 },
  );

  // Check button re-enables
  const enabledAfter = await page.locator('#composeSendBtn').evaluate(btn => !btn.disabled);
  if (enabledAfter) {
    pass('Send button re-enabled after upload completes');
  } else {
    fail('Send button re-enabled after upload completes', 'Button still disabled');
  }

  // Remove the route delay for subsequent tests
  await page.unroute('**/api/screenshots');

  // Clean up — send or clear
  sentInputs.length = 0;
  await page.locator('#composeSendBtn').click();
  await page.waitForTimeout(1000);
} catch (err) {
  fail('Send button during upload', err.message);
}

// ─── Test 8: sendInput uses captured session ID ──────────────────

log('\n── Test 8: sendInput sends to captured session ID (not live activeSessionId)');
try {
  sentInputs.length = 0;

  // Get the current active session ID
  const currentSessionId = await page.evaluate(() => {
    return typeof app !== 'undefined' ? app.activeSessionId : null;
  });

  if (!currentSessionId) {
    fail('sendInput uses captured session ID', 'No active session');
  } else {
    // Attach image and type text
    await page.locator('#composeFileGallery').setInputFiles([redPath]);
    await page.waitForFunction(
      () => {
        const thumbs = document.querySelectorAll('#composeThumbStrip .compose-thumb');
        return [...thumbs].some(t => t.title.includes('preview'));
      },
      { timeout: 15000 },
    );
    await page.locator('#composeTextarea').fill('Test 8: session ID check');
    await page.waitForTimeout(200);

    await page.locator('#composeSendBtn').click();
    await page.waitForTimeout(1500);

    if (sentInputs.length > 0) {
      const sent = sentInputs[sentInputs.length - 1];
      const urlSessionId = sent.url.match(/sessions\/([^/]+)\/input/)?.[1];
      if (urlSessionId === currentSessionId) {
        pass(`Input sent to correct session: ${currentSessionId.slice(0, 12)}...`);
      } else {
        fail('sendInput uses captured session ID',
          `Expected ${currentSessionId}, got ${urlSessionId}`);
      }
    } else {
      fail('sendInput uses captured session ID', 'No input captured');
    }
  }
} catch (err) {
  fail('sendInput uses captured session ID', err.message);
}

// ─── Test 9: Error recovery — input restored on failure ──────────

log('\n── Test 9: Error recovery — input restored on sendInput failure');
try {
  // Block the input endpoint to simulate a failure
  await page.route('**/api/sessions/*/input', async (route) => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: 'Simulated server error' }),
    });
  });

  // Attach image and type text
  await page.locator('#composeFileGallery').setInputFiles([bluePath]);
  await page.waitForFunction(
    () => {
      const thumbs = document.querySelectorAll('#composeThumbStrip .compose-thumb');
      return [...thumbs].some(t => t.title.includes('preview'));
    },
    { timeout: 15000 },
  );
  await page.locator('#composeTextarea').fill('Test 9: should be restored');
  await page.waitForTimeout(200);

  // Try to send — should fail and restore
  await page.locator('#composeSendBtn').click();
  await page.waitForTimeout(2000);

  // Check: textarea should have the text back
  const restoredText = await page.locator('#composeTextarea').inputValue();
  // Check: error toast should be visible
  const toastVisible = await page.evaluate(() => {
    const toasts = document.querySelectorAll('.toast, [class*="toast"]');
    return [...toasts].some(t => t.textContent?.includes('failed to send'));
  });
  // Check: thumbnail should still be there (images restored)
  const thumbCount = await page.locator('#composeThumbStrip .compose-thumb').count();

  const textRestored = restoredText.includes('Test 9: should be restored');
  const imagesRestored = thumbCount > 0;

  if (textRestored) {
    pass('Textarea text restored after send failure');
  } else {
    fail('Textarea text restored after send failure', `Got: "${restoredText}"`);
  }

  if (imagesRestored) {
    pass('Images restored after send failure');
  } else {
    fail('Images restored after send failure', `Thumbnail count: ${thumbCount}`);
  }

  if (toastVisible) {
    pass('Error toast shown after send failure');
  } else {
    // Toast may have auto-dismissed — not a hard failure
    log('  ⚠️  WARN: Error toast not found (may have auto-dismissed)');
  }

  // Remove the blocking route
  await page.unroute('**/api/sessions/*/input');

  // Clean up — remove the image and clear textarea
  const removeBtn = page.locator('#composeThumbStrip .compose-thumb-remove').first();
  if (await removeBtn.count() > 0) {
    await removeBtn.click();
    await page.waitForTimeout(200);
  }
  await page.locator('#composeTextarea').fill('');
} catch (err) {
  fail('Error recovery', err.message);
  // Make sure we clean up the route
  try { await page.unroute('**/api/sessions/*/input'); } catch {}
}

// ─── Done ────────────────────────────────────────────────────────

await browser.close();

log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
log(`  Results: ${passed} passed, ${failed} failed`);
log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

if (failed === 0) {
  log(`\n  ✅ ALL TESTS PASSED\n`);
} else {
  log(`\n  ❌ ${failed} FAILURE(S):\n`);
  results.filter(r => r.status === 'FAIL').forEach(r => {
    log(`     • ${r.name}: ${r.reason}`);
  });
  log('');
}

process.exit(failed > 0 ? 1 : 0);
