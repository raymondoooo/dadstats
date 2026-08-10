# Tests

Three end-to-end browser checks. They drive a **running instance** over HTTP — there is no unit
test layer, because nearly all the logic lives in one browser-side file.

Each test provisions its own throwaway family through the admin API (`helpers.js`), so runs never
collide with each other. Still, point them at a scratch instance, not the one with your real
games in it — `admin-check.js` creates families that stick around.

## Setup

Playwright isn't a project dependency (nothing else needs it), so install it wherever you like:

```bash
npm install playwright
npx playwright install chromium
```

## Running

Start an instance with a **known** admin password so the tests can create families:

```bash
docker run -d --name dadstats-test -p 3208:3108 \
  -e ADMIN_PASSWORD=test-admin-pw \
  -v dadstats-test-data:/app/data dadstats

export APP_URL=http://localhost:3208 ADMIN_PASSWORD=test-admin-pw
node test/sync-check.js
node test/ui-check.js
node test/admin-check.js
```

All three exit non-zero on failure and drop screenshots in `test/screenshots/`.

## What each one covers

**`sync-check.js` — the one that matters.** Opens two independent browser contexts (separate
cookie jars and separate localStorage: two phones), signs both into the same family, has both
land on the same live game, then taps *different* stats on each and asserts **both devices end
up with the union of all taps**. This is the contract described in README § "Sync (the hard
part)" and flagged in CLAUDE.md — derived counters plus tombstoned deletes are what make
concurrent scoring merge instead of clobber, and when that breaks it stays invisible until two
people are scoring a real game from the stands.

Run it after touching: `mergeStates` / `mergePlayer` / `mergeLogs` / `mergeGamesInto`,
`recomputeFromLog`, the `PUT /api/state` version check, or the SSE push.

**`ui-check.js`** — single session through login → kid → season → game → taps → finalize →
Season Averages, asserting every derived number (points, FG/FT lines, and all twelve averages
columns). This is the regression test for the `SPORTS` stat-schema config: points, percentages,
and the averages table are all computed from it, so a bad edit surfaces as wrong arithmetic here.

Run it after touching `SPORTS`, `points()`, `seasonAverages()`, or the tracker card rendering.

**`admin-check.js`** — signs into `/admin`, creates a family with a generated password, and
confirms that password actually signs that family in. This is the gate everything else depends
on: if family creation breaks, nobody can get an account at all.

Run it after touching `server/admin.js`, `server/auth.js`, or `public/admin.html`.
