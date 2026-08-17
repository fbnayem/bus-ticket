// Reads every Bangla-facing page and reports English prose still on it —
// the passenger site, and the three staff workplaces that were promised Bangla.
//   node scripts/lang-audit.mjs [pnr]
//
// Not a translation checker — a *coverage* checker. Plenty of Latin text is
// correct here on purpose: fares, clock times, seat numbers, PNRs, phone
// numbers and place names are Latin in both locales by policy. What this looks
// for is runs of English WORDS, which is what an untranslated string looks like.
import { chromium } from 'playwright';

const base = 'http://localhost:3000';
const pnr = process.argv[2] ?? '';

const ROUTES = [
  ['home', '/'],
  ['search', '/search?from=Dhaka&to=Chattogram'],
  ['offers', '/offers'],
  ['support', '/support'],
  ['login', '/login'],
  ['find booking', '/manage'],
  ['account (signed out)', '/account'],
  ...(pnr ? [
    ['booking', `/manage/${pnr}`],
    ['reschedule', `/manage/${pnr}/reschedule`],
    ['tracking', `/tracking/${pnr}`],
    ['ticket', `/tickets/${pnr}`],
  ] : []),
];

// Words that are Latin on a Bangla page by design, or that arrive from data
// rather than from the interface.
const ALLOW = new Set([
  'jatra', 'dhaka', 'chattogram', 'cumilla', 'feni', 'sylhet', 'khulna', 'rajshahi',
  'barishal', 'rangpur', 'mymensingh', 'bogura', 'coxs', 'bazar', 'ctg',
  'green', 'line', 'hanif', 'shohagh', 'ena', 'shyamoli', 'metro',
  'ac', 'non', 'business', 'economy', 'chair', 'sleeper', 'premium', 'deluxe',
  'bkash', 'nagad', 'rocket', 'upay', 'visa', 'mastercard',
  'sms', 'pnr', 'qr', 'wifi', 'fi', 'en', 'id', 'nid',
  'help', 'jatra.test', 'test', 'am', 'pm',
]);

// The three frontline workplaces. The back-office consoles are English by
// decision — desk roles recruited for ledger and reconciliation literacy, whose
// vocabulary has no settled Bangla — so they are deliberately not listed here.
// Signing in is required, which is why they are a second pass rather than more
// rows in ROUTES.
const STAFF = [
  ['counter · sell',        'counter.dhaka@greenline.test', '/counter'],
  ['counter · held seats',  'counter.dhaka@greenline.test', '/counter/quota'],
  ['counter · sales',       'counter.dhaka@greenline.test', '/counter/sales'],
  ['counter · the cash',    'counter.dhaka@greenline.test', '/counter/shift'],
  ['crew · my trips',       'driver@greenline.test',        '/driver'],
  ['crew · check tickets',  'driver@greenline.test',        '/driver/scan'],
  ['crew · problems',       'driver@greenline.test',        '/driver/incidents'],
  ['agent · wallet',        'agent@shafi.test',             '/agent'],
  ['agent · sell',          'agent@shafi.test',             '/agent/sell'],
  ['agent · sold',          'agent@shafi.test',             '/agent/bookings'],
  ['agent · earnings',      'agent@shafi.test',             '/agent/commissions'],
  ['agent · top-ups',       'agent@shafi.test',             '/agent/recharge'],
  ['the one door',          null,                           '/staff/login'],
];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
await ctx.addCookies([{ name: 'jatra.lang', value: 'bn', url: base }]);
const page = await ctx.newPage();

