// Drives the operator's route builder through a real browser: creates a route
// by searching for stops and ordering them, then confirms it lands in the list.
//
//   node scripts/route-flow.mjs

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const WEB = process.env.WEB ?? 'http://localhost:3000';
const PW = 'Jatra#2026';
const SHOTS = 'artifacts/screenshots';
mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
};

const browser = await chromium.launch();
const page = await browser.newPage();
const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}.png` });

async function fillStable(selector, value) {
  for (let i = 0; i < 5; i++) {
    await page.fill(selector, value);
    if ((await page.inputValue(selector)) === value) return;
    await page.waitForTimeout(150);
  }
}

async function addStop(term) {
  await fillStable('div[role=dialog] input[placeholder^="Add a stop"]', term);
  await page.waitForSelector('div[role=dialog] .card button', { timeout: 5000 });
  await page.locator('div[role=dialog] .card button').first().click();
}

try {
  console.log('\nRoutes — building a route from stops\n');
  await page.goto(`${WEB}/staff/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.removeItem('jatra.staff.token'));
  await fillStable('#email', 'owner@greenline.test');
  await fillStable('#password', PW);
  await page.click('button[type=submit]');
  await page.waitForURL((u) => !u.pathname.startsWith('/staff/login'), { timeout: 8000 });

  await page.goto(`${WEB}/operator/routes`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('table.data', { timeout: 8000 });
  const before = await page.locator('table.data').first().locator('tbody tr').count();

  await page.click('button:has-text("New route")');
  await page.waitForSelector('div[role=dialog]', { timeout: 5000 });
  const name = `Flow Route ${Date.now().toString().slice(-6)}`;
  await fillStable('div[role=dialog] input[placeholder^="e.g. Dhaka"]', name);

  await addStop('Dhaka');
  await addStop('Chattogram');
  const stopRows = await page.locator('div[role=dialog] ol li').count();
  check('two stops were added and ordered', stopRows === 2, `${stopRows} stops`);
  await shot('60-route-builder');

  await page.click('div[role=dialog] button:has-text("Save route")');
  await page.waitForSelector('div[role=dialog]', { state: 'detached', timeout: 8000 });

  await page.waitForSelector(`table.data td:has-text("${name}")`, { timeout: 8000 });
  const after = await page.locator('table.data').first().locator('tbody tr').count();
  check('the new route appears in the routes table', after === before + 1, `${before} → ${after}`);
  await shot('61-route-saved');

  console.log(failures === 0 ? '\nROUTE FLOW OK\n' : `\n${failures} CHECK(S) FAILED\n`);
} catch (e) {
  console.error('\nroute-flow crashed:', e.message, '\n');
  failures++;
} finally {
  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
}
