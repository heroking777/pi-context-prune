# Distribution and restore procedure

Operational procedure for getting this fork's bundle onto a machine and getting back to
the previously deployed bundle. Nothing here changes the **running** Pi process: the
extension is loaded at Pi startup, so a swap always requires a *new* Pi session.

Current values on the reference host (update them when they change):

| Item | Value |
|---|---|
| Production extension dir | `/home/deploy/.pi/agent/local-packages/pi-context-prune/` |
| Production bundle (measured T02f, 2026-10-19 05:15 JST) | `dist/index.js` — SHA-256 `1b1527c66b07b9b54646115a2db50273a810813b3739c01778df00d6b15988c8` (307,119 B, mode `0400`, owner `deploy:deploy`) |
| Verified T02f rollback copy | `dist/index.js.rollback-t02f-20261018T201505Z` — SHA-256 `1b1527c66b07b9b54646115a2db50273a810813b3739c01778df00d6b15988c8` (307,119 B; `cmp`-verified against production; mode/owner preserved) |
| Historical production value (superseded; retained for audit) | SHA-256 `58810bf8a135ba6a8975e6848940c5982872b0a63c7910d2a3481fb9b90ad45c` (218,660 B; introduced in source commit `2694206477ed1e0dc00a1487dee1b378a996da2c`; not a verified rollback artifact) |
| T02c candidate build (not deployed) | SHA-256 `db646f491127000262a44285fa0fc1041a11c90093a0eeac405d6a48a2d753e0` (307,933 B) |
| Upstream v1.4.0 baseline bundle | SHA-256 `5ee648f6c314ff317e2800230cf4044fe4be1f82651191a57226f76f11fc9b1b` (202,756 B; lacks OPT-001/025; not an equivalent automatic fallback) |
| Staging extension dir | `/home/deploy/.pi-work/pruner-phase7/staging/ext/pi-context-prune/` |
| Clean-clone staging bundle | `022bf10438ea2d47058cd6d47f8d8a9b96faf42e6eb815348736d4f426c2ddcb` (223,666 B; recorded lockfile/build environment) |
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

