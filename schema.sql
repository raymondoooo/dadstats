-- DadStats — families are created by the instance admin, who sets each family's password and
-- passes it on to them (see server/admin.js). Signing in with a password that matches no family
-- is simply rejected: unlike earlier versions, an unrecognised password never creates an account,
-- so a typo lands you on an error instead of a confusingly empty app.
--
-- There is still no username or email — within a family, the password is the whole credential,
-- which is what lets two parents sign in on two phones and score the same game together.

CREATE TABLE IF NOT EXISTS families (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One JSON blob per family. The server never parses it — see server/index.js. `version` is
-- optimistic concurrency: every accepted write bumps it, and a client must echo back the version
-- it last read or the write is rejected with a 409 (see PUT /api/state). Without it, two phones
-- scoring the same game would each push their whole view of the world and silently erase taps
-- the other had just made.
CREATE TABLE IF NOT EXISTS app_state (
  family_id INTEGER PRIMARY KEY REFERENCES families(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
