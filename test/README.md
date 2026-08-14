# Tests

Ten browser checks plus five non-browser suites. Most drive a **running instance** over HTTP —
there is almost no unit test layer, because nearly all the logic lives in one browser-side file.
The two exceptions earn it: `ical-guard-check.js` tests a server-side function that can't be
exercised safely against a live instance, and `merge-growth-check.js` asserts on the shape of the
state rather than on anything the screen shows (see their entries below).

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
docker run -d --name dadstats-test -p 3208:3211 \
  -e ADMIN_PASSWORD=test-admin-pw \
  -v dadstats-test-data:/app/data dadstats

export APP_URL=http://localhost:3208 ADMIN_PASSWORD=test-admin-pw
node test/sync-check.js
node test/ui-check.js
node test/admin-check.js
node test/sport-check.js
node test/measurement-check.js
node test/tombstone-check.js
node test/ical-check.js
```

`setup-check.js` and `empty-state-check.js` are the exceptions: both assert on what a **virgin**
instance looks like, and both complete first-run setup themselves — so each needs its own
untouched container, and they can't share one with each other.

```bash
docker run -d --name dadstats-fresh -p 3209:3211 -v dadstats-fresh-data:/app/data dadstats
APP_URL=http://localhost:3209 node test/setup-check.js

# to run it again, throw the volume away — it only works once per instance
docker rm -f dadstats-fresh && docker volume rm dadstats-fresh-data

# empty-state-check.js needs its own, for the same reason
docker run -d --name dadstats-fresh2 -p 3252:3211 -v dadstats-fresh2-data:/app/data dadstats
APP_URL=http://localhost:3252 node test/empty-state-check.js
```

```bash
# static — no container, no browser, run in a second
node test/markup-check.js
node test/ical-guard-check.js
node test/merge-growth-check.js

# image + runtime invariants (manages its own containers, needs no browser)
IMAGE=dadstats ./test/image-check.sh

