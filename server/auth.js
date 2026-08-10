const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db } = require('./db');

// Two separate identities, two separate cookies:
//   family — scores games, sees only its own kids/seasons/games
//   admin  — creates and manages families, never touches game data
//
// Within a family there is still no username or email: the password is the whole credential, so
// two parents given the same password can both sign in and score the same game from two phones.
// Families are created by the admin (see admin.js), and a password matching no family is simply
// rejected — earlier versions turned an unrecognised password into a brand new account, which
// meant a typo silently dropped you into an empty app instead of telling you anything.
//
// bcrypt hashes are salted, so they can't be looked up by equality: login is a linear scan
// running bcrypt.compare against each family. Fine at the scale a household instance ever sees.
const COOKIE_NAME = 'dadstats_session';
const ADMIN_COOKIE_NAME = 'dadstats_admin';
const JWT_EXPIRY = '30d';
const ADMIN_JWT_EXPIRY = '12h';

// Opt-in rather than derived from NODE_ENV. A `secure` cookie is only sent back over HTTPS, so
// defaulting it on (as a production build otherwise would) silently breaks login for anyone
// self-hosting over plain HTTP on their LAN — they'd sign in, get a cookie the browser refuses
// to return, and bounce straight back to the login form with no error to explain it.
// If you terminate TLS at a reverse proxy, the browser still sees HTTPS, so set this to 1.
const SECURE_COOKIES = /^(1|true|yes)$/i.test(process.env.SECURE_COOKIES || '');

function cookieOptions(maxAgeMs) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: SECURE_COOKIES,
    maxAge: maxAgeMs,
  };
}

function issueSession(res, familyId) {
  const token = jwt.sign({ sub: familyId }, process.env.JWT_SECRET, { expiresIn: JWT_EXPIRY });
  res.cookie(COOKIE_NAME, token, cookieOptions(30 * 24 * 60 * 60 * 1000));
}

async function login(req, res) {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'password is required' });

  const families = db.prepare('select id, password_hash from families').all();
  for (const fam of families) {
    if (await bcrypt.compare(password, fam.password_hash)) {
      req.clearAuthFailures();
      issueSession(res, fam.id);
      return res.json({ ok: true });
    }
  }

  // Deliberately vague: naming which part was wrong would confirm to a guesser whether any
  // family uses a given password.
  req.recordAuthFailure();
  res.status(401).json({ error: 'That password does not match any family on this server.' });
}

function logout(req, res) {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
}

function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'not signed in' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.familyId = payload.sub;
    next();
  } catch {
    res.status(401).json({ error: 'session expired, please sign in again' });
  }
}

// --- Admin ---

// timingSafeEqual throws on length mismatch and would otherwise leak length via early return,
// so both sides are hashed to a fixed width first.
function constantTimeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function adminLogin(req, res) {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'password is required' });

  if (!constantTimeEqual(password, process.env.ADMIN_PASSWORD || '')) {
    req.recordAuthFailure();
    return res.status(401).json({ error: 'Incorrect admin password.' });
  }
  req.clearAuthFailures();
  // Shorter-lived than a family session: this one can create and delete accounts, and it's used
  // occasionally from a desktop rather than all game from a phone in a pocket.
  const token = jwt.sign({ admin: true }, process.env.JWT_SECRET, { expiresIn: ADMIN_JWT_EXPIRY });
  res.cookie(ADMIN_COOKIE_NAME, token, cookieOptions(12 * 60 * 60 * 1000));
  res.json({ ok: true });
}

function adminLogout(req, res) {
  res.clearCookie(ADMIN_COOKIE_NAME);
  res.json({ ok: true });
}

function requireAdmin(req, res, next) {
  const token = req.cookies?.[ADMIN_COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'not signed in as admin' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (!payload.admin) return res.status(401).json({ error: 'not an admin session' });
    next();
  } catch {
    res.status(401).json({ error: 'admin session expired, please sign in again' });
  }
}

module.exports = {
  login, logout, requireAuth, COOKIE_NAME,
  adminLogin, adminLogout, requireAdmin, ADMIN_COOKIE_NAME,
  // Exported for first-run setup (admin.js), which signs the new family straight in rather than
  // bouncing them to a login form they'd fill with the password they just chose.
  issueSession,
};
