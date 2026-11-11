require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { db, initSchema, loadOrCreateJwtSecret, loadOrCreateAdminPassword, loadOrCreateInstanceId } = require('./db');
const {
  login, logout, requireAuth,
  adminLogin, adminLogout, requireAdmin,
} = require('./auth');
const {
  listFamilies, createFamily, updateFamily, deleteFamily,
  setupNeeded, setupStatus, completeSetup,
} = require('./admin');
const { loginLimiter } = require('./ratelimit');
const { fetchIcsFeed, icsFeedLimiter } = require('./icalProxy');
const helmet = require('helmet');

// Must happen before any request can hit login/requireAuth, both of which read
// process.env.JWT_SECRET lazily per-call.
process.env.JWT_SECRET = loadOrCreateJwtSecret();
const admin = loadOrCreateAdminPassword();
process.env.ADMIN_PASSWORD = admin.value;
const INSTANCE_ID = loadOrCreateInstanceId();

// Surfaced in the app footer so "which build is this?" is answerable without shelling into the
// container — the question that prompted adding it. CI stamps the tag at build time; a local
// build falls back to package.json and is labelled dev.
// CI stamps this from the git tag, which is `v0.3.0` — the leading `v` is stripped here rather
// than at each display site, so /api/health always reports a bare semver and callers are free to
// prefix it themselves (both the footer and the admin page do).
const APP_VERSION = (process.env.APP_VERSION || require('../package.json').version || 'dev')
  .replace(/^v(?=\d)/, '');

const app = express();

// Behind a reverse proxy, every request otherwise looks like it came from the proxy's IP, which
// would turn the per-client login rate limit into a single global one (see ratelimit.js).
//
// The value is a hop COUNT, not a flag, and that distinction is the whole point. `trust proxy =
// true` trusts the entire X-Forwarded-For chain, and the left-most entry of that chain is
// whatever the visitor typed into the header — so one forged request buys a fresh rate-limit
// bucket, and the limiter this setting exists to fix becomes bypassable. A count instead tells
// Express how many entries on the right were written by proxies you actually run:
//
//   TRUST_PROXY=1            one proxy in front of the app (nginx, Caddy, NPM, Traefik)
//   TRUST_PROXY=2            two hops — e.g. Cloudflare in front of your own reverse proxy
//   TRUST_PROXY=10.0.0.0/8   trust requests from these addresses as proxies
//   TRUST_PROXY=true         the whole chain. Only when you control every hop in it.
//
// Unset is safe but blunt: every visitor shares one bucket, so one person's typo can lock out
// the household for the window. Count the hops instead and give each client its own.
//
// A hop count is only as good as the assumption that requests arrive *through* those proxies:
// if the container's port is also reachable directly, a client can connect to it and forge the
// header itself. Publish the port to the proxy only, or leave this unset.
const TRUST_PROXY = (process.env.TRUST_PROXY || '').trim();
if (TRUST_PROXY) {
  const hops = Number(TRUST_PROXY);
  // `yes`/`true` keep meaning "the whole chain" because earlier versions of this app documented
  // TRUST_PROXY as a flag, and an install that still says `yes` must not crash on boot: Express
  // compiles anything else as a list of proxy addresses and throws on a word it can't parse.
  app.set(
    'trust proxy',
    /^(true|yes)$/i.test(TRUST_PROXY) ? true
      : (Number.isInteger(hops) && hops >= 0 ? hops : TRUST_PROXY)
  );
}
// Response headers. The app answered with `X-Powered-By: Express` and nothing else, which is
// the wrong way round: it advertised the stack and declined to say anything a browser could use
// to contain a mistake.
app.disable('x-powered-by');
app.use(helmet({
  // The whole client is one HTML file with its script and styles inline — that's deliberate
  // (see CLAUDE.md), and it means this first policy has to allow 'unsafe-inline' for both.
  // What's left is still worth having: with default-src 'self' and no external origins allowed,
  // an injected <script src> or an exfiltrating fetch() has nowhere to point. Moving the script
  // into public/app.js is what would let 'unsafe-inline' go, and it's a separate decision.
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'", "'unsafe-inline'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      // Icons and the apple-touch-icon; everything the app renders is same-origin.
      'img-src': ["'self'"],
      'font-src': ["'self'"],
      // Covers the live-update stream and every API call, including the calendar import — which
      // goes through this server's own proxy precisely so the browser never reaches a third
      // party (see icalProxy.js). A feed URL pasted by a family is fetched server-side.
      'connect-src': ["'self'"],
      'manifest-src': ["'self'"],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
      'frame-ancestors': ["'none'"],
      // Deliberately NOT upgrade-insecure-requests: plenty of installs are a plain-HTTP LAN
      // address, and that directive would rewrite this page's own relative requests to https
      // and break the app for them. The reverse proxy is the right place to force HTTPS.
    },
  },
  // Applied per-request below instead. Sent unconditionally it would reach plain-HTTP installs,
  // where it is both meaningless and a trap: a browser that sees it once on a LAN hostname will
  // refuse to load that hostname over HTTP afterwards.
  strictTransportSecurity: false,
  // Would make the page a cross-origin-isolated context, which nothing here needs and which
  // breaks any future embed.
  crossOriginEmbedderPolicy: false,
}));

