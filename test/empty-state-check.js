// A fresh account must open empty, and adding a kid must never presume a sport.
//
// This app started as a basketball-only tracker, and its default state fabricated a "Player 1"
// carrying a basketball "Season 1". For the ten sports that aren't basketball that's simply
// wrong — a swimmer's parent should not have to delete a fictional basketball player — and for
// basketball it's busywork. This guards both halves of that regression: a seeded profile
// reappearing, and a new profile being created in a sport nobody picked.
//
// Needs a *virgin* instance, like setup-check.js, since it asserts on what first run looks like:
//   docker run -d --name dadstats-fresh -p 3209:3211 -v dadstats-fresh-data:/app/data dadstats
//   APP_URL=http://localhost:3209 node test/empty-state-check.js
// Drives the add-kid form directly rather than through helpers.addProfile, because the form
// itself — that the sport picker exists and is populated — is what's under test here.
const { chromium } = require('playwright');
const URL = process.env.APP_URL;

// innerText of the app root, not body.textContent: the latter includes the inline <script>, where
// "Player 1" legitimately survives in a comment and in the legacy v2->v3 migration. Asserting on
// that gave a false positive that cost a debugging round.
function visibleText(page) {
  return page.evaluate(() => document.getElementById('app')
    ? document.getElementById('app').innerText
    : document.body.innerText);
}

(async () => {
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const p = await b.newPage();
  let fails = 0;
  const ok = (m) => console.log('  ok    ' + m);
  const bad = (m) => { console.log('  FAIL  ' + m); fails++; };

  await p.goto(URL, { waitUntil: 'networkidle' });
  await p.waitForSelector('#setupForm', { state: 'visible', timeout: 15000 });
  await p.fill('#setupName', 'Test Family');
  await p.fill('#setupPassword', 'test-family-password');
  await p.click('#setupSubmit');
  await p.waitForSelector('#addProfileBtn', { state: 'visible', timeout: 25000 });
  await p.waitForTimeout(1500);

  const tiles = (await p.$$('[data-openprofile]')).length;
  tiles === 0 ? ok('fresh account has no profiles') : bad(`fresh account has ${tiles} profile(s)`);

  (await p.isVisible('#homeEmpty'))
    ? ok('empty-state prompt is shown')
    : bad('empty-state prompt is not shown');

  const shown = await visibleText(p);
  /Player 1/.test(shown)
    ? bad('"Player 1" is visible on a fresh account')
    : ok('no fabricated player is visible');

  // Adding a kid: the sport must be chosen, not assumed.
  await p.click('#addProfileBtn');
  await p.waitForSelector('#profileForm', { state: 'visible' });
  const opts = await p.$$eval('#profileSportInput option', (els) => els.map((o) => o.value));
  opts.length >= 11 && opts.includes('swimming')
    ? ok(`sport picker offers all ${opts.length} sports`)
    : bad(`sport picker offered ${opts.length}: ${opts.join(',')}`);

  await p.fill('#profileNameInput', 'Swimmer Kid');
  await p.selectOption('#profileSportInput', 'swimming');
  await p.click('#profileForm button[type=submit]');
  await p.waitForSelector('[data-openseason]', { timeout: 10000 });
  await p.waitForTimeout(1200);

  const title = (await p.textContent('#profileTitle')).trim();
  title === 'Swimmer Kid' ? ok('lands on the new profile') : bad(`landed on "${title}"`);

  // The decisive check: the season the app created must be swimming, not basketball.
  const sport = await p.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('dadstats_v5'));
    return s.profiles.map((pr) => pr.seasons.map((se) => se.sport).join(',')).join(' | ');
  });
  sport === 'swimming'
    ? ok('the auto-created season is swimming')
    : bad(`the auto-created season is "${sport}", expected swimming`);

  // Deleting the last profile must be possible now that empty is a legal state.
  p.on('dialog', (d) => d.accept());
  await p.click('#profileBackBtn');
  await p.waitForTimeout(600);
  const delBtn = await p.$('[data-delprofile]');
  if (!delBtn) { bad('no delete button on the only profile'); }
  else {
    await delBtn.click();
    await p.waitForTimeout(1200);
    const left = (await p.$$('[data-openprofile]')).length;
    left === 0 && (await p.isVisible('#homeEmpty'))
      ? ok('the last profile can be deleted, returning to the empty state')
      : bad(`after deleting the last profile: ${left} tile(s)`);
  }

  await b.close();
  console.log(fails === 0 ? 'PASS' : `FAIL (${fails})`);
  process.exit(fails);
})().catch((e) => { console.error('FATAL:', e && e.message); process.exit(1); });
