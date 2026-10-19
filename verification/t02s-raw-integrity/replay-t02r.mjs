import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [sessionPath, fixtureDir, bundlePath, outputPath] = process.argv.slice(2);
if (![sessionPath, fixtureDir, bundlePath, outputPath].every(Boolean)) {
  throw new Error("usage: replay-t02r.mjs SESSION FIXTURES CANDIDATE_BUNDLE OUTPUT_JSON");
}
const must = (condition, message) => { if (!condition) throw new Error(message); };
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
process.env.PI_CONTEXT_PRUNE_OBSERVABILITY = "0";
const entries = readFileSync(sessionPath, "utf8").trim().split(/\r?\n/).map(JSON.parse);
const sessionId = entries.find((entry) => entry.type === "session")?.id;
must(sessionId, "T02r session id unavailable");
const tools = new Map();
const hooks = new Map();
const api = {
  on(name, handler) { hooks.set(name, handler); },
  registerTool(tool) { tools.set(tool.name, tool); },
  registerCommand() {}, registerWidget() {}, registerMessageRenderer() {}, registerFlag() {},
  getActiveTools() { return []; }, setActiveTools() {}, appendEntry() {},
};
const extension = await import(`${pathToFileURL(bundlePath).href}?t02s-replay`);
extension.default(api);
const context = {
  sessionManager: { getBranch: () => entries, getSessionId: () => sessionId, getLeafId: () => entries.at(-1)?.id },
  ui: { notify() {}, setWidget() {}, setStatus() {} },
};
await hooks.get("session_start")?.({ type: "startup" }, context);
const query = tools.get("context_tree_query");
must(query, "candidate did not register context_tree_query");

