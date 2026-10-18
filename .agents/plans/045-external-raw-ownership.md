# 045 — External Raw ownership and compatibility

- [x] Verify expected base/remote SHA and inspect all fullOutputPath deletion sites.
- [x] Remove Pruner-owned deletion/mutation of Pi/other-hook temporary Raw sources and preserve upstream details.
- [x] Extend actual Pi 0.85.1 runner tests for later-hook access, both orders, session Raw/hash, storage growth, and quota fail-closed.
- [x] Run regression, staging, observability, typecheck, build/package-check, and diff-check.
- [x] Commit/push only passing changes to the development branch and verify remote SHA.

Scope: no additional optimization, production changes, active-session lifecycle operations, or model calls. Reverse hook order without a complete upstream Raw source remains blocked.