// Calendar feed import: parsing and reconciliation, via request interception.
//
// The server-side SSRF guard (server/icalProxy.js) means a real fixture ics server would have to
// live at a private address to be reachable from a container in CI — which the guard correctly
// refuses. Testing that live would mean weakening the very protection those checks exist to
// verify (see ical-guard-check.js and security-check.js for that coverage instead). This suite
// intercepts the browser's request to /api/ical-proxy and answers it directly with canned ics
// text, so it tests exactly the part that's actually novel here — parsing and reconciliation —
// without touching the server's network boundary at all.
//
//   APP_URL=http://localhost:3270 ADMIN_PASSWORD=... node test/ical-check.js
const { chromium } = require('playwright');
const { provisionFamily, addProfile, confirmDialog, APP_URL: URL } = require('./helpers');

const fails = [];
const eq = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fails.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
};
const ok = (label, cond) => { if (!cond) fails.push(label); };

function ics(events) {
  return 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\n' + events.join('') + 'END:VCALENDAR\r\n';
}
function vevent({ uid, summary, dtstart, status }) {
  return 'BEGIN:VEVENT\r\n' +
    'UID:' + uid + '\r\n' +
    'DTSTART:' + dtstart + '\r\n' +
    'SUMMARY:' + summary + '\r\n' +
    (status ? 'STATUS:' + status + '\r\n' : '') +
    'END:VEVENT\r\n';
}

