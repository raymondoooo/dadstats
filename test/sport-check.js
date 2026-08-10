// Multi-sport check: one kid, two seasons, two different sports.
//
// Creates a soccer season alongside the default basketball one, scores a soccer game, and
// asserts the tracker and Season Averages both use soccer's schema — while the basketball
// season under the same kid still uses basketball's. That combination is the whole feature:
// the sport belongs to the season, not the profile.
//
//   APP_URL=http://localhost:3208 ADMIN_PASSWORD=... node test/sport-check.js
const { chromium } = require('playwright');
const { provisionFamily, APP_URL: URL } = require('./helpers');

const SHOTS = __dirname + '/screenshots';

(async () => {
  const password = await provisionFamily('Sport Test');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  // One persistent dialog handler fed by a queue. Using page.once() per prompt leaves a handler
  // armed whenever an expected dialog doesn't appear, and it then races the next one.
  const dialogQueue = [];
  page.on('dialog', (d) => d.accept(dialogQueue.length ? dialogQueue.shift() : ''));
  page.on('response', (r) => {
    if (r.status() >= 400 && !(r.status() === 401 && r.url().endsWith('/api/state'))) {
      errors.push('http ' + r.status() + ' ' + r.url());
    }
  });

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('#loginPassword', { timeout: 10000 });
  await page.fill('#loginPassword', password);
  await page.click('#loginForm button[type=submit]');

  await page.waitForSelector('#addProfileBtn', { timeout: 10000 });
  dialogQueue.push('Two Sport Kid');
  await page.click('#addProfileBtn');
  await page.waitForSelector('[data-openseason]', { timeout: 10000 });

  // --- Add a soccer season alongside the default basketball one ---
  await page.click('#addSeasonBtn');
  await page.waitForSelector('#seasonForm', { state: 'visible', timeout: 5000 });
  await page.fill('#seasonNameInput', 'Spring Soccer');
  await page.selectOption('#seasonSportInput', 'soccer');
  await page.click('#seasonForm button[type=submit]');
  await page.waitForFunction(
    () => document.querySelectorAll('[data-openseason]').length === 2,
    { timeout: 5000 }
  );
  await page.screenshot({ path: SHOTS + '/sport-seasons.png' });

  const seasonRows = await page.$$eval('[data-openseason]', (els) =>
    els.map((e) => e.textContent.replace(/\s+/g, ' ').trim())
  );

  // --- Score a soccer game ---
  const soccerRow = await page.$('[data-openseason]:has-text("Spring Soccer")');
  await soccerRow.click();
  await page.waitForSelector('#scheduleGameBtn', { timeout: 5000 });
  dialogQueue.push('vs Rovers');
  await page.click('#scheduleGameBtn');
  await page.waitForSelector('[data-make][data-key="goals"]', { timeout: 10000 });

  // Button faces should read Goal/Miss, not Make/Miss.
  const shotLabels = await page.$$eval('.shot-group .l', (els) => els.map((e) => e.textContent.trim()));
  const tallyLabels = await page.$$eval('.extra-stats .l', (els) => els.map((e) => e.textContent.trim()));
  const primaryLabel = (await page.textContent('.score-label')).trim();

  async function tap(sel) {
    await page.click(sel);
    await page.waitForTimeout(150);
  }
  await tap('[data-make][data-key="goals"]');   // Goal
  await tap('[data-make][data-key="goals"]');   // Goal
  await tap('[data-miss][data-key="shotsOff"]'); // missed shot
  await tap('[data-stat][data-key="ast"]');      // assist
  await tap('[data-stat][data-key="sv"]');       // save

  const primaryValue = (await page.textContent('.score')).trim();
  const logChips = await page.$$eval('.log-chip', (els) => els.map((e) => e.textContent.trim()));
  await page.screenshot({ path: SHOTS + '/sport-soccer-card.png' });

  // --- Finalize and read soccer's Season Averages columns ---
  await page.click('#markWinBtn');
  await page.waitForTimeout(300);
  await page.click('#trackerBackBtn');
  await page.waitForSelector('.avg-table', { timeout: 10000 });
  await page.screenshot({ path: SHOTS + '/sport-soccer-averages.png' });

  const soccerHeaders = await page.$$eval('.avg-table thead th', (els) => els.map((e) => e.textContent.trim()));
  const soccerCells = await page.$$eval('.avg-table tbody tr td', (els) => els.map((e) => e.textContent.trim()));

  const fails = [];
  const eq = (label, got, want) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) fails.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  };

  eq('shot button faces', shotLabels, ['Goal', 'Miss']);
  // Soccer tracks minutes, so Sub In leads the row ahead of the sport's own tally buttons.
  eq('tally button faces', tallyLabels, ['Sub In', 'A', 'SV', 'TK', 'F']);
  eq('primary label', primaryLabel, 'goals');
  eq('primary value (2 goals)', primaryValue, '2');
  eq('log chips', logChips, ['Shot Goal', 'Shot Goal', 'Shot Miss', 'A', 'SV']);
  // GP + soccer's own columns. No MPG: soccer uses a clock, so it should be present.
  eq('soccer avg headers', soccerHeaders,
    ['Player', 'GP', 'G', 'G/G', 'A', 'SH', 'SH%', 'SV', 'TK', 'F', 'MPG']);
  // Player, GP=1, G=2, G/G=2.0, A=1, SH=3, SH%=67%, SV=1, TK=0, F=0, MPG
  eq('soccer G', soccerCells[2], '2');
  eq('soccer A', soccerCells[4], '1');
  eq('soccer SH', soccerCells[5], '3');
  eq('soccer SH%', soccerCells[6], '67%');
  eq('soccer SV', soccerCells[7], '1');

  if (!seasonRows.some((r) => r.includes('Soccer'))) fails.push('season list missing soccer chip: ' + JSON.stringify(seasonRows));
  if (!seasonRows.some((r) => r.includes('Basketball'))) fails.push('season list missing basketball chip: ' + JSON.stringify(seasonRows));

  // --- The basketball season under the same kid must still be basketball ---
  await page.click('#seasonBackBtn');
  await page.waitForSelector('[data-openseason]', { timeout: 5000 });
  const bballRow = await page.$('[data-openseason]:has-text("Season 1")');
  await bballRow.click();
  await page.waitForSelector('[data-make][data-key="made2"], #scheduleGameBtn', { timeout: 5000 });
  dialogQueue.push('vs Hoops');
  await page.click('#scheduleGameBtn');
  await page.waitForSelector('[data-make][data-key="made2"]', { timeout: 10000 });
  const bballShots = await page.$$eval('.shot-group .shot-tag', (els) =>
    els.map((e) => e.textContent.trim().split('\n')[0])
  );
  const bballPrimary = (await page.textContent('.score-label')).trim();

  eq('basketball still has 3 shot types', bballShots.length, 3);
  eq('basketball primary label', bballPrimary, 'points');

  console.log('soccer shot faces:  ', shotLabels.join(' / '));
  console.log('soccer headers:     ', soccerHeaders.join(' | '));
  console.log('soccer row:         ', soccerCells.join(' | '));
  console.log('basketball primary: ', bballPrimary, '| shot groups:', bballShots.length);
  console.log('errors:', errors.length ? errors.join(' | ') : 'none');
  console.log(fails.length || errors.length ? '\nFAIL\n  ' + fails.join('\n  ') : '\nPASS');

  await browser.close();
  process.exit(fails.length || errors.length ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
