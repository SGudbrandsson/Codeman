import { chromium } from 'playwright';

const BASE_URL = 'http://localhost:3001';
const TARGET_TAB = 'feat/all-tests';

(async () => {
  // Launch HEADED browser with GPU enabled to reproduce real user conditions
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--enable-gpu-rasterization',
      '--enable-zero-copy',
    ],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  const consoleMsgs = [];
  page.on('console', msg => {
    const text = msg.text();
    consoleMsgs.push({ type: msg.type(), text, ts: Date.now() });
    if (msg.type() === 'error' || msg.type() === 'warning' || text.includes('[CRASH-DIAG]') || text.includes('[LONG TASK]')) {
      console.log(`[CONSOLE ${msg.type().toUpperCase()}] ${text.slice(0, 300)}`);
    }
  });

  page.on('pageerror', err => {
    console.log(`[PAGE ERROR] ${err.message}`);
  });

  console.log('=== Loading page (headed mode) ===');
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(3000);

  // Switch to a different tab first
  const otherTab = await page.locator('.session-tab:not(.active)').first();
  const otherName = await otherTab.locator('.tab-name').textContent();
  console.log(`=== Pre-switching to "${otherName}" ===`);
  await otherTab.click();
  await page.waitForTimeout(2000);

  // Inject PerformanceObserver + detailed instrumentation via addScriptTag
  await page.addScriptTag({ content: [
    'window._longTasks = [];',
    'window._perfStart = performance.now();',
    '',
    'try {',
    '  var obs = new PerformanceObserver(function(list) {',
    '    list.getEntries().forEach(function(entry) {',
    '      var info = { duration: entry.duration, startTime: entry.startTime - window._perfStart };',
    '      window._longTasks.push(info);',
    '      console.warn("[LONG TASK] " + entry.duration.toFixed(0) + "ms at +" + info.startTime.toFixed(0) + "ms");',
    '    });',
    '  });',
    '  obs.observe({ entryTypes: ["longtask"] });',
    '} catch(e) { console.log("PerformanceObserver not available: " + e); }',
    '',
    '// Instrument selectSession',
    'var origSelect = window.app.selectSession.bind(window.app);',
    'window.app.selectSession = async function(id) {',
    '  console.log("[DEBUG] selectSession(" + id.slice(0,8) + ") START");',
    '  var t0 = performance.now();',
    '  try {',
    '    await origSelect(id);',
    '    console.log("[DEBUG] selectSession completed in " + (performance.now() - t0).toFixed(0) + "ms");',
    '  } catch (err) {',
    '    console.error("[DEBUG] selectSession THREW: " + err.message + "\\n" + err.stack);',
    '  }',
    '};',
    '',
    '// Instrument chunkedTerminalWrite',
    'var origChunked = window.app.chunkedTerminalWrite.bind(window.app);',
    'window.app.chunkedTerminalWrite = async function() {',
    '  var size = arguments[0] ? arguments[0].length : 0;',
    '  console.log("[DEBUG] chunkedTerminalWrite(" + (size/1024).toFixed(1) + "KB) START");',
    '  var t0 = performance.now();',
    '  try {',
    '    await origChunked.apply(window.app, arguments);',
    '    console.log("[DEBUG] chunkedTerminalWrite completed in " + (performance.now() - t0).toFixed(0) + "ms");',
    '  } catch (err) {',
    '    console.error("[DEBUG] chunkedTerminalWrite THREW: " + err.message);',
    '    throw err;',
    '  }',
    '};',
    '',
    '// Instrument _fullRenderSessionTabs',
    'if (window.app._fullRenderSessionTabs) {',
    '  var origFull = window.app._fullRenderSessionTabs.bind(window.app);',
    '  window.app._fullRenderSessionTabs = function() {',
    '    var t0 = performance.now();',
    '    origFull();',
    '    console.log("[DEBUG] _fullRenderSessionTabs: " + (performance.now() - t0).toFixed(0) + "ms");',
    '  };',
    '}',
    '',
    'console.log("[DEBUG] Instrumentation installed");',
  ].join('\n') });

  consoleMsgs.length = 0;

  console.log('\n=== Clicking feat/all-tests tab (headed, GPU active) ===');
  const t0 = Date.now();

  const tabEl = await page.locator('.session-tab:has(.tab-name:text-is("' + TARGET_TAB + '"))').first();
  await tabEl.click();

  // Monitor responsiveness
  for (let i = 1; i <= 30; i++) {
    try {
      await page.locator('body').getAttribute('class', { timeout: 5000 });
      const elapsed = Date.now() - t0;
      if (i <= 5 || i % 5 === 0) {
        console.log('[TIMING] +' + elapsed + 'ms: responsive (check ' + i + ')');
      }
    } catch (err) {
      const elapsed = Date.now() - t0;
      console.log('[TIMING] +' + elapsed + 'ms: FROZEN (check ' + i + ') — ' + err.message.slice(0, 100));
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // Collect long task data
  let longTasks = [];
  try {
    longTasks = await page.$$eval('body', () => window._longTasks || []);
  } catch { console.log('Could not collect performance data'); }

  console.log('\n=== LONG TASKS ===');
  for (const t of longTasks) {
    console.log('  ' + t.duration.toFixed(0) + 'ms at +' + t.startTime.toFixed(0) + 'ms');
  }
  if (longTasks.length === 0) console.log('  None');

  console.log('\n=== KEY CONSOLE MESSAGES ===');
  for (const msg of consoleMsgs) {
    if (msg.text.includes('[DEBUG]') || msg.text.includes('[LONG TASK]') || msg.text.includes('[CRASH-DIAG]') || msg.type === 'error' || msg.type === 'pageerror') {
      console.log('  [' + msg.type + '] ' + msg.text.slice(0, 500));
    }
  }

  await page.screenshot({ path: '/tmp/debug-headed-after-click.png' });
  console.log('\nScreenshot: /tmp/debug-headed-after-click.png');

  await browser.close();
})();
