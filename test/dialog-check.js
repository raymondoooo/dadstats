// The shared in-page dialog: cancelling, dismissing, and validation.
//
// The other suites only ever confirm, which means they'd all still pass if Cancel silently did
// nothing, if Esc left the dialog stuck open, or if the promise never settled and the app quietly
// stopped responding to that button for the rest of the session. Those are the failure modes that
// matter most for something replacing prompt()/confirm(): the confirm path is the one everybody
// tests, and the dismiss paths are the ones people actually hit by accident.
//
//   APP_URL=http://localhost:3208 ADMIN_PASSWORD=... node test/dialog-check.js
const { chromium } = require('playwright');
const { provisionFamily, addProfile, scheduleGame, confirmDialog, APP_URL: URL } = require('./helpers');

const fails = [];
const ok = (m) => console.log('  ok    ' + m);
const bad = (m) => { console.log('  FAIL  ' + m); fails.push(m); };

const openNames = (page) =>
  page.$$eval('[data-openprofile] .name', (e) => e.map((x) => x.textContent.trim()));

(async () => {
  const password = await provisionFamily('Dialog Test');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 414, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('dialog', (d) => { errors.push('native dialog leaked through: ' + d.message()); d.dismiss(); });

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('#loginPassword', { timeout: 15000 });
  await page.fill('#loginPassword', password);
  await page.click('#loginForm button[type=submit]');
  await addProfile(page, 'Keeper', 'basketball');

  // Back to the home screen, where rename/delete live.
  await page.click('#profileBackBtn');
  await page.waitForSelector('#addProfileBtn', { state: 'visible', timeout: 10000 });

  // --- Cancel must leave things exactly as they were ---
  await page.click('[data-delprofile]');
  await page.waitForSelector('#modal[open]', { timeout: 5000 });
  await page.click('#modalCancel');
  await page.waitForTimeout(500);
  const afterCancel = await openNames(page);
  afterCancel.includes('Keeper')
    ? ok('cancelling a delete keeps the profile')
    : bad(`profile deleted despite cancel: ${JSON.stringify(afterCancel)}`);
  (await page.isVisible('#modal')) === false
    ? ok('cancel closes the dialog')
    : bad('dialog stayed open after cancel');

  // --- Esc must behave like cancel, not like confirm ---
  await page.click('[data-delprofile]');
  await page.waitForSelector('#modal[open]', { timeout: 5000 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  const afterEsc = await openNames(page);
  afterEsc.includes('Keeper')
    ? ok('Escape cancels rather than confirming')
    : bad(`profile deleted by Escape: ${JSON.stringify(afterEsc)}`);

  // --- The same control must still work afterwards. If the promise never settled, the dialog
  // --- would refuse to reopen and the button would look dead. This is the regression that a
  // --- promise-based replacement for confirm() is most likely to introduce.
  await page.click('[data-renameprofile]');
  const reopened = await page.waitForSelector('#modal[open]', { timeout: 5000 })
    .then(() => true).catch(() => false);
  reopened ? ok('a dialog reopens after being dismissed') : bad('dialog would not reopen after Escape');

  // --- Rename: validation rejects an empty value rather than saving a nameless profile ---
  if (reopened) {
    await page.fill('#modalInput', '   ');
    await page.click('#modalConfirm');
    await page.waitForTimeout(300);
    const stillOpen = await page.isVisible('#modal');
    const errText = (await page.textContent('#modalError')).trim();
    stillOpen && errText
      ? ok(`an empty name is refused with a message ("${errText}")`)
      : bad(`empty name accepted (open=${stillOpen}, error=${JSON.stringify(errText)})`);

    await page.fill('#modalInput', 'Renamed Kid');
    await page.click('#modalConfirm');
    await page.waitForTimeout(800);
    const renamed = await openNames(page);
    renamed.includes('Renamed Kid')
      ? ok('a valid rename applies')
      : bad(`rename did not apply: ${JSON.stringify(renamed)}`);
  }

  // --- Scheduling a game accepts an empty name, unlike rename: "name it later" is legitimate ---
  await page.click('[data-openprofile]');
  await page.waitForSelector('[data-openseason]', { timeout: 10000 });
  await page.click('[data-openseason]');
  await page.waitForSelector('#scheduleGameBtn', { timeout: 10000 });
  await page.click('#scheduleGameBtn');
  await page.waitForSelector('#modal[open]', { timeout: 5000 });
  await page.fill('#modalInput', '');
  await page.click('#modalConfirm');
  await page.waitForTimeout(800);
  const inTracker = await page.isVisible('#trackerBackBtn');
  inTracker
    ? ok('an unnamed game is allowed and falls back to a default name')
    : bad('submitting an empty game name did nothing');

  if (inTracker) {
    const gameName = await page.inputValue('#gameNameInput');
    /^Game \d+$/.test(gameName)
      ? ok(`unnamed game got a fallback name ("${gameName}")`)
      : bad(`unexpected fallback name: ${JSON.stringify(gameName)}`);
    await page.click('#trackerBackBtn');
    await page.waitForSelector('#scheduleGameBtn', { timeout: 10000 });
  }

  // --- Reset Stats is destructive and must not fire on cancel ---
  await scheduleGame(page, 'Cancel Test');
  await page.waitForSelector('[data-make][data-key="made2"]', { timeout: 10000 });
  await page.click('[data-make][data-key="made2"]');
  await page.waitForTimeout(300);
  const before = (await page.textContent('.score')).trim();
  await page.click('#resetStatsBtn');
  await page.waitForSelector('#modal[open]', { timeout: 5000 });
  await page.click('#modalCancel');
  await page.waitForTimeout(600);
  const afterResetCancel = (await page.textContent('.score')).trim();
  afterResetCancel === before
    ? ok(`cancelling Reset Stats keeps the stats (${before} pts)`)
    : bad(`stats changed on cancel: ${before} -> ${afterResetCancel}`);

  // ...and does fire on confirm.
  await page.click('#resetStatsBtn');
  await confirmDialog(page, 'reset stats');
  await page.waitForTimeout(800);
  const afterReset = (await page.textContent('.score')).trim();
  afterReset === '0'
    ? ok('confirming Reset Stats clears them')
    : bad(`reset did not clear: ${afterReset}`);

  console.log('errors:', errors.length ? errors.join(' | ') : 'none');
  await browser.close();
  console.log();
  console.log(fails.length || errors.length ? `FAIL (${fails.length + errors.length})` : 'PASS');
  process.exit(fails.length || errors.length ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e && e.message); process.exit(1); });
