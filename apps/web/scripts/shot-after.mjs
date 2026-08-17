// Photograph the after-the-ticket screens. Not a test — it asserts nothing.
//   node scripts/shot-after.mjs <outDir> <pnr> [lang]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const dir = process.argv[2] ?? 'artifacts/screenshots';
const pnr = process.argv[3];
const lang = process.argv[4] ?? 'bn';
const base = 'http://localhost:3000';
mkdirSync(dir, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true,
});
await ctx.addCookies([{ name: 'jatra.lang', value: lang, url: base }]);
const page = await ctx.newPage();

const snap = async (name, path, wait) => {
  await page.goto(base + path, { waitUntil: 'networkidle' });
  if (wait) await page.waitForSelector(wait, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${dir}/a-${lang}-${name}.png`, fullPage: true });
  console.log(`  ✓ ${name}`);
};

await snap('1-find', '/manage', '.numplate');
await snap('2-booking', `/manage/${pnr}`, '.ladder');
await snap('3-reschedule', `/manage/${pnr}/reschedule`, '.pick');
await snap('4-tracking', `/tracking/${pnr}`, '.journey');
await snap('5-offers', '/offers', '.coupon');
await snap('6-support', '/support', '.qa');
await snap('7-login', '/login', '#phone');

await browser.close();
console.log('done');
