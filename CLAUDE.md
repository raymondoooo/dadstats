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

Before changing the Dockerfile, the schema, or CI: most of what looks like overkill in those
files is there because it broke somewhere, and the reason is in the comment next to it. The
entrypoint's runtime `chown`, the SIGTERM handler, the pre-migration backup and the downgrade
guard each exist because the absence of them was a real failure, not a hypothetical.

## Schema changes
`SCHEMA_VERSION` + `MIGRATIONS` in `server/db.js`. Bump the version, add the migration, keep it
additive and guarded (`PRAGMA table_info` before an ALTER) — it runs unattended against a
stranger's live database on every boot. On upgrade the DB is snapshotted to `data/backups/` with
a synchronous `VACUUM INTO` **before** migrating; an older binary meeting a newer database exits
non-zero rather than writing through a schema it can't read. Never drop/rename a column, change a
type, or add NOT NULL without a default.

## Auth shape
Admin (`/admin`, `ADMIN_PASSWORD`) creates families and sets their passwords. Families sign in
with that password — no usernames, and one password per family on purpose, so two parents can
both score the same game. An unrecognised password is **rejected**, never turned into a new
account. Don't reintroduce self-signup: duplicate passwords would merge two families into one
account, which is why `admin.js` checks for them at creation.

**First-run setup** (`/api/setup`) is the one exception, and it is load-bearing that it stays an
exception: it creates the first family without auth so a fresh install isn't a scavenger hunt
through `docker logs`. It is gated on the instance having **zero** families, re-checked
server-side on every call. If that gate ever weakens it becomes open self-signup. `setup-check.js`
asserts it closes.

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
