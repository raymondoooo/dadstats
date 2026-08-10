// Throttles password guessing on the login endpoints. In-memory is sufficient and correct here:
// the app is a single process in a single container, so there is no second instance whose counts
// would need sharing, and losing the counts on restart is not a meaningful bypass (an attacker
// can't trigger a restart).
//
// Counts FAILURES, not requests — a family scoring a game never trips it, only wrong passwords do.
// bcrypt at cost 12 already caps guessing at roughly tens per second; this turns that into a hard
// ceiling per client.
//
// IMPORTANT: behind a reverse proxy every request appears to come from the proxy's IP, which
// would make this limit global rather than per-client — one person fat-fingering their password
// would lock out everybody. Set TRUST_PROXY=1 so Express reads X-Forwarded-For instead
// (see server/index.js).

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;

const failures = new Map(); // key -> { count, firstAt }

function sweep() {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [key, entry] of failures) {
    if (entry.firstAt < cutoff) failures.delete(key);
  }
}
// Bounds memory without a timer that would hold the process open.
setInterval(sweep, WINDOW_MS).unref();

function currentEntry(key) {
  const entry = failures.get(key);
  if (!entry) return null;
  if (Date.now() - entry.firstAt >= WINDOW_MS) {
    failures.delete(key);
    return null;
  }
  return entry;
}

// Express middleware: rejects once a client has burned through its failures, and exposes
// req.recordAuthFailure() / req.clearAuthFailures() for the handler to call based on the outcome.
function loginLimiter(scope) {
  return function (req, res, next) {
    const key = scope + ':' + (req.ip || 'unknown');
    const entry = currentEntry(key);
    if (entry && entry.count >= MAX_FAILURES) {
      const retryAfter = Math.ceil((entry.firstAt + WINDOW_MS - Date.now()) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: `Too many failed attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`,
      });
    }
    req.recordAuthFailure = function () {
      const existing = currentEntry(key);
      if (existing) existing.count++;
      else failures.set(key, { count: 1, firstAt: Date.now() });
    };
    req.clearAuthFailures = function () { failures.delete(key); };
    next();
  };
}

module.exports = { loginLimiter };
