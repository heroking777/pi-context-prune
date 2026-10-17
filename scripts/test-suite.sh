#!/usr/bin/env bash
# Portable, offline verification. Exit 2 means the optional Phase5 reference
# comparison was unavailable; regression and staging tests still ran.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
TMP="$ROOT/tests/.test-work"
rm -rf "$TMP"
mkdir -p "$TMP/backup" "$TMP/work" "$TMP/baseline"

BASE_COMMIT="a5fe6973a264dc37031ba02f1a3feb85b82709ab"
git cat-file -e "$BASE_COMMIT^{commit}"
git archive "$BASE_COMMIT" | tar -x -C "$TMP/baseline"
ln -s "$ROOT/node_modules" "$TMP/baseline/node_modules"
(cd "$TMP/baseline" && npm run build)
cp "$TMP/baseline/dist/index.js" "$TMP/backup/index.js.orig"
cp "$ROOT/dist/index.js" "$TMP/work/index.js"

"$ROOT/node_modules/.bin/esbuild" "$ROOT/test-entry.ts" --bundle --platform=node --target=node20 --format=esm \
  --outfile="$TMP/testable.mjs" --external:@earendil-works/pi-ai \
  --external:@earendil-works/pi-coding-agent --external:@earendil-works/pi-tui
"$ROOT/node_modules/.bin/esbuild" "$ROOT/test-entry.ts" --bundle --platform=node --target=node20 --format=esm \
  --outfile="$TMP/test-entry.mjs" --external:@earendil-works/pi-ai \
  --external:@earendil-works/pi-coding-agent --external:@earendil-works/pi-tui

printf '\n=== REQUIRED REGRESSION TESTS ===\n'
node tests/run.mjs
printf '\n=== REQUIRED ISOLATED STAGING TESTS ===\n'
node tests/staging.mjs
printf '\n=== REQUIRED OBSERVABILITY WIRING TESTS ===\n'
node tests/observability-wiring.mjs
printf '\n=== OPTIONAL PHASE5 DIFFERENTIAL ===\n'
set +e
node tests/diff6.mjs
DIFF_RC=$?
set -e
if [[ "$DIFF_RC" -eq 2 ]]; then
  echo "DIFFERENTIAL_STATUS=SKIP (provide PRUNER_PHASE5_BUNDLE to run comparison)"
  echo "OVERALL_STATUS=INCOMPLETE"
  exit 2
elif [[ "$DIFF_RC" -ne 0 ]]; then
  echo "DIFFERENTIAL_STATUS=FAIL"
  exit "$DIFF_RC"
fi
echo "DIFFERENTIAL_STATUS=PASS"
echo "OVERALL_STATUS=PASS"
