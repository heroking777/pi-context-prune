// Phase49 — overlong-value limits, unified subject authority, exact binding.
import {
  DEFAULT_CONFIG, SYSTEM_PROMPT, summarizerSystemPrompt, buildProtectedCore,
  assembleHybridSummary, verifyProtectedSummary, subjectAtIndex, ToolCallIndexer, ok,
} from "./test-support.mjs";

const P = "/srv/repo-alpha";
const pad = (n) => "x".repeat(n);

// 1. Overlong marker values are detected, never silently truncated.
for (const [label, body, limit] of [
  ["task", "UNFINISHED_TASK: ", 2000],
  ["next", "NEXT_ACTION: ", 2000],
  ["rollback", "ROLLBACK=", 2000],
  ["error", "ERROR: ", 2000],
]) {
  const atLimit = `Tool: bash({"command":"cat ${P}/STATE.md"})\nResult (OK): ${body}${pad(limit)}`;
  const overLimit = `Tool: bash({"command":"cat ${P}/STATE.md"})\nResult (OK): ${body}${pad(limit + 1)}`;
  ok(`${label}: value at the limit is accepted`, verifyProtectedSummary(atLimit, atLimit).oversized === false);
  ok(`${label}: value one char over the limit fails closed`,
    buildProtectedCore(overLimit).ok === false || verifyProtectedSummary(overLimit, overLimit).oversized === true);
}
const decisionAt = `Tool: bash({"command":"x"})\nResult (OK): DECISION=${pad(400)}`;
const decisionOver = `Tool: bash({"command":"x"})\nResult (OK): DECISION=${pad(401)}`;
ok("decision: at the limit accepted", verifyProtectedSummary(decisionAt, decisionAt).oversized === false);
ok("decision: over the limit fails closed", verifyProtectedSummary(decisionOver, decisionOver).oversized === true);
const identOver = `Tool: bash({"command":"git -C ${P} rev-parse HEAD"})\nResult (OK): HEAD=${pad(201)}`;
ok("identifier: over the limit fails closed", verifyProtectedSummary(identOver, identOver).oversized === true);

// 2. One authoritative subject resolver.
const raw = `Tool: bash({"command":"cat ${P}/PLAN.md"})\nResult (OK): UNFINISHED_TASK: do X`;
const taskIndex = raw.indexOf("do X");
ok("task subject equals the authoritative resolver", subjectAtIndex(raw, taskIndex) === `${P}/PLAN.md`);
ok("core uses the same subject", buildProtectedCore(raw).core.includes(`- ${P}/PLAN.md | `));
const assembled = assembleHybridSummary(buildProtectedCore(raw).core, "- merged reads");
ok("guard accepts the assembled summary", verifyProtectedSummary(raw, assembled).ok === true);

// 3. Exact binding: a nearer, different subject must not be accepted.
const twoSubjects = [
  `Tool: bash({"command":"cat /srv/a/PLAN.md"})`,
  "Result (OK): UNFINISHED_TASK: do X",
  `Tool: bash({"command":"cat /srv/b/PLAN.md"})`,
  "Result (OK): done with b",
].join("\n");
const misleading = "- /srv/a/PLAN.md | done\n- /srv/b/PLAN.md | UNFINISHED_TASK: do X";
ok("a nearer wrong subject is rejected (proximity alone is not enough)",
  verifyProtectedSummary(twoSubjects, misleading).ok === false && verifyProtectedSummary(twoSubjects, misleading).unboundTasks.length > 0);
ok("the correct binding passes",
  verifyProtectedSummary(twoSubjects, "- /srv/a/PLAN.md | UNFINISHED_TASK: do X").ok === true);

// 4. Task and next action under different subjects.
const split = [
  `Tool: bash({"command":"cat /srv/a/PLAN.md"})`,
  "Result (OK): UNFINISHED_TASK: do X",
  `Tool: bash({"command":"cat /srv/b/PLAN.md"})`,
  "Result (OK): NEXT_ACTION: do Y",
].join("\n");
ok("task and next action bound to their own subjects pass",
  verifyProtectedSummary(split, `- /srv/a/PLAN.md | UNFINISHED_TASK: do X\n- /srv/b/PLAN.md | NEXT_ACTION: do Y`).ok === true);
ok("assigning both to one subject is rejected",
  verifyProtectedSummary(split, `- /srv/a/PLAN.md | UNFINISHED_TASK: do X; NEXT_ACTION: do Y`).ok === false);

// 5. Rollback under the wrong subject.
const rb = [
  `Tool: bash({"command":"cat /srv/a/ROLLBACK.md"})`,
  "Result (OK): ROLLBACK=restore /srv/backups/snap.tar.gz",
  `Tool: bash({"command":"cat /srv/b/ROLLBACK.md"})`,
  "Result (OK): ROLLBACK=restore /srv/backups/snap.tar.gz",
].join("\n");
ok("identical rollback under two subjects needs both bindings",
  verifyProtectedSummary(rb, "- /srv/a/ROLLBACK.md | ROLLBACK=restore /srv/backups/snap.tar.gz").ok === false &&
  verifyProtectedSummary(rb, "- /srv/a/ROLLBACK.md | ROLLBACK=restore /srv/backups/snap.tar.gz\n- /srv/b/ROLLBACK.md | ROLLBACK=restore /srv/backups/snap.tar.gz").ok === true);

// 6. Leakage, retrieval and defaults.
const mixed = `Tool: bash({"command":"cat ${P}/STATE.md"})\nResult (OK): UNFINISHED_TASK: do X; ROLLBACK=restore /srv/backups/snap.tar.gz\nResult (OK): ordinary progress line`;
const mixedCore = buildProtectedCore(mixed);
ok("no protected value leaks into the notes input",
  !mixedCore.notesInput.includes("do X") && !mixedCore.notesInput.includes("restore /srv/backups") && mixedCore.notesInput.includes("ordinary progress line"));
const indexer = new ToolCallIndexer();
indexer.addBatch({ turnIndex: 1, timestamp: 1, toolCalls: [{ toolName: "bash", toolCallId: "t1", args: {}, resultText: mixed, isError: false }] }, { appendEntry: () => {} });
const hits = indexer.searchRecords("ROLLBACK");
const ref = hits.records[0] ? indexer.getSearchRef(hits.records[0].toolCallId) : null;
ok("raw evidence remains retrievable", hits.matchCount > 0 && Boolean(ref) && Boolean(indexer.getRecord(ref)));
ok("default OFF keeps the prompt byte-identical", summarizerSystemPrompt({ ...DEFAULT_CONFIG }) === SYSTEM_PROMPT);
