# DadStats

Self-hosted stat tracker for kids' sports. Built for standing at a gym or a touchline with a
phone, logging what happens within a couple of seconds of it happening — then reviewing it later
as a season.

**Two parents can score the same game from two phones and both sets of taps survive.** That's the
hard part, and it's what this is actually for.

**Source:** <https://github.com/raymondoooo/dadstats> · AGPL-3.0 · free forever, and if it saved
you some effort you can [buy me a coffee](https://ko-fi.com/raymondoooo).

## Quick start

```bash
docker run -d --name dadstats -p 3108:3108 -v dadstats-data:/app/data raymondoooo/dadstats
```

Open `http://localhost:3108`, pick a family name and password, and you're in. No config files, no
setup wizard to read the logs for, no external database.

### docker-compose

```yaml
services:
  dadstats:
    image: raymondoooo/dadstats
    container_name: dadstats
    restart: unless-stopped
    ports:
      - "3108:3108"
    volumes:
      - dadstats-data:/app/data

volumes:
  dadstats-data:
```

## Sports

Basketball · Soccer · Hockey · Field Hockey · Lacrosse · Volleyball · Baseball/Softball

The sport is set per **season**, so one kid can play basketball in the winter and soccer in the
spring under the same name and the same win–loss record. Each season tracks its own stats and
shows its own averages — soccer gets goals and shot%, basketball gets PPG and FG%.

## Configuration

Everything is optional; the command above works as-is.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3108` | Port inside the container |
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
will refuse to start against a newer database rather than risk corrupting it.

## Notes

- Runs as an unprivileged user; the entrypoint fixes volume ownership, so bind mounts work with
  no preparation
- `linux/amd64` and `linux/arm64` — it runs on a Raspberry Pi
- Also on GHCR: `ghcr.io/raymondoooo/dadstats`
- Install it to a phone's home screen and it behaves like a native app
- No accounts, no telemetry, no cloud service behind it. It's a container and a file.
