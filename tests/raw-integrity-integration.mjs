import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { truncateTail, DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { ExtensionRunner } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js";
import { OutputAccumulator } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/output-accumulator.js";
import { ToolCallIndexer, ok, registerQueryTool, registerToolOutputCompaction } from "./test-support.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const ctx = { sessionManager: { getBranch: () => [] } };

// Mirrors the existing external extension's text budget, tail truncation, and error exemption.
function fixtureMinimize(event) {
  if (event.isError || process.env.PI_TOOLRESULT_MINIMIZE === "0") return undefined;
  const budgets = { grep: 4096, find: 4096, ls: 4096 };
  const budget = budgets[event.toolName] ?? 6144;
  let target = -1;
  for (let i = 0; i < event.content.length; i++) {
    const block = event.content[i];
    if (block.type === "text" && (target < 0 || Buffer.byteLength(block.text) > Buffer.byteLength(event.content[target].text))) target = i;
  }
  if (target < 0 || Buffer.byteLength(event.content[target].text) <= budget) return undefined;
  const shortened = truncateTail(event.content[target].text, { maxBytes: budget - 400, maxLines: Number.MAX_SAFE_INTEGER });
  const content = event.content.map((block, index) => index === target
    ? { ...block, text: `${shortened.content}\n\n[toolresult-minimize] truncated ${event.toolName}` }
    : block);
  return { content };
}

async function loadMinimizer() {
  const source = process.env.PI_TOOLRESULT_MINIMIZE_SOURCE;
  if (!source) return fixtureMinimize;
  const output = join(dirname(fileURLToPath(import.meta.url)), ".test-work", "actual-toolresult-minimize.mjs");
  await build({ entryPoints: [source], bundle: true, platform: "node", format: "esm", external: ["@earendil-works/pi-coding-agent"], outfile: output });
  const module = await import(pathToFileURL(output).href);
  let handler;
  module.default({ on: (name, callback) => { if (name === "tool_result") handler = callback; } });
  if (!handler) throw new Error("external toolresult-minimize registered no tool_result hook");
  console.log("INFO integration runner uses the supplied toolresult-minimize source");
  return handler;
}

const minimize = await loadMinimizer();

function makePruner(indexer, persisted) {
  let handler;
  registerToolOutputCompaction({
    on: (name, callback) => { if (name === "tool_result") handler = callback; },
    appendEntry: (customType, data) => persisted.push({ type: "custom", customType, data }),
  }, indexer, () => true);
  return handler;
}

async function runHooks(order, event, indexer = new ToolCallIndexer(), downstreamObserver = () => {}) {
  const persisted = [];
  const pruner = makePruner(indexer, persisted);
  const observer = (result) => { downstreamObserver(result); };
  const handlers = order === "pruner-minimizer"
    ? [["pruner", pruner], ["toolresult-minimize", minimize], ["downstream-observer", observer]]
    : [["toolresult-minimize", minimize], ["pruner", pruner], ["downstream-observer", observer]];
  const runner = Object.create(ExtensionRunner.prototype);
  runner.extensions = handlers.map(([path, handler]) => ({ path, handlers: new Map([["tool_result", [handler]]]) }));
  runner.createContext = () => ctx;
  runner.emitError = (error) => { throw new Error(String(error.error)); };
  const result = await runner.emitToolResult(event) ?? event;
  return { result, indexer, persisted };
}

function event(id, text, details, isError = false, command = "python -c fixture") {
  return { type: "tool_result", toolName: "bash", toolCallId: id, input: { command },
    content: [{ type: "text", text }], details, isError };
}

async function coreSnapshot(text, maxBytes, maxLines) {
  const accumulator = new OutputAccumulator({ maxBytes, maxLines, tempFilePrefix: "pi-pruner-integration" });
  accumulator.append(Buffer.from(text));
  accumulator.finish();
  const snapshot = accumulator.snapshot({ persistIfTruncated: true });
  await accumulator.closeTempFile();
  return snapshot;
}

async function queryBytes(indexer, id) {
  let query;
  registerQueryTool({ registerTool: (tool) => { query = tool; } }, indexer);
  const chunks = [];
  let startByte = 0;
  for (let page = 0; page < 100; page++) {
    const result = await query.execute("integration-query", {
      toolCallIds: [indexer.getSearchRef(id)], startByte, lineLimit: 200,
    });
    const text = result.content[0].text;
    const bodyStart = text.indexOf("\n\n");
    let body = text.slice(bodyStart + 2);
    const marker = /\n\[Raw page: bytes (\d+)-(\d+) of (\d+); continue with startByte=(\d+), startLine=(\d+)\.\]$/.exec(body);
    if (marker) body = body.slice(0, marker.index);
    const bytes = Buffer.from(body, "utf8");
    if (bytes.length > DEFAULT_MAX_BYTES) throw new Error("query page exceeded byte cap");
    chunks.push(bytes);
    if (!marker) return Buffer.concat(chunks);
    const next = Number(marker[4]);
    if (next <= startByte || next > Number(marker[3]) || bytes.length === 0) throw new Error("query cursor failed to advance");
    startByte = next;
  }
  throw new Error("query did not terminate");
}

const small = "s".repeat(6144);
const atBudget = await runHooks("pruner-minimizer", event("budget-exact", small));
ok("6 KiB boundary is not needlessly captured or shortened", !atBudget.indexer.getRecord("budget-exact") && atBudget.result.content[0].text === small);

const markers = "FAILURE_STATE=failed\nWARNING=preserve-this\nSHA256=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\nPATH=/srv/builds/release-42\n";
const medium = markers + "ordinary output ".repeat(700);
const mediumSnapshot = await coreSnapshot(medium, 50 * 1024, 2000);
assert.equal(mediumSnapshot.fullOutputPath, undefined);
const mediumEvent = event("medium-b", medium);
const mediumB = await runHooks("pruner-minimizer", mediumEvent);
const mediumRecord = mediumB.indexer.getRecord("medium-b");
const mediumRestored = await queryBytes(mediumB.indexer, "medium-b");
ok("Pruner→minimizer persists 6–50 KiB original before downstream shortening", sha(mediumRestored) === sha(medium) && mediumRecord?.__contextPruneRawSha256 === sha(medium));
ok("failure, warning, SHA and path survive in verified Raw", ["FAILURE_STATE=failed", "WARNING=preserve-this", "SHA256=", "PATH=/srv/builds/release-42"].every((needle) => mediumRestored.toString().includes(needle)));
ok("Pruner→minimizer marks recoverable bytes in the shortened tool result", mediumB.result.content[0].text.includes("[Raw output ref:") && mediumB.result.content[0].text.includes("[toolresult-minimize] truncated"));

const mediumA = await runHooks("minimizer-pruner", event("medium-a", medium));
ok("minimize→Pruner detects unavailable pre-minimized Raw and fails closed", !mediumA.indexer.getRecord("medium-a") && mediumA.result.content[0].text.includes("Raw unavailable") && !mediumA.result.content[0].text.includes("[Raw output ref:"));

const big = `${markers}${"wide-output-line\n".repeat(5000)}`;
const bigExpected = Buffer.from(big);
for (const order of ["pruner-minimizer", "minimizer-pruner"]) {
  const bigSnapshot = await coreSnapshot(big, 50 * 1024, 2000);
  assert.ok(bigSnapshot.fullOutputPath && bigSnapshot.truncation.truncated);
  const id = `core-path-${order}`;
  const details = { truncation: bigSnapshot.truncation, fullOutputPath: bigSnapshot.fullOutputPath };
  const input = event(id, `${bigSnapshot.content}\n[Full output: ${bigSnapshot.fullOutputPath}]`, details);
  let downstream;
  const sentinel = { consumer: "later-extension" };
  details.downstreamSentinel = sentinel;
  const integrated = await runHooks(order, input, new ToolCallIndexer(), (result) => {
    const path = result.details?.fullOutputPath;
    downstream = typeof path === "string" && existsSync(path)
      ? { path, sha256: sha(readFileSync(path)), sentinel: result.details.downstreamSentinel }
      : { path, missing: true };
  });
  const restored = await queryBytes(integrated.indexer, id);
  ok(`${order} uses verified core fullOutputPath as complete Raw`, sha(restored) === sha(bigExpected) && integrated.indexer.getRecord(id)?.__contextPruneRawByteLength === bigExpected.length);
  ok(`${order} preserves Pi-owned source and downstream details`, existsSync(bigSnapshot.fullOutputPath) && integrated.result.details?.fullOutputPath === bigSnapshot.fullOutputPath && downstream?.path === bigSnapshot.fullOutputPath && downstream?.sha256 === sha(bigExpected) && JSON.stringify(downstream?.sentinel) === JSON.stringify(sentinel), `resultPath=${integrated.result.details?.fullOutputPath}; downstream=${JSON.stringify(downstream)}; keys=${Object.keys(integrated.result.details ?? {}).join(",")}`);
  const rawRecords = integrated.persisted.flatMap((entry) => entry.data?.toolCalls ?? []).filter((record) => record.toolCallId === id);
  const rawBackings = rawRecords.filter((record) => record.__contextPruneRawOnly && record.resultText.length > 0);
  const rawSessionBytes = rawBackings.reduce((total, record) => total + Buffer.byteLength(record.resultText, "utf8"), 0);
  const retainedPiFileBytes = statSync(bigSnapshot.fullOutputPath).size;
  const serializedSessionBytes = Buffer.byteLength(JSON.stringify(integrated.persisted), "utf8");
  ok(`${order} persists one verified Raw backing without duplicate session output`, rawBackings.length === 1 && rawSessionBytes === bigExpected.length && rawRecords.length === 1);
  console.log(`INFO raw-storage order=${order} sessionRawBytes=${rawSessionBytes} retainedPiFileBytes=${retainedPiFileBytes} serializedSessionEntryBytes=${serializedSessionBytes} recordCount=${rawRecords.length}`);
  rmSync(bigSnapshot.fullOutputPath, { force: true });
  const rebuilt = new ToolCallIndexer();
  rebuilt.reconstructFromSession({ sessionManager: { getBranch: () => integrated.persisted.map((entry) => ({ type: "custom", customType: entry.customType, data: entry.data })) } });
  ok(`${order} retrieves session-authoritative Raw after test-owned source cleanup`, !existsSync(bigSnapshot.fullOutputPath) && sha(await queryBytes(rebuilt, id)) === sha(bigExpected));
}

const lineHeavy = `${"line\n".repeat(2001)}`;
const lineSnapshot = await coreSnapshot(lineHeavy, 50 * 1024, 2000);
assert.ok(lineSnapshot.fullOutputPath && lineSnapshot.truncation.truncated);
const lineIntegrated = await runHooks("pruner-minimizer", event("line-limit-core", lineSnapshot.content,
  { truncation: lineSnapshot.truncation, fullOutputPath: lineSnapshot.fullOutputPath }));
ok("2,001-line Pi core truncation is restored byte-exactly", sha(await queryBytes(lineIntegrated.indexer, "line-limit-core")) === sha(lineHeavy));

const missingPath = join(tmpdir(), `pruner-missing-${process.pid}.log`);
const missing = await runHooks("pruner-minimizer", event("missing-file", "clipped output",
  { fullOutputPath: missingPath, truncation: { truncated: true, totalBytes: 100 } }));
ok("missing fullOutputPath creates no Raw record and fails closed", !missing.indexer.getRecord("missing-file") && missing.result.content[0].text.includes("Raw unavailable"));

const badDir = mkdtempSync(join(tmpdir(), "pruner-bad-sha-"));
const badPath = join(badDir, "output.log");
writeFileSync(badPath, "source bytes");
const badSha = await runHooks("pruner-minimizer", event("bad-sha", "clipped output",
  { fullOutputPath: badPath, truncation: { truncated: true, totalBytes: 12, sha256: "0".repeat(64) } }));
ok("SHA mismatch is rejected without deleting the source", !badSha.indexer.getRecord("bad-sha") && existsSync(badPath) && badSha.result.content[0].text.includes("Raw unavailable"));
rmSync(badDir, { recursive: true, force: true });

const badSizeDir = mkdtempSync(join(tmpdir(), "pruner-bad-size-"));
const badSizePath = join(badSizeDir, "output.log");
writeFileSync(badSizePath, "source bytes");
const badSize = await runHooks("pruner-minimizer", event("bad-size", "clipped output",
  { fullOutputPath: badSizePath, truncation: { truncated: true, totalBytes: 99 } }));
ok("byte-count mismatch is rejected without a completeness claim", !badSize.indexer.getRecord("bad-size") && badSize.result.content[0].text.includes("Raw unavailable"));
rmSync(badSizeDir, { recursive: true, force: true });

const errorText = `ERROR=command-failed\n${"diagnostic\n".repeat(1000)}`;
const plainError = await runHooks("pruner-minimizer", event("small-error", errorText, undefined, true));
ok("ordinary error output remains unchanged and is not minimized", plainError.result.isError && plainError.result.content[0].text === errorText && !plainError.indexer.getRecord("small-error"));
const errorCore = await coreSnapshot(errorText, 1024, 2000);
const largeError = await runHooks("pruner-minimizer", event("large-error", errorCore.content,
  { truncation: errorCore.truncation, fullOutputPath: errorCore.fullOutputPath }, true));
ok("core-truncated error is recoverable from verified Raw", largeError.result.isError && sha(await queryBytes(largeError.indexer, "large-error")) === sha(errorText));

const quotaIndexer = new ToolCallIndexer();
for (let i = 0; i < 512; i++) quotaIndexer.indexPersistedRecord({
  toolCallId: `quota-${i}`, toolName: "bash", args: {}, resultText: "",
  isError: false, turnIndex: 0, timestamp: 0, __contextPruneRawOnly: true,
  __contextPruneRawSha256: "a".repeat(64), __contextPruneRawByteLength: 0,
});
const quota = await runHooks("pruner-minimizer", event("quota-hit", "q".repeat(10_000)), quotaIndexer);
ok("Raw-only record quota is bounded and reports downstream limitation", !quota.indexer.getRecord("quota-hit") && quota.result.content[0].text.includes("raw-session-record-limit"));
const byteQuotaIndexer = new ToolCallIndexer();
byteQuotaIndexer.indexPersistedRecord({
  toolCallId: "byte-quota-existing", toolName: "bash", args: {}, resultText: "",
  isError: false, turnIndex: 0, timestamp: 0, __contextPruneRawOnly: true,
  __contextPruneRawSha256: "b".repeat(64), __contextPruneRawByteLength: 64 * 1024 * 1024,
});
const byteQuota = await runHooks("pruner-minimizer", event("byte-quota-hit", "q".repeat(10_000)), byteQuotaIndexer);
ok("64 MiB session Raw-byte quota fails closed without adding a record", !byteQuota.indexer.getRecord("byte-quota-hit") && byteQuota.result.content[0].text.includes("raw-session-byte-limit"));

const storedId = "medium-b";
const summaryIndexer = mediumB.indexer;
const summaryEntries = mediumB.persisted;
const sessionBytesBeforeSummary = Buffer.byteLength(JSON.stringify(summaryEntries), "utf8");
summaryIndexer.addBatch({ toolCalls: [{ toolCallId: storedId, toolName: "bash", args: {}, resultText: "shortened by later minimizer", isError: false }], turnIndex: 2, timestamp: 2 }, {
  appendEntry: (customType, data) => summaryEntries.push({ type: "custom", customType, data }),
});
const summaryUpdate = summaryEntries.at(-1).data.toolCalls[0];
const persistedRawRecords = summaryEntries.flatMap((entry) => entry.data?.toolCalls ?? []).filter((record) => record.toolCallId === storedId);
const fullRawRecords = persistedRawRecords.filter((record) => record.__contextPruneRawOnly && record.resultText.length > 0);
const sessionBytesAfterSummary = Buffer.byteLength(JSON.stringify(summaryEntries), "utf8");
ok("summary indexing retains one full session Raw and stores only a metadata update", summaryIndexer.getRecord(storedId)?.resultText === medium && summaryUpdate.resultText === "" && summaryIndexer.isSummarized(storedId) && fullRawRecords.length === 1 && persistedRawRecords.length === 2);
console.log(`INFO raw-storage-after-summary rawBytes=${Buffer.byteLength(fullRawRecords[0]?.resultText ?? "", "utf8")} sessionBytesBefore=${sessionBytesBeforeSummary} sessionBytesAfter=${sessionBytesAfterSummary} metadataGrowth=${sessionBytesAfterSummary - sessionBytesBeforeSummary}`);
const rebuiltIndexer = new ToolCallIndexer();
rebuiltIndexer.reconstructFromSession({ sessionManager: { getBranch: () => summaryEntries.map((entry) => ({ type: "custom", customType: entry.customType, data: entry.data })) } });
ok("session reconstruction merges summary metadata and restores the original SHA-verified Raw", rebuiltIndexer.getRecord(storedId)?.resultText === medium && rebuiltIndexer.isSummarized(storedId) && sha(await queryBytes(rebuiltIndexer, storedId)) === sha(medium));

if (lineSnapshot.fullOutputPath && existsSync(lineSnapshot.fullOutputPath)) rmSync(lineSnapshot.fullOutputPath, { force: true });
if (errorCore.fullOutputPath && existsSync(errorCore.fullOutputPath)) rmSync(errorCore.fullOutputPath, { force: true });
