// Phase 26 — explicit index search discoverability.
import assert from "node:assert/strict";
import {
  ToolCallIndexer, registerIndexSearchTool, registerQueryTool, formatSummaryToolCallRefs,
  MAX_SEARCH_QUERY_CHARS, sanitizeSearchLimit, validateSearchQuery, deriveSearchRef,
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
const searchRef = (await call(pi.tools.get("context_index_search"), { query: "rollback" })).details.refs[0].ref;
ok("search returns a safe ref and no raw toolCallId", /^s-[0-9a-f]{16}$/.test(searchRef) && !searchOut.includes("floor-0"));
const retrieve = await call(pi.tools.get("context_tree_query"), { toolCallIds: [searchRef] });
ok("raw output is retrievable with the discovered search ref", textOf(retrieve).includes("ROLLBACK=restore release from snapshot"));
ok("exact retrieval by the raw id still works for compatibility", textOf(await call(pi.tools.get("context_tree_query"), { toolCallIds: ["floor-0"] })).includes("ROLLBACK=restore release from snapshot"));

// 3. Search output stays metadata-only.
ok("search output never contains raw output text or secrets", !searchOut.includes(SECRET) && !searchOut.includes("ROLLBACK=restore release"));
ok("search output reports a bounded ref view without any id field", /ref: .* \| tool: .* \| turn: .* \| status: .* \| bytes: \d+/.test(searchOut) && !searchOut.includes("id:"));

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
registerQueryTool(rebuiltPi, rebuilt);
const rebuiltSearch = await call(rebuiltPi.tools.get("context_index_search"), { query: "restore release" });
const rebuiltRef = rebuiltSearch.details.refs[0].ref;
ok("search tool still resolves after reconstruction without exposing ids", !textOf(rebuiltSearch).includes("floor-0") && /^s-[0-9a-f]{16}$/.test(rebuiltRef));
ok("reconstructed search ref retrieves the exact record", textOf(await call(rebuiltPi.tools.get("context_tree_query"), { toolCallIds: [rebuiltRef] })).includes("ROLLBACK=restore release from snapshot"));
ok("search ref is stable across reconstruction", deriveSearchRef("floor-0") === rebuiltRef);

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
  const refs = res.details.refs.map((ref) => ref.ref);
  const hitIndexed = catIndexer.searchRecords(keyword).matchCount > 0;
  const discovered = hitIndexed && refs.length > 0 && !text.includes(value);
  ok(`category ${name}: discoverable by keyword without a ref`, discovered, text.slice(0, 80));
  const target = refs[0];
  const raw = textOf(await call(catQuery, { toolCallIds: [target] }));
  ok(`category ${name}: original output retrievable`, target ? raw.includes(value) : false);
}
ok("floor-batch refs are discoverable even though no summary ref was ever published", catIndexer.getShortId("floor-sha") === undefined && /^s-[0-9a-f]{16}$/.test((await call(catTool, { query: "FINAL_SHA" })).details.refs[0].ref));
ok("summarized records reuse their existing t<n> summary ref", (await call(catTool, { query: "IntegrityError" })).details.refs[0].ref === "t2");

