# Morning list — dadstats

Ordered. Items 1–3 are the release; 4–5 are what makes it findable.

---

## 1. Check CI is green  ← do this first, everything else depends on it

<https://github.com/raymondoooo/dadstats/actions>

Two pushes last night added things that have **never run on GitHub's runners**: a markup check, an
image-invariants script that starts and stops its own containers, a security suite, and a
virgin-instance step. All pass locally, but this box isn't `ubuntu-latest`.

If it's red, paste me the failing step. Most likely candidate is `image-check.sh` doing
docker-in-docker on a runner.

**Do not tag until this is green** — a tag triggers the publish job, and a broken build would
push a broken image to two registries under your name.

## 2. Make the repo public

Settings → General → Danger Zone → Change visibility.

AGPL and a donation link accomplish nothing while nobody can read the source. Also worth a
glance at the rendered README first — that's the shop window.

## 3. Tag the release

```bash
git -C /stacks/products/dadstats tag v0.1.0
git -C /stacks/products/dadstats push --tags
```

Publishes to Docker Hub **and** GHCR, `linux/amd64` + `linux/arm64`, with the full tag ladder
(`0.1.0`, `0.1`, `0`, `latest`), provenance and SBOM.

**This is the irreversible one.** Once it lands, strangers have pulled images and hold volumes,
and every later change has to preserve their upgrade path.

Expect it to be slow. arm64 builds under QEMU emulation and `better-sqlite3` compiles from source
there — this is the first time that has ever been attempted, so it's also the most likely place
to fail.

## 4. Docker Hub description

The page is blank until you paste one; Docker Hub does not pull the GitHub README.

Ready to paste: **`docs/dockerhub-description.md`** in the repo.

Also set the short description on the repo settings page:
> Self-hosted stat tracker for kids' sports — score from the stands, two phones at once.

## 5. Ko-fi page

Confirm the page reads as a **portfolio**, not as DadStats specifically — every container you
publish will point at the same link. Draft blurb is in the CONTAINER-PUBLISHING notes; the key
line is asking people to mention which project brought them, since Ko-fi won't tell you.

---

## Not blocking, but decide sometime

- **The icon is a basketball** while the app now does seven sports. Fine as a deliberate choice,
  odd as a leftover.
- **`main` is now protected by convention only.** From `v0.1.0`, standards §5 says feature
  branches and PRs — `main` is what strangers clone and what `:latest` builds from.
- **The upgrade path is untestable until something is published.** After `v0.1.0` exists, testing
  `v0.1.0 → v0.2.0` against a real volume becomes mandatory before any further tag (standards §7).
  That's the path every existing user takes and the one CI never exercises.

## What I did overnight

**Screenshots** — the biggest thing the README was missing. Four phone-sized shots (live tracker
with the on-court state and bench strips, season averages, one kid with two sports, soccer's
different averages columns) plus the admin panel, in `docs/screenshots/`, laid out as a
two-column table near the top of the README where they do the most work. Seeded from an invented
demo account; no real names anywhere.

**`docs/dockerhub-description.md`** — ready to paste for morning item 4. Quick start, a compose
snippet, the sports list, the full env var table, and the data/backup story.

**README polish** — the stale "Pre-release" banner, the basketball-first framing in the intro,
and a data/backup section documenting the single-folder layout and the upgrade guard.

Nothing published, nothing tagged, repo still private — all four of those are yours.
