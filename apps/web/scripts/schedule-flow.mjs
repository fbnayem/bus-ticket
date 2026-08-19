// Drives the operator's schedule engine through a real browser: creates a
// recurring schedule and confirms trips are generated, then adds a one-off trip.
//
//   node scripts/schedule-flow.mjs

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

try {
  console.log('\nSchedules — recurring schedule and a one-off trip\n');
  await page.goto(`${WEB}/staff/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.removeItem('jatra.staff.token'));
  await fillStable('#email', 'owner@greenline.test');
  await fillStable('#password', PW);
  await page.click('button[type=submit]');
  await page.waitForURL((u) => !u.pathname.startsWith('/staff/login'), { timeout: 8000 });

  await page.goto(`${WEB}/operator/schedules`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('table.data', { timeout: 8000 });
  const before = await page.locator('table.data tbody tr').count();

  // --- Recurring schedule -------------------------------------------------
  await page.click('button:has-text("New schedule")');
  await page.waitForSelector('div[role=dialog]', { timeout: 5000 });
  // Target the throwaway route so the flow never generates trips onto a real
  // seeded route.
  await page.selectOption('div[role=dialog] select >> nth=0', { label: 'ZZ Flow Route' });
  await page.click('div[role=dialog] button:has-text("Save & generate")');
  await page.waitForSelector('div[role=dialog]', { state: 'detached', timeout: 10000 });

  const flash = await page.locator('.notice-info').innerText().catch(() => '');
  const m = flash.match(/(\d+)\s+trips?\s+generated/i);
  check('a schedule was saved and generated trips', m && Number(m[1]) > 0, flash.trim());
  const after = await page.locator('table.data tbody tr').count();
  check('the schedule appears in the table', after >= before + 1, `${before} → ${after}`);
  await shot('70-schedule');

  // --- One-off trip -------------------------------------------------------
  await page.click('button:has-text("One-off trip")');
  await page.waitForSelector('div[role=dialog]', { timeout: 5000 });
  await page.selectOption('div[role=dialog] select >> nth=0', { label: 'ZZ Flow Route' });
  await page.click('div[role=dialog] button:has-text("Create trip")');
  await page.waitForSelector('div[role=dialog]', { state: 'detached', timeout: 10000 });
  const flash2 = await page.locator('.notice-info').innerText().catch(() => '');
  check('a one-off trip was created with seats', /One-off trip created with \d+ seats/.test(flash2), flash2.trim());
  await shot('71-oneoff');

  console.log(failures === 0 ? '\nSCHEDULE FLOW OK\n' : `\n${failures} CHECK(S) FAILED\n`);
} catch (e) {
  console.error('\nschedule-flow crashed:', e.message, '\n');
  failures++;
} finally {
  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
}
