// Regression tests for security bugs that were actually found in this codebase, plus the
// boundaries in SECURITY.md. Every case here is something that was once wrong, or something
// whose correctness is invisible until it fails in the field.
//
//   APP_URL=http://localhost:3208 ADMIN_PASSWORD=... node test/security-check.js
const { provisionFamily, APP_URL: URL } = require('./helpers');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

async function req(method, path, { body, cookie, headers } = {}) {
  const res = await fetch(URL + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(headers || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  let parsed = {};
  try { parsed = JSON.parse(await res.text()); } catch { /* not JSON */ }
  return { status: res.status, body: parsed, setCookie: res.headers.get('set-cookie') };
}

const fails = [];
const check = (label, ok, detail) => {
  if (ok) console.log('  ok    ' + label);
  else { console.log('  FAIL  ' + label + (detail ? ' — ' + detail : '')); fails.push(label); }
};

(async () => {
  console.log('== session cookie ==');

  const famPassword = await provisionFamily('Security Test');
  const login = await req('POST', '/api/login', { body: { password: famPassword } });
  check('valid family password signs in', login.status === 200, 'status ' + login.status);

  const cookie = (login.setCookie || '').split(';')[0];

  // Regression: `secure` was once derived from NODE_ENV, so a production image served over plain
  // HTTP handed out a cookie the browser accepted and then refused to send back — an infinite
  // login loop with no error message. Over plain HTTP the flag must stay off unless the operator
  // forced it on with SECURE_COOKIES.
  const forced = /^(1|true|yes)$/i.test(process.env.SECURE_COOKIES || '');
  const secureFlagged = /;\s*Secure/i.test(login.setCookie || '');
  check(
    `Secure flag off on plain HTTP${forced ? ' unless forced (it is)' : ''}`,
    secureFlagged === forced,
    `cookie: ${login.setCookie}`
  );
  check('session cookie is HttpOnly', /HttpOnly/i.test(login.setCookie || ''));

  // The cookie is marked Secure per-request now, from X-Forwarded-Proto — but only when a proxy
  // is trusted. This instance trusts none, so the header is a client-supplied claim and must be
  // ignored: believing it would hand out a Secure cookie to a plain-HTTP browser, which is the
  // silent login loop above by another route. The trusted case is proven in proxy-check.js,
  // which can configure TRUST_PROXY.
  const trusted = (process.env.TRUST_PROXY || '').trim() !== '';
  const spoofedProto = await req('POST', '/api/login', {
    body: { password: famPassword },
    headers: { 'X-Forwarded-Proto': 'https' },
  });
  const spoofSecure = /;\s*Secure/i.test(spoofedProto.setCookie || '');
  check(
    trusted ? 'X-Forwarded-Proto from a trusted proxy marks the cookie Secure'
            : 'X-Forwarded-Proto is ignored when no proxy is trusted',
    spoofSecure === (forced || trusted),
    `cookie: ${spoofedProto.setCookie}`
  );

  console.log('== auth boundaries ==');

  const wrong = await req('POST', '/api/login', { body: { password: 'definitely-not-a-password' } });
  check('wrong password rejected', wrong.status === 401, 'status ' + wrong.status);

  // Self-signup must stay closed: an unrecognised password used to silently create an account.
  const familiesBefore = ADMIN_PASSWORD ? await countFamilies() : null;
  await req('POST', '/api/login', { body: { password: 'another-unused-password-' + Date.now() } });
  if (familiesBefore !== null) {
    const after = await countFamilies();
    check('unknown password does not create an account', after === familiesBefore,
      `${familiesBefore} -> ${after}`);
  }

  // First-run setup must stay closed on a configured instance, or it *is* self-signup.
  const setup = await req('POST', '/api/setup', {
    body: { name: 'Intruder', password: 'intruder-password' },
  });
  check('setup endpoint closed once configured', setup.status === 409, 'status ' + setup.status);

  const noAuth = await req('GET', '/api/state');
  check('state requires a session', noAuth.status === 401, 'status ' + noAuth.status);

  const adminNoAuth = await req('GET', '/api/admin/families');
  check('admin API requires the admin cookie', adminNoAuth.status === 401, 'status ' + adminNoAuth.status);

  // A family session must not be usable as an admin one.
  const adminWithFamilyCookie = await req('GET', '/api/admin/families', { cookie });
  check('family session cannot reach the admin API',
    adminWithFamilyCookie.status === 401, 'status ' + adminWithFamilyCookie.status);

  console.log('== logout ==');

  const stateBefore = await req('GET', '/api/state', { cookie });
  check('session works before logout', stateBefore.status === 200, 'status ' + stateBefore.status);

  const logout = await req('POST', '/api/logout', { cookie });
  const clearedCookie = (logout.setCookie || '').split(';')[0];
  const stateAfter = await req('GET', '/api/state', { cookie: clearedCookie });
  check('logout invalidates the session', stateAfter.status === 401, 'status ' + stateAfter.status);

  console.log('== calendar feed import (SSRF guard) ==');

  // No auth, no proxying — same boundary as every other family-scoped endpoint.
  const icsNoAuth = await req('GET', '/api/ical-proxy?url=http://example.com/x.ics');
  check('ical-proxy requires a session', icsNoAuth.status === 401, 'status ' + icsNoAuth.status);

  // IP literals reject on the guard's own logic before any network call, so these exercise the
  // real route -> middleware -> handler -> guard wiring without needing a reachable target.
  // Range coverage for the guard itself lives in ical-guard-check.js, which needs no server.
  const privateTargets = [
    ['loopback', 'http://127.0.0.1:9/'],
    ['a LAN address', 'http://192.168.1.1/'],
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['IPv6 loopback', 'http://[::1]/'],
  ];
  for (const [label, url] of privateTargets) {
    const r = await req('GET', '/api/ical-proxy?url=' + encodeURIComponent(url), { cookie });
    check(`ical-proxy rejects ${label}`, r.status === 400, `status ${r.status} for ${url}`);
  }

  const badScheme = await req('GET', '/api/ical-proxy?url=' + encodeURIComponent('file:///etc/passwd'), { cookie });
  check('ical-proxy rejects a non-http(s) scheme', badScheme.status === 400, 'status ' + badScheme.status);

  const noUrl = await req('GET', '/api/ical-proxy', { cookie });
  check('ical-proxy requires a url param', noUrl.status === 400, 'status ' + noUrl.status);

  console.log('== rate limiting ==');

  // Regression: the limiter counts *failures*, and a handler that never recorded one meant the
  // limit could never trip.
  //
  // The forged-header half only means something on an instance that trusts no proxy, which is
  // how this suite is run: there, X-Forwarded-For is just a string a client sent and must not
  // buy a fresh bucket. Where a hop count IS configured the header legitimately decides the
  // bucket, so rotating it is supposed to work — proxy-check.js covers that instance instead.
  let sawLimit = false;
  for (let i = 0; i < 14; i++) {
    const r = await req('POST', '/api/login', {
      body: { password: 'brute-force-guess-' + i },
      headers: trusted ? {} : { 'X-Forwarded-For': `10.0.0.${i}` },
    });
    if (r.status === 429) { sawLimit = true; break; }
  }
  check(
    trusted ? 'login rate limit trips' : 'login rate limit trips despite rotating X-Forwarded-For',
    sawLimit,
    'no 429 in 14 attempts'
  );

  console.log();
  console.log(fails.length ? `FAIL (${fails.length})` : 'PASS');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e && e.message); process.exit(1); });

async function countFamilies() {
  const login = await req('POST', '/api/admin/login', { body: { password: ADMIN_PASSWORD } });
  const adminCookie = (login.setCookie || '').split(';')[0];
  const list = await req('GET', '/api/admin/families', { cookie: adminCookie });
  return (list.body.families || []).length;
}
