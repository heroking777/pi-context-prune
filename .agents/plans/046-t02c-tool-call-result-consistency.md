# T02c — Preserve summarized tool-call/result pairing

## Goal
Keep summarized calls and their `toolResult` messages paired in Pi's provider context, without full raw output, while preserving Raw lookup and `context_tree_query`.

## Plan
- [x] Confirm clean base `2694206477ed1e0dc00a1487dee1b378a996da2c`, matching remote branch, and create independent branch `t02c-tool-call-result-consistency`.
- [x] Confirm `pruneMessages` removes only summarized results; Pi AI synthesizes `No result provided` for the remaining calls.
- [x] Replace summarized `toolResult` content with a compact message carrying `ToolCallIndexer.getSearchRef()`; preserve `toolCallId`, `toolName`, `isError`, and clear potentially large `details`. Leave unindexed/unpruned results untouched; fail open to original content if no safe ref exists.
- [x] Update the context hook to apply same-length content transformations by array identity.
- [x] Add and run focused regression cases for multi-call, partial summaries, unpruned results, summarized errors, Pi AI message transformation, and Raw lookup.
- [x] Replay the copied T02 session through the real Pi provider path with fake transport; assert zero orphan calls/placeholders and retain query schema/refs.
- [x] Run TypeScript, package guard, required portable tests, fake-provider replay, Raw lookup, and `git diff --check`; optional Phase5 differential skipped because no reference bundle is available.
- [x] Update Project Map/TODO/CHANGES; commit and push the source branch and canonical docs branch; verify both remote refs.

## Constraints
No live model API, cap reset, production bundle, shared settings, or original-session modification. Do not widen the source fix beyond this context-pairing defect.