const readCalls = new Map();
const readResults = new Map();
const rawRecords = new Map();
const laterRecords = new Map();
const modelRefs = new Set();
const modelQueryResults = [];
for (const entry of entries) {
  const message = entry.message ?? {};
  for (const block of message.content ?? []) {
    if (block.type !== "toolCall") continue;
    const args = typeof block.arguments === "string" ? JSON.parse(block.arguments) : block.arguments ?? {};
    if (block.name === "read") readCalls.set(path.basename(String(args.path ?? "")), { id: block.id, args });
    if (block.name === "context_tree_query") for (const ref of args.toolCallIds ?? []) modelRefs.add(String(ref));
  }
  if (message.role === "toolResult" && message.toolName === "read") readResults.set(message.toolCallId, message);
  if (message.role === "toolResult" && message.toolName === "context_tree_query") modelQueryResults.push(message);
  if (entry.type !== "custom" || entry.customType !== "context-prune-index") continue;
  for (const record of entry.data?.toolCalls ?? []) {
    const file = path.basename(String(record.args?.path ?? ""));
    if (!file.startsWith("fixture-page-")) continue;
    (record.__contextPruneRawOnly === true ? rawRecords : laterRecords).set(file, record);
  }
}
const liveResultRecords = new Map();
for (const result of modelQueryResults) {
  for (const record of Object.values(result.details?.results ?? {})) {
    const file = path.basename(String(record.args?.path ?? ""));
    if (file.startsWith("fixture-page-")) liveResultRecords.set(file, record);
  }
}
const report = { pages: {}, realNetworkSends: 0, rawPayloadPrinted: false };
for (const file of ["fixture-page-01.txt", "fixture-page-02.txt"]) {
  const expected = readFileSync(path.join(fixtureDir, file));
  const expectedSha = hash(expected);
  const raw = rawRecords.get(file);
  const later = laterRecords.get(file);
  const call = readCalls.get(file);
  const originalResult = raw && readResults.get(raw.toolCallId);
  const details = originalResult?.details?.contextPruneRawIntegrity;
  const content = (originalResult?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
  const marker = content.match(/\[Raw output ref: ([^;\]]+); SHA-256 ([a-f0-9]{64}); (\d+) bytes/);
  must(raw && later && call && originalResult && details, `${file}: required saved evidence missing`);
  must(raw.toolCallId === call.id && later.toolCallId === call.id, `${file}: persisted toolCallId mismatch`);
  must(raw.__contextPruneRawSha256 === expectedSha && raw.__contextPruneRawByteLength === expected.length, `${file}: original Raw metadata mismatch`);
  must(details.rawSha256 === expectedSha && details.rawByteLength === expected.length, `${file}: tool-result Raw metadata mismatch`);
  must(marker && marker[1].trim() === details.rawRef && marker[2] === expectedSha && Number(marker[3]) === expected.length, `${file}: Raw reference marker mismatch`);
  must(JSON.stringify(raw.args) === JSON.stringify(call.args), `${file}: original Raw args mismatch`);
  must(originalResult.toolName === "read" && originalResult.isError === false, `${file}: original status mismatch`);

  const ref = details.rawRef;
  must(ref === `s-${hash(Buffer.from(String(call.id), "utf8")).slice(0, 16)}`, `${file}: short ref does not match its toolCallId`);
  const response = await query.execute(sessionId, { toolCallIds: [ref], lineLimit: 2000 }, undefined, undefined, context);
  const record = Object.values(response.details?.results ?? {}).find((item) => item.toolCallId === call.id);
  must(record, `${file}: saved Raw ref did not resolve`);
  const restored = Buffer.from(String(record.resultText ?? ""), "utf8");
  must(record.__contextPruneRawSha256 === expectedSha && record.__contextPruneRawByteLength === expected.length, `${file}: reconstructed Raw metadata mismatch`);
  must(restored.equals(expected) && hash(restored) === expectedSha, `${file}: reconstructed Raw bytes mismatch`);
  must(record.toolName === "read" && JSON.stringify(record.args) === JSON.stringify(call.args), `${file}: reconstructed call metadata mismatch`);
  must(record.isError === originalResult.isError, `${file}: reconstructed status mismatch`);
  must(record.turnIndex === later.turnIndex, `${file}: reconstructed turn index mismatch`);
  must(record.__contextPruneRawOnly !== true, `${file}: reconstructed summary state was not retained`);

  const responseText = response.content?.map((block) => block.text ?? "").join("\n") ?? "";
  must(responseText.includes(`Raw: SHA-256 ${expectedSha}; ${expected.length} bytes`), `${file}: details.results header mismatch`);
  const pageMarker = responseText.match(/\[Raw page: bytes (\d+)-(\d+) of (\d+); continue with startByte=(\d+), startLine=(\d+)\]/);
  const pageRange = pageMarker
    ? { startByte: Number(pageMarker[1]), endByte: Number(pageMarker[2]), totalBytes: Number(pageMarker[3]), nextByte: Number(pageMarker[4]) }
    : { startByte: 0, endByte: expected.length - 1, totalBytes: expected.length, nextByte: null };
  must(pageRange.totalBytes === expected.length && pageRange.startByte === 0, `${file}: page cursor mismatch`);

  const live = liveResultRecords.get(file);
  let liveDetailsResults = "NOT_AVAILABLE";
  if (live) {
    must(live.toolCallId === call.id && live.__contextPruneRawSha256 === expectedSha &&
      live.__contextPruneRawByteLength === expected.length && Buffer.from(String(live.resultText ?? ""), "utf8").equals(expected),
    `${file}: saved model context_tree_query details.results mismatch`);
    liveDetailsResults = "MATCH";
  }
  const badSha = record.__contextPruneRawSha256;
  record.__contextPruneRawSha256 = "0".repeat(64);
  const corrupt = await query.execute(sessionId, { toolCallIds: [ref] }, undefined, undefined, context);
  must(corrupt.content[0].text.includes("Raw integrity validation failed") && !corrupt.content[0].text.includes(String(record.resultText)), `${file}: tampered Raw was not rejected`);
  record.__contextPruneRawSha256 = badSha;

  report.pages[file] = {
    toolCallIdMatch: true,
    shortRefMatch: modelRefs.has(ref) || marker[1].trim() === ref,
    toolNameMatch: true,
    argsMatch: true,
    isError: false,
    status: "OK",
    rawOnlyTurnIndex: raw.turnIndex,
    laterIndexTurnIndex: later.turnIndex,
    reconstructedTurnIndex: record.turnIndex,
    liveQueryTurnIndex: live?.turnIndex ?? null,
    turnIndexMismatchInSavedDuplicate: raw.turnIndex !== later.turnIndex,
    rawSha256: expectedSha,
    rawSha256Match: true,
    rawByteLength: expected.length,
    rawByteLengthMatch: true,
    exactPageBytes: true,
    detailsResults: liveDetailsResults,
    pageRange,
    metadataTamperRejected: true,
  };
}
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
console.log(JSON.stringify(report));
