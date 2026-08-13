// Fetches a calendar feed (TeamSnap, a league site, etc.) on behalf of the browser, so the
// client's importer can read it without hitting CORS — browsers have no way to fetch a
// cross-origin URL that doesn't opt in, and calendar hosts generally don't.
//
// That makes this an authenticated user telling the server to fetch an arbitrary URL, which is
// the textbook shape of SSRF (CWE-918): without guards, a family member could point it at
// 192.168.1.1, a cloud metadata endpoint, or anything else reachable from the container but not
// from their browser. The guard below resolves the hostname once, rejects private/loopback/
// link-local addresses, and then connects to that *literal* resolved address rather than the
// hostname — closing the DNS-rebinding gap where a second lookup (made by a naive fetch) could
// return something different from the one that passed the check. Redirects are re-validated the
// same way, one hop at a time, since a feed URL that passes the check could still redirect
// somewhere that wouldn't.
const dns = require('dns').promises;
const net = require('net');
const http = require('http');
const https = require('https');

const MAX_BODY_BYTES = 5 * 1024 * 1024; // a season's worth of games is a few KB; this is headroom
const FETCH_TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 3;

function isPrivateAddress(address, family) {
  if (family === 6 || address.includes(':')) {
    const a = address.toLowerCase();
    if (a === '::1' || a === '::') return true;
    if (a.startsWith('fe80:') || a.startsWith('fc') || a.startsWith('fd')) return true; // link-local + unique-local
    if (a.startsWith('::ffff:')) return isPrivateAddress(a.slice(7), 4); // IPv4-mapped
    return false;
  }
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true; // malformed — reject closed
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

// Resolves and validates in one step, returning the exact address the caller must connect to —
// callers must not re-resolve afterwards, or the validation it just did is worthless.
async function resolvePinnedAddress(hostname) {
  const literal = net.isIP(hostname);
  if (literal) {
    if (isPrivateAddress(hostname, literal)) throw new Error('that address is not reachable from here');
    return { address: hostname, family: literal };
  }
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  const safe = records.filter((r) => !isPrivateAddress(r.address, r.family));
  if (!safe.length) throw new Error('that address is not reachable from here');
  return safe[0];
}

function assertFetchableUrl(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error('not a valid URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('only http(s) feed URLs are supported');
  }
  return url;
}

function fetchOnce(url, hops) {
  return resolvePinnedAddress(url.hostname).then((addr) => new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request({
      method: 'GET',
      host: addr.address, // connect to the pinned, already-validated address, never the hostname
      family: addr.family,
      servername: url.protocol === 'https:' ? url.hostname : undefined, // TLS SNI still needs the real name
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        Host: url.hostname,
        'User-Agent': 'DadStats/1.0 (+schedule import; self-hosted, single container)',
        Accept: 'text/calendar, text/plain, */*',
      },
      timeout: FETCH_TIMEOUT_MS,
    }, (resp) => {
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
        resp.resume();
        if (hops >= MAX_REDIRECTS) return reject(new Error('too many redirects'));
        let next;
        try { next = assertFetchableUrl(new URL(resp.headers.location, url).toString()); }
        catch (e) { return reject(e); }
        return resolve(fetchOnce(next, hops + 1));
      }
      if (resp.statusCode < 200 || resp.statusCode >= 300) {
        resp.resume();
        return reject(new Error('feed responded with ' + resp.statusCode));
      }
      const chunks = [];
      let total = 0;
      let tooBig = false;
      resp.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_BODY_BYTES) { tooBig = true; resp.destroy(); return; }
        chunks.push(chunk);
      });
      resp.on('end', () => {
        if (tooBig) return reject(new Error('feed is too large'));
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
      resp.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('feed took too long to respond')));
    req.on('error', reject);
    req.end();
  }));
}

// One family fetching its own league's feed a handful of times an hour is normal use; this just
// stops the endpoint being usable as a general-purpose URL fetcher against arbitrary targets.
const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 10;
const requestLog = new Map(); // familyId -> [timestamps]

function icsFeedLimiter(req, res, next) {
  const key = req.familyId;
  const now = Date.now();
  const hits = (requestLog.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (hits.length >= MAX_REQUESTS_PER_WINDOW) {
    return res.status(429).json({ error: 'Too many feed syncs — wait a minute and try again.' });
  }
  hits.push(now);
  requestLog.set(key, hits);
  next();
}
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [key, hits] of requestLog) {
    const kept = hits.filter((t) => t > cutoff);
    if (kept.length) requestLog.set(key, kept);
    else requestLog.delete(key);
  }
}, WINDOW_MS).unref();

async function fetchIcsFeed(req, res) {
  const raw = String(req.query.url || '');
  if (!raw || raw.length > 2000) {
    return res.status(400).json({ error: 'Give me a feed URL.' });
  }
  let url;
  try { url = assertFetchableUrl(raw); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  // Validated separately from the fetch itself, so a bad *URL* (private, unresolvable, wrong
  // scheme) reports 400 and an actual fetch failure reports 502 — fetchOnce() re-validates every
  // hop on its own regardless, so this isn't the only thing standing between the guard and the
  // network; it's just what makes the first hop's rejection read as "your input" not "my fault".
  try { await resolvePinnedAddress(url.hostname); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  let text;
  try { text = await fetchOnce(url, 0); }
  catch (e) { return res.status(502).json({ error: e.message || 'Could not fetch that feed.' }); }

  if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 200))) {
    return res.status(502).json({ error: "That doesn't look like a calendar feed." });
  }
  res.json({ ok: true, text });
}

module.exports = { fetchIcsFeed, icsFeedLimiter, isPrivateAddress };
