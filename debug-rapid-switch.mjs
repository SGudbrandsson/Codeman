import { chromium } from 'playwright';

const BASE_URL = 'http://localhost:3001';
const TARGET_TAB = 'feat/all-tests';

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  const consoleMsgs = [];
  page.on('console', msg => {
    const text = msg.text();
    consoleMsgs.push({ type: msg.type(), text, ts: Date.now() });
    if (msg.type() === 'error' || text.includes('[CRASH-DIAG]') || text.includes('LONG TASK') || text.includes('FROZE') || text.includes('Error') || text.includes('Uncaught')) {
      console.log(`[${msg.type().toUpperCase()}] ${text.slice(0, 300)}`);
    }
  });
  page.on('pageerror', err => {
    console.log(`[PAGE ERROR] ${err.message}`);
  });

  console.log('=== Loading page ===');
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(4000);

  // Test 1: Click feat/all-tests when it's already active
  console.log('\n=== TEST 1: Click feat/all-tests to make it active ===');
  const targetTabLoc = page.locator('.session-tab:has(.tab-name:text-is("' + TARGET_TAB + '"))').first();
  await targetTabLoc.click();
  await page.waitForTimeout(2000);

  console.log('=== TEST 1b: Click feat/all-tests AGAIN (already active) ===');
  const t1 = Date.now();
  consoleMsgs.length = 0;
  await targetTabLoc.click();
  await page.waitForTimeout(2000);
  console.log(`Elapsed: ${Date.now() - t1}ms`);
  for (const msg of consoleMsgs.filter(m => m.text.includes('[CRASH-DIAG]') || m.type === 'error')) {
    console.log(`  ${msg.text.slice(0, 200)}`);
  }

  // Test 2: Rapid switching between tabs
  console.log('\n=== TEST 2: Rapid switching (5x) ===');
  const otherTab = page.locator('.session-tab:not(.active)').first();
  consoleMsgs.length = 0;
  const t2 = Date.now();

  for (let i = 0; i < 5; i++) {
    await otherTab.click({ delay: 0 });
    await page.waitForTimeout(50);
    await targetTabLoc.click({ delay: 0 });
    await page.waitForTimeout(50);
  }

  // Check responsiveness after rapid switching
  for (let i = 1; i <= 10; i++) {
    try {
      await page.locator('body').getAttribute('class', { timeout: 3000 });
      if (i <= 3 || i === 10) console.log(`  +${Date.now()-t2}ms: responsive (check ${i})`);
    } catch (err) {
      console.log(`  +${Date.now()-t2}ms: FROZEN (check ${i})`);
    }
    await page.waitForTimeout(500);
  }

  // Print debug messages from rapid switch
  console.log('\n  Console during rapid switch:');
  for (const msg of consoleMsgs.filter(m => m.text.includes('[CRASH-DIAG]') || m.text.includes('Error') || m.type === 'error')) {
    console.log(`  ${msg.text.slice(0, 200)}`);
  }

  // Test 3: Click feat/all-tests tab while session is sending data
  // Simulate by sending a prompt first
  console.log('\n=== TEST 3: Switch away, wait, switch back ===');
  await otherTab.click();
  await page.waitForTimeout(1000);
  consoleMsgs.length = 0;
  const t3 = Date.now();
  await targetTabLoc.click();

  for (let i = 1; i <= 10; i++) {
    try {
      await page.locator('body').getAttribute('class', { timeout: 3000 });
      if (i <= 3 || i === 10) console.log(`  +${Date.now()-t3}ms: responsive (check ${i})`);
    } catch (err) {
      console.log(`  +${Date.now()-t3}ms: FROZEN (check ${i})`);
    }
    await page.waitForTimeout(500);
  }

  // Test 4: Network throttle to simulate Tailscale latency
  console.log('\n=== TEST 4: With network throttle (simulating Tailscale) ===');
  const cdpSession = await context.newCDPSession(page);
  await cdpSession.send('Network.enable');
  await cdpSession.send('Network.emulateNetworkConditions', {
    offline: false,
    downloadThroughput: 1024 * 1024, // 1Mbps
    uploadThroughput: 512 * 1024,    // 512Kbps
    latency: 50,                     // 50ms RTT
  });

  await otherTab.click();
  await page.waitForTimeout(1500);
  consoleMsgs.length = 0;
  const t4 = Date.now();
  console.log('  Clicking with 50ms latency + throttled bandwidth...');
  await targetTabLoc.click();

  for (let i = 1; i <= 15; i++) {
    try {
      await page.locator('body').getAttribute('class', { timeout: 5000 });
      if (i <= 5 || i % 5 === 0) console.log(`  +${Date.now()-t4}ms: responsive (check ${i})`);
    } catch (err) {
      console.log(`  +${Date.now()-t4}ms: FROZEN (check ${i})`);
    }
    await page.waitForTimeout(500);
  }

  // Disable throttle
  await cdpSession.send('Network.emulateNetworkConditions', {
    offline: false, downloadThroughput: -1, uploadThroughput: -1, latency: 0,
  });

  console.log('\n=== TEST 4 console during throttled switch: ===');
  for (const msg of consoleMsgs.filter(m => m.text.includes('[CRASH-DIAG]') || m.type === 'error' || m.text.includes('LONG TASK'))) {
    console.log(`  ${msg.text.slice(0, 200)}`);
  }

  await page.screenshot({ path: '/tmp/debug-rapid-switch.png' });
  console.log('\nScreenshot: /tmp/debug-rapid-switch.png');

  await browser.close();
})();
