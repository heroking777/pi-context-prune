# T02j API-send guard (verification only)

This directory preserves the T02j-tested experiment harness. It is separate from the Pruner runtime and is not imported or packaged by the extension. The source-transform parentheses fix and pre-native-WebSocket reservation are retained here with the shared eight-send gate, OAuth refresh deny rule, and fail-closed behavior.

## Offline verification

Use the Pi AI modules already installed on the test machine; no credentials are required. Set their module file paths explicitly so the harness has no dependency on a particular user's install directory:

```bash
export PI_AI_PROVIDER_MODULE=/path/to/pi-ai/dist/api/openai-codex-responses.js
export PI_AI_OAUTH_MODULE=/path/to/pi-ai/dist/auth/oauth/openai-codex.js
./verification/t02j-api-cap/run-offline-tests.sh
```

The runner syntax-checks and executes each focused test once. It uses empty OAuth fields, temporary isolated counter directories, and fake transports. Pi AI requires its provider-shaped API key to enter the provider path, so each probe generates a random unsigned test-only JWT in memory; it is never logged, written, or sent because the dry-run gate blocks before transport. No auth file, session, or captured raw payload is needed. For defense in depth, run the suite in a network-disabled namespace when available.

The suite covers:

- Eight shared HTTP/fetch/WebSocket reservations; denial before send 9.
- Reservation before native WebSocket construction; first `response.create` consumes the handshake reservation without double-counting.
- Constructor, send, error/close, lock-contention, and provider-source-drift failure behavior.
- Cross-process cap persistence and concurrent contention.
- OAuth refresh denial before underlying fetch, with the counter unchanged.
- Live mode refusal when the separate authorization marker is absent; the Pi executable is not invoked and no cap state is initialized.
- Regression for the minified `await(options?.fetch??globalThis.fetch)(...)` rewrite that previously produced `awaitglobalThis`; corrected transform preserves the call parentheses.
- Actual installed Pi AI provider boundary in `auto` and SSE modes with fake/dry-run transport and `context_tree_query` schema capture.

All emitted test evidence goes to an OS temporary directory (printed at the end), not the repository. The runner does not read, reset, or reuse the T02i/T02j experiment counters.

## Capped Pi wrapper for a separately authorized future run

`run-pi-with-cap.sh` defaults to dry-run, requires an explicit `PI_BIN`, requires `PI_API_SEND_CAP_DIR`, and never resets that directory. It only admits the verified `openai-codex` provider. Live mode additionally requires the separate authorization marker `PI_API_SEND_CAP_LIVE_AUTHORIZED=YES`; setting the marker is not itself authorization. Use a new, explicitly approved counter directory when a later task authorizes a live run; do not infer zero sends from the prior T02i counter, whose total remains UNKNOWN.

Example offline invocation:

```bash
PI_BIN=/path/to/pi \
PI_API_SEND_CAP_DIR=/path/to/a-new-offline-state \
PI_API_SEND_CAP_DRY_RUN=1 \
verification/t02j-api-cap/run-pi-with-cap.sh --provider openai-codex --help
```

No production bundle, Pruner source, auth, session, T02i counter, or live-model result is part of this verification package. T02i's actual network-send count remains UNKNOWN; model answer accuracy and model-initiated Raw retrieval remain unverified.
