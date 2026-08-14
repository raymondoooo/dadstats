# DadStats

Self-hosted stat tracker for kids' sports. Built for standing at a gym or a touchline with a
phone, logging what happens within a couple of seconds of it happening — then reviewing it later
as a season.

**Two parents can score the same game from two phones and both sets of taps survive.** That's the
hard part, and it's what this is actually for.

**Source:** <https://github.com/raymondoooo/dadstats> · AGPL-3.0 · free forever, and if it saved
you some effort you can [buy me a coffee](https://ko-fi.com/raymondoooo).

<img src="https://raw.githubusercontent.com/raymondoooo/dadstats/main/docs/screenshots/tracker.png" width="270"> <img src="https://raw.githubusercontent.com/raymondoooo/dadstats/main/docs/screenshots/season.png" width="270"> <img src="https://raw.githubusercontent.com/raymondoooo/dadstats/main/docs/screenshots/schedule-import.png" width="270">

## Quick start

```bash
docker run -d --name dadstats -p 3211:3211 -v dadstats-data:/app/data raymondoooo/dadstats
```

Open `http://localhost:3211`, pick a family name and password, and you're in. No config files, no
setup wizard to read the logs for, no external database.

### docker-compose

```yaml
services:
  dadstats:
    image: raymondoooo/dadstats
    container_name: dadstats
    restart: unless-stopped
    ports:
      - "3211:3211"
    volumes:
      - dadstats-data:/app/data

volumes:
  dadstats-data:
```

## Sports

**Tap-to-count:** Basketball · Soccer · Hockey · Field Hockey · Lacrosse · Volleyball ·
Baseball/Softball

**Typed results, with personal bests:** Swimming · Track & Field · Golf · Bowling

The sport is set per **season**, so one kid can swim in the summer and play basketball in the
winter under the same name and the same record. Each season tracks its own stats and shows its own
table — soccer gets goals and shot%, basketball gets PPG and FG%, swimming gets personal bests per
event.

## Importing a schedule

Paste a TeamSnap (or any league) `.ics` URL on a season and each event becomes a game, with its
name and date filled in. Re-syncing updates a rescheduled game rather than duplicating it, never
touches a game you've already scored, and won't resurrect one you deleted.

## Versions

| Tag | What it is |
|---|---|
| `latest` | Newest stable. Fine for most people. |
| `0.7`, `0` | Newest stable within that minor / major. Pin here for updates without surprises. |
| `0.7.2` | Exactly that build, forever. |
| `beta` | Newest prerelease. Opt-in only — never served to `latest` or any stable pin. |

**Use a separate volume for a beta.** Upgrades migrate the database and are one-way: an older
image refuses to start against a newer schema rather than risk corrupting it.

**Upgrading from `0.3.x` or earlier?** The port inside the container changed from 3108 to 3211 in
`0.4.0`, so host and container sides match. Either update your mapping to `-p 3211:3211` or pin
the old port back with `-e PORT=3108`.

## Configuration

Everything is optional; the command above works as-is.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3211` | Port the app listens on, inside the container |
| `SQLITE_PATH` | `/app/data/dadstats.db` | Database file — keep it on your volume |
| `ADMIN_PASSWORD` | generated | Gate for `/admin`, where you add more families. Printed to the logs on first run |
| `JWT_SECRET` | generated | Session signing key, persisted to the volume |
| `SECURE_COOKIES` | off | Set `1` **only if browsers reach the app over HTTPS**. Turning it on for an `http://` install locks you out of login with no error |
| `TRUST_PROXY` | off | Set `1` behind a reverse proxy, so login rate limiting sees real client IPs |
| `TZ` | container default | Timezone for server-side timestamps |

## Your data

Everything lives under the single directory you mounted at `/app/data` — the database, the
generated secrets, and automatic pre-upgrade backups. **Back up that folder and you've backed up
everything.**

Upgrades snapshot the database into `data/backups/` before touching the schema. An older image
will refuse to start against a newer database rather than corrupt it.

If you ever want to wipe an instance and start over, **stop the container first** and remove the
dotfiles too (`rm -rf /app/data/* /app/data/.[!.]*`, or just delete the volume). Deleting files
under a running instance doesn't reclaim them — SQLite keeps the open handle and carries on
serving data you thought was gone.

## Notes

- Runs as an unprivileged user; the entrypoint fixes volume ownership, so bind mounts work with
  no preparation
- `linux/amd64` and `linux/arm64` — it runs on a Raspberry Pi
- Also on GHCR: `ghcr.io/raymondoooo/dadstats`
- Install it to a phone's home screen and it behaves like a native app
- No accounts, no telemetry, no cloud service behind it. It's a container and a file.
