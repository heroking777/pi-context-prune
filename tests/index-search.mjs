// Phase 26 — explicit index search discoverability.
import assert from "node:assert/strict";
import {
  ToolCallIndexer, registerIndexSearchTool, registerQueryTool, formatSummaryToolCallRefs,
  CUSTOM_TYPE_INDEX, CUSTOM_TYPE_SUMMARY, ok,
} from "./test-support.mjs";

const SECRET = "API_KEY_PRIVATE_DO_NOT_LEAK";
function floorBatch(prefix, resultText, args = { command: "run" }) {
  return {
    turnIndex: 7,
    timestamp: 1000,
    toolCalls: [{ toolName: "bash", toolCallId: `${prefix}-0`, resultText, args, isError: false }],
  };
}
function fakePi() {
  const tools = new Map();
  return {
    tools,
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: () => {}, registerMessageRenderer: () => {}, on: () => {},
    getActiveTools: () => [], setActiveTools: () => {}, appendEntry: () => {}, sendMessage: () => {},
  };
}
async function call(tool, params) { return tool.execute("call", params, undefined, undefined, {}); }
const textOf = (result) => result.content.map((part) => part.text).join("\n");

const indexer = new ToolCallIndexer();
indexer.addBatch(floorBatch("floor", `ROLLBACK=restore release from snapshot ${SECRET}`, { command: "deploy rollback --sha 4d449861" }), fakePi());

// 1. Find information without any short ref.
const found = indexer.searchRecords("rollback");
ok("search finds a size-floor record by keyword in output text", found.matchCount === 1 && found.records[0].toolCallId === "floor-0");
ok("search also matches arguments and tool name", indexer.searchRecords("deploy rollback --sha").matchCount === 1 && indexer.searchRecords("bash").matchCount === 1);
ok("search returns nothing for absent content", indexer.searchRecords("no-such-token-anywhere").matchCount === 0);

// 2. Retrieval reuses the existing ref/id resolver.
indexer.addBatch({ turnIndex: 1, timestamp: 5, toolCalls: [{ toolName: "read", toolCallId: "ref-0", resultText: "regular summarized output", args: {}, isError: false }] }, fakePi());
indexer.registerSummaryRefs([{ shortId: "t1", toolCallId: "ref-0" }]);
const pi = fakePi();
registerIndexSearchTool(pi, indexer);
registerQueryTool(pi, indexer);
const searchOut = textOf(await call(pi.tools.get("context_index_search"), { query: "rollback" }));
ok("explicit tool returns the id needed for retrieval", searchOut.includes("floor-0") && searchOut.includes("ref: (none)"));
const retrieve = await call(pi.tools.get("context_tree_query"), { toolCallIds: ["floor-0"] });
ok("raw output is retrievable with the discovered id", textOf(retrieve).includes("ROLLBACK=restore release from snapshot"));

// 3. Search output stays metadata-only.
ok("search output never contains raw output text or secrets", !searchOut.includes(SECRET) && !searchOut.includes("ROLLBACK=restore release"));
ok("search output reports a bounded identifier view", /ref: .* \| id: .* \| tool: .* \| turn: .* \| status: .* \| bytes: \d+/.test(searchOut));

// 4. No fabrication.
const missOut = textOf(await call(pi.tools.get("context_index_search"), { query: "definitely-absent" }));
ok("no-match search reports zero and fabricates nothing", missOut.includes("No indexed tool output matches") && !missOut.includes("floor-0") && !missOut.includes("ref-0"));
ok("unknown ids are reported as not found, not invented", textOf(await call(pi.tools.get("context_tree_query"), { toolCallIds: ["ghost-id"] })).includes("not found in index"));

// 5. errorsOnly and limit.
indexer.addBatch({ turnIndex: 2, timestamp: 6, toolCalls: [
  { toolName: "bash", toolCallId: "err-0", resultText: "IntegrityError boom", args: {}, isError: true },
  { toolName: "bash", toolCallId: "ok-1", resultText: "IntegrityError resolved", args: {}, isError: false },
] }, fakePi());
const errors = indexer.searchRecords("IntegrityError", { errorsOnly: true });
ok("errorsOnly filters to failed calls", errors.matchCount === 1 && errors.records[0].toolCallId === "err-0");
const limited = indexer.searchRecords("IntegrityError", { limit: 1 });
ok("limit caps returned records but not the reported count", limited.records.length === 1 && limited.matchCount === 2);

