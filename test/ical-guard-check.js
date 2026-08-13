// Unit test for the SSRF guard's address-range logic — see server/icalProxy.js and the
// "Importing a schedule" section of README.md for why this exists.
//
// Deliberately doesn't touch the network or a running server: isPrivateAddress() is a pure
// function, and its correctness is exactly what stands between "authenticated family member
// imports a schedule" and "authenticated family member probes the LAN." Exhaustive range
// coverage here is cheap and doesn't need Docker, a running app, or any fixture server — unlike
// the live-endpoint and redirect/size-cap paths, which do need a reachable target and are covered
// separately (see security-check.js for the live guard, ical-check.js for parsing/reconciliation
// via request interception). A fixture server for *this* guard would have to live at a private
// address for the container to reach it in CI, which the guard would then correctly refuse —
// testing it live would mean weakening the very protection under test, which isn't a trade this
// suite makes.
//
//   node test/ical-guard-check.js
const { isPrivateAddress } = require('../server/icalProxy');

const fails = [];
const check = (label, ok) => {
  if (ok) console.log('  ok    ' + label);
  else { console.log('  FAIL  ' + label); fails.push(label); }
};

console.log('== IPv4 ranges ==');
check('10.0.0.1 is private', isPrivateAddress('10.0.0.1', 4) === true);
check('10.255.255.255 is private', isPrivateAddress('10.255.255.255', 4) === true);
check('127.0.0.1 (loopback) is private', isPrivateAddress('127.0.0.1', 4) === true);
check('127.53.1.1 is private', isPrivateAddress('127.53.1.1', 4) === true);
check('0.0.0.0 is private', isPrivateAddress('0.0.0.0', 4) === true);
check('169.254.169.254 (cloud metadata) is private', isPrivateAddress('169.254.169.254', 4) === true);
check('172.16.0.1 (start of range) is private', isPrivateAddress('172.16.0.1', 4) === true);
check('172.31.255.255 (end of range) is private', isPrivateAddress('172.31.255.255', 4) === true);
check('172.15.255.255 (just below range) is NOT private', isPrivateAddress('172.15.255.255', 4) === false);
check('172.32.0.0 (just above range) is NOT private', isPrivateAddress('172.32.0.0', 4) === false);
check('192.168.1.1 is private', isPrivateAddress('192.168.1.1', 4) === true);
check('192.169.1.1 is NOT private', isPrivateAddress('192.169.1.1', 4) === false);
check('8.8.8.8 (public) is NOT private', isPrivateAddress('8.8.8.8', 4) === false);
check('1.1.1.1 (public) is NOT private', isPrivateAddress('1.1.1.1', 4) === false);
check('malformed address is rejected closed', isPrivateAddress('not-an-ip', 4) === true);

console.log('== IPv6 ranges ==');
check('::1 (loopback) is private', isPrivateAddress('::1', 6) === true);
check('fe80::1 (link-local) is private', isPrivateAddress('fe80::1', 6) === true);
check('fc00::1 (unique-local) is private', isPrivateAddress('fc00::1', 6) === true);
check('fd12:3456::1 (unique-local) is private', isPrivateAddress('fd12:3456::1', 6) === true);
check('2001:4860:4860::8888 (public, Google DNS) is NOT private', isPrivateAddress('2001:4860:4860::8888', 6) === false);
check('::ffff:127.0.0.1 (IPv4-mapped loopback) is private', isPrivateAddress('::ffff:127.0.0.1', 6) === true);
check('::ffff:8.8.8.8 (IPv4-mapped public) is NOT private', isPrivateAddress('::ffff:8.8.8.8', 6) === false);

console.log();
console.log(fails.length ? `FAIL (${fails.length})` : 'PASS');
process.exit(fails.length ? 1 : 0);
