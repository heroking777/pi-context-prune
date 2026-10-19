#!/usr/bin/env bash
set -euo pipefail
umask 077
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
: "${PI_AI_PROVIDER_MODULE:?Set to the pi-ai openai-codex-responses module path or file URL}"
: "${PI_AI_OAUTH_MODULE:?Set to the pi-ai openai-codex OAuth module path or file URL}"

module_url() {
  case "$1" in
    file:*) printf '%s\n' "$1" ;;
    *) node -e 'process.stdout.write(require("node:url").pathToFileURL(require("node:path").resolve(process.argv[1])).href)' "$1" ;;
  esac
}
export PI_AI_PROVIDER_MODULE=$(module_url "$PI_AI_PROVIDER_MODULE")
export PI_AI_OAUTH_MODULE=$(module_url "$PI_AI_OAUTH_MODULE")
node --input-type=module - "$PI_AI_PROVIDER_MODULE" "$PI_AI_OAUTH_MODULE" <<'JS'
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
for (const url of process.argv.slice(2)) {
  if (!existsSync(fileURLToPath(url))) throw new Error(`Pi AI module is missing: ${url}`);
}
JS

run_dir=$(mktemp -d "${TMPDIR:-/tmp}/t02j-offline-suite.XXXXXX")
export PI_API_SEND_CAP_TEST_DIR="$run_dir/cap-tests"
mkdir -m 700 -p "$PI_API_SEND_CAP_TEST_DIR"
for file in "$script_dir"/*.mjs; do node --check "$file"; done
node "$script_dir/test-api-send-cap.mjs"
node "$script_dir/test-transport-diagnostics.mjs"
node "$script_dir/test-provider-fallback-correlation.mjs"
node "$script_dir/test-provider-source-patch.mjs"
node "$script_dir/test-pi-cli-bundle-provider.mjs"
node "$script_dir/test-oauth-refresh-flow.mjs"
node "$script_dir/test-oauth-refresh-guard.mjs"
node "$script_dir/test-stop-guards.mjs"
node "$script_dir/test-provider-boundaries.mjs" "$run_dir/provider-boundaries"
wrapper_state="$run_dir/wrapper-live-auth"
set +e
env -u NODE_OPTIONS PI_BIN=/usr/bin/true PI_API_SEND_CAP_DIR="$wrapper_state" PI_API_SEND_CAP_DRY_RUN=0 \
  "$script_dir/run-pi-with-cap.sh" --provider openai-codex >/dev/null 2>&1
wrapper_status=$?
set -e
test "$wrapper_status" -eq 2
test ! -e "$wrapper_state/state.json"
printf 'LIVE_MODE_WITHOUT_AUTHORIZATION=BLOCKED\nOFFLINE_SUITE=PASS\nEVIDENCE_DIR=%s\n' "$run_dir"
