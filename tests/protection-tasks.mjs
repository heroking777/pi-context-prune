// Phase45 — unfinished-task preservation, subject binding and the Phase 44 f4 shape.
import { DEFAULT_CONFIG, extractProtectedItems, verifyProtectedSummary, summarizeBatch, PROTECTION_FAILURE_MARKER, ok } from "./test-support.mjs";

const RAW = [
  `Tool: bash({"command":"cat /srv/repo-alpha/PLAN.md"})`,
  "Result (OK): UNFINISHED_TASK: apply migration to staging; NEXT_ACTION: verify rollback script",
  `Tool: bash({"command":"cat /srv/repo-alpha/ROLLBACK.md"})`,
  "Result (OK): ROLLBACK=restore /srv/backups/pre-migration.tar.gz if migration fails",
].join("\n");

// 1. The Phase 44 over-capture bug: a task value must stop at ';'.
const items = extractProtectedItems(RAW);
const taskItem = items.find((item) => item.category === "task");
const nextItem = items.find((item) => item.category === "next");
ok("task value stops at the separator", taskItem?.value === "apply migration to staging", taskItem?.value);
ok("next action is extracted separately", nextItem?.value === "verify rollback script", nextItem?.value);

// 2. A summary that splits task and next action (the Phase 44 shape) passes.
const splitSummary = [
  "- /srv/repo-alpha/PLAN.md -> UNFINISHED_TASK: apply migration to staging",
  "  NEXT_ACTION: verify rollback script",
  "- /srv/repo-alpha/ROLLBACK.md -> ROLLBACK=restore /srv/backups/pre-migration.tar.gz if migration fails",
].join("\n");
ok("a split task/next summary passes", verifyProtectedSummary(RAW, splitSummary).ok === true);

// 3. Omission and semantic substitution are rejected.
ok("dropping the unfinished task is rejected",
  verifyProtectedSummary(RAW, splitSummary.replace(/.*UNFINISHED_TASK.*\n/, "")).ok === false);
ok("paraphrasing the task is rejected",
  verifyProtectedSummary(RAW, splitSummary.replace("apply migration to staging", "apply the migration soon")).ok === false);

// 4. Task subject binding: the PLAN.md subject must stay next to the task.
ok("a task without its subject nearby is rejected",
  verifyProtectedSummary(RAW, "- UNFINISHED_TASK: apply migration to staging\n- NEXT_ACTION: verify rollback script").ok === false &&
  verifyProtectedSummary(RAW, "- UNFINISHED_TASK: apply migration to staging\n- NEXT_ACTION: verify rollback script").unboundTasks.length > 0);
ok("a task moved under a different subject is rejected",
  verifyProtectedSummary(RAW, "- /srv/other/OTHER.md -> UNFINISHED_TASK: apply migration to staging\n- NEXT_ACTION: verify rollback script").ok === false);

// 5. Multiple unfinished tasks: every one is required.
const multiRaw = [
  `Tool: bash({"command":"cat /srv/a/PLAN.md"})`,
  "Result (OK): UNFINISHED_TASK: rotate staging credentials",
  `Tool: bash({"command":"cat /srv/b/PLAN.md"})`,
  "Result (OK): UNFINISHED_TASK: backfill historical envelopes",
].join("\n");
const multiOk = [
  "- /srv/a/PLAN.md -> UNFINISHED_TASK: rotate staging credentials",
  "- /srv/b/PLAN.md -> UNFINISHED_TASK: backfill historical envelopes",
].join("\n");
ok("both unfinished tasks are required", verifyProtectedSummary(multiRaw, multiOk).ok === true &&
  verifyProtectedSummary(multiRaw, "- /srv/a/PLAN.md -> UNFINISHED_TASK: rotate staging credentials").ok === false);
ok("an unrelated task cannot substitute for a missing one",
  verifyProtectedSummary(multiRaw, multiOk.replace("backfill historical envelopes", "rotate staging credentials")).ok === false);

// 6. Task/status mismatch for the same subject is rejected.
const statusRaw = [
  `Tool: bash({"command":"run /srv/a/gate"})`,
  "Result (ERROR): /srv/a/gate: FAIL; UNFINISHED_TASK: fix gate threshold",
].join("\n");
ok("a task with a mismatched status subject is rejected",
  verifyProtectedSummary(statusRaw, "- /srv/a/gate: PASS\n- UNFINISHED_TASK: fix gate threshold").ok === false);

// 7. Rollback text and condition are required verbatim.
ok("rollback text is required", verifyProtectedSummary(RAW, splitSummary.replace("restore /srv/backups/pre-migration.tar.gz if migration fails", "restore the backup")).ok === false);

// 8. Regression: the Phase 44 protected response shape still passes end-to-end.
function ctx(text) {
  const provider = { stream() {
    const r = { stopReason: "stop", content: [{ type: "text", text }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 }, timestamp: Date.now() };
    return Object.assign((async function* () { yield { type: "text_end", partial: r }; })(), { result: async () => r });
  } };
  return { model: { provider: "f", id: "m" }, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {}, env: {} }), getProvider: () => provider, find: () => undefined }, ui: { notify: () => {} }, sessionManager: { getSessionId: () => "task-regression" } };
}
const batch = { turnIndex: 1, timestamp: 1, toolCalls: [{ toolName: "bash", toolCallId: "t1", args: {}, isError: false, resultText: RAW }] };
const cfg = { ...DEFAULT_CONFIG, protectedSummaryCompression: true };
const result = await summarizeBatch(batch, cfg, ctx(splitSummary));
ok("summarizeBatch accepts the split-task summary", result && result[PROTECTION_FAILURE_MARKER] !== true && typeof result.summaryText === "string");
const rejected = await summarizeBatch(batch, cfg, ctx("- nothing useful"));
ok("summarizeBatch rejects a task-less summary", rejected && rejected[PROTECTION_FAILURE_MARKER] === true);
