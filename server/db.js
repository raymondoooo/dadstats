const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const dbPath = process.env.SQLITE_PATH || './data/dadstats.db';
const dataDir = path.dirname(dbPath);
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
// SQLite ignores foreign keys unless this is on, per connection. Without it, deleting a family
// would silently orphan its app_state row instead of cascading (see admin.js deleteFamily).
db.pragma('foreign_keys = ON');

// ---- Schema versioning ----
//
// The schema is applied at boot, unattended, against a stranger's live database, on every
// restart. That rules out anything that isn't safe to run twice, and it means a version mismatch
// has to be handled rather than assumed away.
//
// Bump this whenever a migration is added below, and add the matching entry to MIGRATIONS.
const SCHEMA_VERSION = 2;

// Forward-only, applied in order, each inside its own transaction. Every one must be safe to run
// against a database that already has the change (the guard, not the ALTER, is the contract) —
// a fresh install runs schema.sql first, which already creates the current shape.
const MIGRATIONS = {
  // 1: the baseline tables. schema.sql creates them idempotently, so there is nothing to do here
  // beyond claiming the version for databases that predate versioning entirely.
  1: () => {},

  // 2: families.name, added when the admin UI started labelling accounts.
  2: () => {
    const columns = db.prepare('pragma table_info(families)').all().map((c) => c.name);
    if (!columns.includes('name')) {
      db.exec("ALTER TABLE families ADD COLUMN name TEXT NOT NULL DEFAULT ''");
    }
  },
};

function currentVersion() {
  return db.pragma('user_version', { simple: true });
}

// Gated on the database actually containing something, never on the version number. Databases
// written before versioning existed report version 0 — and so does a brand-new empty file. Gating
// on "version > 0" would skip the backup for exactly the users who have data to lose.
function hasUserData() {
  try {
    const families = db.prepare('select count(*) as n from families').get().n;
    return families > 0;
  } catch {
    return false; // tables don't exist yet: nothing to lose
  }
}

// VACUUM INTO is synchronous. better-sqlite3's .backup() returns a promise that would settle
// *after* the migrations below have already run, producing a "backup" of the post-migration
// database — a safety net that looks real and isn't.
function backupBeforeMigrating(fromVersion, toVersion) {
  const backupDir = path.join(dataDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(backupDir, `pre-migration-v${fromVersion}-to-v${toVersion}-${stamp}.db`);
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  console.log(`backed up to ${target} before migrating`);
  return target;
}

function initSchema() {
  // Idempotent create-if-not-exists, so this converges a fresh volume without a migration and is
  // harmless on an existing one.
  const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  db.exec(schema);

  const dbVersion = currentVersion();

  // A newer database on an older binary: the user has rolled back to a previous image. Running
  // anyway would write through a schema this code doesn't understand and corrupt their data in a
  // way no backup taken afterwards could catch. Refusing to start is far better — it is loud,
  // immediate, and entirely recoverable by pulling the newer image again.
  if (dbVersion > SCHEMA_VERSION) {
    console.error(
      `\nDatabase schema v${dbVersion} is newer than this image supports (v${SCHEMA_VERSION}).\n` +
      `This happens when you roll back to an older image after upgrading.\n` +
      `Pull the newer image again, or restore a backup from ${path.join(dataDir, 'backups')}.\n` +
      `Refusing to start rather than risk writing through a schema this version can't read.\n`
    );
    process.exit(1);
  }

  if (dbVersion === SCHEMA_VERSION) return;

  if (hasUserData()) backupBeforeMigrating(dbVersion, SCHEMA_VERSION);

  for (let v = dbVersion + 1; v <= SCHEMA_VERSION; v++) {
    const migrate = MIGRATIONS[v];
    if (!migrate) continue;
    // Each migration commits on its own, so a failure part-way leaves the versions already
    // applied intact rather than half-rolling-back an earlier one.
    db.transaction(migrate)();
    db.pragma(`user_version = ${v}`);
    if (dbVersion > 0) console.log(`applied schema migration v${v}`);
  }
}

// Secrets a self-hoster shouldn't have to invent before `docker run` works: generated once and
// persisted next to the DB so they survive a restart. Without persistence, a new JWT secret on
// every boot would invalidate every session, and a new admin password would lock the owner out.
function loadOrCreateSecret(fileName, envValue, bytes) {
  if (envValue) return { value: envValue, generated: false };
  const file = path.join(dataDir, fileName);
  if (fs.existsSync(file)) return { value: fs.readFileSync(file, 'utf8').trim(), generated: false };
  const value = crypto.randomBytes(bytes).toString(bytes > 16 ? 'hex' : 'base64url');
  fs.writeFileSync(file, value, { mode: 0o600 });
  return { value, generated: true };
}

function loadOrCreateJwtSecret() {
  return loadOrCreateSecret('.jwt_secret', process.env.JWT_SECRET, 48).value;
}

// A stable, non-secret identifier for this installation. Sent to the client so a browser can
// tell whether its offline cache belongs to the instance now answering on this address — see
// the account binding in public/index.html. Deliberately its own random value rather than
// anything derived from JWT_SECRET, so handing it out reveals nothing.
function loadOrCreateInstanceId() {
  return loadOrCreateSecret('.instance_id', process.env.INSTANCE_ID, 16).value;
}

// Returned with `generated` so index.js can print a first-run banner — an auto-generated admin
// password is useless if the owner never sees it.
function loadOrCreateAdminPassword() {
  return loadOrCreateSecret('.admin_password', process.env.ADMIN_PASSWORD, 12);
}

module.exports = {
  db, initSchema, loadOrCreateJwtSecret, loadOrCreateAdminPassword, loadOrCreateInstanceId,
  SCHEMA_VERSION, currentVersion,
};
