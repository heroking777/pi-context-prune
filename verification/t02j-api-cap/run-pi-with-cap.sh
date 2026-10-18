#!/usr/bin/env bash
set -euo pipefail
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)

: "${PI_BIN:?Set PI_BIN to the reviewed Pi CLI executable}"
: "${PI_API_SEND_CAP_DIR:?Set a persistent shared state directory; this wrapper never resets it}"
case "$PI_API_SEND_CAP_DIR" in /*) ;; *) echo "PI_API_SEND_CAP_DIR must be absolute" >&2; exit 2 ;; esac
mkdir -p -- "$PI_API_SEND_CAP_DIR"

export PI_API_SEND_CAP_DRY_RUN=${PI_API_SEND_CAP_DRY_RUN:-1}
case "$PI_API_SEND_CAP_DRY_RUN" in 0|1) ;; *) echo "PI_API_SEND_CAP_DRY_RUN must be 0 or 1" >&2; exit 2 ;; esac
if [[ "$PI_API_SEND_CAP_DRY_RUN" == 0 && ${PI_API_SEND_CAP_LIVE_AUTHORIZED:-} != YES ]]; then
  echo "live mode requires separate authorization and PI_API_SEND_CAP_LIVE_AUTHORIZED=YES" >&2
  exit 2
fi
fake_ws=${PI_API_SEND_CAP_FAKE_WEBSOCKET:-0}
test_exit=${PI_API_SEND_CAP_TEST_EXIT_AFTER_BLOCK:-0}
case "$fake_ws:$test_exit" in 0:0|1:1) ;; *) echo "offline probe flags must be enabled together" >&2; exit 2 ;; esac
if [[ "$fake_ws" == 1 && "$PI_API_SEND_CAP_DRY_RUN" != 1 ]]; then
  echo "offline probe flags require PI_API_SEND_CAP_DRY_RUN=1" >&2
  exit 2
fi
if [[ -n ${NODE_OPTIONS:-} ]]; then
  echo "NODE_OPTIONS must be empty; this wrapper installs the verified preload" >&2
  exit 2
fi
if [[ ! -x "$PI_BIN" ]]; then echo "PI_BIN is not executable" >&2; exit 2; fi

selected_provider=
expect_provider=0
for arg in "$@"; do
  if [[ "$expect_provider" == 1 ]]; then selected_provider=$arg; expect_provider=0; continue; fi
  case "$arg" in --provider) expect_provider=1 ;; --provider=*) selected_provider=${arg#*=} ;; esac
done
if [[ "$selected_provider" != openai-codex ]]; then
  echo "no verified send guard for provider; require --provider openai-codex" >&2
  exit 2
fi

cap_import="--import=file://${script_dir}/preload.mjs"
case " ${NODE_OPTIONS:-} " in *" $cap_import "*) ;; *) export NODE_OPTIONS="$cap_import" ;; esac
exec "$PI_BIN" "$@"
