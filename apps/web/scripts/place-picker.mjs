// Drives the new place picker the way a passenger would, in both languages.
import { chromium } from 'playwright';

const base = 'http://localhost:3000';
const shots = 'C:/Users/User/AppData/Local/Temp/claude/d--bus-ticket/5accf556-cd40-42ba-910b-9784e2109ded/scratchpad';
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? '  ok  ' : '  FAIL'} ${what}`); if (!ok) fails++; };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
const page = await ctx.newPage();

const rows = async () =>
  page.$$eval('.place-list .place-opt', (ns) => ns.map((n) => n.innerText.replace(/\s+/g, ' ').trim()));

/* ------------------------------------------------------------- english
   Set explicitly. The product defaults to Bangla, which is right for this
   market — so an English pass that does not say so is really a second Bangla
   pass, and the English strings go unread. */
await ctx.addCookies([{ name: 'jatra.lang', value: 'en', url: base }]);
await page.goto(base, { waitUntil: 'networkidle' });

await page.click('#from');
await page.waitForSelector('.place-list', { timeout: 5000 });
check((await rows()).length > 0, 'focus opens a list');

// Focus must select what is there, so typing a new place replaces the old one
// instead of appending to it.
check(await page.evaluate(() => {
  const el = document.querySelector('#from');
  return el.selectionStart === 0 && el.selectionEnd === el.value.length;
}), 'focus selects the existing value so typing replaces it');

// An EMPTY box is the interesting case: with nothing typed there is nothing to
// rank on, so the list must be somewhere a passenger can actually go.
await page.fill('#from', '');
await page.waitForTimeout(500);
const opening = await rows();
check(opening.length > 0, `an empty box still offers places (${opening.length})`);
check(!opening.some((r) => /no buses yet/i.test(r)), 'and every one of them is a place we serve');

// A misspelling a real person makes.
await page.fill('#from', 'chitagong');
await page.waitForTimeout(500);
const typo = await rows();
check(typo.some((r) => r.includes('Chattogram')), `"chitagong" still finds Chattogram — ${typo[0] ?? 'nothing'}`);

// The pre-2018 spelling that is still printed on people's old tickets.
await page.fill('#from', 'jessore');
await page.waitForTimeout(500);
const old = await rows();
check(old.some((r) => r.includes('Jashore')), `"jessore" finds Jashore — ${old[0] ?? 'nothing'}`);

// A terminal, which is what people in Dhaka actually name.
await page.fill('#from', 'gabtoli');
await page.waitForTimeout(500);
const term = await rows();
check(term.some((r) => r.includes('Gabtoli') && r.includes('Dhaka')),
  `"gabtoli" finds the terminal and says it is in Dhaka — ${term[0] ?? 'nothing'}`);

// Somewhere real that we do not serve must be shown, and labelled honestly.
await page.fill('#from', 'bandarban');
await page.waitForTimeout(500);
const cold = await rows();
check(cold.some((r) => r.includes('Bandarban')), 'a district we do not serve is still offered');
check(cold.some((r) => /no buses yet/i.test(r)), 'and it says so rather than pretending');

// Nonsense gets an honest empty state, not a silent blank.
await page.fill('#from', 'zzzzqqq');
await page.waitForTimeout(500);
check(await page.isVisible('.place-empty'), 'nonsense gets a "no place by that name" message');

/* ------------------------------------------ keyboard, and the value it commits */
await page.fill('#from', 'cumi');
await page.waitForTimeout(500);
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
check((await page.inputValue('#from')) === 'Cumilla',
  `Enter commits the canonical name, not the typing (got "${await page.inputValue('#from')}")`);
check(!(await page.isVisible('.place-list')), 'and closes the list');

// The form must not have submitted on that Enter.
check(new URL(page.url()).pathname === '/', 'choosing with Enter did not fire the search');

/* --------------------------------------------------------------- bangla
   The default, and the one that matters most: a passenger on a Bangla
   keyboard has to be able to type where they are going. */
await ctx.clearCookies();
await ctx.addCookies([{ name: 'jatra.lang', value: 'bn', url: base }]);
await page.goto(base, { waitUntil: 'networkidle' });
await page.click('#from');
await page.fill('#from', 'কুমি');
await page.waitForTimeout(600);
const bn = await rows();
check(bn.some((r) => r.includes('কুমিল্লা')), `typing Bangla finds the place — ${bn[0] ?? 'nothing'}`);
check(bn.length > 0 && /[A-Za-z]/.test(bn[0]), 'and shows the Latin name beside it');

await page.screenshot({ path: `${shots}/picker-bn.png` });

await page.fill('#from', 'ঢাকা');
await page.waitForTimeout(600);
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
check((await page.inputValue('#from')) === 'ঢাকা',
  `a Bangla reader sees the Bangla name in the box (got "${await page.inputValue('#from')}")`);

// The important half: what the box SHOWS is the reader's language, but what
// it SUBMITS is the canonical name the platform indexes. If these ever merge,
// a Bangla search silently stops resolving.
await page.fill('#to', 'সিলেট');
await page.waitForTimeout(600);
await page.keyboard.press('Enter');
await page.waitForTimeout(200);
await page.click('button[type="submit"]');
await page.waitForTimeout(1500);
const url = new URL(page.url());
check(url.searchParams.get('from') === 'Dhaka' && url.searchParams.get('to') === 'Sylhet',
  `the search submits canonical names, not the Bangla shown (from=${url.searchParams.get('from')} to=${url.searchParams.get('to')})`);

/* ----------------------------------------------- end to end: it still searches */
await page.goto(`${base}/search?from=Dhaka&to=Chattogram`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const found = await page.$$eval('main', (ns) => ns[0]?.innerText ?? '');
check(/বাস|bus/i.test(found), 'the search page still returns buses after the swap');

await browser.close();
console.log(fails === 0 ? '\nPLACE PICKER PASSED' : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
