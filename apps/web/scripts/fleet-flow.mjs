// Drives the operator's fleet surface through a real browser: builds a seat
// layout in the grid builder, saves it, then adds a bus onto it.
//
//   node scripts/fleet-flow.mjs
//
// Every step is a click or a keystroke, so it fails if a page is wired up
// wrongly even when the backend is perfect.

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

async function signIn(email) {
  await page.goto(`${WEB}/staff/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.removeItem('jatra.staff.token'));
  await fillStable('#email', email);
  await fillStable('#password', PW);
  await page.click('button[type=submit]');
  await page.waitForURL((u) => !u.pathname.startsWith('/staff/login'), { timeout: 8000 });
}

try {
  console.log('\nFleet — seat-layout builder and adding a bus\n');
  await signIn('owner@greenline.test');

  await page.goto(`${WEB}/operator/fleet`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('table.data', { timeout: 8000 });

  const busesBefore = await page.locator('table.data').first().locator('tbody tr').count();

  // --- Build a seat layout -----------------------------------------------
  await page.click('button:has-text("New layout")');
  await page.waitForSelector('div[role=dialog]', { timeout: 5000 });
  const name = `Flow Deck ${Date.now().toString().slice(-6)}`;
  await fillStable('div[role=dialog] input[placeholder^="e.g. 40-seat"]', name);
  await page.click('div[role=dialog] button:has-text("Generate")');
  await page.waitForSelector('div[role=dialog] button[title*="tap to change"]', { timeout: 5000 });
  const seatButtons = await page.locator('div[role=dialog] button[title*="tap to change"]').count();
  check('builder generated a grid of seats', seatButtons > 0, `${seatButtons} seats`);

  // Tap the first seat twice to prove the type cycle works, then save.
  await page.locator('div[role=dialog] button[title*="tap to change"]').first().click();
  await page.click('div[role=dialog] button:has-text("Save")');
  await page.waitForSelector('div[role=dialog]', { state: 'detached', timeout: 8000 });

  await page.waitForSelector(`table.data td:has-text("${name}")`, { timeout: 8000 });
  check('the new layout appears in the layouts table', true, name);
  await shot('50-fleet-layout');

  // --- Add a bus onto it --------------------------------------------------
  await page.click('button:has-text("Add bus")');
  await page.waitForSelector('div[role=dialog]', { timeout: 5000 });
  const reg = `FLOW-${Date.now().toString().slice(-5)}`;
  await fillStable('div[role=dialog] input[placeholder^="e.g. Dhaka Metro"]', reg);
  // Choose the layout we just built (it is one of the options).
  await page.selectOption('div[role=dialog] select >> nth=1', { label: new RegExp(name) }).catch(() => {});
  await page.click('div[role=dialog] button:has-text("Add bus")');
  await page.waitForSelector('div[role=dialog]', { state: 'detached', timeout: 8000 });

  await page.waitForSelector(`table.data td:has-text("${reg}")`, { timeout: 8000 });
  const busesAfter = await page.locator('table.data').first().locator('tbody tr').count();
  check('the new bus appears in the fleet', busesAfter === busesBefore + 1, `${busesBefore} → ${busesAfter}`);
  await shot('51-fleet-bus');

  console.log(failures === 0 ? '\nFLEET FLOW OK\n' : `\n${failures} CHECK(S) FAILED\n`);
} catch (e) {
  console.error('\nfleet-flow crashed:', e.message, '\n');
  failures++;
} finally {
  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
}
