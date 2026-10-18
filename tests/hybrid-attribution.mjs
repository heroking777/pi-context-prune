// Phase58 — subject attribution must be call-local; free-form prose never binds.
import { expectedRecords, buildProtectedCore, verifyProtectedSummary, ok } from "./test-support.mjs";

const S1 = "1".repeat(40);
const tool = (cmd) => `Tool: bash({"command":${JSON.stringify(cmd)}})`;

// 1. A path in assistant prose is not a subject (previously a false binding).
const proseBefore = `Assistant said: see /srv/unrelated/notes.md then UNFINISHED_TASK: do X\n${tool("pytest -q")}\nResult (OK): ok`;
const proseRecord = expectedRecords(proseBefore).records.find((r) => r.c === "task");
ok("a path in assistant prose does not become the subject", proseRecord.s === "unknown" && proseRecord.u === true);
ok("the task value itself is still preserved", proseRecord.v === "do X");

// 2. A status pair written in assistant prose is not a tool-output record.
const statusProse = `Assistant said: /srv/unrelated/notes.md: FAIL\n${tool("pytest -q")}\nResult (OK): ok`;
ok("a status pair in prose is not recorded", expectedRecords(statusProse).records.every((r) => r.c !== "st"));
const statusInTool = `Assistant said: /srv/unrelated/notes.md: HOLD\n${tool("pytest -q")}\nResult (ERROR): 3 failed; FAIL`;
const toolStatus = expectedRecords(statusInTool).records.filter((r) => r.c === "st");
ok("a status in tool output is still recorded with unresolved provenance", toolStatus.some((r) => r.v === "FAIL" && r.u === true));

// 3. Cross-tool: a marker never inherits another tool's subject.
const crossTool = [
  tool("git -C /srv/other rev-parse HEAD"), `Result (OK): ${S1}`,
  tool("pytest -q"), "Result (ERROR): UNFINISHED_TASK: do X",
].join("\n");
const crossRecord = expectedRecords(crossTool).records.find((r) => r.c === "task");
ok("a marker does not inherit a neighbouring tool's path", crossRecord.s === "unknown" && crossRecord.u === true);

// 4. Repeated identical markers keep their own call-local subjects.
const repeated = [
  tool("cat /srv/a/PLAN.md"), "Result (OK): UNFINISHED_TASK: do X",
  tool("cat /srv/b/PLAN.md"), "Result (OK): UNFINISHED_TASK: do X",
].join("\n");
const repeatedTasks = expectedRecords(repeated).records.filter((r) => r.c === "task");
ok("identical markers keep per-tool subjects",
  repeatedTasks.length === 2 && repeatedTasks.some((r) => r.s === "/srv/a/PLAN.md") && repeatedTasks.some((r) => r.s === "/srv/b/PLAN.md"));

// 5. A malformed tool block never inherits the next block's result.
const malformed = [tool("git -C /srv/r rev-parse HEAD"), "---", tool("pytest -q"), `Result (OK): ${S1}`].join("\n");
ok("a block without a result does not take the next result", expectedRecords(malformed).records.every((r) => r.r !== "HEAD"));

// 6. Result-text paths remain non-subjects; structure still verifies.
const resultPath = `${tool("pytest -q")}\nResult (ERROR): failure in /srv/elsewhere/file.py; FAIL`;
ok("a result-only path is not a subject", expectedRecords(resultPath).records.every((r) => r.s !== "/srv/elsewhere/file.py"));
const core = buildProtectedCore(crossTool);
ok("attribution core verifies structurally", core.ok === true && verifyProtectedSummary(crossTool, core.core, { structuredOnly: true }).ok === true);
