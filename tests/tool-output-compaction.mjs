import {
  CUSTOM_TYPE_INDEX,
  ToolCallIndexer,
  compactToolOutput,
  ok,
  registerQueryTool,
  registerToolOutputCompaction,
} from "./test-support.mjs";

const event = (toolName, command, text, isError = false) => ({
  toolName,
  toolCallId: "call-raw-1",
  input: { command },
  content: [{ type: "text", text }],
  isError,
  details: undefined,
});
const testsLog = [
  ...Array.from({ length: 100 }, (_, i) => `ok ${i + 1} - suite case ${i + 1}`),
  "# tests 100",
  "# pass 100",
  "# fail 0",
].join("\n");
const testEvent = event("bash", "npm test", testsLog);
const compactedTests = compactToolOutput(testEvent);
ok("successful test logs compact only with explicit zero-failure summary",
  compactedTests?.kind === "test" && compactedTests.text.includes("# pass 100") && !compactedTests.text.includes("suite case 1"));
ok("test fixture reports measured character savings",
  !!compactedTests && compactedTests.removedChars === testsLog.length - compactedTests.text.length,
  compactedTests ? `${testsLog.length}->${compactedTests.text.length}` : "not compacted");
ok("failed test results are returned unchanged",
  compactToolOutput(event("bash", "npm test", testsLog, true)) === null);
ok("unrecognized test output fails open to raw",
  compactToolOutput(event("bash", "npm test", `${testsLog}\nWarning: custom runner metadata`)) === null);
ok("test output containing file paths or full SHAs fails open to raw",
  compactToolOutput(event("bash", "npm test", `${testsLog}\nPASS src/critical.test.ts`)) === null &&
  compactToolOutput(event("bash", "npm test", `${testsLog}\nPASS ${"a".repeat(40)}`)) === null);

const buildLog = Array.from({ length: 80 }, (_, i) => `Compiling crate-${i} v1.0.0`).join("\n") + "\nBuild succeeded";
const compactedBuild = compactToolOutput(event("bash", "cargo build", buildLog));
ok("build progress compresses while final status remains", !!compactedBuild && compactedBuild.kind === "build" && compactedBuild.text.includes("Build succeeded"));
ok("build paths and source-bearing progress lines are preserved",
  compactToolOutput(event("bash", "cargo build", `Compiling crate /work/src/main.rs\n${"x".repeat(1200)}`)) === null);
const criticalBuild = compactToolOutput(event("bash", "cargo build", `${buildLog}\nwarning: keep this diagnostic`));
ok("build warnings and errors are never removed as progress",
  !!criticalBuild && criticalBuild.text.includes("warning: keep this diagnostic"));
const lintLog = Array.from({ length: 80 }, (_, i) => `Linting module-${i}`).join("\n");
const compactedLint = compactToolOutput(event("bash", "npm run lint", lintLog));
ok("successful lint progress is compacted while warnings stay visible",
  !!compactedLint && compactedLint.kind === "lint" && compactedLint.text.includes("routine lint-progress lines omitted") &&
  compactToolOutput(event("bash", "npm run lint", `${lintLog}\nwarning: keep lint warning`))?.text.includes("warning: keep lint warning"));

const repeatedSearch = Array.from({ length: 80 }, () => "src/example.ts:12: matching source text").join("\n");
const compactedSearch = compactToolOutput(event("bash", "rg matching", repeatedSearch));
ok("duplicate search lines retain their count and content",
  !!compactedSearch && compactedSearch.kind === "search" && compactedSearch.text.includes("matching source text [repeated 80 times]"));
ok("search recognition handles a leading directory change",
  compactToolOutput(event("bash", "cd /work && rg matching", repeatedSearch))?.kind === "search");
const groupedHits = Array.from({ length: 60 }, (_, i) => `src/long-module-name.ts:${i + 1}: const value${i} = "source body ${i}";`).join("\n");
const groupedOutput = compactToolOutput(event("bash", "rg value src/long-module-name.ts", groupedHits));
ok("search path grouping retains every line number and source body",
  !!groupedOutput && groupedOutput.text.includes("src/long-module-name.ts:\n  1: const value0") &&
  Array.from({ length: 60 }, (_, i) => groupedOutput.text.includes(`source body ${i}`)).every(Boolean));
const interleavedHits = `src/a.ts:1: ${"alpha".repeat(80)}\nsrc/b.ts:2: ${"beta".repeat(80)}\nsrc/a.ts:3: ${"gamma".repeat(80)}`;
ok("interleaved search paths fail open without reordering output",
  compactToolOutput(event("bash", "rg alpha", interleavedHits)) === null);
