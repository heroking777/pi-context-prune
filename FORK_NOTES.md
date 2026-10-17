# Local fork notes — `heroking777/pi-context-prune`

This repository is a **private working fork** of
[`championswimmer/pi-context-prune`](https://github.com/championswimmer/pi-context-prune).

Its only purpose is to keep the in-house pruner modifications **under source control**
instead of hand-patching the generated `dist/index.js`. Upstream is read-only for us:
we never push to it.

| | |
|---|---|
| Branch | `pruner-phase6-source-v1.4.0` |
| Base | upstream tag **v1.4.0** → commit `a5fe6973a264dc37031ba02f1a3feb85b82709ab` |
| Upstream `main` | **v2.1.0 — deliberately NOT merged / NOT adopted** |
| Derived from | the deployed, byte-verified v1.4.0 build (see *Reproducibility*) |

---

## 1. Why this fork exists

The production extension was running a **generated bundle** (`dist/index.js`) that had been
patched directly. Every `npm update` would silently discard those local patches. This branch
re-implements each local patch **in the TypeScript source**, so the bundle is always
reproducible from reviewable code.

## 2. Locally retained behaviour

Everything below is additive. All new options default to the **previous behaviour**
(`false` / `null` / `"default"`), so an unconfigured installation behaves exactly like
upstream v1.4.0.

### Carried-over in-house options (pre-existing, unchanged semantics)

| Option | Default | Effect |
|---|---|---|
| `midTaskAutoPrune` | `false` | OPT-001 — flush inside the tool loop at `turn_end` |
| `midTaskThresholdChars` | `60000` | raw chars that trigger a mid-task flush |
| `midTaskThresholdToolCalls` | `12` | pending tool calls that trigger a mid-task flush |
| `rateLimitCooldownMs` | `1800000` | OPT-025 — per-batch cooldown after a summarizer 429 / free-tier limit (exponential, capped at 60 min) |
| `minRawCharsForSummary` | `10000` | OPT-025 — size floor; smaller batches never reach the LLM |

### Options added by the source reconstruction

| Option | Default | Effect |
|---|---|---|
| `summarizerMaxOutputTokens` | `null` | OPT-026 — `null` keeps the provider default. A positive cap is passed as `maxTokens`; a truncated response (`stopReason === "length"`) is treated as a failure so raw output is retained |
| `conciseSummaryMode` | `false` | OPT-027 — legacy flag for the concise prompt (B) |
| `summarizerPromptMode` | `"default"` | OPT-028 — `"default"` (A) \| `"concise"` (B) \| `"faithful"` (C). Wins over `conciseSummaryMode` |
| `evidenceAppendix` | `false` | OPT-029/030 — append a mechanically extracted, verbatim identifier appendix after the model summary + refs footer |
| `evidenceAppendixMaxEntries` | `200` | row cap for the appendix (single shared counter) |

### Module layout added by this fork

| Module | Lines | Responsibility |
|---|---|---|
| `src/rate-limit.ts` | ~160 | 429 / free-tier / credit-exhaustion detection + `RateLimitRegistry` cooldowns |
| `src/flush-policy.ts` | ~45 | size floor + mid-task flush predicates |
| `src/evidence-appendix.ts` | ~190 | deterministic verbatim identifier extraction + formatting |
| `src/summarizer-prompts.ts` | ~80 | prompt A/B/C + mode resolution |
| `test-entry.ts` | ~45 | **test-only** re-export entry used by the regression suite |

## 3. Compatibility

* **Runtime**: Pi `0.85.1` (verified against the same `@earendil-works/*` runtime import
  surface as the previously deployed v1.4.0 bundle — no new runtime imports).
* **Provider**: works with any summarizer provider. `summarizerThinking` emits **both**
  `reasoning` and `reasoningEffort`; `off` maps to `undefined` for both (= send nothing).
  This is what makes `deepseek-v4.1-flash` on the Command Code provider observe the setting.
* **Session format**: unchanged. Entry types `context-prune-summary`, `context-prune-index`,
  `context-prune-stats`, `context-prune-frontier` and the refs footer are byte-compatible,
  so sessions written by the deployed v1.4.0 bundle remain readable.
* **Upstream 2.1.0**: not merged. Do not `git merge upstream/main` into this branch.

## 4. Rebuild

```bash
npm install                          # dev deps only; pi-* peers stay external
npx tsc --noEmit -p tsconfig.json    # strict type check (typescript is a dev-only tool)
npm run build                        # -> dist/index.js (+ dist/index.js.map)
npm run check                        # build + package check
```

`dist/` is generated and gitignored — **never hand-edit it**.

### Reproducibility

`esbuild` output is deterministic: two consecutive builds of an identical source tree produce
an identical `dist/index.js` SHA-256. The strongest anchor is that building upstream v1.4.0
unmodified reproduces the deployed baseline bundle byte-for-byte
(`5ee648f6c314ff317e2800230cf4044fe4be1f82651191a57226f76f11fc9b1b`, 202,756 bytes).
Byte-equality with a *patched* bundle is not expected across build environments; verify
semantics instead (§5).

## 5. Verification

* Regression suite: exercises the built bundle directly (via `test-entry.ts`).
* Differential harness: compares the built bundle against the previously deployed
  patched bundle function-by-function (config defaults, prompt bytes, thinking options,
  appendix extraction over the real fixed batch + edge inputs, rate-limit/credit
  classification over error shapes, cooldown registry, `summarizeBatch` provider options).
* No network and **no real LLM call** is made by either suite.

## 6. Distribution and rollback

1. Build on the target machine from this branch (`npm run build`).
2. Copy the result into a **staging** extension directory — never over the running copy.
3. Smoke-test in a **fresh** Pi session with every new option left at its default.
4. Rollback: keep the previously deployed `dist/index.js` (and its SHA-256) beside the
   staging copy and restore it verbatim; no settings migration is required because no
   option default changed.
