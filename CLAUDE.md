# CLAUDE.md — dadstats

## What this is
A self-hosted stat tracker distributed as a single Docker image. Seven team sports, all driven
by one `SPORTS` config object in `public/index.html` — nothing outside it hardcodes a stat name,
so adding a sport is adding an entry.

**Sport lives on the season, not the profile**, so a kid can play two sports under one name. It's
fixed at creation: changing it would strand every existing card's counters outside the new
schema. Measurement sports (swimming, track, golf, bowling) do NOT fit this model — they need a
results mode, not another SPORTS entry. See README § Sports.

**`README.md` is the real documentation** — architecture, the sync design, the data model, and
the rules that keep merges non-destructive. Read it before changing anything in
`public/index.html`, which is the entire client in one file.

## Stack
Single container: Express + `better-sqlite3` (no separate DB service), built and run with plain
`docker build` / `docker run`. See `.env.example` for config; `SQLITE_PATH` points at the data
file, which should live on a mounted volume.

## Auth shape
Admin (`/admin`, `ADMIN_PASSWORD`) creates families and sets their passwords. Families sign in
with that password — no usernames, and one password per family on purpose, so two parents can
both score the same game. An unrecognised password is **rejected**, never turned into a new
account. Don't reintroduce self-signup: duplicate passwords would merge two families into one
account, which is why `admin.js` checks for them at creation.

## Tests
`test/` drives a running instance and needs `APP_URL` + `ADMIN_PASSWORD` (see `test/README.md`).
`sync-check.js` proves the invariant below; `sport-check.js` proves two sports coexist under one
kid. Run both after touching the stat schema.

## The one thing to get right
Stat counters are **derived from the event log, never trusted as independent counters**, and
deletes are **tombstones, not splices**. Both exist so two phones scoring the same game merge to
the union of their taps instead of one clobbering the other. Any change that adds a counter which
isn't recomputed from `log[]`, or that splices an entry out of an array, breaks multi-device
scoring in a way that is invisible until a real game. See README.md § "Sync (the hard part)".

This applies to the `SPORTS` config too: a new sport's stats must still flow through
`recomputeFromLog`/tombstoned log entries, not a parallel counter.