// HSTS only where it means something: a response to a request that actually arrived over TLS.
// Needs TRUST_PROXY set when a proxy terminates it, same as the cookie flag. 180 days, and no
// includeSubDomains — this app has no business making promises about its neighbours.
const hsts = helmet.strictTransportSecurity({
  maxAge: 180 * 24 * 60 * 60,
  includeSubDomains: false,
});
app.use((req, res, next) => (req.secure ? hsts(req, res, next) : next()));

// Two body limits, because exactly one route needs a big one.
//
// The client PUTs its entire state on every save, so that ceiling grows with a family's whole
// history (all profiles/seasons/games/logs), not with a single game. At 2mb a few seasons in,
// every save would start failing with a 413 that the client surfaces as nothing at all.
//
// Everything else — login, setup, a family rename — is a handful of fields, and two of those
// routes are reachable with no account at all. Applying the 8mb ceiling globally meant anyone on
// the internet could make the app read and buffer 8mb per request before it so much as checked a
// password. 64kb is orders of magnitude more than any of them send.
const smallBody = express.json({ limit: '64kb' });
const stateBody = express.json({ limit: '8mb' });

// The big parser is attached to the state route itself, below, *after* requireAuth — so an
// unauthenticated request is turned away before anything buffers it. That only holds if the
// small parser doesn't get there first, hence the skip.
const isStateWrite = (req) => req.method === 'PUT' && req.path === '/api/state';
app.use((req, res, next) => (isStateWrite(req) ? next() : smallBody(req, res, next)));
app.use(cookieParser());
// Absolute so the app doesn't depend on the working directory it was started from.
app.use(express.static(path.join(__dirname, '..', 'public')));

// The admin page is documented as /admin; static serving alone would only answer /admin.html.
// It carries no secrets — every admin API call behind it requires the admin cookie.
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));

app.get('/api/health', (req, res) => {
  try {
    db.prepare('select 1').get();
    // Version is here rather than behind auth so the login and setup screens can show it too.
    res.json({ ok: true, db: 'up', version: APP_VERSION });
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

// A season's schedule importer pastes a feed URL here and gets the raw text back — see
// icalProxy.js for why this can't just be a client-side fetch(), and for the SSRF guard that
// makes it safe to let an authenticated family member point it at an arbitrary URL.
app.get('/api/ical-proxy', requireAuth, icsFeedLimiter, wrap(fetchIcsFeed));

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
    // Which account this data belongs to. The client caches state in localStorage, which is
    // keyed by origin and outlives the container behind it — so a rebuilt instance, or a
    // different family signing in on the same address, would otherwise inherit and then upload
    // the previous account's data. The client compares this and drops a cache that isn't ours.
    account: INSTANCE_ID + ':' + req.familyId,
  });
});

app.put('/api/state', requireAuth, stateBody, (req, res) => {
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
  // A body that overran its limit, or wasn't JSON, is the caller's problem. Reporting those as
  // 500 would both mislabel them and bury the real cause: body-parser already knows exactly what
  // went wrong, and a client that gets a 500 has no reason to think trimming its request helps.
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({ error: 'request body too large' });
  }
  if (err && (err.type === 'entity.parse.failed' || err.type === 'encoding.unsupported')) {
    return res.status(400).json({ error: 'invalid request body' });
  }
  console.error(err);
  res.status(500).json({ error: 'something went wrong' });
});

const port = process.env.PORT || 3211;
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
