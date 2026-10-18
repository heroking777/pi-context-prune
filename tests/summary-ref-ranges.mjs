// Default-path ref footer compression: tA-tB ranges, lossless and expandable.
import {
  ToolCallIndexer, registerQueryTool, formatSummaryToolCallRefs, formatRefRanges, ok,
} from "./test-support.mjs";

const refs = (n) => Array.from({ length: n }, (_, i) => ({ shortId: `t${i + 1}`, toolCallId: `tc-${i}` }));

// 1. Range formatting.
ok("consecutive refs collapse into one range", formatRefRanges(refs(5)) === "`t1-t5`");
const gapped = [refs(3)[0], refs(3)[1], { shortId: "t9", toolCallId: "x" }];
ok("gaps split into separate ranges", formatRefRanges(gapped) === "`t1-t2`, `t9`");
ok("non-numeric refs fall back to a plain list",
  formatRefRanges([{ shortId: "abc", toolCallId: "a" }, { shortId: "t2", toolCallId: "b" }]) === "`abc`, `t2`");

// 2. Footer is materially smaller and still names both tools.
const many = formatSummaryToolCallRefs(refs(30));
ok("a 30-ref footer uses a range", many.includes("`t1-t30`"));
ok("the footer still mentions both retrieval tools", many.includes("context_tree_query") && many.includes("context_index_search"));
ok("the footer is much smaller than a plain list", many.length < 160, String(many.length));

// 3. Ranges expand to individual refs.
const indexer = new ToolCallIndexer();
indexer.addBatch({ turnIndex: 0, timestamp: 0, toolCalls: Array.from({ length: 6 }, (_, i) => ({ toolName: "bash", toolCallId: `tc-${i}`, args: {}, resultText: `payload-${i}`, isError: false })) }, { appendEntry: () => {} });
indexer.registerSummaryRefs(refs(6));
ok("a range expands to every member", JSON.stringify(indexer.expandRef("t2-t5")) === JSON.stringify(["t2", "t3", "t4", "t5"]));
ok("a single ref is unchanged", JSON.stringify(indexer.expandRef("t3")) === JSON.stringify(["t3"]));
ok("a malformed or oversized range is left alone", indexer.expandRef("t5-t2")[0] === "t5-t2" && indexer.expandRef("t1-t999")[0] === "t1-t999");

// 4. The query tool resolves a range end-to-end.
const pi = { registerTool: (tool) => pi.tool = tool };
registerQueryTool(pi, indexer);
const result = await pi.tool.execute("c", { toolCallIds: ["t4-t5"] }, undefined, undefined, {});
const text = result.content.map((part) => part.text).join("\n");
ok("context_tree_query accepts a range and returns each record",
  text.includes("payload-3") && text.includes("payload-4") && !text.includes("payload-5") && !text.includes("not found"));
