// Phase47 — deterministic protected core + LLM notes + guard validation.
import {
  DEFAULT_CONFIG, SYSTEM_PROMPT, summarizerSystemPrompt, summarizerPromptMode,
  buildProtectedCore, assembleHybridSummary, verifyProtectedSummary, summarizeBatch,
  PROTECTION_FAILURE_MARKER, ToolCallIndexer, ok,
} from "./test-support.mjs";

const A = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
const B = "2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e";
const F1 = [
  `Tool: bash({"command":"git -C /srv/repo-alpha rev-parse HEAD"})`,
  `Result (OK): HEAD=${A}`,
  `Tool: bash({"command":"git -C /srv/repo-beta rev-parse HEAD"})`,
  `Result (OK): HEAD=${B}`,
  `Tool: bash({"command":"git -C /srv/repo-alpha commit -m fix"})`,
  `Result (OK): FINAL_SHA=3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f`,
].join("\n");
const F2 = [
  `Tool: bash({"command":"pytest -q tests/test_gate.py"})`,
  "Result (ERROR): 12 passed, 3 failed; jra-gate: FAIL (envelope hash mismatch); exit code 1",
  `Tool: bash({"command":"pytest -q tests/test_boat.py"})`,
  "Result (OK): 8 passed; boat-gate: PASS",
].join("\n");
const F4 = [
  `Tool: bash({"command":"cat /srv/repo-alpha/PLAN.md"})`,
  "Result (OK): UNFINISHED_TASK: apply migration to staging; NEXT_ACTION: verify rollback script",
  `Tool: bash({"command":"cat /srv/repo-alpha/ROLLBACK.md"})`,
  "Result (OK): ROLLBACK=restore /srv/backups/pre-migration.tar.gz if migration fails",
].join("\n");

// 1. Core extraction and guard acceptance, per fixture.
for (const [name, raw] of Object.entries({ F1, F2, F4 })) {
  const core = buildProtectedCore(raw);
  ok(`${name}: core builds`, core.ok === true, core.reason);
  ok(`${name}: core alone satisfies the guard`, verifyProtectedSummary(raw, core.core).ok === true);
}
const f1 = buildProtectedCore(F1);
ok("F1: both repository HEADs are bound to their own subject",
  f1.core.includes(`/srv/repo-alpha | HEAD=${A}`) && f1.core.includes(`/srv/repo-beta | HEAD=${B}`));
ok("F1: final identifier keeps its role label", f1.core.includes("FINAL_SHA=3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f"));
const f2 = buildProtectedCore(F2);
ok("F2: failing subject and status are preserved", f2.core.includes("jra-gate: FAIL"));
const f4 = buildProtectedCore(F4);
ok("F4: unfinished task keeps its exact text and subject",
  f4.core.includes("UNFINISHED_TASK: apply migration to staging") && f4.core.includes("/srv/repo-alpha/PLAN.md"));
ok("F4: next action is preserved", f4.core.includes("NEXT_ACTION: verify rollback script"));
ok("F4: rollback instruction and condition are preserved", f4.core.includes("restore /srv/backups/pre-migration.tar.gz if migration fails"));

// 2. LLM input isolation: protected lines are removed from the notes input.
ok("protected lines are excluded from the LLM input",
  !f4.notesInput.includes("UNFINISHED_TASK") && !f4.notesInput.includes("ROLLBACK=") &&
  !f1.notesInput.includes("HEAD=") && !f2.notesInput.includes("jra-gate: FAIL"));
ok("LLM input is smaller than the raw batch",
  f1.notesInput.length < F1.length && f4.notesInput.length < F4.length);

// 3. Assembly keeps the guard happy and stays deterministic.
const assembled = assembleHybridSummary(f1.core, "- ran three git commands; no further action needed");
ok("assembled summary passes the guard", verifyProtectedSummary(F1, assembled).ok === true);
ok("assembly puts the core first and notes second",
  assembled.indexOf("## Protected state") < assembled.indexOf("## Notes") && assembled.includes("FINAL_SHA="));

