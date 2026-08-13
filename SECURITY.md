# Security

## Reporting a vulnerability

Please report privately via [GitHub's private vulnerability
reporting](https://github.com/raymondoooo/dadstats/security/advisories/new) rather than opening a
public issue.

This is a personal project maintained in spare time. I'll acknowledge as quickly as I can, but
there's no SLA behind that.

## Supported versions

The latest released version only. There are no backported fixes — if you're on an older tag,
upgrading is the fix.

## The trust model

Knowing what this app *doesn't* try to protect against is as useful as knowing what it does. The
following are deliberate design decisions, not oversights, and reporting them won't be treated as
vulnerabilities.

**A family's password is the whole credential.** There are no usernames and no per-person
accounts. Anyone holding a family's password has full access to that family's kids, seasons and
games. That's the point: two parents scoring the same game from two phones both sign in with the
same password. Treat it like a shared door key.

**Families are created by the instance admin.** There is no self-signup. A password matching no
family is rejected rather than creating an account. The one exception is first-run setup, which
creates the first family without authentication and closes permanently once any family exists.

**The admin can delete any family's data, but cannot read it.** Game state is opaque to the admin
surface — it's stored as a single JSON blob the server never parses. Deleting a family destroys
its games; nothing in the admin UI displays them.

**Anyone who can reach the instance can attempt logins.** Failed attempts are rate limited to 10
per IP per 15 minutes on both the family and admin endpoints. Behind a reverse proxy you must set
`TRUST_PROXY=1` or every request appears to originate from the proxy and the limit becomes global
instead of per-client.

**Sessions are JWTs and are not revocable.** Changing a family's password stops *new* sign-ins
with the old one, but a device already signed in stays signed in until its 30-day token expires.
This is deliberate — you don't want a mid-season password change to log a parent out during a
game — but it means a password change is not a way to evict a device.

**Transport security is your responsibility.** The app speaks plain HTTP and expects to sit
behind a reverse proxy if it's exposed beyond a LAN. `SECURE_COOKIES` defaults to **off** because
turning it on without HTTPS silently breaks login; set it to `1` once TLS is in front.

**The data volume is unencrypted.** Anyone with filesystem access to it — or to a backup under
`data/backups/` — can read every family's data and the generated secrets in `.jwt_secret` and
`.admin_password`. Protect the volume the way you'd protect any database file.

**`/api/ical-proxy` fetches a URL an authenticated family member supplies.** That's the shape of
SSRF (CWE-918) if unguarded, so it resolves the target's hostname once, rejects private/loopback/
link-local addresses, and connects to that literal resolved address — closing the DNS-rebinding
gap where a second lookup could return something a first check never saw. Redirects are
re-validated the same way, one hop at a time. See `server/icalProxy.js` and the README's
"Importing a schedule" section.

## What I would consider a vulnerability

- Any path that reads or writes one family's data while authenticated as another
- Any way to reach `/api/admin/*` without the admin cookie
- Reopening self-signup: creating a family without admin auth on an already-configured instance
- Bypassing the login rate limiter (e.g. by forging headers)
- XSS, or injection into the SQLite queries
- A way to recover a password or session token from anything the app serves
- `/api/ical-proxy` reaching a private/loopback/link-local address, directly or via a redirect
