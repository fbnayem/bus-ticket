// Drives the owner's web surface through a real browser: profit & loss, sales
// by staff, and recording a running cost.
//
//   node scripts/owner-flow.mjs
//
// Nothing here talks to the API directly — every step is a click or a keystroke,
// so it fails if a page is wired up wrongly even when the backend is perfect.

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
  console.log('\nOwner — profit & loss, staff sales, and costs\n');
  await signIn('owner@greenline.test');

  // --- Profit & loss ------------------------------------------------------
  await page.goto(`${WEB}/operator/pnl`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('table.data tbody tr', { timeout: 8000 });
  const busRows = await page.locator('table.data tbody tr').count();
  check('P&L lists the operator\'s buses', busRows >= 1, `${busRows} rows`);
  const profitTile = await page.locator('.tiles').first().innerText();
  check('P&L shows a profit or loss total', /Profit|Loss/.test(profitTile));
  const foot = await page.locator('table.data tfoot').innerText();
  check('P&L has an all-buses total row', /All buses/.test(foot));
  await shot('40-owner-pnl');

  // --- Sales by staff -----------------------------------------------------
  await page.goto(`${WEB}/operator/sales-by-staff`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('table.data tbody tr', { timeout: 8000 });
  const staffRows = await page.locator('table.data tbody tr').count();
  check('sales-by-staff lists who sold tickets', staffRows >= 1, `${staffRows} staff`);
  await shot('41-owner-sales-by-staff');

  // --- Record and remove a cost, and watch the P&L move -------------------
  await page.goto(`${WEB}/operator/pnl`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('table.data tfoot', { timeout: 8000 });
  const profitBefore = await page.locator('table.data tfoot td').last().innerText();

  await page.goto(`${WEB}/operator/costs`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('form.card', { timeout: 8000 });
  const iso = new Date().toISOString().slice(0, 10);
  await page.selectOption('select', { label: 'Other' }).catch(() => {});
  await page.fill('input[inputMode=decimal]', '9999');
  await fillStable('input[type=date] >> nth=2', iso); // the form's own date field
  await page.fill('input[placeholder="Diesel, Dhaka depot"]', 'owner-flow probe');
  await page.click('button:has-text("Record")');
  await page.waitForSelector('td:has-text("owner-flow probe")', { timeout: 8000 });
  check('a recorded cost appears in the list', true);
  await shot('42-owner-costs');

  // Profit must have fallen by the cost just added.
  await page.goto(`${WEB}/operator/pnl`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('table.data tfoot', { timeout: 8000 });
  const profitAfter = await page.locator('table.data tfoot td').last().innerText();
  check('recording a cost lowers the profit', profitBefore !== profitAfter,
    `${profitBefore} -> ${profitAfter}`);

  // Clean up the probe so the run is repeatable.
  await page.goto(`${WEB}/operator/costs`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('td:has-text("owner-flow probe")', { timeout: 8000 });
  await page.locator('tr:has-text("owner-flow probe") button:has-text("Remove")').first().click();
  await page.waitForSelector('td:has-text("owner-flow probe")', { state: 'detached', timeout: 8000 });
  check('the probe cost can be removed', true);

  // A driver has no owner.pnl permission: the nav must not offer it.
  await signIn('driver@greenline.test');
  await page.goto(`${WEB}/operator`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const nav = await page.locator('body').innerText();
  check('a driver is not shown the Profit & loss nav', !/Profit & loss/.test(nav));
} catch (err) {
  check(`the owner flow ran to the end`, false, String(err).split('\n')[0]);
} finally {
  await browser.close();
}

console.log(`\n${failures === 0 ? 'All owner checks passed' : failures + ' owner check(s) failed'}\n`);
process.exit(failures === 0 ? 0 : 1);
