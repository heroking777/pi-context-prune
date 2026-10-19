import { createHash } from "node:crypto";
import { ToolCallIndexer, ok, registerQueryTool, registerToolOutputCompaction, CUSTOM_TYPE_INDEX } from "./test-support.mjs";

const raw = "anonymized T02r Raw fixture; no captured page content is stored here.\n";
const secondRaw = "independent anonymized Raw fixture page.\n";
const toolCallId = "t02s-anonymized-page-01";
const secondToolCallId = "t02s-anonymized-page-02";
const sha256 = (text) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
const rawRecord = (id, text, page) => ({
  toolCallId: id,
  toolName: "read",
  args: { path: `/fixture/fixture-page-${page}.txt` },
  resultText: text,
  isError: false,
  turnIndex: 1,
  timestamp: 1,
  __contextPruneRawOnly: true,
  __contextPruneRawSha256: sha256(text),
  __contextPruneRawByteLength: Buffer.byteLength(text, "utf8"),
});
const normalRecord = (source, timestamp, changes = {}) => ({
  toolCallId: source.toolCallId,
  toolName: source.toolName,
  args: source.args,
  resultText: `${source.resultText}\n[Raw output ref: anonymized-ref; SHA-256 ${source.__contextPruneRawSha256}; ${source.__contextPruneRawByteLength} bytes]`,
  isError: source.isError,
  turnIndex: 0,
  timestamp,
  ...changes,
});
const entry = (record) => ({ type: "custom", customType: CUSTOM_TYPE_INDEX, data: { toolCalls: [record] } });
const makeIndexer = (records) => {
  const indexer = new ToolCallIndexer();
  indexer.reconstructFromSession({ sessionManager: { getBranch: () => records.map(entry) } });
  const api = { registerTool(tool) { this.query = tool; } };
  registerQueryTool(api, indexer);
  return { indexer, query: api.query };
};
const queryById = async (query, indexer, id) => {
  const ref = indexer.getSearchRef(id);
  return { ref, response: await query.execute("offline-test", { toolCallIds: [ref] }) };
};
const failsClosed = (response, text) => response.content[0].text.includes("Raw integrity validation failed") &&
  !response.content[0].text.includes(text);

const firstRaw = rawRecord(toolCallId, raw, "01");
const sequentialRecords = [
  firstRaw,
  normalRecord(firstRaw, 2),
  normalRecord(firstRaw, 3),
  normalRecord(firstRaw, 4),
];
let repeatedIndex;
let repeatedQuery;
let repeatedRef;
for (let count = 2; count <= sequentialRecords.length; count++) {
  const { indexer, query } = makeIndexer(sequentialRecords.slice(0, count));
  const { ref, response } = await queryById(query, indexer, toolCallId);
  const result = response.details.results[ref];
  const stagePass = result?.toolCallId === toolCallId && result.resultText === raw &&
    result.__contextPruneRawSha256 === firstRaw.__contextPruneRawSha256 &&
    result.__contextPruneRawByteLength === Buffer.byteLength(raw, "utf8") &&
    result.__contextPruneRawOnly !== true && indexer.isSummarized(toolCallId) &&
    response.content[0].text.endsWith(raw);
  ok(`Raw bytes/metadata/ref remain valid after ${count - 1} normal index update(s)`, stagePass);
  repeatedIndex = indexer;
  repeatedQuery = query;
  repeatedRef = ref;
}

for (let count = 2; count <= sequentialRecords.length; count++) {
  const { indexer, query } = makeIndexer(sequentialRecords.slice(0, count));
  const { ref, response } = await queryById(query, indexer, toolCallId);
  const result = response.details.results[ref];
  ok(`repeated session reconstruction ${count - 1} preserves verified Raw integrity`,
    result?.resultText === raw && result.__contextPruneRawSha256 === firstRaw.__contextPruneRawSha256 &&
    result.__contextPruneRawByteLength === Buffer.byteLength(raw, "utf8") && indexer.isSummarized(toolCallId));
}