let total = 0;
for (const [name, path] of ROUTES) {
  await page.goto(base + path, { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(700);
  // main only: the dev-tools badge and the language switch are not the product.
  //
  // Machine references are stripped first. A PNR, a QR token and a bus
  // registration are Latin in both locales by policy, and leaving them in made
  // this cry wolf over a line that was already correct — which is how a
  // checker stops being read.
  const text = await page.evaluate(() => {
    const main = document.querySelector('main');
    if (!main) return '';
    // Hidden in place and put back, rather than read off a detached clone:
    // innerText needs layout, and a cloned node has none, so a clone collapses
    // the whole page onto one line and every page looks like a violation.
    const refs = [...main.querySelectorAll('.ref, .mono, code')];
    const prior = refs.map((n) => n.style.display);
    refs.forEach((n) => { n.style.display = 'none'; });
    const out = main.innerText;
    refs.forEach((n, i) => { n.style.display = prior[i]; });
    return out;
  }).catch(() => '');
  const runs = [];
  for (const line of text.split('\n')) {
    const words = (line.match(/[A-Za-z][A-Za-z']{2,}/g) ?? [])
      .filter((w) => !ALLOW.has(w.toLowerCase()));
    if (words.length >= 3) runs.push(line.trim().slice(0, 100));
  }
  total += runs.length;
  console.log(`${runs.length === 0 ? '  ok  ' : '  ENG '} ${name}`);
  for (const r of runs.slice(0, 4)) console.log(`         ${r}`);
}

/* ------------------------------------------------------------------ staff */
console.log('');
let signedInAs = null;
for (const [name, account, path] of STAFF) {
  if (account && account !== signedInAs) {
    await page.goto(base + '/staff/login', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { try { localStorage.clear(); } catch { /* ignore */ } });
    await page.goto(base + '/staff/login', { waitUntil: 'domcontentloaded' });
    await page.fill('#email', account);
    await page.fill('#password', 'Jatra#2026');
    await page.click('[data-act="staff-signin"]');
    await page.waitForTimeout(2500);
    signedInAs = account;
  }
  await page.goto(base + path, { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(900);
  // .staff-main, not the whole page: the rail carries the workplace name and
  // the language switch, neither of which is the screen being audited.
  //
  // Two passes, because a staff screen is mostly a table.
  //
  //   chrome — headings, labels, buttons, notices and table HEADERS. Interface,
  //            and therefore translatable. A table BODY is excluded, along with
  //            the subtitle under a workplace heading: those hold a counter's
  //            name, an agency's name, a driver's own words about a bridge.
  //            That is data. No catalogue will ever contain it, and flagging it
  //            is how a checker teaches people to stop reading its output.
  //   pills  — status chips DO sit inside table bodies and ARE interface, so
  //            they get their own pass with no tolerance at all: a Bangla pill
  //            contains zero English words, not merely fewer than three.
  const { chrome, pills } = await page.evaluate(() => {
    const root = document.querySelector('.staff-main')
      ?? document.querySelector('main') ?? document.body;
    const chips = [...root.querySelectorAll('.pill')].map((n) => n.innerText);
    const hidden = [...root.querySelectorAll(
      '.ref, .mono, code, .demo-list, tbody, .staff-head p')];
    const prior = hidden.map((n) => n.style.display);
    hidden.forEach((n) => { n.style.display = 'none'; });
    const out = root.innerText;
    hidden.forEach((n, i) => { n.style.display = prior[i]; });
    return { chrome: out, pills: chips };
  }).catch(() => ({ chrome: '', pills: [] }));
  const text = chrome;
  const runs = [];
  for (const chip of new Set(pills)) {
    const bad = (chip.match(/[A-Za-z][A-Za-z']{2,}/g) ?? [])
      .filter((w) => !ALLOW.has(w.toLowerCase()));
    if (bad.length > 0) runs.push(`pill: ${chip.trim()}`);
  }
  for (const line of text.split('\n')) {
    const words = (line.match(/[A-Za-z][A-Za-z']{2,}/g) ?? [])
      .filter((w) => !ALLOW.has(w.toLowerCase()));
    if (words.length >= 3) runs.push(line.trim().slice(0, 100));
  }
  total += runs.length;
  console.log(`${runs.length === 0 ? '  ok  ' : '  ENG '} ${name}`);
  for (const r of runs.slice(0, 4)) console.log(`         ${r}`);
}

await browser.close();
console.log(`\n${total === 0 ? 'NO ENGLISH PROSE ON THE BANGLA SURFACES' : total + ' LINE(S) STILL IN ENGLISH'}`);
process.exit(total === 0 ? 0 : 1);
