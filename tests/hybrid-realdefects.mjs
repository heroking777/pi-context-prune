// Phase53 — real-log defect regressions: bare status, HEAD authority, unknown subjects.
import { buildProtectedCore, verifyProtectedSummary, expectedRecords, parseRecords, ok } from "./test-support.mjs";

const A = "1".repeat(40), B = "2".repeat(40);

// 1. Bare FAIL/HOLD with no structured pair is preserved with unknown provenance.
const bare = `Tool: bash({"command":"pytest -q"})\nResult (ERROR): 3 failed; FAIL`;
const bareRecords = expectedRecords(bare).records.filter((r) => r.c === "st");
ok("a bare FAIL becomes a status record", bareRecords.length === 1 && bareRecords[0].v === "FAIL");
ok("its provenance is explicitly unresolved", bareRecords[0].u === true && bareRecords[0].s === "unknown");
ok("the core verifies structurally", buildProtectedCore(bare).ok === true);

// 2. A bare status never overrides a structured subject/status pair.
const paired = `Tool: bash({"command":"run /srv/a/gate"})\nResult (OK): /srv/a/gate: FAIL\nResult (OK): stray FAIL line`;
const pairedRecords = expectedRecords(paired).records.filter((r) => r.c === "st");
ok("a structured pair wins and no extra bare record is invented",
  pairedRecords.length === 1 && pairedRecords[0].s === "/srv/a/gate" && pairedRecords[0].v === "FAIL");

// 3. Historical HEAD is not promoted; authoritative HEAD is.
const historical = `Tool: bash({"command":"git -C /srv/r log --oneline"})\nResult (OK): HEAD=${A}`;
ok("a HEAD value from git log is not an active identifier",
  expectedRecords(historical).records.every((r) => !(r.c === "id" && r.r === "HEAD")));
const authoritative = `Tool: bash({"command":"git -C /srv/r rev-parse HEAD"})\nResult (OK): HEAD=${A}`;
const authRecords = expectedRecords(authoritative).records.filter((r) => r.c === "id" && r.r === "HEAD");
ok("a HEAD value from rev-parse is active and bound", authRecords.length === 1 && authRecords[0].s === "/srv/r" && authRecords[0].v === A);
const conflicting = `Tool: bash({"command":"git -C /srv/r rev-parse HEAD"})\nResult (OK): HEAD=${A}\nTool: bash({"command":"git -C /srv/r rev-parse HEAD"})\nResult (OK): HEAD=${B}`;
ok("conflicting authoritative HEAD values fail closed", buildProtectedCore(conflicting).ok === false);
const twoRepos = `Tool: bash({"command":"git -C /srv/r1 rev-parse HEAD"})\nResult (OK): HEAD=${A}\nTool: bash({"command":"git -C /srv/r2 rev-parse HEAD"})\nResult (OK): HEAD=${B}`;
ok("authoritative HEADs of two repositories are both kept",
  expectedRecords(twoRepos).records.filter((r) => r.c === "id" && r.r === "HEAD").length === 2);

// 4. Unknown subjects are marked, not invented, and round-trip through the parser.
const noPath = `Tool: bash({"command":"plan"})\nResult (OK): UNFINISHED_TASK: do X`;
const noPathRecord = expectedRecords(noPath).records.find((r) => r.c === "task");
ok("a task without a structured subject is explicitly unresolved", noPathRecord.s === "unknown" && noPathRecord.u === true);
ok("the unresolved record round-trips", parseRecords(buildProtectedCore(noPath).core).every((r) => r.u === true));
ok("the core still verifies", buildProtectedCore(noPath).ok === true);

// 5. Hybrid never falls back to prose verification.
const noTier1 = `Tool: bash({"command":"ls /srv"})\nResult (OK): a b c`;
ok("an empty record set verifies structurally when hybrid asks for it",
  verifyProtectedSummary(noTier1, "", { structuredOnly: true }).ok === true);
const withTier1 = `Tool: bash({"command":"plan"})\nResult (OK): UNFINISHED_TASK: do X`;
ok("an empty summary with tier-1 content fails closed in structured mode",
  verifyProtectedSummary(withTier1, "", { structuredOnly: true }).ok === false);
ok("the hybrid core for that batch is non-empty", buildProtectedCore(withTier1).core.includes("@rec"));