// 8b. Phase 28 input hardening: empty, oversized and hostile limits.
ok("empty and whitespace queries are rejected", !validateSearchQuery("").ok && validateSearchQuery("   ").ok === false);
ok("empty query never matches all", indexer.searchRecords("").matchCount === 0 && indexer.searchRecords("   ").matchCount === 0);
ok("query length is bounded", !validateSearchQuery("x".repeat(MAX_SEARCH_QUERY_CHARS + 1)).ok && validateSearchQuery("x".repeat(MAX_SEARCH_QUERY_CHARS)).ok === true);
ok("limit is coerced into 1..20", sanitizeSearchLimit(undefined) === 5 && sanitizeSearchLimit(Number.NaN) === 5 && sanitizeSearchLimit(Number.POSITIVE_INFINITY) === 5 && sanitizeSearchLimit(-7) === 1 && sanitizeSearchLimit(0) === 1 && sanitizeSearchLimit(3.7) === 3 && sanitizeSearchLimit(1e9) === 20);
ok("non-numeric limits fall back to the default 5", sanitizeSearchLimit("5") === 5 && sanitizeSearchLimit("7") === 5 && sanitizeSearchLimit("99") === 5 && sanitizeSearchLimit({}) === 5 && sanitizeSearchLimit(null) === 5 && sanitizeSearchLimit(true) === 5 && sanitizeSearchLimit([]) === 5 && sanitizeSearchLimit(undefined) === 5);
const hostileLimits = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -5, 0, 2.9, 1e9];
let hostileOk = true;
for (const value of hostileLimits) {
  const outcome = indexer.searchRecords("IntegrityError", { limit: value });
  if (!Array.isArray(outcome.records) || outcome.records.length > 20) hostileOk = false;
}
ok("hostile limits never throw or return unbounded results", hostileOk);
const emptyToolOut = await call(pi.tools.get("context_index_search"), { query: "   " });
ok("tool reports an empty-query error clearly", textOf(emptyToolOut).includes("error") && emptyToolOut.details.error === "empty" && emptyToolOut.details.refs.length === 0);
const longToolOut = await call(pi.tools.get("context_index_search"), { query: "y".repeat(MAX_SEARCH_QUERY_CHARS + 50) });
ok("tool reports an oversized-query error clearly", longToolOut.details.error === "too-long" && longToolOut.details.matchCount === 0 && textOf(longToolOut).includes("too long"));
const nanLimitOut = await call(pi.tools.get("context_index_search"), { query: "IntegrityError", limit: Number.NaN });
ok("tool survives a NaN limit", Array.isArray(nanLimitOut.details.refs) && nanLimitOut.details.refs.length <= 20);

// 8c. Phase 29 safe refs: raw ids never appear, retrieval stays exact.
const SPECIAL_IDS = {
  normal: "tc-normal-1",
  long: `tc-${'L'.repeat(5000)}`,
  special: "tc|bad\nid` {\"json\":true}",
  secretId: `tc-${SECRET}-id`,
};
const idIndexer = new ToolCallIndexer();
const idCalls = Object.values(SPECIAL_IDS).map((id) => ({ toolName: "bash", toolCallId: id, resultText: `payload-of-${id.length}-chars`, args: {}, isError: false }));
idIndexer.addBatch({ turnIndex: 1, timestamp: 1, toolCalls: idCalls }, fakePi());
const idPi = fakePi();
registerIndexSearchTool(idPi, idIndexer);
registerQueryTool(idPi, idIndexer);
const idSearchOut = await call(idPi.tools.get("context_index_search"), { query: "payload-of", limit: 20 });
const idSearchText = textOf(idSearchOut);
const idRefs = idSearchOut.details.refs.map((entry) => entry.ref);
ok("search returns one bounded safe ref per hostile id", idRefs.length === 4 && idRefs.every((ref) => /^s-[0-9a-f]{16}$/.test(ref)) && new Set(idRefs).size === 4);
ok("no raw toolCallId appears in search content", Object.values(SPECIAL_IDS).every((id) => !idSearchText.includes(id)));
ok("no raw toolCallId appears in search details", !JSON.stringify(idSearchOut.details).includes(SECRET) && !JSON.stringify(idSearchOut.details).includes("payload-of-"));
ok("search content has no id field and a bounded ref length", !idSearchText.includes("id:") && idSearchText.split("\n").filter((line) => line.startsWith("- ref:")).every((line) => line.length < 200));
for (const [kind, id] of Object.entries(SPECIAL_IDS)) {
  const ref = idRefs.find((candidate) => idIndexer.getRecord(candidate)?.toolCallId === id);
  ok(`each ${kind} id maps to its own ref`, typeof ref === "string");
  const retrieved = textOf(await call(idPi.tools.get("context_tree_query"), { toolCallIds: [ref] }));
  ok(`retrieval stays exact for ${kind} id via its ref`, retrieved.includes(`payload-of-${id.length}-chars`));
}
ok("raw result text is never echoed by search even for hostile ids", !idSearchText.includes("payload-of-"));
ok("secret embedded in an id is not serialized anywhere in search output", !JSON.stringify([idSearchText, idSearchOut.details]).includes(SECRET));
ok("direct retrieval by raw hostile id still works", textOf(await call(idPi.tools.get("context_tree_query"), { toolCallIds: [SPECIAL_IDS.secretId] })).includes(`payload-of-${SPECIAL_IDS.secretId.length}-chars`));

