// Deleting a profile or a season must survive a merge with a device that still has it.
//
// Profiles and seasons used to splice on delete. mergeStates unions two devices' profile lists by
// name and season lists by id, and a union cannot tell "this never existed here" from "this was
// deleted here" — so the other device put the deleted kid straight back on the next resync. This
// is the same failure that tombstones already solved one level down, for players within a game and
// entries within a log; it just hadn't been applied to profiles and seasons.
//
// Reproduced before the fix as:
//   A deletes "Doomed Kid"  -> A shows []
//   B (still had it) writes -> server has both again
//   A resyncs               -> "Doomed Kid" is back
//
// Needs two independent browser contexts against one family, like sync-check.
//   APP_URL=... ADMIN_PASSWORD=... node test/tombstone-check.js
const { chromium } = require('playwright');
const { provisionFamily, confirmDialog, APP_URL: URL } = require('./helpers');

let fails = 0;
const ok = (m) => console.log('  ok    ' + m);
const bad = (m) => { console.log('  FAIL  ' + m); fails++; };

async function device(browser, password) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  // Deletes now go through the app's own dialog, not a native one. Kept armed so a native
  // dialog creeping back in fails loudly instead of being silently auto-dismissed.
  page.on('dialog', (d) => { console.log('  FAIL  unexpected native dialog: ' + d.message()); d.dismiss(); });
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('#loginPassword', { timeout: 15000 });
  await page.fill('#loginPassword', password);
  await page.click('#loginForm button[type=submit]');
  // A device booting provisional adopts the server's state wholesale — including its nav — so it
  // can land on whatever screen the other device was last on. Walk back to home. (A comma
  // selector would wait on whichever matches first in the DOM, not whichever is visible.)
  await page.waitForSelector('#loginForm', { state: 'hidden', timeout: 20000 });
  await page.waitForTimeout(1500);
  for (let i = 0; i < 4 && !(await page.isVisible('#addProfileBtn')); i++) {
    if (await page.isVisible('#seasonBackBtn')) await page.click('#seasonBackBtn');
    else if (await page.isVisible('#profileBackBtn')) await page.click('#profileBackBtn');
    await page.waitForTimeout(800);
  }
  return page;
}

const profileNames = (p) =>
  p.$$eval('[data-openprofile] .name', (e) => e.map((x) => x.textContent.trim()));
const seasonNames = (p) =>
  p.$$eval('[data-openseason] .row-name', (e) => e.map((x) => x.textContent.trim()));

async function addKid(page, name, sport) {
  await page.click('#addProfileBtn');
  await page.waitForSelector('#profileForm', { state: 'visible' });
  await page.fill('#profileNameInput', name);
  if (sport) await page.selectOption('#profileSportInput', sport);
  await page.click('#profileForm button[type=submit]');
  await page.waitForSelector('[data-openseason]', { timeout: 10000 });
  await page.waitForTimeout(1800);
}

async function openByName(page, name) {
  const tiles = await page.$$('[data-openprofile]');
  for (const t of tiles) {
    const label = (await t.$eval('.name', (e) => e.textContent.trim())).trim();
    if (label === name) { await t.click(); return; }
  }
  throw new Error(`no profile tile named "${name}"`);
}

async function home(page) {
  for (let i = 0; i < 4 && !(await page.isVisible('#addProfileBtn')); i++) {
    if (await page.isVisible('#seasonBackBtn')) await page.click('#seasonBackBtn');
    else if (await page.isVisible('#profileBackBtn')) await page.click('#profileBackBtn');
    await page.waitForTimeout(700);
  }
}