ok("oversized single lines bypass compaction for safe raw paging",
  compactToolOutput(event("bash", "rg repeated", `${"x".repeat(60_000)}\n${"x".repeat(60_000)}`)) === null);
ok("source reads, git evidence, and arbitrary output remain unchanged",
  compactToolOutput(event("read", "", "x".repeat(1400))) === null &&
  compactToolOutput(event("bash", "git rev-parse HEAD", "a".repeat(1400))) === null &&
  compactToolOutput(event("bash", "npm test", "x".repeat(1400))) === null);

const indexer = new ToolCallIndexer();
let handler;
const persisted = [];
const pi = {
  on: (name, callback) => { if (name === "tool_result") handler = callback; },
  appendEntry: (type, data) => persisted.push({ type, data }),
};
registerToolOutputCompaction(pi, indexer, () => true);
const ctx = { sessionManager: { getBranch: () => [{ type: "message", message: { role: "assistant" } }] } };
const result = await handler(testEvent, ctx);
const rawRecord = indexer.getRecord("call-raw-1");
ok("raw result is persisted and returned with a queryable reference",
  persisted.length === 1 && persisted[0].type === CUSTOM_TYPE_INDEX &&
  result.content[0].text.includes("Raw output ref: s-") && rawRecord?.resultText === testsLog);
ok("compacted records remain visible until actually summarized",
  !!rawRecord && !indexer.isSummarized("call-raw-1"));
const restoredIndexer = new ToolCallIndexer();
restoredIndexer.reconstructFromSession({ sessionManager: { getBranch: () => persisted.map((entry) => ({ type: "custom", customType: entry.type, data: entry.data })) } });
ok("raw output survives index reconstruction without becoming prunable",
  restoredIndexer.getRecord("call-raw-1")?.resultText === testsLog && !restoredIndexer.isSummarized("call-raw-1"));
const queryApi = { registerTool: (tool) => { queryApi.tool = tool; } };
registerQueryTool(queryApi, restoredIndexer);
const ref = /Raw output ref: (s-[a-f0-9]+)/.exec(result.content[0].text)?.[1];
const restored = await queryApi.tool.execute("query", { toolCallIds: [ref] }, undefined, undefined, {});
ok("context_tree_query restores the complete original output after reconstruction", restored.content[0].text.includes(testsLog));
const pagedRaw = Array.from({ length: 450 }, (_, i) => `line-${i + 1}: ${"payload".repeat(20)}`).join("\n");
restoredIndexer.indexPersistedRecord({ toolCallId: "large-raw", toolName: "bash", args: {}, resultText: pagedRaw, isError: false, turnIndex: 2, timestamp: 2 });
const pageRef = restoredIndexer.getSearchRef("large-raw");
const firstPage = await queryApi.tool.execute("query", { toolCallIds: [pageRef], lineLimit: 200 }, undefined, undefined, {});
const secondPage = await queryApi.tool.execute("query", { toolCallIds: [pageRef], startLine: 201, lineLimit: 200 }, undefined, undefined, {});
const lastPage = await queryApi.tool.execute("query", { toolCallIds: [pageRef], startLine: 401, lineLimit: 200 }, undefined, undefined, {});
ok("large raw output can be restored across bounded line pages",
  firstPage.content[0].text.includes("line-1:") && firstPage.content[0].text.includes("startLine=201") &&
  secondPage.content[0].text.includes("line-201:") && secondPage.content[0].text.includes("startLine=401") &&
  lastPage.content[0].text.includes("line-450:") && !lastPage.content[0].text.includes("next page"));
indexer.registerSummaryRefs([{ shortId: "t1", toolCallId: "call-raw-1" }]);
ok("raw-only records remain unpruned until the summary index replaces them", !indexer.isSummarized("call-raw-1"));
indexer.addBatch({ toolCalls: [{ toolCallId: "call-raw-1", toolName: "bash", args: {}, resultText: testsLog, isError: false }], turnIndex: 1, timestamp: 1 }, pi);
ok("normal summary indexing restores pruning behavior", indexer.isSummarized("call-raw-1"));

const beforeDisabled = persisted.length;
registerToolOutputCompaction({ on: (_name, callback) => { handler = callback; }, appendEntry: () => {} }, new ToolCallIndexer(), () => false);
await handler(testEvent, ctx);
ok("disabled extension leaves output untouched", persisted.length === beforeDisabled);
