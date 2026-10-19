import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ToolCallIndexer, ok, registerQueryTool, registerToolOutputCompaction, CUSTOM_TYPE_INDEX } from "./test-support.mjs";

const raw = "anonymized T02r Raw fixture; no captured page content is stored here.\n";
const bytes = Buffer.from(raw, "utf8");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const toolCallId = "t02s-anonymized-page-01";
const rawRecord = {
  toolCallId,
  toolName: "read",
  args: { path: "/fixture/fixture-page-01.txt" },
  resultText: raw,
  isError: false,
  turnIndex: 1,
  timestamp: 1,
  __contextPruneRawOnly: true,
  __contextPruneRawSha256: sha256,
  __contextPruneRawByteLength: bytes.length,
};
const laterIndexRecord = {
  toolCallId,
  toolName: "read",
  args: { path: "/fixture/fixture-page-01.txt" },
  resultText: `${raw}\n[Raw output ref: anonymized-ref; SHA-256 ${sha256}; ${bytes.length} bytes]`,
  isError: false,
  turnIndex: 0,
  timestamp: 2,
};
const entries = [rawRecord, laterIndexRecord].map((record) => ({
  type: "custom",
  customType: CUSTOM_TYPE_INDEX,
  data: { toolCalls: [record] },
}));
const indexer = new ToolCallIndexer();
indexer.reconstructFromSession({ sessionManager: { getBranch: () => entries } });
const api = { registerTool(tool) { this.query = tool; } };
registerQueryTool(api, indexer);
const ref = indexer.getSearchRef(toolCallId);
const result = await api.query.execute("offline-test", { toolCallIds: [ref] });
const record = result.details.results[ref];
const expectedHeader = `Raw: SHA-256 ${sha256}; ${bytes.length} bytes`;
ok("later session record retains the earlier verified Raw bytes and integrity metadata",
  record?.toolCallId === toolCallId && record.resultText === raw &&
  record.__contextPruneRawSha256 === sha256 && record.__contextPruneRawByteLength === bytes.length &&
  record.__contextPruneRawOnly !== true && record.turnIndex === 0 && indexer.isSummarized(toolCallId));
ok("Raw query metadata, status, args, and result bytes remain consistent",
  record?.toolName === "read" && record.args.path.endsWith("fixture-page-01.txt") &&
  record.isError === false && result.content[0].text.includes("Status: OK") &&
  result.content[0].text.includes(expectedHeader) && result.content[0].text.endsWith(raw));

record.__contextPruneRawSha256 = "0".repeat(64);
const corrupt = await api.query.execute("offline-test", { toolCallIds: [ref] });
ok("tampered Raw metadata fails closed without returning the Raw body",
  corrupt.content[0].text.includes("Raw integrity validation failed") &&
  !corrupt.content[0].text.includes(raw));

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
