// Cache/account binding: a browser must not carry one account's data into another.
//
// localStorage is keyed by origin, and an origin outlives the container answering on it. Rebuild
// an instance on the same host:port — or sign a different family in — and the browser still holds
// the previous account's games. Without binding, the merge adopts them and uploads them into the
// new account: a real person saw their kids' names on a brand-new install, and the server had
// genuinely stored them.
//
// Run it as three phases against the same browser profile:
//   APP_URL=... node test/account-check.js seed        # instance A, create a profile
//   (destroy A, start B on the same port)
//   APP_URL=... node test/account-check.js after-setup # instance B, set up fresh
// then assert B's database contains no trace of A's profile.
//
// test/run-account-check.sh drives all of that end to end.
const { chromium } = require('playwright');
const { addProfile } = require('./helpers');
const URL = process.env.APP_URL;
const PROFILE = '/tmp/leak-profile';

async function run(label, fn) {
  const ctx = await chromium.launchPersistentContext(PROFILE, { args: ['--no-sandbox'] });
  const page = ctx.pages()[0] || (await ctx.newPage());
  // Nothing here should raise a native dialog any more — the app uses its own. Armed so a
  // regression is reported rather than silently auto-dismissed.
  page.on('dialog', (d) => { console.error('unexpected native dialog: ' + d.message()); d.dismiss(); });
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const out = await fn(page);
  await ctx.close();
  return out;
}

(async () => {
  const phase = process.argv[2];

  if (phase === 'seed') {
    await run('seed', async (page) => {
      await page.waitForSelector('#setupForm', { state: 'visible', timeout: 15000 });
      await page.fill('#setupName', 'The Real Family');
      await page.fill('#setupPassword', 'real-family-password');
      await page.click('#setupSubmit');
      await page.waitForSelector('#addProfileBtn', { state: 'visible', timeout: 25000 });
      await addProfile(page, 'Hayden');       // stand-in for a real kid's name
      await page.waitForTimeout(1500);
      console.log('  seeded a profile named Hayden');
    });
    return;
  }

  if (phase === 'check') {
    await run('check', async (page) => {
      const body = await page.textContent('body');
      const setupVisible = await page.isVisible('#setupForm').catch(() => false);
      const ls = await page.evaluate(() => {
        const raw = localStorage.getItem('dadstats_v5');
        if (!raw) return '(no localStorage)';
        const s = JSON.parse(raw);
        return (s.profiles || []).map((p) => p.name).join(', ') || '(no profiles)';
      });
      console.log('  setup screen shown:      ', setupVisible);
      console.log('  localStorage profiles:   ', ls);
      console.log('  "Hayden" visible on page:', body.includes('Hayden'));
    });
    return;
  }

  if (phase === 'after-setup') {
    await run('after-setup', async (page) => {
      await page.waitForSelector('#setupForm', { state: 'visible', timeout: 15000 });
      await page.fill('#setupName', 'Brand New Family');
      await page.fill('#setupPassword', 'brand-new-password');
      await page.click('#setupSubmit');
      await page.waitForSelector('#addProfileBtn, [data-openprofile]', { timeout: 25000 });
      await page.waitForTimeout(2000);
      const body = await page.textContent('body');
      const profiles = await page.$$eval('[data-openprofile]', (e) => e.map((x) => x.textContent.trim().split('\n')[0]));
      console.log('  after completing setup on the NEW instance:');
      console.log('    profiles shown:  ', JSON.stringify(profiles));
      console.log('    "Hayden" on page:', body.includes('Hayden'));
    });
    return;
  }

  console.error('usage: leak-repro.js seed|check|after-setup');
  process.exit(1);
})().catch((e) => { console.error('FATAL:', e && e.message); process.exit(1); });