// 4. Conflicting statuses and multiple tasks.
const conflict = `Tool: bash({"command":"run /srv/a/gate"})\nResult (OK): /srv/a/gate: FAIL\nResult (OK): /srv/a/gate: PASS`;
ok("conflicting statuses: the enforced FAIL pair is preserved", buildProtectedCore(conflict).core.includes("/srv/a/gate: FAIL"));
const multi = [
  `Tool: bash({"command":"cat /srv/a/PLAN.md"})`,
  "Result (OK): UNFINISHED_TASK: rotate staging credentials",
  `Tool: bash({"command":"cat /srv/b/PLAN.md"})`,
  "Result (OK): UNFINISHED_TASK: backfill historical envelopes",
].join("\n");
const multiCore = buildProtectedCore(multi);
ok("multiple tasks with different subjects are all preserved",
  multiCore.core.includes("rotate staging credentials") && multiCore.core.includes("backfill historical envelopes") &&
  verifyProtectedSummary(multi, multiCore.core).ok === true);

// 5. Fail-closed on ambiguity, overflow and malformed markers.
const ambiguous = `Tool: bash({"command":"x"})\nResult (OK): FINAL_SHA=${A}\nResult (OK): FINAL_SHA=${B}`;
ok("ambiguous identifiers fail closed", buildProtectedCore(ambiguous).ok === false);
const overflow = Array.from({ length: 26 }, (_, i) => `Tool: bash({"command":"s${i}"})\nResult (OK): DECISION=policy-${i}`).join("\n");
ok("extraction overflow fails closed", buildProtectedCore(overflow).ok === false);
const malformed = `Tool: bash({"command":"plan"})\nResult (OK): UNFINISHED_TASK apply migration without separator`;
ok("malformed markers are not invented", buildProtectedCore(malformed).core.includes("UNFINISHED_TASK") === false);

// 6. Raw retrieval is unaffected.
const indexer = new ToolCallIndexer();
indexer.addBatch({ turnIndex: 1, timestamp: 1, toolCalls: [{ toolName: "bash", toolCallId: "tc-h1", args: {}, resultText: F4, isError: false }] }, { appendEntry: () => {} });
const hits = indexer.searchRecords("ROLLBACK");
const ref = hits.records[0] ? indexer.getSearchRef(hits.records[0].toolCallId) : null;
ok("raw remains retrievable by search ref", hits.matchCount > 0 && Boolean(ref) && Boolean(indexer.getRecord(ref)));

// 7. End-to-end: hybrid mode assembles core + notes and passes the guard.
function ctx(text) {
  const provider = { stream() {
    const r = { stopReason: "stop", content: [{ type: "text", text }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 }, timestamp: Date.now() };
    return Object.assign((async function* () { yield { type: "text_end", partial: r }; })(), { result: async () => r });
  } };
  return { model: { provider: "f", id: "m" }, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {}, env: {} }), getProvider: () => provider, find: () => undefined }, ui: { notify: () => {} }, sessionManager: { getSessionId: () => "hybrid-e2e" } };
}
const batch = { turnIndex: 1, timestamp: 1, toolCalls: [{ toolName: "bash", toolCallId: "t4", args: {}, isError: false, resultText: F4 }] };
const cfg = { ...DEFAULT_CONFIG, protectedSummaryHybrid: true };
const result = await summarizeBatch(batch, cfg, ctx("- ran two reads; no further action"));
ok("hybrid summarizeBatch returns the assembled summary", result && result[PROTECTION_FAILURE_MARKER] !== true && result.summaryText.includes("UNFINISHED_TASK: apply migration to staging") && result.summaryText.includes("## Notes"));
const bad = await summarizeBatch({ ...batch, toolCalls: [{ ...batch.toolCalls[0], toolCallId: "t5", resultText: ambiguous }] }, cfg, ctx("- notes"));
ok("hybrid mode fails closed on an ambiguous core", bad && bad[PROTECTION_FAILURE_MARKER] === true);

// 8. Default OFF equivalence and mode selection.
ok("hybrid mode is opt-in only", summarizerPromptMode({ ...DEFAULT_CONFIG, protectedSummaryHybrid: true }) === "hybrid");
ok("default OFF keeps the prompt byte-identical", summarizerSystemPrompt({ ...DEFAULT_CONFIG }) === SYSTEM_PROMPT);
ok("hybrid prompt does not ask the model to restate protected values",
  summarizerSystemPrompt({ ...DEFAULT_CONFIG, protectedSummaryHybrid: true }).includes("Do NOT repeat or rephrase"));
