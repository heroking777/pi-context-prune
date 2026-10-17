# Distribution and restore procedure

Operational procedure for getting this fork's bundle onto a machine and getting back to
the previously deployed bundle. Nothing here changes the **running** Pi process: the
extension is loaded at Pi startup, so a swap always requires a *new* Pi session.

Current values on the reference host (update them when they change):

| Item | Value |
|---|---|
| Production extension dir | `/home/deploy/.pi/agent/local-packages/pi-context-prune/` |
| Production bundle | `dist/index.js` — SHA-256 `58810bf8a135ba6a8975e6848940c5982872b0a63c7910d2a3481fb9b90ad45c` (218,660 B, upstream v1.4.0 + OPT-001/025) |
| Upstream v1.4.0 baseline bundle | SHA-256 `5ee648f6c314ff317e2800230cf4044fe4be1f82651191a57226f76f11fc9b1b` (202,756 B) |
| Staging extension dir | `/home/deploy/.pi-work/pruner-phase7/staging/ext/pi-context-prune/` |
| Staging bundle | `c8629f0f9bbe2d583662ff0459e73f27e991464db2f6b3e24035dacaf2a8d467` (225,700 B) |
| Settings | `/home/deploy/.pi/agent/context-prune/settings.json` |

> **Never edit `dist/index.js` by hand and never swap it under a running Pi.** `dist/` is
> generated (gitignored) and only exists after `npm run build`.

## 0. Prerequisites

* Node.js 22 (`node -v`), npm, `git`.
* Provider credentials are **not** required to build, type-check or run the offline
  verification suites. They are only needed for a real summarizer run.

## 1. Build from a clean checkout

```bash
git clone git@github.com:heroking777/pi-context-prune.git
cd pi-context-prune
git checkout pruner-phase6-source-v1.4.0

npm install                            # dev deps only (esbuild, typescript, @types/node)
npx tsc --noEmit -p tsconfig.json      # strict type check -> must print nothing
npm run build                          # -> dist/index.js + dist/index.js.map
npm run check                          # build + package check
sha256sum dist/index.js                # record the SHA you are about to deploy
```

A clean rebuild is expected to be **byte-reproducible** on the same machine, esbuild
version and Node version (esbuild output is deterministic). Byte-equality across different
build environments is *not* expected — verify semantics instead (§3).

## 2. Stage on the target host (never overwrite the running copy)

```bash
STAGE=/path/to/isolated/staging/pi-context-prune
mkdir -p "$STAGE/dist"
cp -r dist/index.js dist/index.js.map package.json README.md FORK_NOTES.md "$STAGE/"
sha256sum "$STAGE/dist/index.js"       # must equal the SHA recorded in step 1
```

Rules:

* The staging directory must be **outside** the production extension directory.
* The extension directory must **not** contain `node_modules` — `@earendil-works/*` is
  resolved from the Pi process itself. For a standalone harness, symlink the packaged
  runtime instead (see §3).
* Do **not** modify `settings.json` at this point: every option added by this fork defaults
  to the previous behaviour, so no migration is needed.
* Do **not** restart or stop the running Pi process. Staging is inert until a new Pi
  process loads it.

## 3. Verify before promoting

Offline verification (no network, **no real LLM call**):

```bash
# 3a. Load + registration + lifecycle hooks against the packaged Pi runtime
node staging/load.mjs

# 3b. Regression suite + differential harness against the freshly built bundle
cd <verification-workspace>            # holds run.mjs / diff6.mjs
node run.mjs && node diff6.mjs
```

Real-runtime load check in a **fully isolated** Pi instance — no prompt, so no model call:

```bash
S=/path/to/staging
timeout 25 env HOME=$S/home \
  PI_CODING_AGENT_DIR=$S/home/.pi/agent \
  PI_CODING_AGENT_SESSION_DIR=$S/home/.pi/agent/sessions \
  PI_OFFLINE=1 \
  pi -e "$S/ext/pi-context-prune/dist/index.js" --no-session --no-tools --mode rpc \
  < /dev/null
```

Expected on stdout: a `setStatus` request with `statusKey":"context-prune"` and
`prune: OFF …`, plus `"pruner loaded — pruning OFF | model: default"`. Exit code `0`,
empty stderr. A deliberately broken extension must make the same command exit `1` with
`Failed to load extension …` — use that as the negative control whenever you change this
procedure. Confirm afterwards that the production settings file's mtime and session
directory contents are unchanged.

## 4. Promote (separate, explicit step)

Promotion is a **new Pi session** action, not something to do in a running one:

1. Keep a copy of the outgoing bundle next to the new one (`dist/index.js.prev`) **and its
   recorded SHA**.
2. Stop the Pi session that uses the extension.
3. Replace `dist/index.js` (and `dist/index.js.map`) with the verified staging copy.
4. Verify `sha256sum dist/index.js` equals the SHA recorded in step 1.
5. Start a new Pi session and confirm the `setStatus`/`pruner loaded` output.
6. Leave the new options at their defaults for the first session.

## 5. Restore / rollback

Nothing in this fork changed a default, the settings file, or the session entry format, so
rollback is a pure file swap:

```bash
cd /home/deploy/.pi/agent/local-packages/pi-context-prune
sha256sum dist/index.js                     # record what you are removing
cp dist/index.js dist/index.js.rollback-$(date +%F)
cp dist/index.js.prev dist/index.js         # previous bundle, saved in step 4.1
sha256sum dist/index.js                     # must equal the SHA saved in step 4.1
```

If no saved copy exists, restore the known-good deployed bundle instead:

```bash
# upstream v1.4.0 + OPT-001/025, as deployed
sha256sum dist/index.js   # expect 58810bf8a135ba6a8975e6848940c5982872b0a63c7910d2a3481fb9b90ad45c
```

If that file is unavailable, rebuild the pristine upstream v1.4.0 bundle from the fork
(which contains the v1.4.0 tag) and re-apply nothing — but note that the pristine build
(`5ee648f6c314ff317e2800230cf4044fe4be1f82651191a57226f76f11fc9b1b`) does **not** contain
OPT-001/025, so the in-house behaviour would be lost:

```bash
git clone git@github.com:heroking777/pi-context-prune.git /tmp/prune-v140
cd /tmp/prune-v140 && git checkout v1.4.0 && npm install && npm run build
sha256sum dist/index.js   # expect 5ee648f6c314ff317e2800230cf4044fe4be1f82651191a57226f76f11fc9b1b
```

Rollback requires a Pi restart to take effect (the extension is loaded at startup).
Sessions written while the new bundle was active remain readable by the restored bundle:
the entry types, refs footer and restore path are unchanged.