npm ci                                 # exact dev deps pinned by package-lock.json
npx tsc --noEmit -p tsconfig.json      # strict type check -> must print nothing
npm run build                          # -> dist/index.js + dist/index.js.map
npm run check                          # build + package check
npm test                               # 177 regression + 30 portable staging checks
sha256sum dist/index.js                # record the SHA you are about to deploy
```

A clean rebuild is expected to be **byte-reproducible** on the same machine, esbuild
version and Node version (esbuild output is deterministic). Byte-equality across different
build environments is *not* expected — verify semantics instead (§3).

## 2. Stage on the target host (never overwrite the running copy)

```bash
STAGE=/path/to/isolated/staging/pi-context-prune
mkdir -p "$STAGE/dist"
cp -a dist/index.js "$STAGE/dist/index.js"
cp -a dist/index.js.map "$STAGE/dist/index.js.map"
cp -a package.json README.md FORK_NOTES.md "$STAGE/"
sha256sum "$STAGE/dist/index.js"       # must equal the SHA recorded in step 1
```

Rules:

* The staging directory must be **outside** the production extension directory.
* The extension directory must **not** contain `node_modules` — `@earendil-works/*` is
  resolved from the Pi process itself. For a standalone harness, symlink the packaged
  runtime instead (see §3).
* The production directory had no `dist/index.js.map` during T02f. If a later candidate adds
  a map, record its prior absence and candidate hash; rollback must account for that file too.
* Do **not** modify `settings.json` at this point: every option added by this fork defaults
  to the previous behaviour, so no migration is needed.
* Do **not** restart or stop the running Pi process. Staging is inert until a new Pi
  process loads it.

## 3. Verify before promoting

Offline verification (no network, **no real LLM call**):

```bash
# 3a. Load + registration + lifecycle hooks against the packaged Pi runtime
node tests/staging.mjs

# 3b. Regression + staging suite (builds baseline from the v1.4.0 Git commit)
npm test

# Optional 41-case differential requires an external Phase5 test bundle; no bundle is committed.
PRUNER_PHASE5_BUNDLE=/path/to/phase5-reference.mjs npm test
```

Real-runtime load check in a **fully isolated** Pi instance — no prompt, so no model call:

```bash
S=/path/to/staging
timeout 25 env HOME=$S/home \
  PI_CODING_AGENT_DIR=$S/home/.pi/agent \
  PI_CODING_AGENT_SESSION_DIR=$S/home/.pi/agent/sessions \
  PI_OFFLINE=1 \
  node /home/deploy/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js \
  -e "$S/ext/pi-context-prune/dist/index.js" --no-session --no-tools --mode rpc \
  < /dev/null
```

Expected on stdout: a `setStatus` request with `statusKey":"context-prune"` and
`prune: OFF …`, plus `"pruner loaded — pruning OFF | model: default"`. Exit code `0`,
empty stderr. A deliberately broken extension must make the same command exit `1` with
`Failed to load extension …` — use that as the negative control whenever you change this
procedure. Confirm afterwards that the production settings file's mtime and session
directory contents are unchanged. Do **not** use `/home/deploy/bin/pi` for this isolated
read-only check: that wrapper runs `apply_pi_runtime_patch.mjs --ensure-applied` (which
rewrites the global runtime-generation marker) and can source configured auth files. Use
the direct CLI path above with the isolated `HOME` and `PI_CODING_AGENT_DIR`.

## 4. Promote (separate, explicit step)

Promotion is a **new Pi session** action, not something to do in a running one:

1. Keep the verified T02f rollback copy (`dist/index.js.rollback-t02f-20261018T201505Z`, SHA `1b1527c66b07b9b54646115a2db50273a810813b3739c01778df00d6b15988c8`) unchanged. Before any later promotion, create another unique outgoing-bundle copy; never overwrite a recorded backup. Verify SHA, `cmp`, owner/mode, size, and same filesystem before promotion.
2. Confirm the live bundle still matches the approved predeployment SHA and the staged candidate matches its independently recorded SHA. Any mismatch stops promotion.
3. Stop the Pi session only under separate explicit authorization.
4. Replace the bundle only from the verified stage; use a same-filesystem temporary file and atomic rename. The current production had no source map; handle a candidate map only after recording its hash and prior state.
5. Verify the installed SHA/bytes and file metadata against the approved candidate.
6. Start a new Pi session only under separate explicit authorization and confirm the `setStatus`/`pruner loaded` output.
7. Leave new options at defaults for the first session.

## 5. Restore / rollback (requires explicit authorization; not executed by T02f)

T02f verified this rollback copy against the current production bundle:
`dist/index.js.rollback-t02f-20261018T201505Z` (SHA-256
`1b1527c66b07b9b54646115a2db50273a810813b3739c01778df00d6b15988c8`, 307,119 B,
mode `0400`, owner `deploy:deploy`). Before any restore, confirm the approved current
candidate hash, stop the Pi session only under separate authorization, and run the following
only after checking every precondition:

```bash
set -euo pipefail
D=/home/deploy/.pi/agent/local-packages/pi-context-prune/dist
BACKUP="$D/index.js.rollback-t02f-20261018T201505Z"
EXPECTED_BACKUP_SHA=1b1527c66b07b9b54646115a2db50273a810813b3739c01778df00d6b15988c8
EXPECTED_CURRENT_SHA='<fill with the explicitly approved live candidate SHA>'

# Hard preconditions: no symlinks; exact backup and explicitly approved live bundle.
test -f "$BACKUP" && test ! -L "$BACKUP"
test "$(sha256sum "$BACKUP" | awk '{print $1}')" = "$EXPECTED_BACKUP_SHA"
test "$(stat -c '%s|%a|%U:%G' "$BACKUP")" = '307119|400|deploy:deploy'
test -f "$D/index.js" && test ! -L "$D/index.js"
test "$(sha256sum "$D/index.js" | awk '{print $1}')" = "$EXPECTED_CURRENT_SHA"

# Preserve the outgoing live bundle as another unique copy before restoring.
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$D/index.js.rollback-outgoing-$STAMP"
test ! -e "$OUT"
OUT_TMP=$(mktemp "$D/.index.js.outgoing.XXXXXX")
cp --archive --reflink=never -- "$D/index.js" "$OUT_TMP"
test "$(sha256sum "$OUT_TMP" | awk '{print $1}')" = "$EXPECTED_CURRENT_SHA"
cmp -s "$D/index.js" "$OUT_TMP"
mv -nT -- "$OUT_TMP" "$OUT"
test ! -e "$OUT_TMP"
test "$(sha256sum "$OUT" | awk '{print $1}')" = "$EXPECTED_CURRENT_SHA"
cmp -s "$D/index.js" "$OUT"

# Restore through a same-filesystem temporary file, verify, then atomic rename.
RESTORE_TMP=$(mktemp "$D/.index.js.restore.XXXXXX")
cp --archive --reflink=never -- "$BACKUP" "$RESTORE_TMP"
test "$(sha256sum "$RESTORE_TMP" | awk '{print $1}')" = "$EXPECTED_BACKUP_SHA"
test "$(stat -c '%s|%a|%U:%G' "$RESTORE_TMP")" = '307119|400|deploy:deploy'
cmp -s "$BACKUP" "$RESTORE_TMP"
mv -fT -- "$RESTORE_TMP" "$D/index.js"
test "$(sha256sum "$D/index.js" | awk '{print $1}')" = "$EXPECTED_BACKUP_SHA"
test "$(stat -c '%s|%a|%U:%G' "$D/index.js")" = '307119|400|deploy:deploy'
cmp -s "$BACKUP" "$D/index.js"
```

**Stop without changing or restarting anything** if the live hash differs from the explicitly
approved expected value; the backup is missing, a symlink, has wrong SHA/bytes/metadata; a
path/device/owner/mode/permission check fails; an outgoing-copy destination already exists;
or any command errors. Do not use historical SHA `58810bf8…` or pristine upstream SHA
`5ee648f6…` as automatic fallbacks: neither is the verified T02f backup, and the pristine
bundle lacks OPT-001/025. Any source-map state change requires its own verified rollback
plan. After file verification, a new Pi session/restart remains a separate authorized step.
