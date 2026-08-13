// Measurement sports: swimming, track, golf, bowling.
//
// These record a measured value per event rather than tap-counters, so the things worth
// asserting are different: that the flexible time parser reads what people actually type, that a
// personal best is derived correctly (and knows lower is better for a time but higher for a
// bowling score), and that a deleted result is tombstoned rather than spliced — the invariant
// every other sport depends on too.
//
//   APP_URL=http://localhost:3270 ADMIN_PASSWORD=... node test/measurement-check.js
const { chromium } = require('playwright');
const { provisionFamily, addProfile, APP_URL: URL } = require('./helpers');

const SHOTS = __dirname + '/screenshots';

(async () => {
  const password = await provisionFamily('Measurement Test');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 414, height: 900 } });
  const errors = [];
  const dialogQueue = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('dialog', (d) => d.accept(dialogQueue.length ? dialogQueue.shift() : ''));
  page.on('response', (r) => {
    if (r.status() >= 400 && !(r.status() === 401 && r.url().endsWith('/api/state'))) {
      errors.push('http ' + r.status() + ' ' + r.url());
    }
  });

  const fails = [];
  const eq = (label, got, want) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      fails.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
  };

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('#loginPassword', { timeout: 10000 });
  await page.fill('#loginPassword', password);
  await page.click('#loginForm button[type=submit]');

  // Left on the default so the swimming season added below is created through the season form,
  // exercising the tally -> measurement transition rather than starting already in it.
  await addProfile(page, 'Swimmer', 'basketball');

  // --- Swimming season ---
  await page.click('#addSeasonBtn');
  await page.waitForSelector('#seasonForm', { state: 'visible', timeout: 5000 });
  await page.fill('#seasonNameInput', 'Summer League');
  await page.selectOption('#seasonSportInput', 'swimming');
  await page.click('#seasonForm button[type=submit]');
  await page.waitForFunction(() => document.querySelectorAll('[data-openseason]').length === 2, { timeout: 5000 });

  await page.locator('[data-openseason]', { hasText: 'Summer League' }).first().click();
  await page.waitForSelector('#scheduleGameBtn', { timeout: 5000 });
  dialogQueue.push('County Meet');
  await page.click('#scheduleGameBtn');
  await page.waitForSelector('[data-resultvalue]', { timeout: 10000 });

  // The tally UI must be absent entirely — not merely empty.
  eq('no shot buttons in measurement mode', await page.$$eval('.shot-group', (e) => e.length), 0);
  eq('no stat buttons in measurement mode', await page.$$eval('[data-stat]', (e) => e.length), 0);
  eq('no sub button (swimming has no clock)', await page.$$eval('[data-sub]', (e) => e.length), 0);

  async function addResult(eventKey, text) {
    await page.selectOption('[data-resultevent="0"]', eventKey);
    await page.fill('[data-resultvalue="0"]', text);
    await page.click('[data-resultsave="0"]');
    await page.waitForTimeout(350);
  }

  // Each of these is a format a person might plausibly type for the same kind of value.
  await addResult('free50', '32.15');     // plain seconds
  await addResult('free100', '1:12.40');  // mm:ss.hh
  await addResult('free100', '1.10.90');  // dots instead of colons — a faster swim
  await addResult('back50', '41');        // whole seconds

  const shown = await page.$$eval('.result-row', (rows) =>
    rows.map((r) => r.querySelector('.result-event').textContent.trim() + '=' +
                    r.querySelector('.result-value').textContent.trim())
  );
  // Newest first.
  eq('parsed and formatted results', shown,
    ['50 Back=41.00', '100 Free=1:10.90', '100 Free=1:12.40', '50 Free=32.15']);

  // A bad value must be refused, not stored as NaN — one would poison every later best.
  await page.selectOption('[data-resultevent="0"]', 'free50');
  await page.fill('[data-resultvalue="0"]', 'not a time');
  await page.click('[data-resultsave="0"]');
  await page.waitForTimeout(300);
  const errText = (await page.textContent('[data-resulterror="0"]')).trim();
  if (!/couldn't read/i.test(errText)) fails.push(`bad input not rejected clearly: "${errText}"`);
  eq('bad input did not create a row', await page.$$eval('.result-row', (e) => e.length), 4);

  await page.screenshot({ path: SHOTS + '/measurement-meet.png' });

  // Results must survive sanitize(), which runs on every load and at the end of every merge.
  // Reloading forces that path deterministically — a background resync would exercise it too,
  // but only if one happened to land during the test, which is how this went unnoticed: an early
  // version of withDefaults rebuilt log entries from a field whitelist that omitted `value`, so
  // every result silently lost its number and disappeared with no error.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-resultvalue]', { timeout: 15000 });
  await page.waitForTimeout(500);
  const afterReload = await page.$$eval('.result-row', (rows) =>
    rows.map((r) => r.querySelector('.result-event').textContent.trim() + '=' +
                    r.querySelector('.result-value').textContent.trim())
  );
  // Aborts rather than continuing: with the results gone, every later assertion fails as a
// confusing downstream timeout instead of naming the actual cause.
  if (JSON.stringify(afterReload) !== JSON.stringify(shown)) {
    console.log('  results BEFORE reload:', shown.join('  '));
    console.log('  results AFTER reload: ', afterReload.join('  ') || '(none)');
    console.log('\nFAIL\n  results did not survive a reload — sanitize() is dropping a field ' +
                'from the log entry (this was `value` once already)');
    await browser.close();
    process.exit(1);
  }

  // --- Personal bests: lower is better for a time ---
  await page.click('#trackerBackBtn');
  await page.waitForSelector('.avg-table', { timeout: 10000 });
  await page.screenshot({ path: SHOTS + '/measurement-bests.png' });

  const pb = await page.$$eval('.avg-table tbody tr', (rows) =>
    rows.map((r) => Array.from(r.querySelectorAll('td')).map((td) => td.textContent.trim()))
  );
  // 100 Free swum twice: best is the faster 1:10.90, and it's also the latest, so it's flagged.
  const free100 = pb.find((r) => r[0] === '100 Free');
  eq('100 Free best is the faster time', free100 && free100[1].replace(/\s+/g, ' '), '1:10.90 PB');
  eq('100 Free attempts counted', free100 && free100[3], '2');
  const free50 = pb.find((r) => r[0] === '50 Free');
  eq('single-attempt event not flagged PB', free50 && free50[1], '32.15');

  // --- Bowling: the one sport where higher is better ---
  await page.click('#seasonBackBtn');
  await page.waitForSelector('[data-openseason]', { timeout: 5000 });
  await page.click('#addSeasonBtn');
  await page.waitForSelector('#seasonForm', { state: 'visible', timeout: 5000 });
  await page.fill('#seasonNameInput', 'Winter Bowling');
  await page.selectOption('#seasonSportInput', 'bowling');
  await page.click('#seasonForm button[type=submit]');
  await page.waitForTimeout(500);
  await page.locator('[data-openseason]', { hasText: 'Winter Bowling' }).first().click();
  await page.waitForSelector('#scheduleGameBtn', { timeout: 5000 });
  dialogQueue.push('League Night');
  await page.click('#scheduleGameBtn');
  await page.waitForSelector('[data-resultvalue]', { timeout: 10000 });

  await addResult('game', '142');
  await addResult('game', '96');   // worse, must NOT become the best
  await addResult('game', '155');  // better

  await page.click('#trackerBackBtn');
  await page.waitForSelector('.avg-table', { timeout: 10000 });
  const bowl = await page.$$eval('.avg-table tbody tr td', (t) => t.map((x) => x.textContent.trim()));
  // Flagged PB because the highest score is also the most recent one.
  eq('bowling best is the HIGHEST score', bowl[1].replace(/\s+/g, ' '), '155 PB');
  eq('bowling latest is the last entered', bowl[2], '155');
  eq('bowling attempts', bowl[3], '3');

  // --- Deleting a result tombstones it (and the best recomputes) ---
  await page.locator('[data-opengame]').first().click();
  await page.waitForSelector('[data-delresult]', { timeout: 10000 });
  const before = await page.$$eval('.result-row', (e) => e.length);
  await page.locator('[data-delresult]').first().click();  // newest = the 155
  await page.waitForTimeout(400);
  eq('a row disappears when removed', await page.$$eval('.result-row', (e) => e.length), before - 1);

  await page.click('#trackerBackBtn');
  await page.waitForSelector('.avg-table', { timeout: 10000 });
  const afterDel = await page.$$eval('.avg-table tbody tr td', (t) => t.map((x) => x.textContent.trim()));
  eq('best falls back after the top score is removed', afterDel[1], '142');

  console.log('  swimming results:', shown.join('  '));
  console.log('  bowling best/latest/tries:', bowl.slice(1).join(' / '));
  console.log('  after delete, best:', afterDel[1]);
  console.log('  errors:', errors.length ? errors.join(' | ') : 'none');
  console.log(fails.length || errors.length ? '\nFAIL\n  ' + fails.join('\n  ') : '\nPASS');

  await browser.close();
  process.exit(fails.length || errors.length ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e && e.message); process.exit(1); });
