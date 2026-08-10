// First-run setup check. Unlike the other tests this one needs a *virgin* instance — an
// instance with no families at all — because that's the only state where setup is offered.
//
//   APP_URL=http://localhost:3209 node test/setup-check.js
//
// Start one with a throwaway volume first:
//   docker run -d --name dadstats-fresh -p 3209:3108 -v dadstats-fresh-data:/app/data dadstats
//
// Covers the security property as much as the UX: once a family exists, setup must be closed.
const { chromium } = require('playwright');

const URL = process.env.APP_URL || 'http://localhost:3209';
const SHOTS = __dirname + '/screenshots';

(async () => {
  const status = await (await fetch(URL + '/api/setup')).json();
  if (!status.setupNeeded) {
    console.error('FATAL: instance already has families — point this at a fresh one.');
    process.exit(1);
  }

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('response', (r) => {
    // Expected non-2xx responses: the pre-login state probe, and the 400 this test deliberately
    // provokes by submitting a too-short password.
    const expected =
      (r.status() === 401 && r.url().endsWith('/api/state')) ||
      (r.status() === 400 && r.url().endsWith('/api/setup'));
    if (r.status() >= 400 && !expected) errors.push('http ' + r.status() + ' ' + r.url());
  });

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('#setupForm', { state: 'visible', timeout: 10000 });
  await page.screenshot({ path: SHOTS + '/setup-first-run.png' });

  const loginHidden = !(await page.isVisible('#loginForm'));

  // Too-short password must be refused rather than creating a weak first account.
  await page.fill('#setupName', 'The Firsts');
  await page.fill('#setupPassword', 'short');
  await page.click('#setupSubmit');
  await page.waitForFunction(
    () => document.getElementById('setupError').textContent.trim().length > 0,
    { timeout: 10000 }
  );
  const shortErr = (await page.textContent('#setupError')).trim();

  // A valid setup should land straight in the app — no second sign-in.
  await page.fill('#setupPassword', 'first-family-pw');
  await page.click('#setupSubmit');
  await page.waitForSelector('#addProfileBtn', { state: 'visible', timeout: 20000 });
  await page.screenshot({ path: SHOTS + '/setup-signed-in.png' });

  const inApp = await page.isVisible('#addProfileBtn');

  // --- The gate: setup must now be closed ---
  const statusAfter = await (await fetch(URL + '/api/setup')).json();
  const secondAttempt = await fetch(URL + '/api/setup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Intruder', password: 'intruder-password' }),
  });
  const secondBody = await secondAttempt.json().catch(() => ({}));

  // And the password chosen at setup must work as a normal family login.
  const loginRes = await fetch(URL + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'first-family-pw' }),
  });

  const fails = [];
  const eq = (label, got, want) => { if (got !== want) fails.push(`${label}: got ${got}, want ${want}`); };

  eq('login form hidden during setup', loginHidden, true);
  if (!/at least 8/i.test(shortErr)) fails.push(`short-password error unhelpful: "${shortErr}"`);
  eq('landed in app without second sign-in', inApp, true);
  eq('setup closed afterwards', statusAfter.setupNeeded, false);
  eq('second setup attempt rejected', secondAttempt.status, 409);
  eq('chosen password works as a login', loginRes.status, 200);

  console.log('login form hidden during setup:', loginHidden);
  console.log('short-password error:', shortErr);
  console.log('in app after setup:', inApp);
  console.log('setupNeeded afterwards:', statusAfter.setupNeeded);
  console.log('second setup attempt:', secondAttempt.status, JSON.stringify(secondBody));
  console.log('login with chosen password:', loginRes.status);
  console.log('errors:', errors.length ? errors.join(' | ') : 'none');
  console.log(fails.length || errors.length ? '\nFAIL\n  ' + fails.join('\n  ') : '\nPASS');

  await browser.close();
  process.exit(fails.length || errors.length ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e && e.message); process.exit(1); });
