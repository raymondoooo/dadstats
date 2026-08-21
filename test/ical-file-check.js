// Importing a downloaded .ics file, as opposed to subscribing to a URL.
//
// Some leagues only ever hand out a file — no subscribe link, no feed URL — so the file path is
// the only way in for those teams. It shares applyIcsText with the URL path, which is the point:
// the rules that took real effort to get right (match by UID, refresh only name and date, never
// resurrect a game you deleted) must hold identically whichever way the text arrived. This suite
// exists to prove they do, because it would be very easy for the file route to quietly become a
// dumber "just add everything" importer.
//
// Uses Playwright's setInputFiles with an in-memory buffer, so nothing is written to disk and the
// server is never involved — a file import is parsed entirely in the browser.
//
//   APP_URL=http://localhost:3208 ADMIN_PASSWORD=... node test/ical-file-check.js
const { chromium } = require('playwright');
const { provisionFamily, addProfile, confirmDialog, APP_URL: URL } = require('./helpers');

const fails = [];
const ok = (m) => console.log('  ok    ' + m);
const bad = (m) => { console.log('  FAIL  ' + m); fails.push(m); };

const ics = (events) => 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\n' + events.join('') + 'END:VCALENDAR\r\n';
const vevent = (uid, summary, dtstart) =>
  'BEGIN:VEVENT\r\nUID:' + uid + '\r\nDTSTART:' + dtstart + '\r\nSUMMARY:' + summary + '\r\nEND:VEVENT\r\n';

(async () => {
  const password = await provisionFamily('ICS File');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 414, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('dialog', (d) => { errors.push('native dialog: ' + d.message()); d.dismiss(); });
  // Nothing here should reach the proxy. If the file path ever starts calling it, this catches it.
  page.on('request', (r) => {
    if (r.url().includes('/api/ical-proxy')) errors.push('file import hit the proxy: ' + r.url());
  });

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('#loginPassword', { timeout: 15000 });
  await page.fill('#loginPassword', password);
  await page.click('#loginForm button[type=submit]');
  await addProfile(page, 'File Kid', 'soccer');
  await page.click('[data-openseason]');
  await page.waitForSelector('#scheduleGameBtn', { timeout: 10000 });

  const gameNames = () =>
    page.$$eval('#gameList [data-opengame] .row-name', (e) => e.map((x) => x.textContent.trim()));

  async function importFile(name, body) {
    await page.click('#icsAddBtn');
    await page.waitForSelector('#icsForm', { state: 'visible' });
    await page.setInputFiles('#icsFileInput', {
      name, mimeType: 'text/calendar', buffer: Buffer.from(body, 'utf8'),
    });
    await page.click('#icsFormSubmit');
    await page.waitForTimeout(1800);
  }

  // --- A plain import ---
  const schedule = ics([
    vevent('f1', 'vs Central High', '20261002T160000'),
    vevent('f2', 'at Lakeside Prep', '20261009T173000'),
    vevent('f3', 'vs Ridgeview', '20261016T150000'),
  ]);
  await importFile('freshman-schedule.ics', schedule);

  let names = await gameNames();
  names.length === 3
    ? ok('a downloaded .ics file imports its games')
    : bad(`expected 3 games, got ${JSON.stringify(names)}`);

  const status = await page.textContent('#icsStatus');
  /imported/i.test(status)
    ? ok(`status calls it an import, not a sync ("${status.trim()}")`)
    : bad(`status wording: ${JSON.stringify(status)}`);

  // A file has nothing to re-fetch, so offering Sync would promise a refresh that can't happen.
  (await page.isVisible('#icsSyncBtn')) === false
    ? ok('no Sync button after a file import')
    : bad('Sync button offered for a file-imported season');

  // --- Re-importing the same file must not duplicate ---
  await importFile('freshman-schedule.ics', schedule);
  names = await gameNames();
  names.length === 3
    ? ok('re-importing the same file does not duplicate')
    : bad(`re-import produced ${names.length} games: ${JSON.stringify(names)}`);

  // --- A rescheduled game updates in place rather than being added again ---
  await importFile('freshman-schedule.ics', ics([
    vevent('f1', 'vs Central High (moved)', '20261003T180000'),
    vevent('f2', 'at Lakeside Prep', '20261009T173000'),
    vevent('f3', 'vs Ridgeview', '20261016T150000'),
  ]));
  names = await gameNames();
  names.length === 3 && names.some((n) => n.includes('(moved)'))
    ? ok('a rescheduled game updates in place')
    : bad(`expected 3 games with one renamed, got ${JSON.stringify(names)}`);

  // --- Deleting a game, then re-importing the same file, must not bring it back ---
  const rows = await page.$$('#gameList [data-opengame]');
  const idx = (await gameNames()).findIndex((n) => n.includes('Lakeside'));
  await rows[idx].hover();
  const delBtn = await rows[idx].$('[data-delgame]');
  await delBtn.click();
  await confirmDialog(page, 'delete game');
  await page.waitForTimeout(800);
  names = await gameNames();
  names.some((n) => n.includes('Lakeside'))
    ? bad('game was not deleted')
    : ok('a game imported from a file can be deleted');

  await importFile('freshman-schedule.ics', schedule);
  names = await gameNames();
  names.some((n) => n.includes('Lakeside'))
    ? bad(`the deleted game came back on re-import: ${JSON.stringify(names)}`)
    : ok('re-importing does not resurrect a deleted game');

  // --- Picking the wrong file says so, rather than reporting "no events found" ---
  await importFile('notes.txt', 'this is not a calendar at all\n');
  const wrongStatus = (await page.textContent('#icsStatus')).trim();
  /calendar file/i.test(wrongStatus)
    ? ok(`a non-calendar file is rejected clearly ("${wrongStatus}")`)
    : bad(`unhelpful message for a non-calendar file: ${JSON.stringify(wrongStatus)}`);

  names = await gameNames();
  names.length === 2
    ? ok('a rejected file changes nothing')
    : bad(`game list changed after a bad import: ${JSON.stringify(names)}`);

  console.log('errors:', errors.length ? errors.join(' | ') : 'none');
  await browser.close();
  console.log();
  console.log(fails.length || errors.length ? `FAIL (${fails.length + errors.length})` : 'PASS');
  process.exit(fails.length || errors.length ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e && e.message); process.exit(1); });
