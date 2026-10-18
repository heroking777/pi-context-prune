// Phase48 — adversarial integrity tests for the hybrid protected core.
import {
  DEFAULT_CONFIG, SYSTEM_PROMPT, summarizerSystemPrompt, buildProtectedCore,
  assembleHybridSummary, verifyProtectedSummary, checkMarkerSubjects, extractProtectedItems,
  ToolCallIndexer, parseRecords, ok,
} from "./test-support.mjs";

const A = "1".repeat(40), B = "2".repeat(40);
const longTask = "apply the migration to staging and verify the rollback script end to end " + "x".repeat(300);

// 1. Same value on two subjects must not collapse.
const sameSha = [
  `Tool: bash({"command":"git -C /srv/repo-a rev-parse HEAD"})`,
  `Result (OK): HEAD=${A}`,
  `Tool: bash({"command":"git -C /srv/repo-b rev-parse HEAD"})`,
  `Result (OK): HEAD=${A}`,
].join("\n");
const sameShaCore = buildProtectedCore(sameSha);
const sameShaRec = parseRecords(sameShaCore.core).filter((r) => r.c === "id" && r.r === "HEAD" && r.v === A);
ok("identical HEAD on two repos keeps both subject bindings",
  sameShaCore.ok && sameShaRec.some((r) => r.s === "/srv/repo-a") && sameShaRec.some((r) => r.s === "/srv/repo-b") && sameShaRec.length === 2);
ok("guard accepts the two-subject core", verifyProtectedSummary(sameSha, sameShaCore.core).ok === true);

// 2. Identical task text on two files.
const sameTask = [
  `Tool: bash({"command":"cat /srv/a/PLAN.md"})`,
  "Result (OK): UNFINISHED_TASK: rotate staging credentials",
  `Tool: bash({"command":"cat /srv/b/PLAN.md"})`,
  "Result (OK): UNFINISHED_TASK: rotate staging credentials",
].join("\n");
const sameTaskCore = buildProtectedCore(sameTask);
const sameTaskRec = parseRecords(sameTaskCore.core).filter((r) => r.c === "task" && r.v === "rotate staging credentials");
ok("identical task text keeps both subjects",
  sameTaskCore.ok && sameTaskRec.some((r) => r.s === "/srv/a/PLAN.md") && sameTaskRec.some((r) => r.s === "/srv/b/PLAN.md") && sameTaskRec.length === 2);
ok("guard detects a task missing one subject binding",
  checkMarkerSubjects(sameTask, "- /srv/a/PLAN.md | UNFINISHED_TASK: rotate staging credentials", extractProtectedItems(sameTask).filter((i) => i.category === "task")).length > 0);

// 3. Identical rollback text under two subjects.
const sameRollback = [
  `Tool: bash({"command":"cat /srv/a/ROLLBACK.md"})`,
  "Result (OK): ROLLBACK=restore /srv/backups/snap.tar.gz",
  `Tool: bash({"command":"cat /srv/b/ROLLBACK.md"})`,
  "Result (OK): ROLLBACK=restore /srv/backups/snap.tar.gz",
].join("\n");
const sameRollbackCore = buildProtectedCore(sameRollback);
const sameRbRec = parseRecords(sameRollbackCore.core).filter((r) => r.c === "rollback");
ok("identical rollback text keeps both subjects",
  sameRollbackCore.ok && sameRbRec.some((r) => r.s === "/srv/a/ROLLBACK.md") && sameRbRec.some((r) => r.s === "/srv/b/ROLLBACK.md"));

// 4. Genuinely duplicated records for one subject collapse.
const dup = [
  `Tool: bash({"command":"cat /srv/a/PLAN.md"})`,
  "Result (OK): UNFINISHED_TASK: rotate staging credentials",
  "Result (OK): UNFINISHED_TASK: rotate staging credentials",
].join("\n");
ok("duplicate records for one subject collapse to one line",
  parseRecords(buildProtectedCore(dup).core).filter((r) => r.v === "rotate staging credentials").length === 1);

