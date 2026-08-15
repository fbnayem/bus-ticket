// Visual check across the axes that actually differ: language, viewport, theme.
import { chromium } from 'playwright';

const dir = process.argv[2];
const base = 'http://localhost:3000';
const b = await chromium.launch();

async function shot(name, { lang = 'bn', width = 360, height = 800, url = '/', full = false, theme } = {}) {
  const ctx = await b.newContext({
    viewport: { width, height }, deviceScaleFactor: 2,
    colorScheme: theme === 'dark' ? 'dark' : 'light',
  });
  await ctx.addCookies([{ name: 'jatra.lang', value: lang, url: base }]);
  const p = await ctx.newPage();
  await p.goto(base + url, { waitUntil: 'networkidle' });
  await p.screenshot({ path: `${dir}/${name}.png`, fullPage: full });
  await ctx.close();
}

await shot('home-bn-360', { lang: 'bn', width: 360, height: 780 });
await shot('home-en-1280', { lang: 'en', width: 1280, height: 900 });
await shot('home-bn-360-dark', { lang: 'bn', width: 360, height: 780, theme: 'dark' });

await b.close();
console.log('ok');
