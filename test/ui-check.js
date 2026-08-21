// End-to-end stat-math check: drives one browser session through login -> kid -> season -> game
// -> tapping stats -> finalizing -> Season Averages, and asserts the derived numbers.
//
// This is the regression test for the config-driven stat schema (SPORTS in public/index.html).
// Points, FG/FT lines, and every Season Averages column are computed from that config, so a bad
// edit there shows up here as wrong arithmetic rather than a crash.
//
//   APP_URL=http://localhost:3208 ADMIN_PASSWORD=... node test/ui-check.js
const { chromium } = require('playwright');
const { provisionFamily, addProfile, scheduleGame, APP_URL: URL } = require('./helpers');

const SHOTS = __dirname + '/screenshots';

(async () => {
  // Families are admin-created now, so provision one before the browser ever opens.
  const familyPassword = await provisionFamily('UI Test');

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));
  page.on('response', (res) => {
    // 401 on the pre-login probe is expected: boot() hits /api/state to detect an existing
    // session and shows the login form when there isn't one.
    if (res.status() >= 400 && !(res.status() === 401 && res.url().endsWith('/api/state'))) {
      errors.push('http ' + res.status() + ' ' + res.url());
    }
  });

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('#loginPassword', { timeout: 10000 });
  await page.fill('#loginPassword', familyPassword);
  await page.click('#loginForm button[type=submit]');

  await addProfile(page, 'Test Kid');

  await page.click('[data-openseason]');
  await page.waitForSelector('#scheduleGameBtn', { timeout: 10000 });

  // Naming a game goes through the in-page dialog, then navigates straight into the tracker.
  await scheduleGame(page, 'Test Game');
  await page.waitForSelector('[data-make][data-key="made2"]', { timeout: 10000 });

  async function tap(sel) {
    const btn = await page.$(sel);
    if (!btn) { errors.push('missing button ' + sel); return; }
    await btn.click();
    await page.waitForTimeout(120);
  }
  // 2 + 3 + 1 = 6 points, plus one rebound and one assist.
  await tap('[data-make][data-key="made2"]');
  await tap('[data-make][data-key="made3"]');
  await tap('[data-make][data-key="made1"]');
  await tap('[data-stat][data-key="reb"]');
  await tap('[data-stat][data-key="ast"]');

  const scoreText = (await page.textContent('.score')).trim();
  const statRowText = (await page.textContent('.stat-row')).replace(/\s+/g, ' ').trim();
  await page.screenshot({ path: SHOTS + '/tracker.png' });

  // Finalize as a Win, then back out to the season screen to read Season Averages. (There was a
  // dialog handler armed here for years; finalizing has never shown one, so it never fired.)
  await page.click('#markWinBtn');
  await page.waitForTimeout(300);
  await page.click('#trackerBackBtn');
  await page.waitForSelector('.avg-table', { timeout: 10000 });
  await page.screenshot({ path: SHOTS + '/season-averages.png' });

  const cells = await page.$$eval('.avg-table tbody tr td', (tds) =>
    tds.map((td) => td.textContent.trim())
  );
  // Columns: Player, GP, PPG, RPG, APG, SPG, BPG, TOPG, FG%, 3P%, FT%, MPG
  const [name, gp, ppg, rpg, apg, spg, bpg, topg, fgPct, p3Pct, ftPct] = cells;

  const fails = [];
  const eq = (label, got, want) => { if (got !== want) fails.push(`${label}: got ${got}, want ${want}`); };

  eq('card points', scoreText, '6');
  // The middot separators are their own spans with no whitespace between them in the DOM.
  eq('card stat row', statRowText, '2/2 FG·100%·1/1 FT');
  eq('averages name', name, 'Test Kid');
  eq('GP', gp, '1');
  eq('PPG', ppg, '6.0');
  eq('RPG', rpg, '1.0');
  eq('APG', apg, '1.0');
  eq('SPG', spg, '0.0');
  eq('BPG', bpg, '0.0');
  eq('TOPG', topg, '0.0');
  eq('FG%', fgPct, '100%');
  eq('3P%', p3Pct, '100%');
  eq('FT%', ftPct, '100%');

  console.log('card:', scoreText, 'pts |', statRowText);
  console.log('averages row:', cells.join(' | '));
  console.log('unexpected errors:', errors.length ? errors.join(' | ') : 'none');
  console.log(fails.length ? '\nFAIL\n  ' + fails.join('\n  ') : '\nPASS');

  await browser.close();
  process.exit(fails.length || errors.length ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
