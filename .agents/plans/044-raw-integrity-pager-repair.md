# Raw integrity and pager repair

## Goal and invariants
- Preserve only verified complete text Raw before later minimization; never publish a Raw ref when source verification/storage fails.
- Prefer the existing session index as the sole durable Raw backing. Bound new Raw-only records/bytes per session and per record.
- Keep existing compression rules unchanged. Pruner cannot prevent an external downstream minimizer from shortening output when its own Raw capture fails; surface this limitation explicitly.
- Page by byte-safe UTF-8 cursors and line bounds; every continuation advances and concatenated page bytes equal the indexed Raw bytes.

## Steps
1. Implement verified capture for core `fullOutputPath` and minimizer-at-risk results; preserve hash/byte metadata, remove the temporary duplicate only after durable append, and fail closed on missing, mismatched, oversized, or quota-exhausted data.
2. Repair Raw paging with backward-compatible `startLine`, a forward-only `startByte` cursor, and exact final-page termination.
3. Add unit and isolated Pi 0.85.1 runner integration tests for both hook orders, core accumulator truncation, minimizer budgets, errors, missing/corrupt files, quotas, and byte-exact page reconstruction.
4. Run regression/staging/observability, package check/build, type checks, line counts, and `git diff --check`; commit/push only tested task-owned files and verify the remote branch SHA.

## Acceptance
- Reconstructed Raw SHA-256 and byte length equal original fixtures for every supported case.
- Missing/unverifiable/over-budget Raw never receives a completeness claim; any downstream-minimizer limitation remains explicit.
- No changes to production package, settings, sessions, or running Pi processes; no model calls or main merge.
