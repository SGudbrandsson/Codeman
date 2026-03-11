import { chromium } from 'playwright';

const BASE_URL = 'http://localhost:3001';
const TARGET_TAB = 'feat/all-tests';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  // Collect ALL console messages
  const consoleMsgs = [];
  page.on('console', msg => {
    const text = msg.text();
    consoleMsgs.push({ type: msg.type(), text, ts: Date.now() });
    // Print warnings and errors immediately
    if (msg.type() === 'error' || msg.type() === 'warning') {
      console.log(`[CONSOLE ${msg.type().toUpperCase()}] ${text}`);
    }
  });

  // Collect page errors (uncaught exceptions)
  page.on('pageerror', err => {
    console.log(`[PAGE ERROR] ${err.message}`);
    consoleMsgs.push({ type: 'pageerror', text: err.message, ts: Date.now() });
  });

  console.log('=== Loading page ===');
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });

  // Wait for SSE to connect and sessions to load
  await page.waitForTimeout(3000);

  // Check what tabs exist
  const tabs = await page.$$eval('.session-tab', els =>
    els.map(el => ({
      name: el.querySelector('.tab-name')?.textContent?.trim(),
      id: el.getAttribute('data-session-id') || el.getAttribute('onclick')?.match(/'([^']+)'/)?.[1],
      classes: el.className,
    }))
  );
  console.log('=== Session tabs found ===');
  console.log(JSON.stringify(tabs, null, 2));

  // Find the target tab
  const targetTab = tabs.find(t => t.name === TARGET_TAB);
  if (!targetTab) {
    console.log(`ERROR: Tab "${TARGET_TAB}" not found among: ${tabs.map(t => t.name).join(', ')}`);
    await browser.close();
    process.exit(1);
  }

  // First, click on a DIFFERENT tab to make sure we're not already on feat/all-tests
  const otherTab = tabs.find(t => t.name !== TARGET_TAB && !t.classes.includes('active'));
  if (otherTab) {
    console.log(`\n=== Clicking other tab "${otherTab.name}" first ===`);
    const otherEl = await page.locator(`.session-tab:has(.tab-name:text-is("${otherTab.name}"))`).first();
    await otherEl.click();
    await page.waitForTimeout(2000);
  }

  // Clear console messages before the critical click
  consoleMsgs.length = 0;
  console.log(`\n=== About to click "${TARGET_TAB}" tab ===`);

  // Inject performance observer and instrumentation
  await page.addScriptTag({ content: `
    window._longTasks = [];
    window._perfStart = performance.now();
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window._longTasks.push({
          name: entry.name,
          duration: entry.duration,
          startTime: entry.startTime - window._perfStart,
        });
        console.warn('[LONG TASK] ' + entry.duration.toFixed(0) + 'ms at +' + (entry.startTime - window._perfStart).toFixed(0) + 'ms');
      }
    });
    observer.observe({ entryTypes: ['longtask'] });

    // Instrument selectSession to see timing
    const origSelect = window.app.selectSession.bind(window.app);
    window.app.selectSession = async function(id) {
      console.log('[DEBUG] selectSession(' + id + ') START');
      const t0 = performance.now();
      try {
        await origSelect(id);
        console.log('[DEBUG] selectSession completed in ' + (performance.now() - t0).toFixed(0) + 'ms');
      } catch (err) {
        console.error('[DEBUG] selectSession THREW: ' + err.message + '\\n' + err.stack);
      }
    };

    // Instrument chunkedTerminalWrite
    const origChunked = window.app.chunkedTerminalWrite.bind(window.app);
    window.app.chunkedTerminalWrite = async function() {
      const size = arguments[0] && arguments[0].length || 0;
      console.log('[DEBUG] chunkedTerminalWrite(' + (size/1024).toFixed(1) + 'KB) START');
      const t0 = performance.now();
      try {
        await origChunked.apply(this, arguments);
        console.log('[DEBUG] chunkedTerminalWrite completed in ' + (performance.now() - t0).toFixed(0) + 'ms');
      } catch (err) {
        console.error('[DEBUG] chunkedTerminalWrite THREW: ' + err.message);
      }
    };

    // Instrument flushPendingWrites
    const origFlush = window.app.flushPendingWrites.bind(window.app);
    window.app.flushPendingWrites = function() {
      const pending = window.app.pendingWrites ? window.app.pendingWrites.reduce(function(s, w) { return s + w.length; }, 0) : 0;
      if (pending > 1024) {
        console.log('[DEBUG] flushPendingWrites(' + (pending/1024).toFixed(1) + 'KB pending)');
      }
      const t0 = performance.now();
      origFlush();
      const dt = performance.now() - t0;
      if (dt > 5) {
        console.warn('[DEBUG] flushPendingWrites took ' + dt.toFixed(0) + 'ms');
      }
    };

    // Instrument _fullRenderSessionTabs
    const origFullRender = window.app._fullRenderSessionTabs ? window.app._fullRenderSessionTabs.bind(window.app) : null;
    if (origFullRender) {
      window.app._fullRenderSessionTabs = function() {
        console.log('[DEBUG] _fullRenderSessionTabs START');
        const t0 = performance.now();
        origFullRender();
        console.log('[DEBUG] _fullRenderSessionTabs completed in ' + (performance.now() - t0).toFixed(0) + 'ms');
      };
    }
  `});

  // Click the target tab
  const t0 = Date.now();
  console.log(`[TIMING] Click at t=0`);

  const tabEl = await page.locator(`.session-tab:has(.tab-name:text-is("${TARGET_TAB}"))`).first();
  await tabEl.click();

  // Wait and see what happens — give it time to freeze or complete
  for (let i = 1; i <= 20; i++) {
    try {
      // Try a simple page interaction — if page is frozen this will timeout
      await page.locator('body').getAttribute('class', { timeout: 3000 });
      const elapsed = Date.now() - t0;
      if (i <= 3 || i % 5 === 0) {
        console.log(`[TIMING] +${elapsed}ms: page responsive (check ${i})`);
      }
    } catch (err) {
      const elapsed = Date.now() - t0;
      console.log(`[TIMING] +${elapsed}ms: PAGE FROZEN (check ${i}) — ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // Collect results
  let longTasks = [];
  try {
    longTasks = await page.locator('body').getAttribute('class', { timeout: 3000 })
      .then(() => page.$$eval('body', () => window._longTasks));
  } catch {
    console.log('Could not collect long tasks — page may be frozen');
  }

  console.log('\n=== LONG TASKS DETECTED ===');
  if (longTasks.length === 0) {
    console.log('None detected');
  } else {
    for (const task of longTasks) {
      console.log(`  ${task.duration.toFixed(0)}ms at +${task.startTime.toFixed(0)}ms`);
    }
  }

  console.log('\n=== CONSOLE MESSAGES DURING TAB SWITCH ===');
  for (const msg of consoleMsgs) {
    if (msg.text.includes('[DEBUG]') || msg.text.includes('[LONG TASK]') || msg.text.includes('[CRASH-DIAG]') || msg.type === 'error' || msg.type === 'pageerror') {
      console.log(`  [${msg.type}] ${msg.text.slice(0, 500)}`);
    }
  }

  // Take a screenshot after
  await page.screenshot({ path: '/tmp/debug-after-click.png' });
  console.log('\nScreenshot saved to /tmp/debug-after-click.png');

  await browser.close();
})();
