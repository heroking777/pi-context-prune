# T02k — Persist T02j offline send-cap harness

## Goal
Commit the T02j-verified provider rewrite and API-send guard tests under a verification-only directory, without changing Pruner source or production artifacts.

## Scope
- [x] Add `verification/t02j-api-cap/` with only the required cap/provider/OAuth guard modules, focused tests, portable offline runner, and documentation.
- [x] Remove fixed `/tmp` and `/home/deploy` references from copied harness code; take Pi AI provider/OAuth module paths from explicit environment variables.
- [x] Do not include auth fixtures/tokens, sessions, provider payloads, or T02j evidence files.
- [x] Run the full offline verification once in this clean worktree; preserve T02i network-send count as UNKNOWN and do not touch its counter.
- [x] Commit/push only this verification harness and plan; update/push Project Map/TODO after source push.

## Verification
- `verification/t02j-api-cap/run-offline-tests.sh` (unit cap, provider auto/SSE boundaries, source-transform regression, OAuth refresh guard, lock/cap fail-closed).
- `node --check` all harness JavaScript; `git diff --check`; clean independent checkout before edit.
- Remote readback for source branch and Project Map main.

## Safety
No live provider, real auth, production bundle, Pi process, T02i counter, or existing T02j harness mutation. The test runner creates isolated temporary counters only.