(async () => {
  const password = await provisionFamily('ICS Test');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 414, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('response', (r) => {
    // /api/ical-proxy is intercepted below and deliberately answers with an error in one case —
    // that's the thing under test there, not a bug to flag.
    if (r.status() >= 400 && !r.url().includes('/api/ical-proxy') &&
        !(r.status() === 401 && r.url().endsWith('/api/state'))) {
      errors.push('http ' + r.status() + ' ' + r.url());
    }
  });

  // Swapped out by each scenario below; the route handler always reads the current value, so a
  // test can change what "the feed" says between one sync and the next.
  let feedResponse = { status: 200, body: '' };
  await page.route('**/api/ical-proxy**', (route) => {
    route.fulfill({
      status: feedResponse.status,
      contentType: 'application/json',
      body: JSON.stringify(feedResponse.status === 200 ? { ok: true, text: feedResponse.body } : { error: feedResponse.body }),
    });
  });

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('#loginPassword', { timeout: 10000 });
  await page.fill('#loginPassword', password);
  await page.click('#loginForm button[type=submit]');
  await addProfile(page, 'Feed Kid', 'soccer'); // lands on the profile screen (its season list)
  await page.click('[data-openseason]'); // into "Season 1", where the feed importer lives
  await page.waitForSelector('#scheduleGameBtn', { timeout: 10000 });

  function gameRows() {
    return page.$$eval('#gameList [data-opengame]', (rows) => rows.map((r) => ({
      name: r.querySelector('.row-name').textContent.trim(),
      date: r.querySelector('.row-meta').textContent.trim(),
    })));
  }
  function connectFeed(url) {
    return (async () => {
      await page.click('#icsAddBtn');
      await page.waitForSelector('#icsForm', { state: 'visible' });
      await page.fill('#icsUrlInput', url);
      await page.click('#icsForm button[type=submit]');
      await page.waitForTimeout(1500);
    })();
  }
  function syncAgain() {
    return (async () => {
      await page.click('#icsSyncBtn');
      await page.waitForTimeout(1500);
    })();
  }

  // --- Initial import: two events, one UTC, one floating time ---
  feedResponse = { status: 200, body: ics([
    vevent({ uid: 'game-1', summary: 'vs Eagles', dtstart: '20260901T180000Z' }),
    vevent({ uid: 'game-2', summary: 'vs Hawks', dtstart: '20260908T173000' }),
  ]) };
  await connectFeed('https://example.com/team.ics');

  let rows = await gameRows();
  eq('two games created from the feed', rows.map((r) => r.name).sort(), ['vs Eagles', 'vs Hawks']);

  const statusText = await page.textContent('#icsStatus');
  ok('sync status reports what happened', /added/.test(statusText));

  // --- Cancelled event is skipped on import ---
  feedResponse = { status: 200, body: ics([
    vevent({ uid: 'game-1', summary: 'vs Eagles', dtstart: '20260901T180000Z' }),
    vevent({ uid: 'game-2', summary: 'vs Hawks', dtstart: '20260908T173000' }),
    vevent({ uid: 'game-3', summary: 'vs Wolves', dtstart: '20260915T170000Z', status: 'CANCELLED' }),
  ]) };
  await syncAgain();
  rows = await gameRows();
  eq('a CANCELLED event is not imported', rows.some((r) => r.name === 'vs Wolves'), false);

  // --- Re-sync with one event's time/name changed updates the existing game, doesn't duplicate ---
  feedResponse = { status: 200, body: ics([
    vevent({ uid: 'game-1', summary: 'vs Eagles (rescheduled)', dtstart: '20260903T190000Z' }),
    vevent({ uid: 'game-2', summary: 'vs Hawks', dtstart: '20260908T173000' }),
  ]) };
  await syncAgain();
  rows = await gameRows();
  eq('still exactly two games after a re-sync', rows.length, 2);
  ok('the changed event updated its existing game', rows.some((r) => r.name === 'vs Eagles (rescheduled)'));
  ok('the unchanged event was left as-is', rows.some((r) => r.name === 'vs Hawks'));

  // --- A scored game's stats survive a re-sync that changes its schedule metadata ---
  await page.click('[data-opengame]'); // whichever sorts first; either has no stats yet
  await page.waitForSelector('[data-stat], #trackerBackBtn', { timeout: 10000 });
  const statBtn = await page.$('[data-stat]');
  ok('a tap target exists to give the game real stats', !!statBtn);
  if (statBtn) await statBtn.click();
  await page.waitForTimeout(800);
  await page.click('#trackerBackBtn');
  await page.waitForSelector('#scheduleGameBtn', { timeout: 10000 });

  const beforeResync = await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('dadstats_v5'));
    const season = raw.profiles[0].seasons[0];
    return JSON.stringify(season.games.map((g) => g.players));
  });
  feedResponse = { status: 200, body: ics([
    vevent({ uid: 'game-1', summary: 'vs Eagles (moved again)', dtstart: '20260904T190000Z' }),
    vevent({ uid: 'game-2', summary: 'vs Hawks', dtstart: '20260908T173000' }),
  ]) };
  await syncAgain();
  const afterResync = await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('dadstats_v5'));
    const season = raw.profiles[0].seasons[0];
    return JSON.stringify(season.games.map((g) => g.players));
  });
  eq('player data is untouched by a metadata-only re-sync', afterResync, beforeResync);

  // --- Deleting a synced game, then re-syncing the same feed, does not resurrect it ---
  rows = await gameRows();
  const hawksRow = (await page.$$('#gameList [data-opengame]'))[
    rows.findIndex((r) => r.name === 'vs Hawks')
  ];
  await hawksRow.hover();
  const delBtn = await hawksRow.$('[data-delgame]');
  await delBtn.click();
  await confirmDialog(page, 'delete game');
  await page.waitForTimeout(1000);
  rows = await gameRows();
  eq('the game is gone right after deleting it', rows.some((r) => r.name === 'vs Hawks'), false);

  await syncAgain(); // same feed, same UID still present
  rows = await gameRows();
  eq('the deleted game does not come back on the next sync', rows.some((r) => r.name === 'vs Hawks'), false);
  eq('the other game is unaffected', rows.some((r) => r.name.indexOf('vs Eagles') === 0), true);

  // --- A new event in the feed still gets added, even with a prior deletion in the mix ---
  feedResponse = { status: 200, body: ics([
    vevent({ uid: 'game-1', summary: 'vs Eagles (moved again)', dtstart: '20260904T190000Z' }),
    vevent({ uid: 'game-4', summary: 'vs Foxes', dtstart: '20260920T160000Z' }),
  ]) };
  await syncAgain();
  rows = await gameRows();
  ok('a genuinely new event is still imported', rows.some((r) => r.name === 'vs Foxes'));

  // --- A response that doesn't look like a calendar surfaces an error, doesn't crash ---
  feedResponse = { status: 502, body: "That doesn't look like a calendar feed." };
  const beforeBadSync = await gameRows();
  await syncAgain();
  const afterBadSync = await gameRows();
  eq('a feed error changes nothing', afterBadSync, beforeBadSync);
  const errStatus = await page.textContent('#icsStatus');
  ok('the error is shown, not swallowed', /error|feed/i.test(errStatus));

  console.log('errors:', errors.length ? errors.join('; ') : 'none');
  await browser.close();

  console.log();
  console.log(fails.length ? `FAIL (${fails.length})\n` + fails.map((f) => '  FAIL  ' + f).join('\n') : 'PASS');
  process.exit(fails.length || errors.length ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e && e.message); process.exit(1); });