# security regressions — run LAST, see below
APP_URL=http://localhost:3208 ADMIN_PASSWORD=test-admin-pw node test/security-check.js
```

All of them exit non-zero on failure; the browser ones drop screenshots in `test/screenshots/`.

**Order matters for one of them.** `security-check.js` deliberately trips the login rate limiter,
which then blocks family logins from that IP for 15 minutes — so run it last, or the other suites
fail for reasons that have nothing to do with them.

## What each one covers

**`sync-check.js` — the one that matters.** Opens two independent browser contexts (separate
cookie jars and separate localStorage: two phones), signs both into the same family, has both
land on the same live game, then taps *different* stats on each and asserts **both devices end
up with the union of all taps**. This is the contract described in README § "Sync (the hard
part)" — derived counters plus tombstoned deletes are what make concurrent scoring merge
instead of clobber, and when that breaks it stays invisible until two people are scoring a real
game from the stands.

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

**`sport-check.js`** — creates a soccer season alongside the default basketball one under the
same kid, scores a soccer game, and asserts the tracker buttons, the card's headline number and
the Season Averages columns all use soccer's schema while the basketball season still uses
basketball's. That combination is the multi-sport feature: the sport belongs to the season.

Run it after touching `SPORTS`, `freshSeason`, `sportOfSeason`, or anything that threads `sport`
through the tracker or averages.

**`measurement-check.js`** — swimming, track, golf and bowling: that the forgiving time parser
reads what people actually type, that a bad value is refused rather than stored as NaN, that a
personal best knows lower is better for a time but higher for a bowling score, and that deleting
a result tombstones it and the best recomputes.

Critically it also **reloads the page mid-test**. A measurement result carries a `value` on its
log entry, and `sanitize()` — which runs on every load and at the end of every merge — once
rebuilt log entries from a field whitelist that omitted it. Every result silently lost its number
with no error anywhere, and it only showed up when a background resync happened to land during a
session. The reload makes that path deterministic.

Run it after touching `withDefaults`, `sanitize`, `parseValue`, or `seasonBests`.

**`run-account-check.sh`** (drives `account-check.js`) — the one that came from a real report.
localStorage is keyed by origin, and an origin outlives the container behind it. Rebuild an
instance on the same host:port, or sign a different family in, and the browser still holds the
previous account's games; without a guard the merge adopts them and **uploads them into the new
account**. Someone set up a brand-new install and saw their kids' names, and the server really
had stored them.

It seeds one instance, destroys it container-and-volume, stands up a fresh one on the same port
with the same browser profile, and asserts the new instance's database never receives the old
data.

```bash
IMAGE=dadstats CPORT=3211 PORT=3280 ./test/run-account-check.sh
```

Run it after touching `apiGetState`, `mergeStates`, `discardCacheIfForeign`, or anything about
how the client decides its cache is still valid.

**`setup-check.js`** — on a virgin instance, asserts the setup form replaces the sign-in form,
rejects a too-short password, signs you straight into the app with no second login, and then
**closes permanently**: `setupNeeded` goes false and a second POST to `/api/setup` gets a 409.
That last part is the security property — if setup ever stayed open it would be self-signup,
which is exactly what the admin model removed.

Run it after touching `server/admin.js` setup handlers, `boot()`, or the login/setup markup.

**`image-check.sh`** — properties of the image itself, which regress silently because no app
behaviour changes when they break: no build toolchain in the runtime image, OCI labels present,
the process actually runs unprivileged (checked on PID 1, since the entrypoint starts as root and
drops), the healthcheck reaches `healthy`, data survives a container **recreate** (not just a
restart — a restart would still pass if data lived in the container layer), and a bind mount to a
host path Docker had to create still starts. That last one was a real failure: Docker creates a
missing host path as root and the unprivileged app died with `SQLITE_CANTOPEN`.

Run it after touching the Dockerfile or `docker-entrypoint.sh`.

**`security-check.js`** — one case per security bug ever found here, plus the boundaries in
`SECURITY.md`: the session cookie's `Secure` flag tracks `SECURE_COOKIES` (it was once derived
from `NODE_ENV`, which silently broke login over plain HTTP), a wrong password is rejected, an
unknown password does not create an account, `/api/setup` stays closed once configured, a family
session can't reach the admin API, logout invalidates the session, and the rate limiter still
trips when `X-Forwarded-For` is rotated. Also that `/api/ical-proxy` requires a session and
refuses loopback, LAN, cloud-metadata and IPv6-loopback targets — using IP literals, which the
guard rejects on its own logic before any network call, so this exercises the real
route → middleware → handler → guard wiring without needing a reachable target.

Run it after touching anything in `server/auth.js`, `server/ratelimit.js`, `server/icalProxy.js`,
or the setup handlers.

**`tombstone-check.js`** — two browser contexts, and the one that proves deletes actually stick.
Profiles and seasons used to splice on delete, and `mergeStates` unions profile lists by name and
season lists by id — a union can't tell "never existed here" from "deleted here", so the other
device put the deleted kid straight back on the next resync. Covers profile delete, reusing a
deleted kid's name (a tombstone must not kill a *new* profile that merely shares a name), season
delete, and deleting every season down to an empty profile.

Run it after touching `deleteProfile`, `deleteSeason`, `addProfile` in `mergeStates`,
`activeProfiles` / `activeSeasons`, or the nav fallbacks in `sanitize()`.

**`empty-state-check.js`** — needs a **virgin** instance. A fresh account must open genuinely
empty rather than on a fabricated "Player 1" carrying a basketball season nobody chose, and adding
a kid must *ask* which sport rather than assuming. Also asserts the last profile can be deleted.

Run it after touching `defaultState`, `renderHome`, or the add-kid form.

**`ical-check.js`** — calendar feed import, driven through **request interception** rather than a
real feed server. It stubs `/api/ical-proxy` in the browser and answers with canned ics text, so it
tests the genuinely novel part — parsing and reconciliation — without touching the server's
network boundary. Covers: events becoming games, `STATUS:CANCELLED` being skipped, a re-sync
updating a rescheduled game instead of duplicating it, a scored game's players surviving a
metadata-only re-sync untouched, and a game you deleted **not** coming back on the next sync.

That last one is the subtle one: the season remembers every UID it has ever imported
(`icsSeenUids`), independently of whether a game for it still exists, and that memory is
*unioned* across devices in `mergeStates` rather than last-writer-wins — otherwise a device that
missed the import could resurrect a deleted game on its next sync.

Run it after touching `parseIcs`, `syncIcsFeed`, or the `icsSeenUids` union in `mergeStates`.

**`merge-growth-check.js`** — static, no container, no browser. Lifts the real `mergeStates` out
of `index.html` and merges a state against itself repeatedly, asserting **the profile list does
not grow**. This is a regression test for a bug that reached production: a tombstone sharing a
name with a live profile could never claim the name key, so it failed to match itself and was
appended on every merge — doubling each sync until one account held 13,440 copies of a single
deleted kid and 2.5MB of state.

The symptom was not duplicates. The UI filters tombstones, so the list looked perfectly normal;
it was a phone that had become too slow to respond to a tap, because every save serialised and
uploaded megabytes. Nothing that asserted on *what the screen shows* could have caught it, which
is exactly why this one asserts on the state itself.

Also covers: the tombstone stays dead, a re-created profile with a reused name isn't killed by
the old tombstone, two devices adding the same kid still converge to one, and an already-bloated
state collapses on load.

Run it after touching `mergeStates`, `addProfile`, or `sanitize`.

**`ical-guard-check.js`** — static, no container, no network: the SSRF guard's address ranges
(`isPrivateAddress`). This is the only pure-unit test in the suite, and deliberately so. The guard
rejects every private address — which is exactly where a fixture server would have to live for a
CI container to reach it, so testing it against a live feed server would mean weakening the very
protection under test. Range coverage lives here; that the guard is actually *wired into* the real
route is asserted live in `security-check.js` using IP literals, which reject before any network
call happens.

Run it after touching `server/icalProxy.js`.

**`markup-check.js`** — static, instant, no container. Asserts every element id the client
reaches for actually exists in the markup. The client builds HTML from strings, so a renamed or
typo'd id fails silently: `getElementById` returns null, the listener never attaches, and the
button simply does nothing — no error, no failed request, nothing a server-side test can see.

Run it after touching any markup or handler wiring. It's the cheapest check here.
