// Ties: recording a drawn game, and keeping the option away from sports that can't draw.
//
// Soccer, hockey, field hockey, lacrosse and youth baseball all end level regularly, and until
// now the only outcomes were Win and Loss — so a drawn game had to be recorded as a lie or left
// unfinalized, and an unfinalized game is excluded from Season Averages entirely.
//
// The gating is the half most likely to rot: `allowsTie` lives in the SPORTS config next to
// usesClock, and it would be easy for a future edit to show Tie everywhere (wrong for basketball,
// which goes to overtime) or nowhere (which is the bug this fixes).
//
//   APP_URL=http://localhost:3208 ADMIN_PASSWORD=... node test/tie-check.js
const { chromium } = require('playwright');
const { provisionFamily, addProfile, scheduleGame, APP_URL: URL } = require('./helpers');

const fails = [];
const ok = (m) => console.log('  ok    ' + m);
const bad = (m) => { console.log('  FAIL  ' + m); fails.push(m); };

(async () => {
  const password = await provisionFamily('Tie Test');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 414, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('dialog', (d) => { errors.push('native dialog: ' + d.message()); d.dismiss(); });

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('#loginPassword', { timeout: 15000 });
  await page.fill('#loginPassword', password);
  await page.click('#loginForm button[type=submit]');

  // --- Soccer: Tie is offered ---
  await addProfile(page, 'Draw Kid', 'soccer');
  await page.click('[data-openseason]');
  await page.waitForSelector('#scheduleGameBtn', { timeout: 10000 });

  await scheduleGame(page, 'vs Rovers');
  await page.waitForSelector('[data-make][data-key="goals"]', { timeout: 10000 });
  (await page.isVisible('#markTieBtn'))
    ? ok('soccer offers a Tie button')
    : bad('soccer has no Tie button');

  // A tap so the game counts as played, then finalize as a draw.
  await page.click('[data-make][data-key="goals"]');
  await page.waitForTimeout(300);
  await page.click('#markTieBtn');
  await page.waitForTimeout(600);

  const tieActive = await page.$eval('#markTieBtn', (e) => e.classList.contains('active'));
  const winActive = await page.$eval('#markWinBtn', (e) => e.classList.contains('active'));
  tieActive && !winActive
    ? ok('Tie shows as the active result, Win does not')
    : bad(`active states wrong (tie=${tieActive}, win=${winActive})`);

  const storedResult = await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('dadstats_v5'));
    const season = s.profiles.find((p) => !p.removed).seasons.find((x) => !x.removed);
    return season.games.map((g) => ({ finalized: g.finalized, result: g.result }));
  });
  JSON.stringify(storedResult) === JSON.stringify([{ finalized: true, result: 'T' }])
    ? ok("a drawn game stores result 'T' and is finalized")
    : bad(`stored as ${JSON.stringify(storedResult)}`);

  // --- The chip and the season record both show it ---
  await page.click('#trackerBackBtn');
  await page.waitForSelector('#scheduleGameBtn', { timeout: 10000 });
  const chip = (await page.textContent('#gameList .status-chip')).trim();
  chip === 'T' ? ok('the game list shows a T chip') : bad(`chip reads ${JSON.stringify(chip)}`);

  const record = (await page.textContent('.screen-title .record-chip') || '').replace(/\s+/g, '');
  record === '0–0–1'
    ? ok(`season record counts the draw (${record})`)
    : bad(`season record reads ${JSON.stringify(record)}, want 0–0–1`);

  // A finalized draw must count toward Season Averages — the whole reason a tie needs recording
  // rather than being left unfinalized.
  const gp = await page.$$eval('.avg-table tbody tr td', (tds) => tds.map((t) => t.textContent.trim()));
  gp[1] === '1'
    ? ok('a drawn game counts as a game played in Season Averages')
    : bad(`GP after a draw is ${JSON.stringify(gp[1])}, want 1`);

  // --- Basketball: Tie is not offered ---
  await page.click('#seasonBackBtn');
  await page.waitForSelector('#addSeasonBtn', { timeout: 10000 });
  await page.click('#addSeasonBtn');
  await page.waitForSelector('#seasonForm', { state: 'visible' });
  await page.fill('#seasonNameInput', 'Winter Hoops');
  await page.selectOption('#seasonSportInput', 'basketball');
  await page.click('#seasonForm button[type=submit]');
  await page.waitForTimeout(800);

  await page.locator('[data-openseason]', { hasText: 'Winter Hoops' }).first().click();
  await page.waitForSelector('#scheduleGameBtn', { timeout: 10000 });
  await scheduleGame(page, 'vs Hoops');
  await page.waitForSelector('[data-make][data-key="made2"]', { timeout: 10000 });

  (await page.isVisible('#markTieBtn')) === false
    ? ok('basketball hides the Tie button (it goes to overtime)')
    : bad('basketball offered a Tie button');
  (await page.isVisible('#markWinBtn')) && (await page.isVisible('#markLossBtn'))
    ? ok('Win and Loss remain for basketball')
    : bad('hiding Tie broke the other result buttons');

  console.log('errors:', errors.length ? errors.join(' | ') : 'none');
  await browser.close();
  console.log();
  console.log(fails.length || errors.length ? `FAIL (${fails.length + errors.length})` : 'PASS');
  process.exit(fails.length || errors.length ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e && e.message); process.exit(1); });
