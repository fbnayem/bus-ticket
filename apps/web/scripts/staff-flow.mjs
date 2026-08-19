// Drives the operator's staff and rostering surfaces through a real browser:
// hires a new account, confirms it lands, then rosters them onto a trip and
// takes them off again.
//
//   node scripts/staff-flow.mjs

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

const name = `Roster Tester ${Date.now().toString().slice(-5)}`;
const email = `crewflow-${Date.now().toString().slice(-6)}@greenline.test`;

try {
  console.log('\nStaff & rostering — hire, then crew a trip\n');
  await page.goto(`${WEB}/staff/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.removeItem('jatra.staff.token'));
  await fillStable('#email', 'owner@greenline.test');
  await fillStable('#password', PW);
  await page.click('button[type=submit]');
  await page.waitForURL((u) => !u.pathname.startsWith('/staff/login'), { timeout: 8000 });

  // --- Hire ----------------------------------------------------------------
  await page.goto(`${WEB}/operator/staff`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('table.data', { timeout: 8000 });
  await page.click('button:has-text("New staff")');
  await page.waitForSelector('div[role=dialog]', { timeout: 5000 });
  await fillStable('div[role=dialog] input[placeholder="name@company.test"]', email);
  await page.locator('div[role=dialog] label:has-text("Full name") input').fill(name);
  await page.locator('div[role=dialog] label:has-text("Initial password") input').fill('changeme-please');
  await page.click('div[role=dialog] button:has-text("driver")');
  await page.click('div[role=dialog] button:has-text("Create account")');
  await page.waitForSelector('div[role=dialog]', { state: 'detached', timeout: 8000 });

  await page.waitForSelector(`table.data td:has-text("${email}")`, { timeout: 8000 });
  check('the new account appears in the staff table', true, email);
  await shot('80-staff');

  // --- Roster onto a trip --------------------------------------------------
  await page.goto(`${WEB}/operator/trips`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('table.data', { timeout: 8000 });
  const trips = await page.locator('table.data tbody tr').count();
  if (trips === 0) { check('there is a trip to crew', false, 'no trips today'); throw new Error('no trips'); }

  await page.locator('table.data tbody tr').first().locator('button:has-text("Crew")').click();
  await page.waitForSelector('div[role=dialog]', { timeout: 5000 });
  // The new hire is the selected option; add as HELPER.
  await page.selectOption('div[role=dialog] select >> nth=0', { label: name }).catch(() => {});
  await page.selectOption('div[role=dialog] select >> nth=1', { label: 'helper' }).catch(() => {});
  await page.click('div[role=dialog] button:has-text("Add")');
  await page.waitForSelector(`div[role=dialog] li:has-text("${name}")`, { timeout: 6000 });
  check('the hire is rostered onto the trip', true, `${name} as helper`);
  await shot('81-roster');

  // Take them off again, to leave the seed as we found it.
  await page.locator(`div[role=dialog] li:has-text("${name}") button[aria-label="Remove"]`).click();
  await page.waitForSelector(`div[role=dialog] li:has-text("${name}")`, { state: 'detached', timeout: 6000 });
  check('the hire can be removed from the roster', true);

  console.log(failures === 0 ? '\nSTAFF FLOW OK\n' : `\n${failures} CHECK(S) FAILED\n`);
} catch (e) {
  console.error('\nstaff-flow crashed:', e.message, '\n');
  failures++;
} finally {
  await browser.close();
  console.log(`CLEANUP_EMAIL=${email}`);
  process.exit(failures === 0 ? 0 : 1);
}
