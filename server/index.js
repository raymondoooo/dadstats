require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { db, initSchema, loadOrCreateJwtSecret, loadOrCreateAdminPassword } = require('./db');
const {
  login, logout, requireAuth,
  adminLogin, adminLogout, requireAdmin,
} = require('./auth');
const {
  listFamilies, createFamily, updateFamily, deleteFamily,
  setupNeeded, setupStatus, completeSetup,
} = require('./admin');
const { loginLimiter } = require('./ratelimit');

// Must happen before any request can hit login/requireAuth, both of which read
// process.env.JWT_SECRET lazily per-call.
process.env.JWT_SECRET = loadOrCreateJwtSecret();
const admin = loadOrCreateAdminPassword();
process.env.ADMIN_PASSWORD = admin.value;

const app = express();

// Behind a reverse proxy, every request otherwise looks like it came from the proxy's IP, which
// would turn the per-client login rate limit into a single global one (see ratelimit.js).
if (/^(1|true|yes)$/i.test(process.env.TRUST_PROXY || '')) app.set('trust proxy', true);
// The client PUTs its entire state on every save, so this ceiling grows with a family's whole
// history (all profiles/seasons/games/logs), not with a single game. At 2mb a few seasons in,
// every save would start failing with a 413 that the client surfaces as nothing at all.
app.use(express.json({ limit: '8mb' }));
app.use(cookieParser());
// Absolute so the app doesn't depend on the working directory it was started from.
app.use(express.static(path.join(__dirname, '..', 'public')));

// The admin page is documented as /admin; static serving alone would only answer /admin.html.
// It carries no secrets — every admin API call behind it requires the admin cookie.
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));

app.get('/api/health', (req, res) => {
  try {
    db.prepare('select 1').get();
    res.json({ ok: true, db: 'up' });
  } catch (err) {
    res.status(503).json({ ok: false, db: 'down', error: err.message });
  }
});

// Express 5 forwards a rejected promise from an async handler to the error middleware on its
// own, which Express 4 did not — a rejection there used to hang the request until the client
// gave up. Kept anyway: it costs nothing, it makes the intent explicit at each async route, and
// it means these handlers don't silently depend on which major of Express is installed.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// --- First-run setup ---
// Unauthenticated by necessity — there is no account to authenticate as yet. Safe only because
// both handlers refuse to do anything once a single family exists (see admin.js setupNeeded).
// Rate limited anyway: it's an unauthenticated write endpoint on the open internet.
app.get('/api/setup', setupStatus);
app.post('/api/setup', loginLimiter('setup'), wrap(completeSetup));

// --- Auth ---
app.post('/api/login', loginLimiter('family'), wrap(login));
app.post('/api/logout', logout);

// --- Admin: family management (never touches game data) ---
app.post('/api/admin/login', loginLimiter('admin'), adminLogin);
app.post('/api/admin/logout', adminLogout);
app.get('/api/admin/session', requireAdmin, (req, res) => res.json({ ok: true }));
app.get('/api/admin/families', requireAdmin, listFamilies);
app.post('/api/admin/families', requireAdmin, wrap(createFamily));
app.patch('/api/admin/families/:id', requireAdmin, wrap(updateFamily));
app.delete('/api/admin/families/:id', requireAdmin, deleteFamily);

// --- Live change notifications (SSE) ---
// One long-lived stream per open tab, grouped by family. A committed write pushes only the new
// version number, not the state itself: the client already knows how to GET + merge, and a nudge
// keeps the payload tiny. This replaces waiting up to 20s for the next poll to notice.
const familyStreams = new Map(); // familyId -> Set<res>

// `origin` is the clientId of whoever made the write, so that device can ignore its own change
// instead of resyncing and re-rendering on top of whatever the user is currently doing.
function notifyFamily(familyId, version, origin) {
  const streams = familyStreams.get(familyId);
  if (!streams) return;
  const payload = `data: ${JSON.stringify({ type: 'state', version, origin })}\n\n`;
  for (const stream of streams) {
    try { stream.write(payload); } catch { /* a dead socket is cleaned up by its own close handler */ }
  }
}

app.get('/api/events', requireAuth, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    // no-transform + X-Accel-Buffering stop nginx/Cloudflare buffering the stream, which would
    // hold events until the connection closed and defeat the whole point.
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');

  if (!familyStreams.has(req.familyId)) familyStreams.set(req.familyId, new Set());
  familyStreams.get(req.familyId).add(res);

  // Proxies drop idle connections; a comment line every 25s keeps this one alive and costs
  // nothing (clients ignore comments).
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* close handler below does the cleanup */ }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    const streams = familyStreams.get(req.familyId);
    if (!streams) return;
    streams.delete(res);
    if (streams.size === 0) familyStreams.delete(req.familyId);
  });
});

