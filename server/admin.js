// Family management, admin-only. This is the whole "who gets an account" story: the person
// running the container creates a family, sets its password, and passes that password to them.
// Nothing here reads or writes game data — app_state is opaque to the admin surface, and the
// only thing that touches a family's games is deleting the family outright.
const bcrypt = require('bcryptjs');
const { db } = require('./db');
const { issueSession: issueFamilySession } = require('./auth');

const BCRYPT_COST = 12;
const MIN_PASSWORD_LENGTH = 8;

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

// A family's password is the entire credential, and the admin picks it on the family's behalf,
// so a duplicate would silently put two families into one account — the exact failure mode the
// old "any unused password creates an account" design suffered from. Checked here rather than
// enforced by a unique index because bcrypt hashes are salted and never compare equal.
async function passwordInUse(password, exceptFamilyId) {
  const rows = db.prepare('select id, password_hash from families').all();
  for (const row of rows) {
    if (exceptFamilyId && row.id === exceptFamilyId) continue;
    if (await bcrypt.compare(password, row.password_hash)) return true;
  }
  return false;
}

// --- First-run setup ---
//
// The common install is one person, one family, their own box. Making them read the admin
// password out of `docker logs`, sign into /admin, create an account for themselves, then sign
// in again somewhere else is four steps more than "open the page and pick a password" — and it's
// exactly where someone evaluating a self-hosted app gives up.
//
// So the first visit to a brand new instance creates the first family directly. This is NOT
// self-signup returning: it is available only while the instance has no families at all, which
// makes it a one-time door rather than an open one. Everything after the first account still
// goes through the admin.
function setupNeeded() {
  return db.prepare('select count(*) as n from families').get().n === 0;
}

function setupStatus(req, res) {
  res.json({ setupNeeded: setupNeeded() });
}

async function completeSetup(req, res) {
  // Re-checked here rather than trusted from the status call: two people hitting a fresh
  // instance at once must not both get to create "the first" family.
  if (!setupNeeded()) {
    // Counted against the rate limiter so an already-configured instance can't be hammered.
    if (req.recordAuthFailure) req.recordAuthFailure();
    return res.status(409).json({ error: 'This instance is already set up. Sign in instead.' });
  }

  const { name, password } = req.body || {};
  const label = (name || '').trim();
  if (!label) return res.status(400).json({ error: 'Family name is required.' });

  const invalid = validatePassword(password);
  if (invalid) return res.status(400).json({ error: invalid });

  const hash = await bcrypt.hash(password, BCRYPT_COST);
  const { lastInsertRowid } = db
    .prepare('insert into families (name, password_hash) values (?, ?)')
    .run(label, hash);

  // No duplicate-password check: there is nothing to collide with on an empty instance.
  issueFamilySession(res, lastInsertRowid);
  res.json({ ok: true });
}

function listFamilies(req, res) {
  // Deliberately never returns password hashes. `has_data` lets the UI warn before a delete
  // that actually destroys somebody's season.
  const rows = db.prepare(`
    select f.id, f.name, f.created_at,
           case when s.family_id is null then 0 else 1 end as has_data
    from families f
    left join app_state s on s.family_id = f.id
    order by f.id
  `).all();
  res.json({ families: rows });
}

async function createFamily(req, res) {
  const { name, password } = req.body || {};
  const label = (name || '').trim();
  if (!label) return res.status(400).json({ error: 'Family name is required.' });

  const invalid = validatePassword(password);
  if (invalid) return res.status(400).json({ error: invalid });

  if (await passwordInUse(password)) {
    return res.status(409).json({ error: 'Another family already uses that password. Pick a different one.' });
  }

  const hash = await bcrypt.hash(password, BCRYPT_COST);
  const { lastInsertRowid } = db
    .prepare('insert into families (name, password_hash) values (?, ?)')
    .run(label, hash);
  res.json({ ok: true, family: { id: lastInsertRowid, name: label } });
}

async function updateFamily(req, res) {
  const id = Number(req.params.id);
  const existing = db.prepare('select id from families where id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'No such family.' });

  const { name, password } = req.body || {};

  if (name !== undefined) {
    const label = (name || '').trim();
    if (!label) return res.status(400).json({ error: 'Family name cannot be empty.' });
    db.prepare('update families set name = ? where id = ?').run(label, id);
  }

  if (password !== undefined) {
    const invalid = validatePassword(password);
    if (invalid) return res.status(400).json({ error: invalid });
    if (await passwordInUse(password, id)) {
      return res.status(409).json({ error: 'Another family already uses that password. Pick a different one.' });
    }
    const hash = await bcrypt.hash(password, BCRYPT_COST);
    db.prepare('update families set password_hash = ? where id = ?').run(hash, id);
    // Existing sessions keep working: they're JWTs signed at login and aren't re-checked against
    // the password. Changing a password locks out anyone who hasn't signed in yet, not the phone
    // already mid-game — which is the behaviour you want during a season.
  }

  res.json({ ok: true });
}

function deleteFamily(req, res) {
  const id = Number(req.params.id);
  const existing = db.prepare('select id from families where id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'No such family.' });
  // app_state cascades (foreign_keys pragma is on — see db.js), so this destroys every season
  // and game that family recorded. The UI confirms first.
  db.prepare('delete from families where id = ?').run(id);
  res.json({ ok: true });
}

module.exports = {
  listFamilies, createFamily, updateFamily, deleteFamily,
  setupNeeded, setupStatus, completeSetup,
};