// 5. Long values are not truncated.
const longRaw = `Tool: bash({"command":"cat /srv/a/PLAN.md"})\nResult (OK): UNFINISHED_TASK: ${longTask}`;
const longCore = buildProtectedCore(longRaw);
ok("a long unfinished task is preserved in full", parseRecords(longCore.core).some((r) => r.c === "task" && r.v === longTask), longCore.reason);
ok("guard accepts the long task core", verifyProtectedSummary(longRaw, longCore.core).ok === true);
const longRollback = `Tool: bash({"command":"cat /srv/a/ROLLBACK.md"})\nResult (OK): ROLLBACK=restore ${"/srv/backups/".padEnd(400, "z")}`;
ok("a long rollback is preserved", parseRecords(buildProtectedCore(longRollback).core).some((r) => r.c === "rollback" && r.v.includes("/srv/backups/")));
const longError = `Tool: bash({"command":"run"})\nResult (ERROR): ERROR: ${"e".repeat(250)}`;
ok("a long error string is preserved", parseRecords(buildProtectedCore(longError).core).some((r) => r.c === "error" && r.v.includes("e".repeat(250))));

// 6. Multiple markers on one line.
const multi = `Tool: bash({"command":"cat /srv/a/STATE.md"})\nResult (OK): UNFINISHED_TASK: do X; NEXT_ACTION: do Y; ROLLBACK=restore /srv/backups/snap.tar.gz`;
const multiCore = buildProtectedCore(multi);
const multiRec = parseRecords(multiCore.core);
ok("all markers on one line are preserved",
  multiCore.ok && multiRec.some((r) => r.v === "do X") && multiRec.some((r) => r.v === "do Y") && multiRec.some((r) => r.v.includes("restore /srv/backups/snap.tar.gz")));

// 7. Mixed-line isolation: no protected value reaches the notes input.
const mixed = [
  `Tool: bash({"command":"git -C /srv/repo-a status"})`,
  `Result (OK): HEAD=${A} plus ordinary progress text and UNFINISHED_TASK: do X; NEXT_ACTION: do Y; ROLLBACK=restore /srv/backups/snap.tar.gz`,
  `Result (OK): nothing important happened here`,
].join("\n");
const mixedCore = buildProtectedCore(mixed);
ok("mixed lines are fully excluded from the LLM input",
  !mixedCore.notesInput.includes(A) && !mixedCore.notesInput.includes("do X") && !mixedCore.notesInput.includes("restore /srv/backups") &&
  mixedCore.notesInput.includes("nothing important happened here"));
ok("mixed-line core still passes the guard", verifyProtectedSummary(mixed, mixedCore.core).ok === true);

// 8. Two protected subjects on one line are both preserved.
const twoOnOneLine = `Tool: bash({"command":"git -C /srv/repo-a rev-parse HEAD"})\nResult (OK): HEAD=${A}; DEPLOYED_SHA=${B}`;
const twoCore = buildProtectedCore(twoOnOneLine);
const twoRec = parseRecords(twoCore.core);
ok("two protected subjects on one line are both kept", twoRec.some((r) => r.r === "HEAD" && r.v === A) && twoRec.some((r) => r.r === "DEPLOYED_SHA" && r.v === B));

// 9. Ambiguity still fails closed before any provider call.
const ambiguous = `Tool: bash({"command":"x"})\nResult (OK): FINAL_SHA=${A}\nResult (OK): FINAL_SHA=${B}`;
ok("ambiguous identifiers fail closed", buildProtectedCore(ambiguous).ok === false);

// 10. Assembly + retrieval + defaults.
const assembled = assembleHybridSummary(sameShaCore.core, "- merged three reads");
ok("assembled summary keeps the guard green", verifyProtectedSummary(sameSha, assembled).ok === true);
const indexer = new ToolCallIndexer();
indexer.addBatch({ turnIndex: 1, timestamp: 1, toolCalls: [{ toolName: "bash", toolCallId: "t1", args: {}, resultText: mixed, isError: false }] }, { appendEntry: () => {} });
const hits = indexer.searchRecords("ROLLBACK");
const ref = hits.records[0] ? indexer.getSearchRef(hits.records[0].toolCallId) : null;
ok("raw evidence remains retrievable", hits.matchCount > 0 && Boolean(ref) && Boolean(indexer.getRecord(ref)));
ok("default OFF keeps the prompt byte-identical", summarizerSystemPrompt({ ...DEFAULT_CONFIG }) === SYSTEM_PROMPT);