// 8d. Hash collision must fail closed, never resolve to a guessed record.
class CollidingIndexer extends ToolCallIndexer {
  deriveSearchRefFor() { return "s-0000000000000000"; }
}
const collisionIndexer = new CollidingIndexer();
collisionIndexer.addBatch({ turnIndex: 1, timestamp: 1, toolCalls: [
  { toolName: "bash", toolCallId: "coll-a", resultText: "collision payload alpha", args: {}, isError: false },
  { toolName: "bash", toolCallId: "coll-b", resultText: "collision payload beta", args: {}, isError: false },
] }, fakePi());
ok("colliding ref is not published for either record", collisionIndexer.getSearchRef("coll-a") === undefined && collisionIndexer.getSearchRef("coll-b") === undefined);
ok("colliding ref fails closed on resolve", collisionIndexer.resolveToolCallId("s-0000000000000000") === undefined && collisionIndexer.getRecord("s-0000000000000000") === undefined);
ok("raw ids still resolve under collision", collisionIndexer.getRecord("coll-a")?.resultText === "collision payload alpha" && collisionIndexer.getRecord("coll-b")?.resultText === "collision payload beta");
const collisionPi = fakePi();
registerIndexSearchTool(collisionPi, collisionIndexer);
registerQueryTool(collisionPi, collisionIndexer);
const collisionOut = await call(collisionPi.tools.get("context_index_search"), { query: "collision payload" });
ok("colliding search results expose no ref and no id", collisionOut.details.refs.every((entry) => entry.ref === null) && !textOf(collisionOut).includes("coll-a") && !textOf(collisionOut).includes("coll-b"));
ok("unresolvable colliding ref is reported not found", textOf(await call(collisionPi.tools.get("context_tree_query"), { toolCallIds: ["s-0000000000000000"] })).includes("not found"));

// 8e. Ref derivation: unique, bounded and stable.
const many = new Set();
for (let i = 0; i < 50000; i++) many.add(deriveSearchRef(`bulk-${i}`));
ok("50k derived refs are unique and bounded", many.size === 50000 && [...many].every((ref) => ref.length === 18));
ok("derivation is deterministic and does not embed the id", deriveSearchRef("abc") === deriveSearchRef("abc") && !deriveSearchRef("abc").includes("abc"));
ok("summary refs and search refs cannot share a namespace", deriveSearchRef("x").startsWith("s-") && /^t\d+$/.test("t7"));

// 8f. Records persisted directly (session-delivery path) must also be resolvable.
const persisted = new ToolCallIndexer();
persisted.indexPersistedRecord({ toolCallId: "persisted-0", toolName: "bash", args: {}, resultText: "persisted payload", isError: false, turnIndex: 1, timestamp: 1 });
const persistedRef = persisted.getSearchRef("persisted-0");
ok("directly persisted records are resolvable by their search ref", /^s-[0-9a-f]{16}$/.test(persistedRef) && persisted.getRecord(persistedRef)?.resultText === "persisted payload");

// 9. Registered tool surface.
assert.ok(pi.tools.has("context_index_search"));
ok("index search tool is registered with a prompt snippet", pi.tools.get("context_index_search").promptSnippet.length > 0);
console.log("  INFO index search tests use an in-memory index; no provider or network call");
