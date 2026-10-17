import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG, MetadataObserver, measureSummary, withFlushObservation,
  withPendingBatchMetrics, instrumentExtensionAPI, isFloorSkippedBatch,
  recordBatchOutcome, runWithFlushReason,
  RATE_LIMITED_MARKER, shouldMidTaskAutoPrune, summarizeBatch, makeCtx, state, ok,
} from "./test-support.mjs";

const config = { ...DEFAULT_CONFIG, pruneOn: "agent-message", midTaskAutoPrune: true };
const privateValues = ["RAW_TOOL_PRIVATE", "PROMPT_PRIVATE", "SUMMARY_PRIVATE", "API_KEY_PRIVATE", "COOKIE_PRIVATE"];
function batch(id, text = privateValues[0]) {
  return { turnIndex: 1, timestamp: 10, toolCalls: [{ toolName: "bash", toolCallId: id, resultText: `${text} ${privateValues[4]}`, args: { command: privateValues[1] } }] };
}
const tempDirs = [];
function temp(name) {
  const path = mkdtempSync(join(tmpdir(), `pruner-${name}-`));
  tempDirs.push(path);
  return path;
}
function records(dir) {
  return readdirSync(dir).filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) => readFileSync(join(dir, name), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse));
}
function recorder(directory, options = {}) {
  return new MetadataObserver({ enabled: true, directory, loadedBuildIdentity: "b".repeat(64), ...options });
}
function result(text = privateValues[2]) {
  return { summaryText: text, usage: { input: 12, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 19 } };
}

const offDir = join(temp("off-parent"), "not-created");
const off = new MetadataObserver({ enabled: false, directory: offDir });
const same = result();
const offResult = await measureSummary(batch("call-secret-off"), config, async () => same, off);
ok("OFF preserves result and performs no write", offResult === same && !existsSync(offDir));

const dir = temp("metadata");
const observer = recorder(dir);
const one = batch("call-secret-one", privateValues[0]);
const two = batch("call-secret-two", "second raw result");
const observedResult = await withFlushObservation("message_end", config, () =>
  withPendingBatchMetrics([one, two], () => measureSummary(one, config, async () => same, observer)), observer);
const firstRecord = records(dir)[0];
ok("threshold predicate stays unchanged", shouldMidTaskAutoPrune({ ...config, midTaskThresholdChars: 1 }, [one]));
ok("ON preserves summary result", observedResult === same);
const offProvider = makeCtx({ text: "same-summary" });
const onProvider = makeCtx({ text: "same-summary" });
const offSummary = await withFlushObservation("message_end", config, () => summarizeBatch(one, config, offProvider.ctx), off);
const onSummary = await withFlushObservation("message_end", config, () => summarizeBatch(one, config, onProvider.ctx), observer);
ok("real summarizer wrapper is behavior-equivalent OFF/ON", JSON.stringify(offSummary) === JSON.stringify(onSummary) && onProvider.calls.notify.length === offProvider.calls.notify.length);
ok("records schema, settings hash, build ID, event reason", firstRecord.schemaVersion === 1 && firstRecord.loadedBuildIdentity === "b".repeat(64) && /^[a-f0-9]{64}$/.test(firstRecord.effectiveConfigHash) && firstRecord.flushReason === "message_end");
ok("batch and pending metrics are exact", firstRecord.pendingCallCount === 2 && firstRecord.pendingRawCharCount === one.toolCalls[0].resultText.length + two.toolCalls[0].resultText.length && firstRecord.batchMembershipCount === 1 && firstRecord.pendingScope === "flush");
ok("summary usage and latency are recorded", firstRecord.summaryApiUsage.inputTokens === 12 && firstRecord.summaryApiUsage.outputTokens === 4 && firstRecord.summaryApiUsage.reasoningTokens === null && firstRecord.summaryApiUsage.cacheReadTokens === 2 && firstRecord.summaryApiUsage.cacheWriteTokens === 1 && firstRecord.summaryLatencyMs >= 0);
ok("raw IDs and private text are absent", !privateValues.some((value) => JSON.stringify(firstRecord).includes(value)) && !JSON.stringify(firstRecord).includes("call-secret-one"));
ok("call refs are fixed-length pseudonyms", /^[a-f0-9]{20}$/.test(firstRecord.firstCallRef) && firstRecord.firstCallRef === firstRecord.lastCallRef);

const beforePredicate = records(dir).length;
withFlushObservation("threshold", config, () => {
  assert.equal(isFloorSkippedBatch(batch("floor-private", "tiny"), 100), true);
  assert.equal(isFloorSkippedBatch(batch("floor-private", "tiny"), 100), true);
}, observer);
ok("floor predicate is pure and records nothing", records(dir).length === beforePredicate);

// Regression test for the Phase 22 double-record defect: the flush loop evaluates
// the floor predicate twice per batch (filter + results map). Observation moved
// to the single commit site, so one batch yields exactly one commit record.
const floorOnceDir = temp("floor-once");
const floorOnceObserver = recorder(floorOnceDir);
const floorBatch = batch("floor-mixed", "tiny");
await withFlushObservation("threshold", config, () => {
  isFloorSkippedBatch(floorBatch, 100);
  isFloorSkippedBatch(floorBatch, 100);
  recordBatchOutcome(floorBatch, "skipped-size-floor", { indexPersisted: true, threshold: 100 });
}, floorOnceObserver);
const floorRecords = records(floorOnceDir);
ok("double predicate check yields exactly one floor commit record", floorRecords.length === 1 && floorRecords[0].event === "batch_outcome" && floorRecords[0].outcome === "skipped-size-floor" && floorRecords[0].indexPersisted === true && floorRecords[0].summaryApiUsage.inputTokens === null);

