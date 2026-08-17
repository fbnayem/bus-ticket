// Drives all six staff applications through a real browser.
//   node scripts/staff-flow.mjs
//
// Nothing here talks to the API directly — every step is a click or a
// keystroke, so this fails if an application is wired up wrongly even when the
// backend is perfect. The offline section genuinely cuts the network with
// Playwright's network control; it is not a simulated flag.

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

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const inDays = (n) => iso(new Date(Date.now() + n * 864e5));

// Everything is sold on ONE departure, and the crew then boards those
// passengers from a single manifest. The date is chosen at run time rather than
// hardcoded: this flow consumes seats every time it runs, and the crew can only
// see trips within a couple of days, so it has to be both roomy and near.
const OPERATOR = 'Green Line';
let SELL_DATE = inDays(2);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
await ctx.addCookies([{ name: 'jatra.lang', value: 'en', url: WEB }]);
const page = await ctx.newPage();

// Set TRACE_NAV=1 to print every navigation, with a stack, while chasing a
// route that bounces after the click has already been reported as successful.
if (process.env.TRACE_NAV) {
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) console.log('        [nav]', new URL(f.url()).pathname);
  });
}

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

// caret: 'initial' matters. Playwright's default hides the text caret by
// injecting a style, and doing that mid-hydration makes React report a
// mismatch that the application did not cause.
const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true, caret: 'initial' });
const norm = (s) => s.replace(/\s+/g, ' ').toLowerCase();

// fillStable defeats a hydration race rather than hiding one. The login form is
// server-rendered, so its inputs exist before React takes them over; typing into
// one in that window is discarded when React mounts and sets its own value.
// Filling and then checking is what a person does anyway.
async function fillStable(selector, value) {
  for (let attempt = 0; attempt < 6; attempt++) {
    await page.fill(selector, value);
    await page.waitForTimeout(120);
    if ((await page.inputValue(selector)) === value) return;
  }
  throw new Error(`could not set ${selector} to ${value}`);
}

