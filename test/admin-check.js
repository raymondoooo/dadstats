// Admin flow: sign in at /admin, create a family with a generated password, then confirm that
// password actually signs that family in. This covers the gate everything else depends on — if
// family creation breaks, nobody can get an account at all.
//
//   APP_URL=http://localhost:3208 ADMIN_PASSWORD=... node test/admin-check.js
const { chromium } = require('playwright');
const { APP_URL: URL } = require('./helpers');

const SHOTS = __dirname + '/screenshots';
const FAMILY_NAME = 'Test Family ' + Date.now();

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('response', (r) => {
    if (r.status() >= 400 && !r.url().endsWith('/api/admin/session')) {
      errors.push('http ' + r.status() + ' ' + r.url());
    }
  });

  await page.goto(URL + '/admin', { waitUntil: 'networkidle' });
  await page.waitForSelector('#adminPassword', { timeout: 10000 });
  await page.screenshot({ path: SHOTS + '/admin-login.png' });

  await page.fill('#adminPassword', process.env.ADMIN_PASSWORD);
  await page.click('#loginForm button[type=submit]');
  await page.waitForSelector('#createForm', { state: 'visible', timeout: 10000 });

  // Use the built-in suggester, then create a family.
  await page.fill('#newName', FAMILY_NAME);
  await page.click('#suggestBtn');
  const suggested = await page.inputValue('#newPassword');
  // Wait for the actual response, not a guessed timeout — creation is slow by design
  // (bcrypt compare against every existing family).
  const created = page.waitForResponse(
    (r) => r.url().endsWith('/api/admin/families') && r.request().method() === 'POST'
  );
  await page.click('#createForm button[type=submit]');
  await created;
  await page.waitForFunction(
    () => !document.querySelector('#createForm button[type=submit]').disabled,
    { timeout: 15000 }
  );
  await page.screenshot({ path: SHOTS + '/admin-created.png' });

  const msg = await page.textContent('#msg');
  const listText = await page.textContent('#familyList');

  console.log('suggested password:', suggested);
  console.log('banner:', msg.trim());
  console.log('list contains new family:', listText.includes(FAMILY_NAME));

  // The suggested password must actually work as a family login.
  const res = await fetch(URL + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: suggested }),
  });
  console.log('login with suggested password ->', res.status);

  console.log('errors:', errors.length ? errors.join(' | ') : 'none');
  const ok = res.status === 200 && listText.includes(FAMILY_NAME) && errors.length === 0
    && /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test(suggested);
  console.log(ok ? 'PASS' : 'FAIL');
  await browser.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
