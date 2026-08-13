// Two-device merge test: the sync contract from README § "Sync (the hard part)".
// Two independent browser contexts = two phones (separate cookie jars + separate localStorage),
// signing into the SAME family and scoring the SAME live game. The pass condition is that both
// devices converge on the UNION of both sets of taps, not whichever device saved last.
const { chromium } = require('playwright');

//
//   APP_URL=http://localhost:3208 ADMIN_PASSWORD=... node test/sync-check.js
const { provisionFamily, addProfile, APP_URL: URL } = require('./helpers');

const SHOTS = __dirname + '/screenshots';
// Set once the family is provisioned; both devices sign in with it, which is the real-world
// case — two parents given the same family password.
let PASSWORD;

function log(...a) { console.log(...a); }

async function newDevice(browser, label, errors) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`));
  page.on('response', (r) => {
    // 401 on the pre-login probe is expected (boot() checks for an existing session).
    if (r.status() >= 400 && !(r.status() === 401 && r.url().endsWith('/api/state'))) {
      errors.push(`${label} http ${r.status()} ${r.url()}`);
    }
  });
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('#loginPassword', { timeout: 10000 });
  await page.fill('#loginPassword', PASSWORD);
  await page.click('#loginForm button[type=submit]');
  return { ctx, page };
}

// Reads the first player card's derived totals straight off the rendered DOM.
async function readCard(page) {
  return page.evaluate(() => ({
    points: document.querySelector('.score') ? document.querySelector('.score').textContent.trim() : null,
    reb: (document.querySelector('[data-stat][data-key="reb"] .n') || {}).textContent,
    ast: (document.querySelector('[data-stat][data-key="ast"] .n') || {}).textContent,
    made2: (document.querySelector('[data-make][data-key="made2"] .n') || {}).textContent,
    made3: (document.querySelector('[data-make][data-key="made3"] .n') || {}).textContent,
    logChips: Array.from(document.querySelectorAll('.log-chip')).map((c) => c.textContent.trim()),
  }));
}

async function tap(page, sel, times = 1) {
  for (let i = 0; i < times; i++) {
    await page.click(sel);
    await page.waitForTimeout(150);
  }
}

(async () => {
  PASSWORD = await provisionFamily('Sync Test');

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const errors = [];

  // --- Device A: creates the account, the kid, the season, and the game ---
  const A = await newDevice(browser, 'A', errors);
  await addProfile(A.page, 'Sync Kid');
  await A.page.click('[data-openseason]');
  await A.page.waitForSelector('#scheduleGameBtn', { timeout: 10000 });
  A.page.once('dialog', (d) => d.accept('Sync Game'));
  await A.page.click('#scheduleGameBtn');
  await A.page.waitForSelector('[data-make][data-key="made2"]', { timeout: 10000 });
  log('device A: created kid + game, sitting on the tracker');

  // Let A's initial state reach the server before B signs in.
  await A.page.waitForTimeout(1500);

  // --- Device B: signs into the same family, should pull A's game down ---
  const B = await newDevice(browser, 'B', errors);
  // nav is part of the synced state, so B should land straight on the same tracker screen.
  await B.page.waitForSelector('[data-make][data-key="made2"]', { timeout: 15000 });
  log('device B: signed in and landed on the same game');

  const bBefore = await readCard(B.page);
  log('device B sees the shared game before any taps:', JSON.stringify(bBefore));

  // --- Concurrent scoring: each device taps DIFFERENT stats on the same player card ---
  await tap(A.page, '[data-make][data-key="made2"]', 2); // A: two 2PT makes  = 4 pts
  await tap(A.page, '[data-stat][data-key="reb"]', 1);   // A: one rebound
  await tap(B.page, '[data-make][data-key="made3"]', 1); // B: one 3PT make   = 3 pts
  await tap(B.page, '[data-stat][data-key="ast"]', 1);   // B: one assist
  log('both devices tapped; waiting for merge to settle');

  // SSE nudges each device to resync; the 20s poll is the belt-and-braces fallback.
  await A.page.waitForTimeout(6000);
  await B.page.waitForTimeout(500);

  const aAfter = await readCard(A.page);
  const bAfter = await readCard(B.page);

  await A.page.screenshot({ path: SHOTS + '/sync-device-A.png' });
  await B.page.screenshot({ path: SHOTS + '/sync-device-B.png' });

  // Expected union: 2x2PT + 1x3PT = 7 points, 1 reb, 1 ast, and 5 log entries on BOTH devices
  // (A contributed 3 taps, B contributed 2 — the union is all five, in timestamp order).
  const want = { points: '7', made2: '2', made3: '1', reb: '1', ast: '1', chips: 5 };
  function grade(label, got) {
    const fails = [];
    if (got.points !== want.points) fails.push(`points ${got.points} != ${want.points}`);
    if (got.made2 !== want.made2) fails.push(`made2 ${got.made2} != ${want.made2}`);
    if (got.made3 !== want.made3) fails.push(`made3 ${got.made3} != ${want.made3}`);
    if (got.reb !== want.reb) fails.push(`reb ${got.reb} != ${want.reb}`);
    if (got.ast !== want.ast) fails.push(`ast ${got.ast} != ${want.ast}`);
    if (got.logChips.length !== want.chips) fails.push(`log entries ${got.logChips.length} != ${want.chips}`);
    log(`device ${label}: ${JSON.stringify(got)}`);
    return fails;
  }

  const aFails = grade('A', aAfter);
  const bFails = grade('B', bAfter);

  log('\n=== RESULT ===');
  log('device A:', aFails.length ? 'FAIL -> ' + aFails.join('; ') : 'PASS (has the union of both devices\' taps)');
  log('device B:', bFails.length ? 'FAIL -> ' + bFails.join('; ') : 'PASS (has the union of both devices\' taps)');
  log('unexpected errors:', errors.length ? errors.join(' | ') : 'none');
  const ok = aFails.length === 0 && bFails.length === 0 && errors.length === 0;
  log(ok ? '\nOVERALL: PASS' : '\nOVERALL: FAIL');

  await browser.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
