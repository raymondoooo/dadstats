// TRUST_PROXY is a hop count, and this proves it counts.
//
// The login limiter buckets by client address. Behind a proxy that address comes out of
// X-Forwarded-For, and how much of that header is believed is the whole question: trust the
// right-hand entries your own proxies wrote and each visitor gets a bucket; trust the left-hand
// end and the visitor picks their own bucket per request, which is the same as having no limit.
//
// So each phase burns the limiter with one forged header and then checks *which* other headers
// land in the same bucket. The pass/fail difference between one hop and two is only visible
// that way — nothing in the API reports the address it decided on.
//
// Run through test/run-proxy-check.sh, which starts the instances this needs (one per hop
// count). Phase is argv[2]: `one` or `two`.
const { provisionFamily, APP_URL: URL } = require('./helpers');

const PHASE = process.argv[2];
const fails = [];
const check = (label, ok, detail) => {
  if (ok) console.log('  ok    ' + label);
  else { console.log('  FAIL  ' + label + (detail ? ' — ' + detail : '')); fails.push(label); }
};

async function post(path, body, headers) {
  const res = await fetch(URL + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, setCookie: res.headers.get('set-cookie') };
}

// Documented ranges for examples (RFC 5737), so nothing here can look like a real address.
const CLIENT_A = '203.0.113.11';
const CLIENT_B = '203.0.113.22';
const EDGE_1 = '198.51.100.7';
const EDGE_2 = '198.51.100.8';

// Enough wrong passwords to exhaust the window (10) for whichever bucket these headers resolve to.
async function burnLimiter(xff) {
  let last = 0;
  for (let i = 0; i < 12; i++) {
    const r = await post('/api/login', { password: `wrong-guess-${i}` }, { 'X-Forwarded-For': xff });
    last = r.status;
    if (r.status === 429) break;
  }
  return last;
}

(async () => {
  console.log(`== TRUST_PROXY=${PHASE === 'two' ? 2 : 1} ==`);

  // --- The Secure flag follows the request's own protocol ---
  const password = await provisionFamily('Proxy Test');

  const plain = await post('/api/login', { password });
  check('a plain-HTTP login gets a cookie without Secure',
    plain.status === 200 && !/;\s*Secure/i.test(plain.setCookie || ''),
    `status ${plain.status}, cookie ${plain.setCookie}`);

  const forwarded = await post('/api/login', { password }, { 'X-Forwarded-Proto': 'https' });
  check('the same login behind an HTTPS proxy gets Secure',
    forwarded.status === 200 && /;\s*Secure/i.test(forwarded.setCookie || ''),
    `status ${forwarded.status}, cookie ${forwarded.setCookie}`);

  // --- Which bucket a forged header lands in ---
  if (PHASE === 'two') {
    // Two hops: the app's own proxy wrote the right-hand entry, so the client address is the
    // LEFT one of the two. A different intermediate must not buy a fresh bucket; a different
    // client must.
    const burned = await burnLimiter(`${CLIENT_A}, ${EDGE_1}`);
    check('the limiter trips for a client two hops out', burned === 429, 'last status ' + burned);

    const sameClientOtherEdge = await post('/api/login', { password: 'nope' },
      { 'X-Forwarded-For': `${CLIENT_A}, ${EDGE_2}` });
    check('same client via a different intermediate stays blocked',
      sameClientOtherEdge.status === 429, 'status ' + sameClientOtherEdge.status);

    const otherClient = await post('/api/login', { password: 'nope' },
      { 'X-Forwarded-For': `${CLIENT_B}, ${EDGE_1}` });
    check('a different client two hops out gets its own bucket',
      otherClient.status === 401, 'status ' + otherClient.status);

    // The giveaway for a count that is one too high: with only two hops configured, a client that
    // prepends an extra entry would be read as the one further left if the chain were trusted
    // whole. It must still be counted as itself.
    const prepended = await post('/api/login', { password: 'nope' },
      { 'X-Forwarded-For': `${CLIENT_B}, ${CLIENT_A}, ${EDGE_1}` });
    check('prepending an extra entry does not move a blocked client out of its bucket',
      prepended.status === 429, 'status ' + prepended.status);
  } else {
    // One hop: the client address is the right-hand entry, because that is the only one this
    // app's single proxy could have written.
    const burned = await burnLimiter(CLIENT_A);
    check('the limiter trips for a client one hop out', burned === 429, 'last status ' + burned);

    const same = await post('/api/login', { password: 'nope' }, { 'X-Forwarded-For': CLIENT_A });
    check('the same client stays blocked', same.status === 429, 'status ' + same.status);

    const other = await post('/api/login', { password: 'nope' }, { 'X-Forwarded-For': CLIENT_B });
    check('a different client gets its own bucket', other.status === 401, 'status ' + other.status);

    // With one hop trusted, everything to the left of the last entry is the visitor's own words.
    // A blocked client prepending addresses must not escape its bucket.
    const prepended = await post('/api/login', { password: 'nope' },
      { 'X-Forwarded-For': `${CLIENT_B}, ${CLIENT_A}` });
    check('a blocked client cannot escape by prepending an address',
      prepended.status === 429, 'status ' + prepended.status);
  }

  console.log();
  console.log(fails.length ? `FAIL (${fails.length})` : 'PASS');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e && e.message); process.exit(1); });
