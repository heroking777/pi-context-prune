# Portable verification suite

All test inputs are synthetic and anonymized. Tests do not read Pi sessions, production
configuration, provider credentials, or call an LLM API. `dist/` and `tests/.test-work/` are
generated locally and are not committed.

## Run from a clean checkout

```bash
npm ci
npx tsc --noEmit -p tsconfig.json
npm run build
npm run check
npm test
```

`npm test` builds the upstream v1.4.0 baseline from commit
`a5fe6973a264dc37031ba02f1a3feb85b82709ab` using the installed dependencies, creates a
non-secret synthetic evidence fixture under `tests/fixtures/`, then runs the regression
and isolated staging suites.

### Status semantics

* **Required regression**: must PASS. It compares defaults/session-format/prompt invariants
to a locally rebuilt upstream v1.4.0 baseline. Failure is non-zero.
* **Required isolated staging**: must PASS. It imports `dist/index.js` under Node, registers
the extension on a mock ExtensionAPI, drives lifecycle hooks, and asserts no provider/API
call. This is not the same as starting the Pi CLI itself.
* **Optional Phase5 differential**: set `PRUNER_PHASE5_BUNDLE=/absolute/path/to/phase5-reference.mjs`
to run the 41 function-level comparisons against the pre-Phase6 patched bundle. The
reference module must export the functions listed in `tests/diff6.mjs`. The bundle is an
external generated artifact and must **not** be committed. If unset, the test prints
`DIFFERENTIAL=SKIP`, and `npm test` exits **2 / OVERALL_STATUS=INCOMPLETE** — it does not
report a full PASS.
* **Real Pi 0.85.1 startup** is an optional host check. Use a separate temporary `HOME`,
`PI_CODING_AGENT_DIR` and session directory, with `PI_OFFLINE=1`, no prompt and no existing
session. The Node staging test does not claim to replace this runtime check.

## Test inventory

* `run.mjs` orchestrates `regression-options.mjs`, `regression-source.mjs`,
  `regression-evidence.mjs`, and `regression-phase5.mjs`. Together they retain 177
  assertions (Phase1–6); no external session data is read. Handwritten test modules stay
  under the 300-line source limit.
* `diff6.mjs`: the optional Phase5-vs-current differential suite; 41 assertions when the
external reference bundle is supplied.
* `staging.mjs`: portable mock registration/lifecycle/default/provider-isolation suite; 30
assertions.
* `provider-contract.mjs`: minimal offline model-reasoning mapping contract, copied from the
  Command Code provider 0.6.4 implementation shape. It is not fetched from a host
  installation and does not access credentials.
* `fixtures/evidence-batch.json`: synthetic identifiers only; 21 unique labeled 64-hex
values across synthetic bash calls. It contains no real repository, commit, deployment or
client data.

A regression assertion count can change when checks are added or removed. Always use the
printed counts and final status lines as the execution result; do not infer PASS from process
startup alone.
