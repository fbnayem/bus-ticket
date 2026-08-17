// Walk the funnel and photograph it. Not a test — it asserts nothing.
import { chromium } from 'playwright';

const dir = process.argv[2];
const lang = process.argv[3] ?? 'bn';
const base = 'http://localhost:3000';
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true,
});
await ctx.addCookies([{ name: 'jatra.lang', value: lang, url: base }]);
const page = await ctx.newPage();

const snap = async (n) => {
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${dir}/f-${lang}-${n}.png` });
  console.log(`  ✓ ${n}`);
};

await page.goto(`${base}/search?from=Dhaka&to=Chattogram`, { waitUntil: 'networkidle' });
await page.waitForSelector('article[data-trip]', { timeout: 25000 });
await snap('2-results');

await page.locator('article[data-trip] a').first().click();
await page.waitForURL('**/trips/**');
await page.waitForSelector('.bus button.seat', { timeout: 25000 });
const free = page.locator('.bus button.seat[data-state="free"]');
await free.nth(0).click();
await free.nth(0).click();
await snap('3-seats');

await page.locator('.actionbar button').click();
await page.waitForURL('**/checkout**', { timeout: 25000 });
await page.waitForSelector('input[id^="name-"]', { timeout: 25000 });
const names = page.locator('input[id^="name-"]');
await names.nth(0).fill('রহিম উদ্দিন');
await names.nth(1).fill('ফাতেমা বেগম');
await page.fill('#phone', '01700000000');
await snap('4-checkout');

await page.locator('.actionbar button').click();
await page.waitForURL('**/payment/**', { timeout: 25000 });
await page.waitForSelector('.fare-plate', { timeout: 25000 });
await snap('5-payment');

await browser.close();
console.log('done');
