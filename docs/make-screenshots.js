// Regenerates the screenshots in docs/screenshots/ by driving the real app.
//
// Committed rather than done by hand, because screenshots go stale silently: the previous set was
// taken before the season screen's actions moved into its title row, and nothing flagged that the
// README was showing a button the app no longer has.
//
// Everything here is fabricated — invented kids, invented opponents, invented times. Nothing from
// a real account ever ends up in a public screenshot.
//
// Needs a *virgin* instance, since it walks through first-run setup:
//
//   docker build -t dadstats:shots .
//   docker run -d --name dadstats-shots -p 3260:3211 -v dadstats-shots:/app/data dadstats:shots
//   APP_URL=http://localhost:3260 node docs/make-screenshots.js
//   docker rm -f dadstats-shots && docker volume rm dadstats-shots
//
// ADMIN_PASSWORD is only needed for the /admin shot; omit it and that one is skipped.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const URL = process.env.APP_URL || 'http://localhost:3260';
const OUT = path.join(__dirname, 'screenshots');
const PHONE = { width: 414, height: 900 };

// A phone-shaped viewport, because that is where this app is used and what the README shows.
async function shot(page, name, opts) {
  await page.waitForTimeout(400);
  await page.screenshot(Object.assign({ path: path.join(OUT, name + '.png') }, opts || {}));
  console.log('  ' + name + '.png');
}