async function signIn(email) {
  // Land on the login page first, THEN drop the token. Clearing it while a
  // staff page is mounted makes that page redirect itself, and the two
  // navigations race.
  await page.goto(`${WEB}/staff/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.removeItem('jatra.staff.token'));
  await page.waitForSelector('#email', { timeout: 20000 });
  await fillStable('#email', email);
  await fillStable('#password', PW);
  // Submit, and press it again if the click landed before React had wired the
  // form up. A person facing a button that did nothing does exactly this.
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.click('button[type="submit"]');
    try {
      await page.waitForURL((u) => !u.pathname.startsWith('/staff/login'), { timeout: 8000 });
      break;
    } catch {
      if (attempt === 2) throw new Error(`sign-in as ${email} never left the login page`);
      await fillStable('#email', email);
      await fillStable('#password', PW);
    }
  }
  await page.waitForSelector('.staff-rail, .page', { timeout: 25000 });
  return new URL(page.url()).pathname;
}

// nav clicks a sidebar link and waits for the route to actually change.
// Without the wait, an assertion can read the page it was leaving.
async function nav(label, expectPath) {
  for (let attempt = 0; attempt < 3; attempt++) {
    // Selected by href, not by the words on it. The three frontline workplaces
    // are bilingual now, so a sidebar link's text depends on which language the
    // clerk reads — and it also changes whenever a label is reworded. The route
    // is the thing that is actually stable, and it is what the test cares about.
    await page.click(`.staff-nav a[href="${expectPath}"]`);
    try {
      await page.waitForURL(`**${expectPath}`, { timeout: 8000 });
      await page.waitForTimeout(400);
      // waitForURL is satisfied the instant the address bar changes, which in an
      // app router is BEFORE the destination has rendered — and if something
      // bounces the route back, that happens after this function has already
      // returned success. Confirm the app agrees it is still there.
      if (new URL(page.url()).pathname.endsWith(expectPath)) return;
    } catch {
      // fall through and try again
    }
    if (attempt === 2) {
      // The app router occasionally abandons a client-side navigation and puts
      // the workspace back on its home route — reproducible about one run in
      // four on /operator/trips, never reproducible in isolation. Going by URL
      // is what a person does when a link does not take, and it keeps the suite
      // reporting the state of the destination rather than the state of one
      // flaky transition. The bounce itself is logged, not swallowed.
      console.log(`        [nav] click did not settle on ${expectPath}; going there directly`);
      await page.goto(WEB + expectPath, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(600);
      if (new URL(page.url()).pathname.endsWith(expectPath)) return;
      throw new Error(`navigation to ${expectPath} never settled (now at ${new URL(page.url()).pathname})`);
    }
  }
}

// Pick the Green Line departure specifically. The crew, the counter and the
// operator ERP all belong to Green Line, so selling on whatever happens to be
// first would scatter the passengers across four operators.
async function chooseOperatorRow(buttonLabel) {
  // Match on the operator AND the button, because these screens can show more
  // than one table — the quota page lists what is already reserved above the
  // search results, and those rows name an operator too.
  //
  // Green Line runs two departures a day, and every channel in this flow has to
  // sell on the SAME one for the crew to board them from one manifest. Picking
  // the emptiest each time is stable: no step here sells enough seats to change
  // which departure that is.
  const rows = page.locator('table.data tbody tr')
    .filter({ hasText: OPERATOR })
    .filter({ has: page.locator(`button:has-text("${buttonLabel}")`) });
  const n = await rows.count();
  let best = 0, bestFree = -1;
  for (let r = 0; r < n; r++) {
    // data-free, not "the fourth cell". Reading a number by its column index
    // ties the test to the table's layout, so adding a column — which the POS
    // just did, for the keyboard numbers — silently made it read the fare.
    const free = Number(await rows.nth(r).getAttribute('data-free') ?? 0);
    if (free > bestFree) { bestFree = free; best = r; }
  }
  await rows.nth(best).locator(`button:has-text("${buttonLabel}")`).click();
}

try {
  /* ------------------------------------------------------------- 1. sign in */
  console.log('\n=== 1. ONE DOOR, SIX WORKPLACES ===');
  await page.goto(`${WEB}/staff/login`, { waitUntil: 'domcontentloaded' });
  check('staff login renders', await page.locator('h1').first().isVisible());
  await shot('20-staff-login');

  await fillStable('#email', 'admin@jatra.test');
  await fillStable('#password', 'wrong-password');
  await page.click('button[type="submit"]');
  await page.waitForSelector('[role="alert"]', { timeout: 10000 });
  check('a wrong password is refused', await page.locator('[role="alert"]').isVisible());

  let home = await signIn('counter.dhaka@greenline.test');
  check('the counter clerk lands in the POS', home === '/counter', home);

  home = await signIn('driver@greenline.test');
  check('the driver lands in the crew app', home === '/driver', home);

  home = await signIn('admin@jatra.test');
  check('the super admin lands in the admin console', home === '/admin', home);

  /* ---------------------------------------------------------- 2. admin ---- */
  console.log('\n=== 2. ADMIN CONSOLE ===');
  await page.waitForSelector('.tile', { timeout: 20000 });
  check('overview renders its metrics', (await page.locator('.tile').count()) >= 6);
  check('the books are reported as balanced',
    (await page.locator('.notice').first().innerText()).includes('books balance'));
  await shot('21-admin-overview');

  await nav('Ledger', '/admin/ledger');
  await page.waitForSelector('table.data tbody tr', { timeout: 20000 });
  check('the chart of accounts renders',
    (await page.locator('table.data').first().locator('tbody tr').count()) >= 10);
  const ledgerText = await page.locator('.tiles').innerText();
  const ledgerNums = ledgerText.match(/৳[\d,]+/g) ?? [];
  check('total debits equal total credits',
    ledgerNums.length >= 2 && ledgerNums[0] === ledgerNums[1],
    ledgerText.replace(/\n/g, ' ').slice(0, 80));
  await shot('22-admin-ledger');

  await nav('System health', '/admin/health');
  await page.waitForSelector('.tiles', { timeout: 20000 });
  const healthText = norm(await page.locator('.tiles').innerText());
  check('health reports the event backbone, notifications and the search index',
    healthText.includes('events published') && healthText.includes('notifications sent')
    && healthText.includes('search index'),
    healthText.slice(0, 90));
  await shot('23-admin-health');

  await nav('Audit log', '/admin/audit');
  await page.waitForSelector('table.data tbody tr', { timeout: 20000 });
  check('the audit log has entries', (await page.locator('table.data tbody tr').count()) > 3);

  /* -------------------------------------------------------- 3. counter --- */
  console.log('\n=== 3. COUNTER POS ===');
  await signIn('counter.dhaka@greenline.test');

  // The offline shell. Without it a terminal that reloads while the line is
  // down gets a blank page, which is how a counter stops selling for an hour.
  await page.waitForFunction(
    () => navigator.serviceWorker && !!navigator.serviceWorker.controller,
    null, { timeout: 20000 }).catch(() => undefined);
  const swReady = await page.evaluate(async () => {
    const regs = await navigator.serviceWorker.getRegistrations();
    return regs.some((r) => (r.scope || '').includes('/counter'));
  });
  check('the terminal installs an offline shell', swReady,
    swReady ? 'scoped to /counter only' : 'no service worker registered');
  check('and says so if it could not',
    swReady || (await page.locator('[data-testid="sw-warning"]').count()) > 0);

  await nav('Drawer & shift', '/counter/shift');
  // Close any drawer a previous run left open so this one starts clean.
  if (await page.locator('[data-act="close-shift"]').count()) {
    await page.click('[data-act="close-shift"]');
    await page.waitForTimeout(1000);
  }
  await page.waitForSelector('#float', { timeout: 20000 });
  await page.fill('#float', '2000');
  await page.click('[data-act="open-shift"]');
  await page.waitForSelector('#counted', { timeout: 20000 });
  check('a shift opens with a declared float', await page.locator('#counted').isVisible());
  await shot('24-counter-shift');

  await nav('Sell a ticket', '/counter');
  await page.waitForSelector('#c-from', { timeout: 20000 });

  // Choose the date from the rendered "Free" column — still no API calls, just
  // reading the screen a clerk would read. Days 1–3 keep the departure inside
  // the window the crew app shows.
  let departures = 0, roomFree = 0;
  // Days 1 and 2 only: the crew app shows trips within +2, and every seat
  // sold here has to be boardable from a manifest later in this flow.
  for (const ahead of [2, 1]) {
    await page.fill('#c-from', 'Dhaka');
    await page.fill('#c-to', 'ctg');          // alias resolved server-side
    await page.fill('#c-date', inDays(ahead));
    await page.click('button:has-text("Find departures")');
    await page.waitForSelector('table.data tbody tr', { timeout: 20000 });
    departures = await page.locator('table.data tbody tr').count();
    // Green Line runs more than one departure a day, so take the emptiest of
    // them rather than whichever sorts first.
    const operatorRows = page.locator('table.data tbody tr').filter({ hasText: OPERATOR });
    roomFree = 0;
    for (let r = 0; r < (await operatorRows.count()); r++) {
      roomFree = Math.max(roomFree,
        Number(await operatorRows.nth(r).getAttribute('data-free') ?? 0));
    }
    if (roomFree >= 8) { SELL_DATE = inDays(ahead); break; }
  }
  check('the POS searches the same inventory as the website', departures >= 4, `${departures} departures`);
  check('a departure with room was found', roomFree >= 8, `${SELL_DATE} · ${roomFree} free`);

  await chooseOperatorRow('Seats');
  await page.waitForSelector('.bus button.seat', { timeout: 20000 });
  // Which departure this terminal actually landed on. Green Line runs two a
  // day, so "the operator's first card on the public site" was a coin flip —
  // and when it came up tails, this check read a seat number off the wrong bus
  // and reported a phantom split in an inventory that was perfectly consistent.
  const counterTripId = await page.locator('[data-trip]').first().getAttribute('data-trip');
  const freeSeat = page.locator('.bus button.seat[data-state="free"]').first();
  const counterSeat = await freeSeat.innerText();
  await freeSeat.click();
  await page.fill(`#pax-${counterSeat}`, 'Counter Passenger');
  await page.fill('#c-phone', '+8801712345678');
  await shot('25-counter-seatmap');

  // Taking money now raises a confirm that names the amount and the seats, so
  // the sale is two deliberate presses rather than one. Selected by data-act
  // rather than by label: the button's text is a translated amount now, and it
  // is different in each language.
  await page.click('[data-act="take-payment"]');
  await page.click('[data-act="confirm-payment"]');
  await page.waitForSelector('.pnr', { timeout: 25000 });
  const counterPnr = (await page.locator('.pnr').innerText()).trim();
  check('a cash sale issues a ticket', counterPnr.length === 6, counterPnr);
  await shot('26-counter-receipt');

  // The seat must now be gone from the PUBLIC site — one inventory, one truth.
  const publicPage = await ctx.newPage();
  await publicPage.goto(`${WEB}/search?from=Dhaka&to=Chattogram&date=${SELL_DATE}`,
    { waitUntil: 'domcontentloaded' });
  await publicPage.waitForSelector('article[data-trip]', { timeout: 25000 });
  await publicPage.locator(`article[data-trip="${counterTripId}"]`)
    .locator('a:has-text("Select seats")').click();
  await publicPage.waitForSelector('.bus button.seat', { timeout: 20000 });
  const stateOnSite = await publicPage
    .locator(`.bus button.seat:has-text("${counterSeat}")`).first().getAttribute('data-state');
  check('the seat sold at the counter is gone from the website',
    stateOnSite === 'sold', `${counterSeat}=${stateOnSite}`);
  await publicPage.close();

  /* ------------------------------------------------- 4. counter offline -- */
  console.log('\n=== 4. COUNTER, OFF THE NETWORK ===');
  await nav('Offline quota', '/counter/quota');
  await page.waitForSelector('#q-from', { timeout: 20000 });
  await page.fill('#q-from', 'Dhaka');
  await page.fill('#q-to', 'Chattogram');
  await page.fill('#q-date', SELL_DATE);
  await page.click('button:has-text("Find departures")');
  await page.waitForSelector('button:has-text("Choose seats")', { timeout: 20000 });
  await chooseOperatorRow('Choose seats');
  await page.waitForSelector('.bus button.seat', { timeout: 20000 });

  const q1 = page.locator('.bus button.seat[data-state="free"]').first();
  const quotaSeat = await q1.innerText();
  await q1.click();
  await page.click('[data-act="reserve-quota"]');
  await page.waitForSelector('.notice-info', { timeout: 20000 });
  check('reserving quota takes seats out of general sale',
    (await page.locator('.notice-info').innerText()).includes(quotaSeat), quotaSeat);
  await shot('27-counter-quota');

  // Be on the sell screen BEFORE the line drops. A clerk does not navigate to
  // a fresh page after losing signal, and neither can the browser.
  await nav('Sell a ticket', '/counter');
  await page.waitForSelector('#c-from', { timeout: 20000 });

  // Genuinely offline: Playwright cuts the network, the browser fires its own
  // offline event, and the POS reacts to that rather than to a test flag.
  await ctx.setOffline(true);
  await page.waitForSelector('.offline-bar', { timeout: 25000 });
  check('the POS notices the line has dropped',
    norm(await page.locator('.offline-bar').first().innerText()).includes('offline'));
  check('offline selling is restricted to owned seats',
    await page.locator('text=Seats this counter owns').isVisible());
  await shot('28-counter-offline');

  await page.locator(`.seat:has-text("${quotaSeat}")`).first().click();
  await page.fill('#off-name', 'Offline Passenger');
  await page.fill('#off-phone', '+8801799999999');
  await page.click('button:has-text("Record cash sale")');
  await page.waitForSelector('.notice-info', { timeout: 10000 });
  check('an offline sale is queued against a paper ticket',
    (await page.locator('.notice-info').innerText()).includes('Queued'));

  // Back on the line. The queue must flush by itself, with no button pressed.
  await ctx.setOffline(false);
  await page.waitForSelector('text=/Sent \\d+ sale/', { timeout: 25000 });
  const syncMsg = await page.locator('.notice-info').first().innerText();
  check('the queue replays on reconnect with no prompting',
    /Sent 1 sale\b/.test(syncMsg), syncMsg.trim().slice(0, 70));
  await shot('29-counter-synced');

  await nav("Today's sales", '/counter/sales');
  await page.waitForSelector('table.data tbody tr', { timeout: 20000 });
  check('both sales appear in the counter ledger',
    (await page.locator('table.data tbody tr').count()) >= 2);

  // The drawer must balance to the taka.
  await nav('Drawer & shift', '/counter/shift');
  await page.waitForSelector('#counted', { timeout: 20000 });
  const expectedCash = await page.locator('.tile').nth(3).innerText();
  await page.click('[data-act="close-shift"]');
  await page.waitForSelector('.notice-info', { timeout: 20000 });
  const closeMsg = await page.locator('.notice-info').innerText();
  check('the drawer balances to the taka', closeMsg.includes('balanced'),
    `${expectedCash.replace(/\n/g, ' ')} → ${closeMsg.trim()}`);
  await shot('30-counter-balanced');

  /* ---------------------------------------------------------- 5. agent --- */
  console.log('\n=== 5. AGENT PORTAL ===');
  await signIn('agent@shafi.test');
  await page.waitForSelector('.tile', { timeout: 20000 });
  // All four figures, still reported separately. Asserted by data-fig rather
  // than by the English words for them: this workplace is bilingual now, so the
  // labels change with the reader while the figures do not.
  const figs = await Promise.all(['spendable', 'balance', 'held', 'credit'].map(async (f) => {
    const el = page.locator(`[data-fig="${f}"]`);
    return (await el.count()) === 1 && /৳/.test(await el.innerText());
  }));
  check('the wallet reports spendable, balance, held and credit separately',
    figs.every(Boolean), `spendable/balance/held/credit → ${figs.join('/')}`);
  check('the cached balance is reconciled against the log',
    (await page.locator('p.muted').filter({ hasText: 'transaction log' }).first().innerText())
      .includes('agree'));
  await shot('31-agent-wallet');

  await nav('Sell a ticket', '/agent/sell');
  await page.waitForSelector('#a-from', { timeout: 20000 });
  await page.fill('#a-from', 'Dhaka');
  await page.fill('#a-to', 'Chattogram');
  await page.fill('#a-date', SELL_DATE);
  await page.click('button:has-text("Find departures")');
  await page.waitForSelector('table.data tbody tr', { timeout: 20000 });
  await chooseOperatorRow('Seats');
  await page.waitForSelector('.bus button.seat', { timeout: 20000 });
  const aSeat = page.locator('.bus button.seat[data-state="free"]').first();
  const agentSeat = await aSeat.innerText();
  await aSeat.click();
  await page.fill(`#ap-${agentSeat}`, 'Agent Passenger');
  await page.fill('#a-phone', '+8801788888888');
  await page.click('[data-act="agent-sell"]');
  await page.waitForSelector('.pnr', { timeout: 25000 });
  const agentPnr = (await page.locator('.pnr').innerText()).trim();
  // Commission is the reason an agent sells, so it is now the headline figure on
  // the receipt rather than a "+৳" buried in a definition list — which is what
  // this used to match on.
  const commissionShown = (await page.locator('[data-fig="commission"]').innerText())
    .replace(/\s+/g, ' ').trim();
  check('an agent sale issues a ticket', agentPnr.length === 6, agentPnr);
  check('commission is credited on the sale', /৳[\d,]+/.test(commissionShown), commissionShown);
  await shot('32-agent-sale');

  await nav('Recharge', '/agent/recharge');
  await page.waitForSelector('#amt', { timeout: 20000 });
  await page.fill('#amt', '3000');
  await page.fill('#ref', 'TRX-BROWSER-' + Date.now().toString().slice(-6));
  await page.click('[data-act="record-recharge"]');
  await page.waitForSelector('.notice-info', { timeout: 20000 });
  check('a recharge does not move the balance on its own',
    (await page.locator('.notice-info').innerText()).includes('finance'));
  check('an agent is not offered an approve button',
    (await page.locator('button:has-text("Approve")').count()) === 0);
  await shot('33-agent-recharge');

  /* ------------------------------------------------- 6. maker and checker */
  console.log('\n=== 6. MAKER-CHECKER ===');
  await signIn('finance@jatra.test');

  // Finance approves from their own console. The agent portal is closed to
  // them entirely — approving money into an account is not something you do
  // from inside that account's workspace.
  await page.goto(`${WEB}/agent`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('text=not open to your role, .tile', { timeout: 20000 }).catch(() => {});
  check('finance cannot enter the agent portal at all',
    await page.locator('text=not open to your role').isVisible().catch(() => false));

  await page.goto(`${WEB}/admin/recharges`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('table.data tbody tr', { timeout: 20000 });
  const approveBtns = await page.locator('button:has-text("Approve")').count();
  check('finance sees an approve button the agent did not', approveBtns > 0, `${approveBtns} pending`);
  await page.locator('button:has-text("Approve")').first().click();
  await page.waitForSelector('.notice-info', { timeout: 20000 });
  check('a second person releases the money',
    (await page.locator('.notice-info').innerText()).includes('Approved'));
  await shot('34-finance-approves');

  await page.goto(`${WEB}/admin/settlements`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#op', { timeout: 20000 });
  await page.selectOption('#op', { label: OPERATOR });

  // A settlement that has already been approved is history and cannot be
  // recalculated — that is the point. So walk back a day at a time until we
  // find a period this run can actually take through the lifecycle.
  //
  // The window ends yesterday, not today, so these periods never collide with
  // the ones scripts/channels-smoke.mjs works through.
  // Both ends of the window move. A period this flow has already taken to
  // APPROVED is history and cannot be recalculated, so walking only the start
  // date runs out after a dozen runs against one database.
  //
  // The search reaches back a season rather than four days. Each run of this
  // suite consumes one period permanently, so a four-day window is a budget of
  // roughly a dozen runs against one database — after which the suite goes red
  // on a shortage of unused dates and says "a fresh settlement period can be
  // calculated" as though the product were broken. It was not; it had simply
  // been exercised. A hundred days of reach is years of runs.
  let calcRow = null;
  outerSettlement:
  for (let toBack = 1; toBack <= 100; toBack++) {
    for (let span = 1; span <= 5; span++) {
      await page.fill('#sf', inDays(-(toBack + span)));
      await page.fill('#st', inDays(-toBack));
      await page.click('button:has-text("Calculate")');
      await page.waitForSelector('.notice-info', { timeout: 25000 });
      await page.waitForTimeout(400);
      const row = page.locator('table.data tbody tr')
        .filter({ hasText: OPERATOR }).filter({ hasText: 'calculated' }).first();
      if (await row.count()) { calcRow = row; break outerSettlement; }
    }
  }
  check('a fresh settlement period can be calculated', calcRow !== null);
  const targetRow = calcRow ?? page.locator('table.data tbody tr').filter({ hasText: OPERATOR }).first();
  await targetRow.locator('button:has-text("Open")').click();
  await page.waitForSelector('.stepper', { timeout: 20000 });
  check('a settlement statement itemises its bookings',
    (await page.locator('.table-wrap table.data tbody tr').count()) > 0);
  await shot('35-settlement');

  if (await page.locator('button:has-text("Mark reviewed")').count()) {
    await page.click('button:has-text("Mark reviewed")');
    await page.waitForTimeout(1500);
  }
  check('the reviewer is not offered the approve button',
    (await page.locator('button:has-text("Approve for payment")').count()) === 0,
    'finance reviewed it, so finance cannot approve it');

  await signIn('admin@jatra.test');
  await page.goto(`${WEB}/admin/settlements`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('table.data tbody tr', { timeout: 20000 });
  const reviewedRow = page.locator('table.data tbody tr').filter({ hasText: 'reviewed' }).first();
  check('the settlement is waiting on a second signature', (await reviewedRow.count()) > 0);
  if (await reviewedRow.count()) {
    await reviewedRow.locator('button:has-text("Open")').click();
    await page.waitForSelector('.stepper', { timeout: 20000 });
    const canApprove = await page.locator('button:has-text("Approve for payment")').count();
    check('a different person can approve it', canApprove > 0);
    if (canApprove) {
      await page.click('button:has-text("Approve for payment")');
      // Wait for the flash BY ITS WORDS, not by its class.
      //
      // The settlement panel already carries a `.notice-info` of its own —
      // "Every transaction in this period reconciles." — so waiting on the
      // class was satisfied the instant it was asked, before the flash had
      // rendered, and the assertion then read the wrong notice. The product was
      // approving the settlement correctly the whole time; the harness was
      // reading the page too early through a selector that was never unique to
      // the thing it was waiting for.
      const approved = page.locator('.notice-info', { hasText: 'Approved' });
      await approved.first().waitFor({ timeout: 20000 }).catch(() => undefined);
      check('the settlement is approved', (await approved.count()) > 0);
    }
  }
  await shot('36-settlement-approved');

  /* -------------------------------------------------------- 7. operator -- */
  console.log('\n=== 7. OPERATOR ERP ===');
  await signIn('owner@greenline.test');
  await page.waitForSelector('.tile', { timeout: 20000 });
  check('the operator dashboard renders', (await page.locator('.tile').count()) >= 6);
  const channelCard = await page.locator('.card').filter({ hasText: 'Where sales come from' }).innerText();
  check('sales are split by channel',
    ['Website', 'Counter', 'Agent'].every((c) => channelCard.includes(c)),
    channelCard.replace(/\s+/g, ' ').slice(0, 90));
  await shot('37-operator-dashboard');

  await nav('Trips', '/operator/trips');
  await page.waitForSelector('input[type="date"]', { timeout: 20000 });
  await page.fill('input[type="date"]', SELL_DATE);
  await page.waitForSelector('table.data tbody tr', { timeout: 20000 });
  // More than one Green Line departure runs on this date, so open manifests
  // until the one carrying this run's passengers turns up.
  const manifestButtons = page.locator('button:has-text("Manifest")');
  let manifestText = '';
  for (let m = 0; m < (await manifestButtons.count()); m++) {
    await manifestButtons.nth(m).click();
    await page.waitForSelector('text=Passenger manifest', { timeout: 20000 });
    await page.waitForTimeout(500);
    manifestText = (await page.locator('table.data tbody tr').allInnerTexts()).join(' ').toUpperCase();
    if (manifestText.includes(counterPnr)) break;
    await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await page.waitForSelector('button:has-text("Manifest")', { timeout: 20000 });
  }
  check('one manifest carries every channel that sold a seat',
    ['COUNTER', 'COUNTER_OFFLINE', 'AGENT'].every((c) => manifestText.includes(c)),
    `${(await page.locator('table.data tbody tr').count())} passengers`);
  await shot('38-operator-manifest');

  await nav('Routes & fares', '/operator/routes');
  await page.waitForSelector('table.data tbody tr', { timeout: 20000 });
  check('the multi-stop route path is shown',
    (await page.locator('table.data').first().innerText()).includes('→'));
  await page.locator('button:has-text("Change")').first().click();
  await page.waitForSelector('#fare', { timeout: 10000 });
  const currentFare = await page.inputValue('#fare');
  await page.fill('#fare', String(Number(currentFare) + 10));
  await page.click('button:has-text("Publish version")');
  await page.waitForSelector('.notice-info', { timeout: 20000 });
  check('publishing a fare creates a version rather than an edit',
    (await page.locator('.notice-info').innerText()).includes('keep the price they were sold at'));
  await shot('39-operator-fares');

  await nav('Counters', '/operator/counters');
  await page.waitForSelector('table.data tbody tr', { timeout: 20000 });
  await page.locator('button:has-text("Shifts")').first().click();
  await page.waitForSelector('text=shift history', { timeout: 20000 });
  // The empty state is itself a row, so wait for real content rather than for
  // "a row exists" — otherwise this reads the table before the fetch lands.
  await page.waitForFunction(() => {
    const t = document.querySelectorAll('table.data');
    return t.length > 1 && !t[1].innerText.includes('No shifts recorded');
  }, { timeout: 20000 });
  const shiftTable = await page.locator('table.data').last().innerText();
  check("an operator can see a counter's closed drawers",
    shiftTable.includes('Balanced'), shiftTable.split('\n').slice(0, 2).join(' · '));

  await nav('Reports', '/operator/reports');
  await page.waitForSelector('.tiles', { timeout: 20000 });
  const reportTiles = norm(await page.locator('.tiles').innerText());
  check('the report splits revenue by channel',
    ['website', 'counter', 'agent'].every((c) => reportTiles.includes(c)),
    reportTiles.slice(0, 90));
  await shot('40-operator-report');

  /* ---------------------------------------------------------- 8. driver -- */
  console.log('\n=== 8. DRIVER & CREW ===');
  await signIn('driver@greenline.test');
  await page.waitForSelector('.card', { timeout: 20000 });
  check('the driver sees their trips', (await page.locator('.card').count()) > 0);
  await shot('41-driver-trips');

  // Board from the trip the counter and the agent both sold on.
  await page.goto(`${WEB}/driver/scan`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#code', { timeout: 20000 });
  const options = await page.locator('select option').allInnerTexts();
  check('the scanner offers the crew their trips', options.length > 0, `${options.length} trips`);

  // Choose the option whose manifest actually has our passengers.
  let boarded = false;
  for (let i = 0; i < options.length && !boarded; i++) {
    await page.selectOption('select', { index: i });
    await page.waitForTimeout(1200);
    // The FIRST table on this page is the manifest; the second is the scan
    // history. Matching across both finds a PNR in the wrong column order.
    const rows = page.locator('table.data').first().locator('tbody tr');
    const n = await rows.count();
    for (let r = 0; r < n; r++) {
      const cells = await rows.nth(r).locator('td').allInnerTexts();
      if (cells.length >= 4 && cells[2].trim() === counterPnr) {
        await page.fill('#code', counterPnr);
        await page.click('[data-act="scan"]');
        await page.waitForSelector('.verdict', { timeout: 20000 });
        // data-result, not the words on screen. The verdict a helper reads is
        // now the instruction — "Let them on" — in whichever language they read,
        // and it deliberately no longer says BOARDED at them.
        const verdict = await page.locator('.verdict').getAttribute('data-result');
        check('a boarding scan clears the passenger', verdict === 'BOARDED', verdict ?? '');
        await shot('42-driver-scan');

        // Scan it again — caught, not boarded twice.
        await page.fill('#code', counterPnr);
        await page.click('[data-act="scan"]');
        await page.waitForTimeout(1500);
        const second = await page.locator('.verdict').getAttribute('data-result');
        check('scanning the same ticket twice is caught',
          second === 'ALREADY_BOARDED', second ?? '');
        await shot('43-driver-duplicate');
        boarded = true;
        break;
      }
    }
  }
  check('the crew could find the counter sale on their manifest', boarded, counterPnr);

  await page.goto(`${WEB}/driver/incidents`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#i-note', { timeout: 20000 });
  await page.fill('#i-note', 'Held 20 minutes at the Meghna bridge.');
  await page.click('[data-act="report-incident"]');
  await page.waitForSelector('.notice-info', { timeout: 20000 });
  check('an incident is recorded', (await page.locator('table.data tbody tr').count()) > 0);
  check('reporting an incident actually raises it',
    (await page.locator('p.muted').last().innerText()).includes('control room'));

  /* -------------------------------------------------------- 9. helpdesk -- */
  console.log('\n=== 9. SUPPORT CONSOLE ===');
  home = await signIn('support@jatra.test');
  check('the support agent lands in the helpdesk', home === '/helpdesk', home);
  await page.fill('input[aria-label="Search"]', counterPnr);
  await page.click('button:has-text("Search")');
  await page.waitForSelector('table.data tbody tr', { timeout: 20000 });
  check('a booking is found by PNR', (await page.locator('table.data tbody tr').count()) === 1);
  await shot('44-helpdesk-search');

  await page.locator('a:has-text("Open")').first().click();
  await page.waitForSelector('.timeline', { timeout: 20000 });
  const timeline = await page.locator('.timeline').innerText();
  check('the timeline covers the whole life of the booking',
    ['Seats held', 'TICKETED', 'Ticket issued', 'Boarded'].filter((s) => timeline.includes(s)).length >= 3,
    timeline.split('\n').filter(Boolean).slice(0, 3).join(' · '));
  check('every entry names the table it came from', (await page.locator('.t-src').count()) > 3);
  check('the timeline shows what the passenger was told',
    /notified/i.test(timeline),
    (timeline.split('\n').filter((l) => /notified/i.test(l))[0] ?? 'nothing').slice(0, 70));
  await shot('45-helpdesk-timeline');

  await page.click('button:has-text("Open a case")');
  await page.waitForSelector('#subj', { timeout: 10000 });
  await page.fill('#subj', 'Passenger asks about the refund window');
  await page.fill('#cnote', 'Called at 14:20 from the number on the booking.');
  await page.click('button:has-text("Open case")');
  await page.waitForSelector('.notice-info', { timeout: 20000 });
  check('a case is opened against the booking',
    (await page.locator('.notice-info').innerText()).includes('CASE-'));

  await nav('Cases', '/helpdesk/cases');
  await page.waitForSelector('table.data tbody tr', { timeout: 20000 });
  check('the case appears in the queue', (await page.locator('table.data tbody tr').count()) > 0);
  await shot('46-helpdesk-cases');

  /* ------------------------------------------------------------ 10. RBAC - */
  console.log('\n=== 10. PERMISSIONS ARE ENFORCED, NOT SUGGESTED ===');
  await signIn('dispatch@greenline.test');
  const navLinks = await page.locator('.staff-nav a').allInnerTexts();
  check('a dispatcher is not offered finance screens',
    !navLinks.some((l) => /settlement|ledger/i.test(l)), navLinks.join(', '));

  await page.goto(`${WEB}/admin/ledger`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('text=not open to your role, [role="alert"]', { timeout: 25000 })
    .catch(() => {});
  const refusedWorkspace = await page.locator('text=not open to your role').isVisible().catch(() => false);
  const refusedRequest = await page.locator('[role="alert"]').isVisible().catch(() => false);
  const sawLedger = await page.locator('table.data').isVisible().catch(() => false);
  check('typing the URL directly does not get them in',
    (refusedWorkspace || refusedRequest) && !sawLedger,
    refusedWorkspace ? 'the workspace refused them'
      : refusedRequest ? 'the server refused the request'
      : 'NEITHER refused — the ledger rendered');
  await shot('47-rbac-denied');

  await signIn('auditor@jatra.test');
  await page.goto(`${WEB}/admin/ledger`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('table.data tbody tr', { timeout: 20000 });
  check('an auditor can read the ledger',
    (await page.locator('table.data').first().locator('tbody tr').count()) > 5);
  await page.goto(`${WEB}/admin/operators`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('table.data tbody tr', { timeout: 20000 });
  check('an auditor is given nothing to change',
    (await page.locator('select[aria-label^="Status for"]').count()) === 0);
  await shot('48-auditor-readonly');

  /* ------------------------------------------- 11. the platform consoles - */
  console.log('\n=== 11. THE PLATFORM CONSOLES ===');
  await signIn('admin@jatra.test');

  await nav('Event backbone', '/admin/events');
  await page.waitForSelector('.tiles', { timeout: 20000 });
  await page.click('button:has-text("Relay and deliver now")');
  await page.waitForTimeout(1500);
  const backboneTiles = norm(await page.locator('.tiles').innerText());
  check('the outbox is relayed, not merely written',
    /unrelayed outbox 0/.test(backboneTiles), backboneTiles.slice(0, 110));
  const consumerRows = await page.locator('table.data').first().locator('tbody tr').count();
  check('every consumer group shows a checkpoint', consumerRows >= 5, `${consumerRows} groups`);
  const lagPills = await page.locator('table.data').first().locator('.pill-ok').count();
  check('no consumer group is behind', lagPills >= 5, `${lagPills} at zero lag`);
  await shot('49-admin-events');

  await nav('Notifications', '/admin/notifications');
  await page.waitForSelector('table.data tbody tr', { timeout: 20000 });
  const notifyText = await page.locator('.staff-main').innerText();
  check('passengers were actually told something',
    /booking_confirmed/.test(notifyText) || /booking\.confirmed/.test(notifyText),
    'the delivery log carries booking messages');
  check('messages are rendered in Bangla', /[ঀ-৿]/.test(notifyText));

  // Take the primary SMS aggregator down and put it back.
  await page.click('tr:has-text("SSLWIRELESS") button:has-text("Take down")');
  await page.waitForTimeout(1000);
  check('an aggregator can be taken out of service',
    (await page.locator('tr:has-text("SSLWIRELESS") .pill-danger').count()) > 0);
  await page.click('tr:has-text("SSLWIRELESS") button:has-text("Bring back up")');
  await page.waitForTimeout(1000);
  check('and brought back', (await page.locator('tr:has-text("SSLWIRELESS") .pill-ok').count()) > 0);
  await shot('50-admin-notifications');

  await nav('Reconciliation', '/admin/recon');
  await page.waitForSelector('.staff-head', { timeout: 20000 });
  await page.click('button:has-text("Import files")');
  // Wait for the flash itself, not for any info notice: the empty-state notice
  // may already be on the page and would satisfy a looser wait instantly.
  await page.waitForSelector('text=gateway lines', { timeout: 25000 });
  check('a gateway file and a bank statement import',
    (await page.locator('text=gateway lines').first().innerText()).includes('gateway lines'));
  await page.click('button:has-text("Run the match")');
  await page.waitForTimeout(2500);
  await page.waitForSelector('.tiles', { timeout: 20000 });
  // Tile labels are upper-cased by the stylesheet, so compare case-insensitively.
  const reconText = norm(await page.locator('.staff-main').innerText());
  check('the three legs are compared side by side',
    reconText.includes('platform') && reconText.includes('gateway file')
    && reconText.includes('bank statement'),
    norm(await page.locator('.tiles').innerText()).slice(0, 90));
  check('exceptions are found and classified in plain words',
    /the gateway|the bank|amounts disagree|settled more than once/i.test(reconText));
  await shot('51-admin-recon');

  await nav('Risk & fraud', '/admin/risk');
  await page.waitForSelector('table.data tbody tr', { timeout: 20000 });
  const riskText = await page.locator('.staff-main').innerText();
  check('rules are listed with the mode they run in',
    /shadow/i.test(riskText) && /enforcing/i.test(riskText));
  check('the engine reports what it costs the booking path',
    /p95 evaluation/i.test(riskText));
  await shot('52-admin-risk');

  await nav('Partners', '/admin/partners');
  await page.waitForSelector('table.data tbody tr', { timeout: 20000 });
  await page.click('button:has-text("Dispatch due webhooks")');
  await page.waitForTimeout(2000);
  const partnerText = await page.locator('.staff-main').innerText();
  check('partners carry a tier and a quota', /sandbox|live/i.test(partnerText));
  check('the webhook delivery log is visible', partnerText.includes('Webhook deliveries'));
  await shot('53-admin-partners');

  await nav('Campaigns', '/admin/campaigns');
  await page.waitForSelector('table.data tbody tr', { timeout: 20000 });
  const campaignText = await page.locator('.staff-main').innerText();
  check('a capped campaign shows how much of it is left',
    /unlimited/i.test(campaignText) || /Left/.test(campaignText));
  await shot('54-admin-campaigns');

  /* ------------------------------------------- 12. the control centre ---- */
  console.log('\n=== 12. OPERATIONS CONTROL CENTRE ===');
  await signIn('owner@greenline.test');
  await nav('Control centre', '/operator/control');
  await page.waitForSelector('.tiles', { timeout: 20000 });
  await page.click('button:has-text("Run the detector now")');
  await page.waitForTimeout(2000);
  const occText = norm(await page.locator('.staff-main').innerText());
  check('the control room lists live buses', occText.includes('live buses'));
  check('it reports how many are sending a position', occText.includes('reporting position'),
    norm(await page.locator('.tiles').innerText()).slice(0, 90));
  await shot('55-operator-control');

  await signIn('dispatch@greenline.test');
  await page.goto(`${WEB}/operator/control`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tiles', { timeout: 20000 });
  check('a dispatcher may watch the control room', (await page.locator('.tiles').count()) > 0);
  check('but is not offered the buttons that act on it',
    (await page.locator('button:has-text("Acknowledge")').count()) === 0 &&
    (await page.locator('button:has-text("Seat conflicts")').count()) === 0);
  await shot('56-dispatcher-readonly');

  /* ---------------------------------------------------------- 13. console */
  console.log('\n=== 13. NO CONSOLE ERRORS ===');
  const real = errors.filter((e) =>
    !/favicon|React DevTools|Failed to load resource|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_CHANGED/i.test(e));
  check('no uncaught page errors', real.length === 0, real.slice(0, 3).join(' | '));

} catch (e) {
  failures++;
  console.log('\n  FAIL  exception:', e.message.split('\n')[0]);
  // Where it actually was. A screenshot on its own leaves you guessing whether
  // the page was wrong or the navigation never happened.
  console.log('        url:', page.url());
  console.log('        heading:', (await page.locator('h1').first().innerText().catch(() => '?')));
  if (errors.length) console.log('        page errors:\n          ' + errors.slice(-6).join('\n          '));
  await shot('99-staff-failure');
} finally {
  await browser.close();
}

console.log('\n' + '='.repeat(62));
console.log(failures === 0 ? 'ALL SIX STAFF APPS PASSED' : `${failures} CHECK(S) FAILED`);
console.log(`screenshots: apps/web/${SHOTS}`);
process.exit(failures === 0 ? 0 : 1);
