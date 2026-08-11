# Tests

Five browser checks plus two non-browser suites. They drive a **running instance** over HTTP — there is no unit
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
node test/sport-check.js
```

`setup-check.js` is the exception: first-run setup only exists on an instance with **no families
at all**, so it needs its own untouched container.

```bash
docker run -d --name dadstats-fresh -p 3209:3108 -v dadstats-fresh-data:/app/data dadstats
APP_URL=http://localhost:3209 node test/setup-check.js

# to run it again, throw the volume away — it only works once per instance
docker rm -f dadstats-fresh && docker volume rm dadstats-fresh-data
```

```bash
# static — no container, no browser, runs in a second
node test/markup-check.js

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
trips when `X-Forwarded-For` is rotated.

Run it after touching anything in `server/auth.js`, `server/ratelimit.js`, or the setup handlers.

**`markup-check.js`** — static, instant, no container. Asserts every element id the client
reaches for actually exists in the markup. The client builds HTML from strings, so a renamed or
typo'd id fails silently: `getElementById` returns null, the listener never attaches, and the
button simply does nothing — no error, no failed request, nothing a server-side test can see.

Run it after touching any markup or handler wiring. It's the cheapest check here.