// 6. Discoverability survives a compaction-style reconstruction.
const branch = [
  { type: "custom", customType: CUSTOM_TYPE_INDEX, data: { toolCalls: [
    { toolCallId: "floor-0", toolName: "bash", args: {}, resultText: "ROLLBACK=restore release from snapshot", isError: false, turnIndex: 7, timestamp: 1000 },
  ] } },
  { type: "custom_message", customType: CUSTOM_TYPE_SUMMARY, details: { toolCallRefs: [{ shortId: "t9", toolCallId: "rebuilt-0" }] } },
  { type: "custom", customType: CUSTOM_TYPE_INDEX, data: { toolCalls: [
    { toolCallId: "rebuilt-0", toolName: "read", args: {}, resultText: "post-compaction payload", isError: false, turnIndex: 9, timestamp: 2000 },
  ] } },
];
const rebuilt = new ToolCallIndexer();
rebuilt.reconstructFromSession({ sessionManager: { getBranch: () => branch } });
ok("search path exists after compaction reconstruction", rebuilt.searchRecords("post-compaction payload").matchCount === 1);
ok("summary refs survive reconstruction for reference lookup", rebuilt.getShortId("rebuilt-0") === "t9" && rebuilt.getRecord("t9")?.toolCallId === "rebuilt-0");
const rebuiltPi = fakePi();
registerIndexSearchTool(rebuiltPi, rebuilt);
ok("search tool still resolves after reconstruction", textOf(await call(rebuiltPi.tools.get("context_index_search"), { query: "restore release" })).includes("floor-0"));

// 7. Constant-size summary footer guide (bounded per-summary cost).
const withRefs = formatSummaryToolCallRefs([{ shortId: "t1", toolCallId: "ref-0" }]);
const withoutRefs = formatSummaryToolCallRefs([]);
ok("summary footer points at the search tool with bounded cost", withRefs.includes("context_index_search") && withoutRefs.includes("context_index_search"));
ok("footer stays small", withRefs.length < 260 && withoutRefs.length < 120, `${withRefs.length}/${withoutRefs.length}`);

// 8. Phase 25 information categories: floor-indexed (no ref) and summarized.
const CATEGORIES = {
  sha: "FINAL_SHA=4d449861d9803ad5aa9f45b569e6d83c912f1e40",
  path: "/home/deploy/hr-p0/jra/src/heroking_jra/pit/integrity.py",
  error: "IntegrityError: envelope_hash mismatch at row 42",
  decision: "DECISION=KEEP_RAW_TOOL_OUTPUT_UNTIL_FRONTIER_ADVANCES",
  task: "UNFINISHED_TASK: resume Phase 18 SHA context tracing",
  rollback: "ROLLBACK=restore /opt/heroking/releases/jra-da015ff from snapshot",
};
const catIndexer = new ToolCallIndexer();
// floor batch: indexed but never given a summary ref.
catIndexer.addBatch({ turnIndex: 3, timestamp: 1, toolCalls: [
  { toolName: "bash", toolCallId: "floor-sha", resultText: CATEGORIES.sha, args: {}, isError: false },
  { toolName: "bash", toolCallId: "floor-rb", resultText: CATEGORIES.rollback, args: {}, isError: false },
] }, fakePi());
// summarized batch: has refs.
catIndexer.addBatch({ turnIndex: 4, timestamp: 2, toolCalls: [
  { toolName: "read", toolCallId: "sum-path", resultText: CATEGORIES.path, args: {}, isError: false },
  { toolName: "bash", toolCallId: "sum-err", resultText: CATEGORIES.error, args: {}, isError: true },
  { toolName: "bash", toolCallId: "sum-dec", resultText: CATEGORIES.decision, args: {}, isError: false },
  { toolName: "bash", toolCallId: "sum-task", resultText: CATEGORIES.task, args: {}, isError: false },
] }, fakePi());
catIndexer.registerSummaryRefs([
  { shortId: "t1", toolCallId: "sum-path" }, { shortId: "t2", toolCallId: "sum-err" },
  { shortId: "t3", toolCallId: "sum-dec" }, { shortId: "t4", toolCallId: "sum-task" },
]);
const catPi = fakePi();
registerIndexSearchTool(catPi, catIndexer);
registerQueryTool(catPi, catIndexer);
const catTool = catPi.tools.get("context_index_search");
const catQuery = catPi.tools.get("context_tree_query");
const KEYWORDS = { sha: "FINAL_SHA", path: "integrity.py", error: "IntegrityError", decision: "DECISION", task: "UNFINISHED_TASK", rollback: "ROLLBACK" };
for (const [name, value] of Object.entries(CATEGORIES)) {
  const keyword = KEYWORDS[name];
  const res = await call(catTool, { query: keyword });
  const text = textOf(res);
  const ids = res.details.refs.map((ref) => ref.id);
  const hitIndexed = catIndexer.searchRecords(keyword).matchCount > 0;
  const discovered = hitIndexed && ids.length > 0 && !text.includes(value);
  ok(`category ${name}: discoverable by keyword without a ref`, discovered, text.slice(0, 80));
  const target = ids[0];
  const raw = textOf(await call(catQuery, { toolCallIds: [target] }));
  ok(`category ${name}: original output retrievable`, target ? raw.includes(value) : false);
}
ok("floor-batch ids are discoverable even though no ref was ever published", catIndexer.getShortId("floor-sha") === undefined && (await call(catTool, { query: "FINAL_SHA" })).details.refs[0].id === "floor-sha");

// 9. Registered tool surface.
assert.ok(pi.tools.has("context_index_search"));
ok("index search tool is registered with a prompt snippet", pi.tools.get("context_index_search").promptSnippet.length > 0);
console.log("  INFO index search tests use an in-memory index; no provider or network call");
