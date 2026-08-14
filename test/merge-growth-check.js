// Repeated merges must not grow the state.
//
// This is the regression test for a bug that reached production. mergeStates coalesces profiles
// by name, and the tombstone rules added a case where a *deleted* profile sharing a name with a
// *live* one deliberately refused to coalesce (so a tombstone couldn't kill a new kid who reused
// a deleted one's name). But that tombstone also never claimed the name key — so on the next
// merge it failed to match itself and was appended again. Every sync added one more copy.
//
// A real account reached 13,440 copies of a single deleted profile and 2.5MB of state, which the
// client re-uploaded on every save. The visible symptom was not "duplicates" — the UI filters
// tombstones, so the list looked normal — it was a phone that had become too slow to respond to
// a tap.
//
// Runs the real mergeStates out of public/index.html rather than a copy, so it can't drift.
//
//   node test/merge-growth-check.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const fails = [];
const check = (label, ok, detail) => {
  if (ok) console.log('  ok    ' + label);
  else { console.log('  FAIL  ' + label + (detail ? ' — ' + detail : '')); fails.push(label); }
};

// The client is one big IIFE against the DOM, so rather than boot it, lift out the few pure
// functions this needs. They're extracted by name and evaluated in a sandbox with the small
// amount of surrounding scaffolding they reference.
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];

function extract(name) {
  const start = script.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('could not find function ' + name);
  let depth = 0, i = script.indexOf('{', start);
  const from = i;
  for (; i < script.length; i++) {
    if (script[i] === '{') depth++;
    else if (script[i] === '}') { depth--; if (depth === 0) break; }
  }
  return script.slice(start, i + 1);
}

const NEEDED = [
  'mergeStates', 'sanitize', 'mergeGamesInto', 'mergePlayers', 'mergePlayer', 'mergeLogs',
  'activeSeasons', 'activeProfiles', 'activePlayers', 'activeLogEntries', 'withDefaults',
  'emptyPlayer', 'freshSeason', 'sportOfSeason', 'sportConfig', 'recomputeFromLog',
  'findGameInProfile', 'uid', 'now', 'nowIso',
];

const sandbox = {
  console,
  Date,
  Math,
  JSON,
  // Scaffolding the extracted functions close over.
  SCREENS: ['home', 'profile', 'season', 'tracker'],
  DEFAULT_SPORT: 'basketball',
  LEGACY_META_TS: 0,
  clockOffset: 0,
  state: null,
  SPORTS: null,
};
vm.createContext(sandbox);

// SPORTS drives withDefaults/recomputeFromLog; take the real object rather than a stand-in.
const sportsSrc = script.slice(script.indexOf('var SPORTS = {'), script.indexOf('var SPORT_KEYS'));
vm.runInContext(sportsSrc, sandbox);
vm.runInContext('var SPORT_KEYS = Object.keys(SPORTS);', sandbox);
NEEDED.forEach((n) => {
  try { vm.runInContext(extract(n), sandbox); }
  catch (e) { console.error('could not lift ' + n + ': ' + e.message); process.exit(1); }
});

// --- The exact shape that caused the production bug: a live profile and a tombstone that share
// --- a name but have different ids ("deleted Hayden, made a new Hayden").
function baseState() {
  return {
    nav: { screen: 'home', profileId: null },
    profiles: [
      { id: 'dead-1', name: 'Hayden', removed: true, activeSeasonId: null,
        seasons: [{ id: 's-dead', name: 'Season 1', sport: 'basketball', removed: true, games: [] }] },
      { id: 'live-1', name: 'Hayden', removed: false, activeSeasonId: 's-live',
        seasons: [{ id: 's-live', name: '2026 - Premier', sport: 'soccer', removed: false, games: [] }] },
      { id: 'live-2', name: 'Abbie', removed: false, activeSeasonId: 's-abbie',
        seasons: [{ id: 's-abbie', name: '2026 - JV', sport: 'basketball', removed: false, games: [] }] },
    ],
  };
}

const start = sandbox.sanitize(baseState());
check('starts with 3 profile entries', start.profiles.length === 3, 'got ' + start.profiles.length);

// Merge the state against itself repeatedly, which is what a device does every time it resyncs.
let local = start;
let server = sandbox.sanitize(baseState());
const counts = [];
for (let i = 0; i < 25; i++) {
  local = sandbox.mergeStates(local, server);
  server = JSON.parse(JSON.stringify(local));
  counts.push(local.profiles.length);
}

const grew = counts[counts.length - 1] > counts[0];
check('repeated merges do not grow the profile list', !grew,
  'entries went ' + counts[0] + ' -> ' + counts[counts.length - 1] + ' over 25 merges');
check('settles at 3 entries', local.profiles.length === 3, 'got ' + local.profiles.length);

// The behaviour the tombstone rules exist for must still hold.
const live = sandbox.activeProfiles(local).map((p) => p.name).sort();
check('both live profiles survive', JSON.stringify(live) === JSON.stringify(['Abbie', 'Hayden']),
  JSON.stringify(live));
const deadStillDead = local.profiles.filter((p) => p.id === 'dead-1').every((p) => p.removed);
check('the tombstone stays a tombstone', deadStillDead);
const liveStillLive = local.profiles.filter((p) => p.id === 'live-1').every((p) => !p.removed);
check('the re-created profile is not killed by the old tombstone', liveStillLive);

// Two devices independently adding the same kid should still converge to one profile — that's
// what name coalescing is for, and the id-first lookup must not break it.
const a = sandbox.sanitize({
  nav: { screen: 'home', profileId: null },
  profiles: [{ id: 'a-1', name: 'Jordan', removed: false, activeSeasonId: 'sa',
    seasons: [{ id: 'sa', name: 'Season 1', sport: 'basketball', removed: false, games: [] }] }],
});
const b = sandbox.sanitize({
  nav: { screen: 'home', profileId: null },
  profiles: [{ id: 'b-1', name: 'Jordan', removed: false, activeSeasonId: 'sb',
    seasons: [{ id: 'sb', name: 'Season 1', sport: 'basketball', removed: false, games: [] }] }],
});
const converged = sandbox.mergeStates(a, b);
check('two devices adding the same kid converge to one profile',
  sandbox.activeProfiles(converged).length === 1,
  'got ' + sandbox.activeProfiles(converged).length);

// A state already damaged by the old bug must heal, not merely stop growing.
const damaged = baseState();
for (let i = 0; i < 500; i++) {
  damaged.profiles.push(JSON.parse(JSON.stringify(damaged.profiles[0])));
}
const healed = sandbox.sanitize(damaged);
check('an already-bloated state collapses on load', healed.profiles.length === 3,
  'got ' + healed.profiles.length + ' from 503');
check('healing keeps both live profiles',
  sandbox.activeProfiles(healed).length === 2, 'got ' + sandbox.activeProfiles(healed).length);

console.log();
console.log(fails.length ? `FAIL (${fails.length})` : 'PASS');
process.exit(fails.length ? 1 : 0);
