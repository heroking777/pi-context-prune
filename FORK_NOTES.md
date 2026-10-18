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

## 7. Hybrid protected summaries (opt-in, Phase 47)

`protectedSummaryHybrid` (default `false`) replaces prompt-only protected
summaries with a three-stage pipeline:

1. **Deterministic core** (`src/hybrid-summary.ts`) extracts Tier-1 state from
   the raw batch (active identifiers with role + subject, status/subject pairs,
   unresolved errors, decisions, every unfinished task with its next action and
   rollback instructions) and renders it in the exact form the guard validates.
2. **LLM notes** receive only the remaining non-critical lines; protected lines
   are removed from the model input.
3. **Assembly** concatenates core + notes and re-validates the result with the
   *same* `verifyProtectedSummary` guard. Any ambiguity, overflow, or guard
   failure fails closed and keeps the raw output on the existing restore path.

The mode never makes the model the authority for Tier-1 values, and default
behaviour (all options at their defaults) is unchanged.

Integrity rules (Phase 48): deduplication is per (role/category, subject, value)
so two subjects with the same value never collapse; protected values are never
truncated (a line that cannot be rendered safely fails closed before any
provider call); and any notes line containing a protected value, status pair or
marker is excluded from the LLM input. Subject binding is checked per raw
occurrence, so repeated identical text under different subjects must keep every
binding.

Phase 49 hardening: every protected value has an explicit capture limit and a
terminator check — a value that hits the cap without a legitimate terminator is
treated as oversized and fails closed before any provider call. Subject
resolution has a single implementation (`subjectAtIndex`) shared by identifier
extraction, core construction and guard validation, and marker binding now
requires the *nearest* subject before an occurrence to match exactly (proximity
within a window is not sufficient).

Phase 50: the protected core is now rendered as structured `@rec {json}`
tuples (category, exact subject, exact role, exact value). Verification compares
tuples for exact equality, so a matching value under a different subject, a
subject mentioned in surrounding prose, a prefix-overlapping path, or an
`unknown` subject are all rejected. Free-form prose summaries still fall back to
the text checks and are reported as less verifiable than structured records.

Phase 51: structured parsing is strict and verification is set-exact. Any
`@rec`-intended line switches the summary to structural verification; malformed
JSON, missing fields, invalid category/role combinations or unsupported shapes
fail closed instead of falling back to prose checks. Verification compares
expected and actual record sets in both directions, so extra/injected records,
missing records, swapped subjects and conflicting identifier values are rejected.
LLM notes are also stripped of `@rec` lines at assembly so injected records can
never become authoritative. Prose-only summaries (no `@rec` lines) keep the older
text checks.

Phase 53: real-log defects fixed. (1) A bare `FAIL/HOLD/BLOCKED` with no
`subject: STATUS` pair is now recorded as a status record with explicit
`u:true` unknown provenance instead of vanishing and emptying the core; a
structured pair still wins and no extra bare record is invented. (2) A `HEAD=`
value is only the active HEAD when an authoritative command produced it
(`rev-parse`, `symbolic-ref`, `describe`, `status -b`); `git log/show/diff`
values stay historical, and conflicting authoritative values still fail closed.
(3) Records whose subject cannot be established carry `s:"unknown"` and
`u:true` so unresolved provenance is distinguishable from a verified binding.
Hybrid callers verify with `{ structuredOnly: true }` so an empty record set can
never fall back to the weaker prose checks.