const combinedDir = temp("mixed-flush");
const combinedObserver = recorder(combinedDir);
await withFlushObservation("threshold", config, () => {
  recordBatchOutcome(floorBatch, "skipped-size-floor", { indexPersisted: true, threshold: 100 });
  return withPendingBatchMetrics([one], () => measureSummary(one, config, async () => same, combinedObserver));
}, combinedObserver);
const combinedSummary = records(combinedDir).at(-1);
ok("flush pending totals include floor-only and API batches", combinedSummary.event === "summary_api" && combinedSummary.pendingCallCount === 2 && combinedSummary.pendingRawCharCount === floorBatch.toolCalls[0].resultText.length + one.toolCalls[0].resultText.length && combinedSummary.pendingScope === "flush");

await withFlushObservation("threshold", config, () => measureSummary(one, config, async () => null, observer), observer);
const cooldown = { [RATE_LIMITED_MARKER]: true, error: privateValues[3] };
await withFlushObservation("threshold", config, () => measureSummary(one, config, async () => cooldown, observer), observer);
const failureRecords = records(dir).slice(-2);
ok("summary failure and cooldown are classified without error text", failureRecords[0].event === "summary_api" && failureRecords[0].outcome === "failed" && failureRecords[1].event === "summary_api" && failureRecords[1].outcome === "rate-limited" && !JSON.stringify(failureRecords).includes(privateValues[3]));

const apiRecords = temp("api");
const apiObserver = recorder(apiRecords);
const handlers = new Map();
const commands = new Map();
const tools = new Map();
const fakeApi = {
  on(name, handler) { handlers.set(name, handler); },
  registerCommand(name, options) { commands.set(name, options); },
  registerTool(tool) { tools.set(tool.name, tool); },
  identity() { return this === fakeApi; },
};
const observedApi = instrumentExtensionAPI(fakeApi, () => config, import.meta.url, apiObserver);
observedApi.on("turn_end", () => runWithFlushReason("every_turn", () => measureSummary(one, config, async () => same)));
observedApi.on("message_end", () => runWithFlushReason("message_end", () => measureSummary(one, config, async () => same)));
observedApi.on("session_tree", () => measureSummary(one, config, async () => same));
observedApi.registerCommand("pruner", { handler: () => measureSummary(one, config, async () => same) });
observedApi.registerTool({ name: "context_prune", execute: () => measureSummary(one, config, async () => same) });
assert.equal(observedApi.identity(), true);
await handlers.get("turn_end")({}, {});
await handlers.get("message_end")({}, {});
await commands.get("pruner").handler();
await tools.get("context_prune").execute();
const apiLog = records(apiRecords);
ok("only explicitly evaluated flush reasons are recorded", apiLog.map((entry) => entry.flushReason).join(",") === "every_turn,message_end,manual_command,context_prune_tool");
ok("callbacks produce one unique ordered record each", apiLog.length === 4 && apiLog.map((entry) => entry.sequence).join(",") === "1,2,3,4" && new Set(apiLog.map((entry) => entry.eventId)).size === 4 && apiLog.every((entry) => /^[0-9a-f-]{36}$/.test(entry.eventId)));
ok("loaded artifact identity is resolved", /^[a-f0-9]{64}$/.test(apiLog[0].loadedBuildIdentity));

const thrownObserver = recorder(temp("throw"));
const thrown = new Error(privateValues[3]);
let preservedError = false;
try {
  await measureSummary(one, config, async () => { throw thrown; }, thrownObserver);
} catch (error) { preservedError = error === thrown; }
ok("observer preserves summary exceptions", preservedError && records(thrownObserver["directory"])[0].outcome === "failed");
ok("error messages and summary text are never stored", !JSON.stringify(records(dir)).includes(privateValues[2]) && !JSON.stringify(records(thrownObserver["directory"])).includes(privateValues[3]));

const capDir = temp("cap");
const capped = recorder(capDir, { maxBytes: 1 });
await measureSummary(one, config, async () => same, capped);
ok("size cap drops telemetry without failing work", records(capDir).length === 0);

const retentionDir = temp("retention");
const now = Date.parse("2026-01-20T12:00:00.000Z");
const expired = join(retentionDir, "pruner-2026-01-01.jsonl");
writeFileSync(expired, "old metadata\n");
const retained = recorder(retentionDir, { now: () => now });
await measureSummary(one, config, async () => same, retained);
ok("retention removes only expired owned log files", !existsSync(expired) && records(retentionDir).length === 1);

const blocker = join(temp("write-failure"), "file-not-directory");
writeFileSync(blocker, "blocked");
const failingObserver = recorder(blocker);
const afterWriteFailure = await measureSummary(one, config, async () => same, failingObserver);
ok("log write failure is non-fatal", afterWriteFailure === same);

await handlers.get("session_tree")({}, {});
const boundaryRecord = records(apiRecords).at(-1);
ok("unproven event reasons are recorded as unknown, not guessed", boundaryRecord.flushReason === "unknown" && boundaryRecord.sequence === 5);

for (const path of tempDirs) {
  try { rmSync(path, { recursive: true, force: true }); } catch { /* isolated test temp only */ }
}
console.log("  INFO observability tests use fake summary operations; no provider/network calls");
