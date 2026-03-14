import { chromium } from 'playwright';

const BASE = 'http://localhost:3002';

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const results = [];

  function pass(name) { results.push({ name, status: 'PASS' }); console.log(`PASS: ${name}`); }
  function fail(name, err) { results.push({ name, status: 'FAIL', error: String(err) }); console.log(`FAIL: ${name} — ${err}`); }

  try {
    // Check if sessions exist via API
    const sessionsRes = await fetch(`${BASE}/api/sessions`);
    const sessions = await sessionsRes.json();
    const hasSessions = Array.isArray(sessions) && sessions.length > 0;
    console.log(`Sessions found: ${hasSessions ? sessions.length : 0}`);

    // Load the page
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);

    // 1. Check #sessionIndicatorBar exists in DOM
    const bar = await page.$('#sessionIndicatorBar');
    if (bar) {
      pass('#sessionIndicatorBar exists in DOM');
    } else {
      fail('#sessionIndicatorBar exists in DOM', 'Element not found');
      await browser.close();
      process.exit(1);
    }

    // 2. Check visibility based on sessions
    const display = await page.locator('#sessionIndicatorBar').evaluate(el => getComputedStyle(el).display);
    if (hasSessions) {
      if (display === 'flex') {
        pass('Bar visible (display:flex) when sessions exist');
      } else {
        fail('Bar visible (display:flex) when sessions exist', `display is "${display}"`);
      }
    } else {
      if (display === 'none') {
        pass('Bar hidden (display:none) when no sessions');
      } else {
        fail('Bar hidden (display:none) when no sessions', `display is "${display}"`);
      }
    }

    // 3. Check CSS properties: height <= 28px on desktop
    const height = await page.locator('#sessionIndicatorBar').evaluate(el => {
      return parseFloat(getComputedStyle(el).height);
    });
    if (height <= 28) {
      pass(`Height is ${height}px (<=28px on desktop)`);
    } else {
      fail(`Height <= 28px on desktop`, `Height is ${height}px`);
    }

    // 4. Check font-size is 0.75rem / 12px
    const fontSize = await page.locator('#sessionIndicatorBar').evaluate(el => {
      return getComputedStyle(el).fontSize;
    });
    if (fontSize === '12px' || fontSize === '0.75rem') {
      pass(`Font-size is ${fontSize}`);
    } else {
      fail('Font-size is 0.75rem / 12px', `Font-size is "${fontSize}"`);
    }

    // 5. Check child elements exist
    const childSelectors = ['.sib-status-dot', '.sib-session-name', '.sib-sep', '.sib-project'];
    for (const sel of childSelectors) {
      const count = await page.locator(`#sessionIndicatorBar ${sel}`).count();
      if (count > 0) {
        pass(`Child element ${sel} exists`);
      } else {
        fail(`Child element ${sel} exists`, 'Not found');
      }
    }

    // 6. If bar is visible, check that session name has content
    if (display === 'flex') {
      const sessionName = await page.locator('#sibSessionName').textContent();
      if (sessionName && sessionName.trim().length > 0) {
        pass(`Session name has content: "${sessionName.trim()}"`);
      } else {
        fail('Session name has content', 'Text is empty');
      }

      const project = await page.locator('#sibProject').textContent();
      if (project && project.trim().length > 0) {
        pass(`Project has content: "${project.trim()}"`);
      } else {
        fail('Project has content', 'Text is empty');
      }

      // Check status dot has a class (idle or busy)
      const dotClasses = await page.locator('#sibStatusDot').getAttribute('class');
      if (dotClasses && (dotClasses.includes('idle') || dotClasses.includes('busy'))) {
        pass(`Status dot has state class: "${dotClasses}"`);
      } else {
        fail('Status dot has idle/busy class', `Classes: "${dotClasses}"`);
      }
    }

  } catch (e) {
    fail('Unexpected error', e.message);
  }

  await browser.close();

  // Summary
  console.log('\n=== SUMMARY ===');
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  console.log(`${passed} passed, ${failed} failed out of ${results.length} checks`);

  if (failed > 0) {
    console.log('\nFailed checks:');
    results.filter(r => r.status === 'FAIL').forEach(r => console.log(`  - ${r.name}: ${r.error}`));
    process.exit(1);
  }
  process.exit(0);
}

run();