(async () => {
  const password = await provisionFamily('Tombstone');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  const A = await device(browser, password);
  await addKid(A, 'Doomed Kid');
  await home(A);

  const B = await device(browser, password);
  const bSaw = await profileNames(B);
  bSaw.includes('Doomed Kid')
    ? ok('device B picked up the profile A created')
    : bad(`device B never saw the profile: ${JSON.stringify(bSaw)}`);

  // --- A deletes it while B still holds a copy ---
  await (await A.$('[data-delprofile]')).click();
  await confirmDialog(A, 'delete profile');
  await A.waitForTimeout(2500);
  const aAfter = await profileNames(A);
  aAfter.length === 0 ? ok('A shows no profiles after deleting') : bad(`A still shows ${JSON.stringify(aAfter)}`);

  // B writes, which merges its stale copy with the server's tombstone.
  await addKid(B, 'Other Kid');
  await home(B);
  await B.waitForTimeout(2000);
  const bAfter = await profileNames(B);
  bAfter.includes('Doomed Kid')
    ? bad(`B resurrected the deleted profile: ${JSON.stringify(bAfter)}`)
    : ok('B dropped the deleted profile on merge');

  // A resyncs and must not get it back.
  await A.reload({ waitUntil: 'networkidle' });
  await A.waitForTimeout(3000);
  await home(A);
  const aResync = await profileNames(A);
  aResync.includes('Doomed Kid')
    ? bad(`the deleted profile came back on A: ${JSON.stringify(aResync)}`)
    : ok('the deletion survived a full round trip');
  aResync.includes('Other Kid')
    ? ok("B's new profile still reached A (the merge still unions live data)")
    : bad(`A lost B's profile: ${JSON.stringify(aResync)}`);

  // --- A name may be reused after deletion: a tombstone must not kill a new same-named kid ---
  await addKid(A, 'Doomed Kid', 'soccer');
  await home(A);
  await A.waitForTimeout(2000);
  await B.reload({ waitUntil: 'networkidle' });
  await B.waitForTimeout(3000);
  await home(B);
  const reused = await profileNames(B);
  reused.filter((n) => n === 'Doomed Kid').length === 1
    ? ok('a deleted name can be reused without the tombstone killing it')
    : bad(`re-added profile did not survive on B: ${JSON.stringify(reused)}`);

  // --- Season deletion tombstones the same way ---
  // Opened by name, not by position: B adds a profile partway through, and merged profile order
  // is not stable, so "the first tile" is not the same kid before and after a resync.
  const subject = (await profileNames(A))[0];
  await openByName(A, subject);
  await A.waitForSelector('#addSeasonBtn', { timeout: 10000 });
  await A.click('#addSeasonBtn');
  await A.waitForSelector('#seasonForm', { state: 'visible' });
  await A.fill('#seasonNameInput', 'Doomed Season');
  await A.click('#seasonForm button[type=submit]');
  await A.waitForTimeout(2000);

  await B.reload({ waitUntil: 'networkidle' });
  await B.waitForTimeout(3000);

  const delSeason = await A.$('[data-delseason]');
  if (!delSeason) bad('no season delete button (need more than one season)');
  else {
    // Delete whichever season the button belongs to, then confirm it stays gone.
    const before = await seasonNames(A);
    await delSeason.click();
    await confirmDialog(A, 'delete season');
    await A.waitForTimeout(2500);
    const after = await seasonNames(A);
    after.length === before.length - 1
      ? ok('A dropped the deleted season')
      : bad(`A season list went ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);

    // B is holding a pre-delete copy (it reloaded above, before the delete). Make it *write*, so
    // its stale season list is unioned against the server's tombstone. Without this the season
    // half of this test proves nothing — B never merges, so a spliced season has nothing to come
    // back from, and the check passes even against the unfixed build.
    await home(B);
    await addKid(B, 'Season Witness');
    await home(B);
    await B.waitForTimeout(2000);

    await A.reload({ waitUntil: 'networkidle' });
    await A.waitForTimeout(3000);
    await home(A);
    await openByName(A, subject);
    await A.waitForSelector('#addSeasonBtn', { timeout: 10000 });
    const resynced = await seasonNames(A);
    resynced.length === after.length
      ? ok('the season deletion survived a merge with a device that still had it')
      : bad(`season came back: ${JSON.stringify(resynced)}`);

    // --- Every season can go: a seasonless profile is a legal state, not one to be rescued ---
    for (let guard = 0; guard < 6; guard++) {
      const btn = await A.$('[data-delseason]');
      if (!btn) break;
      await btn.click();
      await confirmDialog(A, 'delete season');
      await A.waitForTimeout(1500);
    }
    const emptied = await seasonNames(A);
    emptied.length === 0
      ? ok('the last season can be deleted')
      : bad(`seasons remain after deleting all: ${JSON.stringify(emptied)}`);

    (await A.isVisible('#profileEmpty'))
      ? ok('the profile shows its empty prompt')
      : bad('no empty prompt on a seasonless profile');

    // The old code re-created one here, and two devices doing that independently produced a
    // duplicate pair. Nothing should be fabricated now — on either device.
    await A.reload({ waitUntil: 'networkidle' });
    await A.waitForTimeout(3000);
    await home(A);
    await openByName(A, subject);
    await A.waitForSelector('#addSeasonBtn', { timeout: 10000 });
    const afterReload = await seasonNames(A);
    afterReload.length === 0
      ? ok('no season is fabricated on reload')
      : bad(`a season reappeared on reload: ${JSON.stringify(afterReload)}`);

    await B.reload({ waitUntil: 'networkidle' });
    await B.waitForTimeout(3000);
    await home(B);
    await openByName(B, subject);
    await B.waitForSelector('#addSeasonBtn', { timeout: 10000 });
    const onB = await seasonNames(B);
    onB.length === 0
      ? ok('the other device agrees the profile has no seasons')
      : bad(`B shows seasons the profile no longer has: ${JSON.stringify(onB)}`);
  }

  await browser.close();
  console.log(fails === 0 ? 'PASS' : `FAIL (${fails})`);
  process.exit(fails);
})().catch((e) => { console.error('FATAL:', e && e.message); process.exit(1); });