const finalRecord = repeatedIndex.getRecord(toolCallId);
const savedHash = finalRecord.__contextPruneRawSha256;
const savedLength = finalRecord.__contextPruneRawByteLength;
finalRecord.__contextPruneRawSha256 = "0".repeat(64);
let bad = await repeatedQuery.execute("offline-test", { toolCallIds: [repeatedRef] });
ok("tampered Raw SHA fails closed without returning the body", failsClosed(bad, raw));
finalRecord.__contextPruneRawSha256 = savedHash;
finalRecord.__contextPruneRawByteLength = savedLength + 1;
bad = await repeatedQuery.execute("offline-test", { toolCallIds: [repeatedRef] });
ok("tampered Raw byteLength fails closed without returning the body", failsClosed(bad, raw));
finalRecord.__contextPruneRawByteLength = savedLength;
finalRecord.resultText += "body-tamper";
bad = await repeatedQuery.execute("offline-test", { toolCallIds: [repeatedRef] });
ok("tampered Raw body fails closed without returning content", failsClosed(bad, raw));

const conflictCases = [
  { name: "conflicting SHA", changes: { __contextPruneRawSha256: "f".repeat(64), __contextPruneRawByteLength: Buffer.byteLength(raw, "utf8") } },
  { name: "conflicting byteLength", changes: { __contextPruneRawSha256: firstRaw.__contextPruneRawSha256, __contextPruneRawByteLength: Buffer.byteLength(raw, "utf8") + 1 } },
];
for (const test of conflictCases) {
  const { indexer, query } = makeIndexer([firstRaw, normalRecord(firstRaw, 2, test.changes)]);
  const { ref, response } = await queryById(query, indexer, toolCallId);
  ok(`${test.name} in a duplicate record fails closed`, failsClosed(response, raw));
}
const tamperedRaw = { ...firstRaw, resultText: `${raw}altered` };
const tamperedIndex = makeIndexer([tamperedRaw, normalRecord(firstRaw, 2)]);
const tamperedQuery = await queryById(tamperedIndex.query, tamperedIndex.indexer, toolCallId);
ok("unverified Raw-only body is never promoted by a later index record",
  failsClosed(tamperedQuery.response, raw));
const anomalousRawOnly = { ...firstRaw, resultText: `${raw}altered`, timestamp: 4 };
const anomalousIndex = makeIndexer([firstRaw, normalRecord(firstRaw, 2), anomalousRawOnly]);
const anomalousQuery = await queryById(anomalousIndex.query, anomalousIndex.indexer, toolCallId);
ok("anomalous later Raw-only record fails closed and remains unsummarized",
  failsClosed(anomalousQuery.response, raw) && !anomalousIndex.indexer.isSummarized(toolCallId));

const independent = rawRecord(secondToolCallId, secondRaw, "02");
const multi = makeIndexer([
  firstRaw, independent,
  normalRecord(firstRaw, 2), normalRecord(independent, 2),
  normalRecord(firstRaw, 3), normalRecord(independent, 3),
]);
for (const [id, expected] of [[toolCallId, raw], [secondToolCallId, secondRaw]]) {
  const { ref, response } = await queryById(multi.query, multi.indexer, id);
  const result = response.details.results[ref];
  ok(`distinct toolCallId ${id.endsWith("01") ? "01" : "02"} retains its own Raw ref and bytes`,
    result?.toolCallId === id && result.resultText === expected &&
    result.__contextPruneRawSha256 === sha256(expected) &&
    result.__contextPruneRawByteLength === Buffer.byteLength(expected, "utf8") &&
    multi.indexer.isSummarized(id));
}

const captureIndexer = new ToolCallIndexer();
let captureHandler;
registerToolOutputCompaction({
  on(name, callback) { if (name === "tool_result") captureHandler = callback; },
  appendEntry() {},
}, captureIndexer, () => true);
const testLog = [...Array.from({ length: 100 }, (_, i) => `ok ${i + 1} - suite case ${i + 1}`), "# tests 100", "# pass 100", "# fail 0"].join("\n");
await captureHandler({
  toolName: "bash", toolCallId: "t02s-turn-index", input: { command: "npm test" },
  content: [{ type: "text", text: testLog }], isError: false, details: undefined,
}, { sessionManager: { getBranch: () => [{ type: "message", message: { role: "assistant" } }] } });
ok("new Raw captures use the zero-based assistant turn index",
  captureIndexer.getRecord("t02s-turn-index")?.turnIndex === 0);
