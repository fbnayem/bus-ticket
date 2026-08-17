// Drives a complete passenger booking through the real UI in a real browser.
//   node scripts/browser-flow.mjs
//
// Nothing here talks to the API directly — every step is a click or a keystroke,
// so this fails if the UI is wired up wrongly even when the backend is perfect.

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const WEB = process.env.WEB ?? 'http://localhost:3000';
const SHOTS = 'artifacts/screenshots';
mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
// Pin the interface language. These checks assert on English copy, and the
// site now defaults to Bangla — so without this the suite would be testing a
// translation it never claimed to. A Bangla pass is its own run, not a side
// effect of whichever default happens to be in force.
await ctx.addCookies([{ name: 'jatra.lang', value: 'en', url: WEB }]);
const page = await ctx.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const shot = (name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

// A fresh mobile number per run.
//
// This used to be the literal 01700000000 in three places, which made the suite
// fail on its sixth run inside five minutes — not because anything was broken,
// but because the OTP endpoint rate-limits a number after five codes and the
// harness kept asking for a sixth. A test that goes red from being run is a
// test people learn to ignore.
//
// The number still has to be the SAME on both sides of the run: the booking is
// made as a guest against it, and step 13 signs in on it to prove the guest
// booking is claimed. One value, generated once, used in both places.
const PHONE = '017' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
const PHONE_E164 = '+880' + PHONE.slice(1);
console.log(`passenger for this run: ${PHONE}`);

try {
  console.log('\n=== 1. HOME ===');
  await page.goto(WEB, { waitUntil: 'networkidle' });
  check('home renders', await page.locator('h1').first().isVisible());
  check('search form present', await page.locator('#from').isVisible());
  await shot('01-home');

  console.log('\n=== 2. SEARCH ===');
  const date = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10);
  await page.fill('#from', 'Dhaka');
  await page.fill('#to', 'ctg');               // alias must resolve server-side
  await page.fill('#date-full', date);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/search**');
  await page.waitForSelector('article[data-trip]', { timeout: 20000 });
  const cards = await page.locator('article[data-trip]').count();
  check('results rendered', cards >= 4, `${cards} departures`);
  check('alias resolved in heading', (await page.locator('h1').first().innerText()).includes('Chattogram'));
  await shot('02-search');

  console.log('\n=== 3. FILTER + SORT ===');
  // The filters are toggle chips now, not native checkboxes — a pressed button
  // rather than a label-and-input pair, so this asserts aria-pressed too.
  const acChip = page.getByRole('button', { name: 'AC only', exact: true });
  await acChip.click();
  check('AC chip reports itself pressed', await acChip.getAttribute('aria-pressed') === 'true');
  await page.waitForTimeout(300);
  const acCards = await page.locator('article[data-trip]').count();
  check('AC filter narrows results', acCards > 0 && acCards <= cards, `${acCards} of ${cards}`);
  await page.selectOption('#sort', 'price');
  await page.waitForTimeout(300);
  const prices = await page.locator('.br-fare').allInnerTexts();
  const nums = prices.map((p) => Number(p.replace(/[^\d]/g, '')));
  check('price sort ascending', nums.every((v, i) => i === 0 || nums[i - 1] <= v), nums.join(' ≤ '));
  await shot('03-filtered');

  console.log('\n=== 4. SEAT SELECTION ===');
  await page.locator('article[data-trip] a:has-text("Select seats")').first().click();
  await page.waitForURL('**/trips/**');
  const tripUrl = page.url();
  await page.waitForSelector('.bus button.seat', { timeout: 20000 });
  const seatCount = await page.locator('.bus button.seat').count();
  check('seat map rendered', seatCount > 0, `${seatCount} seats`);

  const free = page.locator('.bus button.seat[data-state="free"]');
  check('free seats available', (await free.count()) >= 2);
  const seatA = await free.nth(0).innerText();
  const seatB = await free.nth(1).innerText();
  await free.nth(0).click();
  await free.nth(0).click();  // list re-filters after the first click
  await page.waitForTimeout(200);
  const selectedCount = await page.locator('.bus button.seat[data-state="selected"]').count();
  check('seats select', selectedCount === 2, `picked ${seatA}, ${seatB}`);
  check('total shown', (await page.locator('aside dd').last().innerText()).includes('৳'));
  await shot('04-seatmap');

  console.log('\n=== 5. HOLD + CHECKOUT ===');
  await page.click('aside button:has-text("Continue")');
  await page.waitForURL('**/checkout**', { timeout: 20000 });
  check('reached checkout', page.url().includes('/checkout'));
  // Wait for the client render, not just the URL change — the countdown and the
  // passenger fields are drawn after the hold is read back.
  await page.waitForSelector('.countdown', { timeout: 20000 });
  check('hold countdown running', await page.locator('.countdown').isVisible());
  const names = page.locator('input[id^="name-"]');
  check('one name field per seat', (await names.count()) === 2);
  await names.nth(0).fill('Rahim Uddin');
  await names.nth(1).fill('Fatema Begum');
  // The contact number is no longer pre-filled with a developer's placeholder,
  // so it has to be typed — which is the point. This step passing without it
  // was the bug: a real passenger would have sent their ticket to +8801700000000.
  check('contact number starts empty', (await page.inputValue('#phone')) === '');
  // The same number this run signs in with at step 13 — the guest booking is
  // claimed by phone, so the two must agree for that assertion to mean anything.
  await page.fill('#phone', PHONE);
  await page.fill('#coupon', 'EIDSAFAR');
  await shot('05-checkout');

  console.log('\n=== 6. PAYMENT ===');
  await page.click('button[type="submit"]:has-text("Continue to payment")');
  await page.waitForURL('**/payment/**', { timeout: 20000 });
  // Wait for the client render, not just the URL change.
  await page.waitForSelector('text=Choose how to pay', { timeout: 20000 });
  check('payment page reached', await page.locator('text=Choose how to pay').isVisible());
  const pnr = new URL(page.url()).searchParams.get('pnr');
  check('PNR issued', !!pnr && pnr.length === 6, pnr ?? '');
  await shot('06-payment');

  await page.click('label:has-text("bKash")');
  await page.click('button:has-text("Pay ")');
  await page.waitForURL('**/payment/sandbox**', { timeout: 20000 });
  check('sandbox provider reached', await page.locator('text=Test payment screen').isVisible());
  await shot('07-sandbox');

  console.log('\n=== 7. CONFIRMATION ===');
  await page.click('button:has-text("Approve payment")');
  await page.waitForURL('**/confirmation/**', { timeout: 25000 });
  await page.waitForSelector('text=Booking confirmed', { timeout: 25000 });
  check('booking confirmed in UI', await page.locator('text=Booking confirmed').isVisible());
  check('PNR displayed', (await page.locator('.pnr').innerText()).trim() === pnr);
  await shot('08-confirmation');

  console.log('\n=== 8. TICKET + QR ===');
  await page.click('a:has-text("View ticket")');
  await page.waitForURL('**/tickets/**');
  await page.waitForSelector('.qr-box svg', { timeout: 20000 });
  const qrPaths = await page.locator('.qr-box svg path, .qr-box svg rect').count();
  check('QR code actually rendered', qrPaths > 0, `${qrPaths} svg nodes`);
  const rows = await page.locator('table.data tbody tr').count();
  check('one ticket row per passenger', rows === 2, `${rows} rows`);
  await shot('09-ticket');

  console.log('\n=== 9. TRACKING ===');
  await page.goto(`${WEB}/tracking/${pnr}`, { waitUntil: 'networkidle' });
  check('tracking renders', await page.locator('text=Where is my bus?').isVisible());
  check('simulated source disclosed', await page.locator('text=Estimated from the timetable').isVisible());
  await shot('10-tracking');

  console.log('\n=== 10. MANAGE + CANCEL ===');
  await page.goto(`${WEB}/manage/${pnr}`, { waitUntil: 'networkidle' });
  check('manage page renders', await page.locator(`text=${pnr}`).first().isVisible());
  // A stable hook, not the word "back". The previous selector was `text=back`,
  // which matched whatever sentence happened to contain those four letters and
  // would have gone green against a page with no refund figure on it at all.
  const refundText = await page.locator('[data-testid="refund-quote"]').innerText().catch(() => '');
  check('refund quote shown', /৳/.test(refundText), refundText.replace(/\n/g, ' ').trim());
  await shot('11-manage');

  await page.click('button:has-text("Cancel booking")');
  await page.click('button:has-text("Yes, cancel")');
  await page.waitForSelector('text=Cancelled.', { timeout: 20000 });
  check('cancellation confirmed in UI', await page.locator('text=Cancelled.').isVisible());
  await shot('12-cancelled');

  console.log('\n=== 11. CANCELLED SEATS RETURN TO SALE ===');
  // The seats we just cancelled must be selectable again on the same trip —
  // a cancelled seat that stays dead until departure is lost revenue.
  await page.goto(tripUrl, { waitUntil: 'networkidle' });
  await page.waitForSelector('.bus button.seat', { timeout: 20000 });
  const freedA = await page.locator(`.bus button.seat:has-text("${seatA}")`).first().getAttribute('data-state');
  const freedB = await page.locator(`.bus button.seat:has-text("${seatB}")`).first().getAttribute('data-state');
  check('both cancelled seats sellable again', freedA === 'free' && freedB === 'free',
    `${seatA}=${freedA} ${seatB}=${freedB}`);
  await shot('13-seats-released');

  console.log('\n=== 12. SIGNED OUT, THE ACCOUNT SHOWS NOTHING ===');
  await page.goto(`${WEB}/account`, { waitUntil: 'networkidle' });
  await page.waitForSelector('text=Sign in to see your trips', { timeout: 15000 });
  check("a signed-out visitor is invited to sign in, not shown a stranger's trips",
    await page.locator('text=Sign in to see your trips').isVisible());
  await shot('14-account-signed-out');

  console.log('\n=== 13. SIGN IN WITH A ONE-TIME CODE ===');
  await page.click('.page a:has-text("Sign in")');
  await page.waitForURL('**/login**', { timeout: 15000 });
  // Fill and verify: the form is server-rendered, so a keystroke landing before
  // React takes the input over is discarded.
  for (let i = 0; i < 6; i++) {
    await page.fill('#phone', PHONE);
    await page.waitForTimeout(120);
    if ((await page.inputValue('#phone')) === PHONE) break;
  }
  await page.click('button:has-text("Send me a code")');
  // SHOW_OTP is on for this harness, so the page fills the code in. In
  // production it arrives by SMS and the API never returns it.
  await page.waitForSelector('#code', { timeout: 15000 });
  const otp = await page.inputValue('#code');
  check('a six-digit code was issued', /^\d{6}$/.test(otp), otp);
  await page.click('button[type="submit"]:has-text("Sign in")');
  await page.waitForURL('**/account**', { timeout: 20000 });
  await page.waitForSelector('[data-testid="account-identity"]', { timeout: 20000 });
  check('signed in and landed on the account',
    (await page.locator('[data-testid="account-identity"]').innerText()).includes(PHONE_E164),
    PHONE_E164);
  await shot('15-signed-in');

  console.log('\n=== 14. THE GUEST BOOKING IS NOW IN THE ACCOUNT ===');
  const accountText = await page.locator('.page').innerText();
  check('the trip booked as a guest appears once signed in', accountText.includes(pnr),
    `looking for ${pnr}`);

  await page.click('button:has-text("Invite a friend")');
  await page.waitForTimeout(400);
  check('the passenger has a referral code',
    /[ACDEFGHJKLMNPQRTUVWXY3479]{8}/.test(await page.locator('.page').innerText()));
  await shot('16-referral');

  // "Devices" and "This one" were the old labels. A passenger does not think in
  // devices, they think about where they are still signed in — so the tab says
  // that, and the badge names the phone in their hand rather than "this one".
  await page.click('button:has-text("Where you are signed in")');
  await page.waitForTimeout(400);
  check('this sign-in is listed',
    (await page.locator('.page').innerText()).includes('This device'));
  await shot('17-devices');

  console.log('\n=== 15. NO CONSOLE ERRORS ===');
  // A 401 on /account while signed out is the correct answer, not a fault, so
  // it is excluded — the check is for errors the application did not intend.
  const real = errors.filter((e) =>
    !/favicon|Download the React DevTools/i.test(e) &&
    !/401 \(Unauthorized\)/.test(e));
  check('no uncaught page errors', real.length === 0, real.slice(0, 3).join(' | '));

} catch (e) {
  failures++;
  console.log('\n  FAIL  exception:', e.message.split('\n')[0]);
  await shot('99-failure');
} finally {
  await browser.close();
}

console.log('\n' + '='.repeat(60));
console.log(failures === 0 ? 'BROWSER FLOW PASSED' : `${failures} CHECK(S) FAILED`);
console.log(`screenshots: apps/web/${SHOTS}`);
process.exit(failures === 0 ? 0 : 1);
