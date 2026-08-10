const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const dataDir = path.dirname(process.env.SQLITE_PATH || './data/dadstats.db');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(process.env.SQLITE_PATH || './data/dadstats.db');
db.pragma('journal_mode = WAL');
// SQLite ignores foreign keys unless this is on, per connection. Without it, deleting a family
// would silently orphan its app_state row instead of cascading (see admin.js deleteFamily).
db.pragma('foreign_keys = ON');

// Idempotent (create ... if not exists), so this converges a fresh volume or an in-place upgrade
// without a separate migration step.
function initSchema() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  db.exec(schema);
  // SQLite has no "ADD COLUMN IF NOT EXISTS", so bring pre-existing volumes forward by hand.
  const columns = db.prepare('pragma table_info(families)').all().map((c) => c.name);
  if (!columns.includes('name')) {
    db.exec("ALTER TABLE families ADD COLUMN name TEXT NOT NULL DEFAULT ''");
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

// Returned with `generated` so index.js can print a first-run banner — an auto-generated admin
// password is useless if the owner never sees it.
function loadOrCreateAdminPassword() {
  return loadOrCreateSecret('.admin_password', process.env.ADMIN_PASSWORD, 12);
}

module.exports = { db, initSchema, loadOrCreateJwtSecret, loadOrCreateAdminPassword };
