// Phase50 — exact structural record binding (no proximity/substring matching).
import { buildProtectedCore, verifyProtectedSummary, expectedRecords, parseRecords, ok } from "./test-support.mjs";

const mk = (c, s, v, r) => "@rec " + JSON.stringify(r ? { c, s, v, r } : { c, s, v });
const RAW = [
  `Tool: bash({"command":"cat /srv/a/PLAN.md"})`,
  "Result (OK): UNFINISHED_TASK: do X",
  `Tool: bash({"command":"cat /srv/b/PLAN.md"})`,
  "Result (OK): NEXT_ACTION: do Y",
].join("\n");

// 1. Correct value under the wrong subject.
ok("a correct value under the wrong subject is rejected",
  verifyProtectedSummary(RAW, mk("task", "/srv/b/PLAN.md", "do X")).ok === false &&
  verifyProtectedSummary(RAW, mk("task", "/srv/b/PLAN.md", "do X")).unboundTasks.length > 0);
ok("the exact record pair is accepted",
  verifyProtectedSummary(RAW, `${mk("task", "/srv/a/PLAN.md", "do X")}\n${mk("next", "/srv/b/PLAN.md", "do Y")}`).ok === true);

// 2. Same value under two subjects needs both records.
const SAME = [
  `Tool: bash({"command":"cat /srv/a/PLAN.md"})`,
  "Result (OK): UNFINISHED_TASK: rotate creds",
  `Tool: bash({"command":"cat /srv/b/PLAN.md"})`,
  "Result (OK): UNFINISHED_TASK: rotate creds",
].join("\n");
const one = mk("task", "/srv/a/PLAN.md", "rotate creds");
const both = `${one}\n${mk("task", "/srv/b/PLAN.md", "rotate creds")}`;
ok("one of two identical-value subjects is a contradiction", verifyProtectedSummary(SAME, one).ok === false);
ok("both subjects pass", verifyProtectedSummary(SAME, both).ok === true);

// 3. Subject only in unrelated prose / elsewhere on the line.
const prose = `context mentions /srv/a/PLAN.md but the record says otherwise\n${mk("task", "/srv/b/PLAN.md", "do X")}`;
ok("a subject in unrelated prose does not bind", verifyProtectedSummary(RAW, prose).ok === false);
const sameLine = `${mk("task", "/srv/b/PLAN.md", "do X")} (see /srv/a/PLAN.md)`;
ok("a subject elsewhere on the same line does not bind", verifyProtectedSummary(RAW, sameLine).ok === false);

// 4. Prefix-overlapping paths are distinct subjects.
const prefix = [
  `Tool: bash({"command":"cat /srv/a/PLAN.md"})`,
  "Result (OK): UNFINISHED_TASK: do X",
].join("\n");
ok("a prefix-overlapping path is not accepted",
  verifyProtectedSummary(prefix, mk("task", "/srv/a-long/PLAN.md", "do X")).ok === false);

// 5. More than 200 distinct paths: the record subject is exact, not universe-limited.
const manyPaths = Array.from({ length: 250 }, (_, i) => `/srv/p${i}/file.md`);
const deepRaw = `Tool: bash({"command":"cat ${manyPaths[249]}"})\nResult (OK): UNFINISHED_TASK: deep task`;
const deepExpected = expectedRecords(deepRaw);
ok("the 250th path binds exactly", deepExpected.ok && deepExpected.records.some((r) => r.s === manyPaths[249] && r.v === "deep task"));
ok("the deep record passes structurally", verifyProtectedSummary(deepRaw, mk("task", manyPaths[249], "deep task")).ok === true);

// 6. Multiple markers on one line become separate records.
const multi = `Tool: bash({"command":"cat /srv/a/STATE.md"})\nResult (OK): UNFINISHED_TASK: do X; NEXT_ACTION: do Y; ROLLBACK=restore /srv/backups/snap.tar.gz`;
const multiRec = parseRecords(buildProtectedCore(multi).core);
ok("each marker on a shared line is its own record",
  multiRec.filter((r) => ["task", "next", "rollback"].includes(r.c)).length === 3);

// 7. Multiple repositories keep separate identifier records.
const A = "1".repeat(40), B = "2".repeat(40);
const repos = `Tool: bash({"command":"git -C /srv/ra rev-parse HEAD"})\nResult (OK): HEAD=${A}\nTool: bash({"command":"git -C /srv/rb rev-parse HEAD"})\nResult (OK): HEAD=${B}`;
const repoRec = parseRecords(buildProtectedCore(repos).core).filter((r) => r.r === "HEAD");
ok("two repositories produce two identifier records", repoRec.length === 2 && repoRec.some((r) => r.s === "/srv/ra") && repoRec.some((r) => r.s === "/srv/rb"));
ok("swapping the two repository values is rejected",
  verifyProtectedSummary(repos, `${mk("id", "/srv/ra", B, "HEAD")}\n${mk("id", "/srv/rb", A, "HEAD")}`).ok === false);

// 8. Rollback binding.
const rb = `Tool: bash({"command":"cat /srv/a/ROLLBACK.md"})\nResult (OK): ROLLBACK=restore /srv/backups/snap.tar.gz`;
ok("rollback under the right subject passes", verifyProtectedSummary(rb, mk("rollback", "/srv/a/ROLLBACK.md", "restore /srv/backups/snap.tar.gz")).ok === true);
ok("rollback under a wrong subject is rejected", verifyProtectedSummary(rb, mk("rollback", "/srv/b/ROLLBACK.md", "restore /srv/backups/snap.tar.gz")).ok === false);

// 9. An unknown subject cannot stand in for a known one.
ok("an unknown-subject record does not satisfy a known subject",
  verifyProtectedSummary(RAW, mk("task", "unknown", "do X")).ok === false);

// 10. Free-form prose remains text-checked (and is not silently passed).
const proseOnly = "- did some work and finished the task";
ok("free-form prose without records is not accepted when a task is required", verifyProtectedSummary(RAW, proseOnly).ok === false);
