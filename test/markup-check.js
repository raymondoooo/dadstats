// Static check: every element id the client code reaches for actually exists in the markup.
//
// Cheap, and it catches a class of bug nothing else here does. The client is one big file that
// builds HTML from strings; a renamed or typo'd id fails silently at runtime — getElementById
// returns null, the listener is never attached, and the button just does nothing. No error, no
// failing request, nothing a server-side test would see. Only a browser on that exact screen
// would find it.
//
//   node test/markup-check.js
const fs = require('fs');
const path = require('path');

const files = ['public/index.html', 'public/admin.html'];
let failures = 0;

for (const file of files) {
  const full = path.join(__dirname, '..', file);
  const src = fs.readFileSync(full, 'utf8');

  // Ids the markup defines — both static attributes and ones built into template strings.
  const defined = new Set();
  for (const m of src.matchAll(/\bid\s*=\s*["']([\w-]+)["']/g)) defined.add(m[1]);

  // Ids the script reaches for.
  const referenced = new Map(); // id -> how it was referenced
  for (const m of src.matchAll(/getElementById\(\s*["']([\w-]+)["']\s*\)/g)) {
    referenced.set(m[1], 'getElementById');
  }
  // querySelector('#foo') / querySelectorAll('#foo ...') — only the leading id, and only when
  // it's a literal rather than a built string.
  for (const m of src.matchAll(/querySelector(?:All)?\(\s*["']#([\w-]+)/g)) {
    if (!referenced.has(m[1])) referenced.set(m[1], 'querySelector');
  }

  const missing = [];
  for (const [id, how] of referenced) {
    if (!defined.has(id)) missing.push(`${id} (via ${how})`);
  }

  if (missing.length) {
    failures += missing.length;
    console.log(`  FAIL  ${file} — ${missing.length} id(s) referenced but not defined:`);
    for (const m of missing) console.log(`          ${m}`);
  } else {
    console.log(`  ok    ${file} — ${referenced.size} referenced ids all exist (${defined.size} defined)`);
  }
}

console.log();
console.log(failures ? `FAIL (${failures})` : 'PASS');
process.exit(failures ? 1 : 0);
