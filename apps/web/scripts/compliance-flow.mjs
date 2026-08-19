// Drives the operator's compliance surface through a real browser: reads the
// expiry alerts, adds a document, confirms it lands, then removes it.
//
//   node scripts/compliance-flow.mjs

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

const number = `FLOW-TAX-${Date.now().toString().slice(-6)}`;

try {
  console.log('\nCompliance — alerts, add a document, remove it\n');
  await page.goto(`${WEB}/staff/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.removeItem('jatra.staff.token'));
  await fillStable('#email', 'owner@greenline.test');
  await fillStable('#password', PW);
  await page.click('button[type=submit]');
  await page.waitForURL((u) => !u.pathname.startsWith('/staff/login'), { timeout: 8000 });

  await page.goto(`${WEB}/operator/compliance`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('table.data', { timeout: 8000 });

  const banner = await page.locator('.card').first().innerText().catch(() => '');
  check('the expiry-alert banner shows what is lapsing', /expired|expiring/i.test(banner), banner.split('\n')[0]);
  const expiredPills = await page.locator('table.data .pill-danger').count();
  check('at least one document reads as expired', expiredPills >= 1, `${expiredPills} expired`);
  await shot('90-compliance');

  const before = await page.locator('table.data tbody tr').count();

  // Add a tax token for a bus, expiring next year.
  await page.click('button:has-text("Add document")');
  await page.waitForSelector('div[role=dialog]', { timeout: 5000 });
  await page.selectOption('div[role=dialog] label:has-text("Document") select', 'TAX_TOKEN');
  await page.locator('div[role=dialog] label:has-text("Number") input').fill(number);
  await page.locator('div[role=dialog] label:has-text("Expires") input').fill('2027-12-31');
  await page.click('div[role=dialog] button:has-text("Save document")');
  await page.waitForSelector('div[role=dialog]', { state: 'detached', timeout: 8000 });

  await page.waitForSelector(`table.data td:has-text("${number}")`, { timeout: 8000 });
  const after = await page.locator('table.data tbody tr').count();
  check('the new document appears in the list', after === before + 1, `${before} → ${after}`);
  await shot('91-compliance-added');

  // Remove it again to leave the seed as we found it.
  const row = page.locator(`table.data tbody tr:has-text("${number}")`);
  await row.locator('button:has-text("Delete")').click();
  await page.waitForSelector(`table.data td:has-text("${number}")`, { state: 'detached', timeout: 8000 });
  check('the document can be removed', true);

  console.log(failures === 0 ? '\nCOMPLIANCE FLOW OK\n' : `\n${failures} CHECK(S) FAILED\n`);
} catch (e) {
  console.error('\ncompliance-flow crashed:', e.message, '\n');
  failures++;
} finally {
  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
}
