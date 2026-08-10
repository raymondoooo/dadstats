// Shared test setup. Families are created by the admin now, so a test can't just invent a
// password and log in — it has to provision an account first, exactly like a real operator would.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const APP_URL = process.env.APP_URL || 'http://localhost:3108';

async function api(cookie, method, path, body) {
  const res = await fetch(APP_URL + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { /* non-JSON error page */ }
  return { ok: res.ok, status: res.status, body: parsed, setCookie: res.headers.get('set-cookie') };
}

// Creates a family via the admin API and returns the password to sign in with. Each call uses a
// unique name + password, so tests never collide with each other or with real data.
async function provisionFamily(label) {
  if (!ADMIN_PASSWORD) {
    throw new Error(
      'ADMIN_PASSWORD is required.\n' +
      'Start the test instance with a known admin password, e.g.\n' +
      '  docker run -d --name dadstats-test -p 3208:3108 -e ADMIN_PASSWORD=test-admin-pw \\\n' +
      '    -v dadstats-test-data:/app/data dadstats\n' +
      'then run tests with ADMIN_PASSWORD=test-admin-pw'
    );
  }

  const login = await api(null, 'POST', '/api/admin/login', { password: ADMIN_PASSWORD });
  if (!login.ok) throw new Error('admin login failed: ' + JSON.stringify(login.body));

  const adminCookie = (login.setCookie || '').split(';')[0];
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const password = `test-${unique}`;

  const created = await api(adminCookie, 'POST', '/api/admin/families', {
    name: `${label} ${unique}`,
    password,
  });
  if (!created.ok) throw new Error('family creation failed: ' + JSON.stringify(created.body));

  return password;
}

module.exports = { provisionFamily, APP_URL };