const ics = (events) => 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\n' + events.join('') + 'END:VCALENDAR\r\n';
const vevent = (uid, summary, dtstart) =>
  'BEGIN:VEVENT\r\nUID:' + uid + '\r\nDTSTART:' + dtstart + '\r\nSUMMARY:' + summary + '\r\nEND:VEVENT\r\n';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: PHONE, deviceScaleFactor: 2 });
  const dialogs = [];
  page.on('dialog', (d) => d.accept(dialogs.length ? dialogs.shift() : ''));
  page.on('pageerror', (e) => { console.error('PAGE ERROR:', e.message); process.exitCode = 1; });

  // A canned feed, so the schedule-import shot shows a real import rather than a mock-up.
  await page.route('**/api/ical-proxy**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, text: ics([
      vevent('d1', 'vs Riverside United', '20261003T180000'),
      vevent('d2', 'at Oak Hill FC', '20261010T173000'),
      vevent('d3', 'vs Bayside Rangers', '20261017T140000'),
      vevent('d4', 'at Fairview Athletic', '20261024T120000'),
      vevent('d5', 'vs Northgate Rovers', '20261031T153000'),
    ]) }),
  }));

  // ---- First run ----
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('#setupForm', { state: 'visible', timeout: 20000 });
  await shot(page, 'first-run');

  await page.fill('#setupName', 'The Example Family');
  await page.fill('#setupPassword', 'a-demo-password');
  await page.click('#setupSubmit');
  await page.waitForSelector('#addProfileBtn', { state: 'visible', timeout: 25000 });

  // ---- Add two kids ----
  async function addKid(name, sport) {
    await page.click('#addProfileBtn');
    await page.waitForSelector('#profileForm', { state: 'visible' });
    await page.fill('#profileNameInput', name);
    await page.selectOption('#profileSportInput', sport);
    await page.click('#profileForm button[type=submit]');
    await page.waitForSelector('[data-openseason]', { timeout: 10000 });
    await page.waitForTimeout(600);
  }
  // Walks up from wherever it is: tracker -> season -> profile -> home. Missing the tracker step
  // once left a "home" screenshot that was actually still showing a game.
  async function home() {
    for (let i = 0; i < 5 && !(await page.isVisible('#addProfileBtn')); i++) {
      if (await page.isVisible('#trackerBackBtn')) await page.click('#trackerBackBtn');
      else if (await page.isVisible('#seasonBackBtn')) await page.click('#seasonBackBtn');
      else if (await page.isVisible('#profileBackBtn')) await page.click('#profileBackBtn');
      await page.waitForTimeout(400);
    }
  }
  async function openKid(name) {
    for (const t of await page.$$('[data-openprofile]')) {
      if ((await t.$eval('.name', (e) => e.textContent.trim())) === name) { await t.click(); return; }
    }
    throw new Error('no kid named ' + name);
  }

  await addKid('Jordan', 'basketball');
  dialogs.push('Winter 2026');
  await page.click('[data-renameseason]');
  await page.waitForTimeout(500);
  await home();

  await addKid('Riley', 'swimming');
  dialogs.push('Summer Club');
  await page.click('[data-renameseason]');
  await page.waitForTimeout(500);
  await home();

  // ---- Jordan: a basketball season with three finished games and one live ----
  await openKid('Jordan');
  await page.waitForSelector('[data-openseason]', { timeout: 10000 });
  await page.click('[data-openseason]');
  await page.waitForSelector('#scheduleGameBtn', { timeout: 10000 });

  // Roster names reused across games, since Season Averages groups players by name.
  const ROSTER = ['Sam', 'Riley P.', 'Alex'];

  async function addRoster() {
    for (const n of ROSTER) {
      await page.click('#addPlayerBtn');
      await page.waitForTimeout(250);
      const inputs = await page.$$('.name-input');
      await inputs[inputs.length - 1].fill(n);
      await page.waitForTimeout(250);
    }
  }
  // Scoped to a card by index, so stats land on a chosen player rather than always the first.
  // Cards render in array order while nobody is on court, so index is stable here.
  async function tap(sel, times) {
    for (let i = 0; i < (times || 1); i++) {
      const b = await page.$(sel);
      if (!b) return;
      await b.click();
      await page.waitForTimeout(80);
    }
  }
  async function score(idx, s) {
    const at = (attr, key) => '[' + attr + '][data-key="' + key + '"][data-idx="' + idx + '"]';
    // data-miss carries the *miss* key, not the made one — misses give the percentages something
    // to divide by, so FG% isn't a flat 100%.
    await tap(at('data-make', 'made2'), s.made2);
    await tap(at('data-miss', 'miss2'), s.miss2);
    await tap(at('data-make', 'made3'), s.made3);
    await tap(at('data-miss', 'miss3'), s.miss3);
    await tap(at('data-make', 'made1'), s.made1);
    await tap(at('data-stat', 'reb'), s.reb);
    await tap(at('data-stat', 'ast'), s.ast);
    await tap(at('data-stat', 'stl'), s.stl);
  }
  // Dated explicitly rather than left at "now": a season whose games all share one timestamp
  // looks like test data, which is exactly what a screenshot shouldn't look like.
  async function setDate(value) {
    await page.fill('#gameDateInput', value);
    await page.waitForTimeout(250);
  }

  async function playGame(name, date, lines, team, opp, result) {
    dialogs.push(name);
    await page.click('#scheduleGameBtn');
    await page.waitForSelector('[data-make][data-key="made2"]', { timeout: 10000 });
    await addRoster();
    await setDate(date);
    for (let i = 0; i < lines.length; i++) await score(i, lines[i]);
    await page.fill('#teamScoreInput', String(team));
    await page.fill('#oppScoreInput', String(opp));
    await page.waitForTimeout(200);
    if (result) {
      await page.click(result === 'W' ? '#markWinBtn' : '#markLossBtn');
      await page.waitForTimeout(300);
    }
    await page.click('#trackerBackBtn');
    await page.waitForSelector('#scheduleGameBtn', { timeout: 10000 });
  }

  // Jordan (the profile's own card) plus two team-mates, so Season Averages has real rows.
  await playGame('vs Westbrook', '2026-01-09T18:30', [
    { made2: 6, miss2: 3, made3: 2, miss3: 2, made1: 3, reb: 7, ast: 4, stl: 2 },
    { made2: 4, miss2: 3, made3: 1, miss3: 2, made1: 2, reb: 4, ast: 6, stl: 1 },
    { made2: 3, miss2: 2, made3: 0, miss3: 1, made1: 1, reb: 6, ast: 1, stl: 0 },
  ], 48, 39, 'W');
  await playGame('at Eastview', '2026-01-16T19:00', [
    { made2: 4, miss2: 5, made3: 1, miss3: 3, made1: 2, reb: 6, ast: 5, stl: 1 },
    { made2: 3, miss2: 4, made3: 2, miss3: 2, made1: 0, reb: 3, ast: 4, stl: 2 },
    { made2: 2, miss2: 3, made3: 0, miss3: 2, made1: 2, reb: 5, ast: 0, stl: 1 },
  ], 34, 41, 'L');
  await playGame('vs Northside', '2026-01-23T18:00', [
    { made2: 7, miss2: 2, made3: 3, miss3: 1, made1: 1, reb: 9, ast: 3, stl: 3 },
    { made2: 5, miss2: 3, made3: 0, miss3: 2, made1: 4, reb: 5, ast: 7, stl: 0 },
    { made2: 4, miss2: 1, made3: 1, miss3: 1, made1: 0, reb: 7, ast: 2, stl: 2 },
  ], 45, 38, 'W');

  // A live game, so the list shows an IN PROGRESS chip next to finished ones.
  dialogs.push('vs Southgate');
  await page.click('#scheduleGameBtn');
  await page.waitForSelector('[data-make][data-key="made2"]', { timeout: 10000 });
  await addRoster();
  await setDate('2026-01-30T18:30');
  await score(0, { made2: 4, miss2: 2, made3: 1, miss3: 1, made1: 0, reb: 3, ast: 2, stl: 1 });
  await score(1, { made2: 2, miss2: 1, made3: 0, miss3: 1, made1: 2, reb: 2, ast: 3, stl: 0 });
  await page.fill('#teamScoreInput', '18');
  await page.fill('#oppScoreInput', '14');
  // Jordan on court — index 0, the card the stats above went to. On-court players sort to the
  // top, so this is what puts a card with real numbers and a running clock at the top of the
  // shot, with the rest collapsed to one-line strips beneath it. Subbing in anyone else would
  // float an all-zero card above it instead.
  await tap('[data-sub="0"]', 1);
  await page.waitForTimeout(600);
  // Freshly added players start expanded (see `added.expanded` in index.html) and only fall under
  // the bench-collapse rule once they've been collapsed or subbed out. Collapsing them here is
  // the steady state of a real game, and it's the behaviour the caption describes: one card for
  // whoever's on court, everyone else a one-line strip.
  // Re-queried each pass: collapsing one re-renders the card list, which detaches every other
  // handle taken from the previous render.
  for (let i = 0; i < 6; i++) {
    const el = await page.$('[data-collapse]');
    if (!el) break;
    await el.click();
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(1200);
  await shot(page, 'tracker');

  await page.click('#trackerBackBtn');
  await page.waitForSelector('.avg-table', { timeout: 10000 });
  await shot(page, 'season', { fullPage: true });

  // ---- A second season under the same kid, in a different sport ----
  await page.click('#seasonBackBtn');
  await page.waitForSelector('#addSeasonBtn', { timeout: 10000 });
  await page.click('#addSeasonBtn');
  await page.waitForSelector('#seasonForm', { state: 'visible' });
  await page.fill('#seasonNameInput', 'Spring 2026');
  await page.selectOption('#seasonSportInput', 'soccer');
  await page.click('#seasonForm button[type=submit]');
  await page.waitForTimeout(800);
  await shot(page, 'seasons');

  // Score a soccer game so the averages table shows soccer's columns, not basketball's.
  const soccerRow = await page.locator('[data-openseason]', { hasText: 'Spring 2026' }).first();
  await soccerRow.click();
  await page.waitForSelector('#scheduleGameBtn', { timeout: 10000 });
  dialogs.push('vs Riverside');
  await page.click('#scheduleGameBtn');
  await page.waitForSelector('[data-make][data-key="goals"]', { timeout: 10000 });
  await addRoster();
  await setDate('2026-04-11T10:00');
  const soccerAt = (attr, key, idx) => '[' + attr + '][data-key="' + key + '"][data-idx="' + idx + '"]';
  await tap(soccerAt('data-make', 'goals', 0), 2);
  await tap(soccerAt('data-miss', 'shotsOff', 0), 3);
  await tap(soccerAt('data-stat', 'ast', 0), 1);
  await tap(soccerAt('data-stat', 'tkl', 0), 2);
  await tap(soccerAt('data-make', 'goals', 1), 1);
  await tap(soccerAt('data-miss', 'shotsOff', 1), 2);
  await tap(soccerAt('data-stat', 'ast', 1), 2);
  await tap(soccerAt('data-stat', 'sv', 1), 3);
  await tap(soccerAt('data-stat', 'tkl', 2), 4);
  await tap(soccerAt('data-stat', 'foul', 2), 1);
  await page.fill('#teamScoreInput', '3');
  await page.fill('#oppScoreInput', '1');
  await page.click('#markWinBtn');
  await page.waitForTimeout(400);
  await page.click('#trackerBackBtn');
  await page.waitForSelector('.avg-table', { timeout: 10000 });
  await shot(page, 'soccer', { fullPage: true });

  // ---- Schedule import, on the soccer season ----
  await page.click('#icsAddBtn');
  await page.waitForSelector('#icsForm', { state: 'visible' });
  await page.fill('#icsUrlInput', 'https://ical-cdn.example.com/team_schedule/demo.ics');
  await page.click('#icsForm button[type=submit]');
  await page.waitForTimeout(2500);
  await shot(page, 'schedule-import', { fullPage: true });
  await page.waitForTimeout(300);

  // ---- A measurement sport: typed results and personal bests ----
  await home();
  await openKid('Riley');
  await page.waitForSelector('[data-openseason]', { timeout: 10000 });
  await page.click('[data-openseason]');
  await page.waitForSelector('#scheduleGameBtn', { timeout: 10000 });
  dialogs.push('County Meet');
  await page.click('#scheduleGameBtn');
  await page.waitForSelector('.result-add', { timeout: 10000 });
  async function addResult(event, value) {
    await page.selectOption('.result-add select', { label: event });
    await page.fill('.result-add input', value);
    await page.click('.result-save');
    await page.waitForTimeout(350);
  }
  await addResult('50 Free', '31.44');
  await addResult('100 Free', '1:09.80');
  await addResult('50 Back', '38.22');
  await page.waitForTimeout(400);
  await shot(page, 'swimming');

  // Taken last, so the tiles carry season counts and a real record rather than the blank state
  // they'd show if this were captured right after the kids were created.
  await home();
  await shot(page, 'home');

  // ---- Admin ----
  if (process.env.ADMIN_PASSWORD) {
    const admin = await browser.newPage({ viewport: PHONE, deviceScaleFactor: 2 });
    await admin.goto(URL + '/admin', { waitUntil: 'networkidle' });
    await admin.fill('#adminPassword', process.env.ADMIN_PASSWORD);
    await admin.click('#loginForm button[type=submit]');
    await admin.waitForSelector('#panel', { state: 'visible', timeout: 15000 });
    await admin.waitForTimeout(600);
    await admin.screenshot({ path: path.join(OUT, 'admin.png') });
    console.log('  admin.png');
    await admin.close();
  } else {
    console.log('  (skipped admin.png — set ADMIN_PASSWORD to include it)');
  }

  await browser.close();
  console.log('\ndone — ' + OUT);
})().catch((e) => { console.error('FATAL:', e && e.message); process.exit(1); });