// --- App state: one JSON blob per family, synced across every device that family logs into. ---
app.get('/api/state', requireAuth, (req, res) => {
  const row = db.prepare('select state, version from app_state where family_id = ?').get(req.familyId);
  // serverNow lets clients correct for their own clock skew (see now()/clockOffset in
  // public/index.html) — two devices' phones can easily disagree by tens of seconds, and that
  // skew otherwise leaks straight into live-clock timestamps and merge tie-breaks.
  res.json({
    state: row ? JSON.parse(row.state) : null,
    version: row ? row.version : 0,
    serverNow: Date.now(),
  });
});

app.put('/api/state', requireAuth, (req, res) => {
  const { state, version, clientId } = req.body || {};
  if (!state || typeof state !== 'object') {
    return res.status(400).json({ error: 'state (object) is required' });
  }
  const stateJson = JSON.stringify(state);

  // Transition allowance: a browser still running a cached copy of the pre-versioning client
  // omits `version` entirely. Rejecting it would silently drop that device's saves (the old
  // client never checked the response status), so accept it unconditionally and log it instead.
  // Every current client always sends a number, including 0 for "I have never synced".
  if (version === undefined) {
    console.warn(`unversioned write from family ${req.familyId} — client is running stale code`);
    const legacy = db.prepare(
      `insert into app_state (family_id, state, version, updated_at) values (?, ?, 1, datetime('now'))
       on conflict(family_id) do update set state = excluded.state, version = app_state.version + 1, updated_at = datetime('now')
       returning version`
    ).get(req.familyId, stateJson);
    notifyFamily(req.familyId, legacy.version, clientId);
    return res.json({ ok: true, version: legacy.version });
  }

  // First write for this family. If another device raced us to creating the row, this inserts
  // nothing and we fall through to the version-checked update, which will 409 correctly.
  if (version === 0) {
    const inserted = db.prepare(
      `insert into app_state (family_id, state, version, updated_at) values (?, ?, 1, datetime('now'))
       on conflict(family_id) do nothing
       returning version`
    ).get(req.familyId, stateJson);
    if (inserted) {
      notifyFamily(req.familyId, inserted.version, clientId);
      return res.json({ ok: true, version: inserted.version });
    }
  }

  const updated = db.prepare(
    `update app_state set state = ?, version = version + 1, updated_at = datetime('now')
     where family_id = ? and version = ?
     returning version`
  ).get(stateJson, req.familyId, version);
  if (updated) {
    notifyFamily(req.familyId, updated.version, clientId);
    return res.json({ ok: true, version: updated.version });
  }

  // Stale write: someone committed between this client's last read and this save. Hand back the
  // current state alongside the 409 so the client can merge and retry in one round trip.
  const current = db.prepare('select state, version from app_state where family_id = ?').get(req.familyId);
  res.status(409).json({
    error: 'version conflict',
    state: current ? JSON.parse(current.state) : null,
    version: current ? current.version : 0,
    serverNow: Date.now(),
  });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'something went wrong' });
});

const port = process.env.PORT || 3108;
initSchema();

const server = app.listen(port, () => {
  console.log(`dadstats listening on ${port}`);

  // An auto-generated admin password is worthless if the owner never sees it, and it's only
  // printed when it was generated — so it doesn't sit in the logs of every subsequent restart.
  if (admin.generated) {
    console.log('\n' + '='.repeat(64));
    console.log('  Admin password (for adding more families later, at /admin):\n');
    console.log(`      ${admin.value}\n`);
    console.log('  Saved to the data volume; set ADMIN_PASSWORD to choose your own.');
    console.log('='.repeat(64) + '\n');
  }

  // Nobody should have to read this to get started — the app itself walks a new instance
  // through creating the first account. The banner is a pointer, not an instruction.
  if (setupNeeded()) {
    console.log(`Open http://localhost:${port} to set up your first family.`);
  }
});

// The entrypoint execs node as PID 1, and Linux gives PID 1 no default signal dispositions —
// so without these handlers SIGTERM is simply ignored. Docker then waits out its grace period
// and SIGKILLs, which meant every stop, restart and redeploy took ten seconds and killed the
// database mid-write instead of closing it. WAL makes that survivable, not correct.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — shutting down`);

  // SSE streams are deliberately long-lived, so server.close() would wait on them forever:
  // it stops accepting new connections but does not end open ones. Close them explicitly.
  for (const streams of familyStreams.values()) {
    for (const stream of streams) {
      try { stream.end(); } catch { /* already gone */ }
    }
  }
  familyStreams.clear();

  server.close(() => {
    try { db.close(); } catch { /* nothing useful to do at this point */ }
    process.exit(0);
  });

  // Backstop for a request that refuses to finish. Well inside Docker's default 10s grace, so
  // a clean-ish exit still beats being killed.
  setTimeout(() => {
    try { db.close(); } catch { /* ignore */ }
    process.exit(0);
  }, 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
