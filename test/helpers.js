// Shared test setup. Families are created by the admin now, so a test can't just invent a
// password and log in — it has to provision an account first, exactly like a real operator would.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const APP_URL = process.env.APP_URL || 'http://localhost:3211';

async function api(cookie, method, path, body) {
  const res = await fetch(APP_URL + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { /* non-JSON error page */ }
  return { ok: res.ok, status: res.status, body: parsed, setCookie: res.headers.get('set-cookie') };
}

// Families created by previous runs, recognised by the suffix provisionFamily stamps on the
// name. Everything else on the instance is left alone.
const TEST_NAME_PATTERN = /\s\d{13}-[a-z0-9]{6}$/;

// Logging in compares the submitted password against every family's bcrypt hash in turn, because
// salted hashes can't be looked up. That's fine for a household, but a test suite creating a
// family per run turns it into a real cost: at ~300ms per comparison, twenty leftover families
// push a single login past ten seconds and tests start timing out on their own debris rather
// than on anything the app got wrong. So each run clears the previous runs' families first.
async function pruneTestFamilies(adminCookie) {
  const list = await api(adminCookie, 'GET', '/api/admin/families');
  const stale = (list.body.families || []).filter((f) => TEST_NAME_PATTERN.test(f.name || ''));
  for (const f of stale) {
    await api(adminCookie, 'DELETE', `/api/admin/families/${f.id}`);
  }
  return stale.length;
}

// Creates a family via the admin API and returns the password to sign in with. Each call uses a
// unique name + password, so tests never collide with each other or with real data.
async function provisionFamily(label) {
  if (!ADMIN_PASSWORD) {
    throw new Error(
      'ADMIN_PASSWORD is required.\n' +
      'Start the test instance with a known admin password, e.g.\n' +
      '  docker run -d --name dadstats-test -p 3208:3211 -e ADMIN_PASSWORD=test-admin-pw \\\n' +
      '    -v dadstats-test-data:/app/data dadstats\n' +
      'then run tests with ADMIN_PASSWORD=test-admin-pw'
    );
  }

  const login = await api(null, 'POST', '/api/admin/login', { password: ADMIN_PASSWORD });
  if (!login.ok) throw new Error('admin login failed: ' + JSON.stringify(login.body));

  const adminCookie = (login.setCookie || '').split(';')[0];
  await pruneTestFamilies(adminCookie);

  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const password = `test-${unique}`;

  const created = await api(adminCookie, 'POST', '/api/admin/families', {
    name: `${label} ${unique}`,
    password,
  });
  if (!created.ok) throw new Error('family creation failed: ' + JSON.stringify(created.body));

  return password;
}

// Adding a kid is an inline form (name + first sport), not a prompt() — the app stopped assuming
// basketball for every new profile. Centralised because six suites open with this exact step, and
// they'd otherwise all have to be edited again the next time the flow moves.
//
// Omit `sport` to take the form's own default, which is what the suites that predate the sport
// picker did implicitly.
async function addProfile(page, name, sport) {
  await page.waitForSelector('#addProfileBtn', { state: 'visible', timeout: 15000 });
  await page.click('#addProfileBtn');
  await page.waitForSelector('#profileForm', { state: 'visible', timeout: 10000 });
  await page.fill('#profileNameInput', name);
  if (sport) await page.selectOption('#profileSportInput', sport);
  await page.click('#profileForm button[type=submit]');
  // Creating a profile navigates straight into it, so its seasons list is the signal it landed.
  await page.waitForSelector('[data-openseason]', { timeout: 10000 });
}

// The app replaced every prompt()/confirm()/alert() with one in-page <dialog>, so suites can no
// longer drive these with page.on('dialog'). Playwright's dialog event only fires for the native
// ones — a handler left in place simply never runs, and the test hangs on whatever it expected to
// happen next. These three are the replacement.
//
// Deliberately fail loudly rather than no-op when the dialog isn't open: a silent no-op here would
// let a test "pass" while the interaction it meant to exercise never happened.
async function expectDialog(page, what) {
  try {
    await page.waitForSelector('#modal[open]', { state: 'attached', timeout: 5000 });
  } catch {
    throw new Error('expected a dialog to open for: ' + what);
  }
}

// Confirms whatever dialog is open. Works for both confirm-style and alert-style dialogs.
async function confirmDialog(page, label) {
  await expectDialog(page, label || 'confirm');
  await page.click('#modalConfirm');
  await page.waitForSelector('#modal[open]', { state: 'detached', timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(150);
}

async function dismissDialog(page, label) {
  await expectDialog(page, label || 'cancel');
  await page.click('#modalCancel');
  await page.waitForTimeout(150);
}

// Fills the dialog's text field and confirms. Pass '' to submit an empty value, which only the
// game-naming dialog accepts.
async function fillDialog(page, value) {
  await expectDialog(page, 'text entry');
  await page.fill('#modalInput', value);
  await page.click('#modalConfirm');
  await page.waitForSelector('#modal[open]', { state: 'detached', timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(150);
}

// Schedules a game: opens the season screen's button, names it through the dialog, and waits for
// the tracker. Six suites did this by hand.
async function scheduleGame(page, name) {
  await page.click('#scheduleGameBtn');
  await fillDialog(page, name);
  await page.waitForTimeout(300);
}

module.exports = {
  provisionFamily, pruneTestFamilies, addProfile, APP_URL,
  confirmDialog, dismissDialog, fillDialog, scheduleGame,
};
