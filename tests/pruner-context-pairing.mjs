import { transformMessages } from "../node_modules/@earendil-works/pi-ai/dist/api/transform-messages.js";
import { ToolCallIndexer, pruneMessages, registerQueryTool, ok } from "./test-support.mjs";

const indexer = new ToolCallIndexer();
const records = [
  { toolCallId: "sum-ok", toolName: "bash", args: { command: "ok" }, resultText: "RAW_OK_DETAIL", isError: false },
  { toolCallId: "sum-error", toolName: "bash", args: { command: "fail" }, resultText: "RAW_ERROR_DETAIL", isError: true },
  { toolCallId: "sum-second", toolName: "read", args: { path: "fixture.txt" }, resultText: "RAW_SECOND_DETAIL", isError: false },
];
indexer.addBatch({ turnIndex: 1, timestamp: 1, toolCalls: records }, { appendEntry() {} });
indexer.registerSummaryRefs([
  { shortId: "t1", toolCallId: "sum-ok" },
  { shortId: "t2", toolCallId: "sum-error" },
  { shortId: "t3", toolCallId: "sum-second" },
]);
const call = (id, name) => ({ type: "toolCall", id, name, arguments: {} });
const result = (id, text, isError = false, details) => ({
  role: "toolResult", toolCallId: id, toolName: "bash", isError,
  content: [{ type: "text", text }], details,
});
const summary = { role: "user", content: [{ type: "text", text: "Summary refs t1-t3; t2 is an error." }] };
const messages = [
  { role: "user", content: [{ type: "text", text: "Task" }] },
  { role: "assistant", content: [call("sum-ok", "bash"), call("live", "read"), { type: "text", text: "Keep this prose" }] },
  result("sum-ok", "RAW_OK_DETAIL", false, { raw: "large detail" }),
  result("live", "UNPRUNED_LIVE_RESULT"),
  { role: "assistant", content: [call("sum-error", "bash"), call("sum-second", "read")] },
  result("sum-error", "RAW_ERROR_DETAIL", true),
  result("sum-second", "RAW_SECOND_DETAIL"),
  summary,
];
const model = { provider: "openai-codex", id: "gpt-6-luna", api: "openai-codex-responses", input: ["text", "image"] };
const oldBehavior = messages.filter((message) => !(message.role === "toolResult" && indexer.isSummarized(message.toolCallId)));
const oldProviderMessages = transformMessages(oldBehavior, model);
const syntheticCount = (items) => items.filter((message) => message.role === "toolResult" &&
  message.content?.some((block) => block.type === "text" && block.text === "No result provided")).length;
const callIds = (items) => items.flatMap((message) => message.role === "assistant"
  ? (message.content ?? []).filter((block) => block.type === "toolCall").map((block) => block.id) : []);
const resultIds = (items) => items.filter((message) => message.role === "toolResult").map((message) => message.toolCallId);
const orphanIds = (items) => callIds(items).filter((id) => !resultIds(items).includes(id));

ok("legacy filtering reproduces three orphan calls and synthetic results",
  orphanIds(oldBehavior).length === 3 && syntheticCount(oldProviderMessages) === 3);
const compacted = pruneMessages(messages, indexer);
ok("same-length compact replacements are returned as a changed array",
  compacted !== messages && compacted.length === messages.length);
const paired = pruneMessages(compacted, indexer);
ok("compaction is idempotent", paired === compacted);
const compactedProviderMessages = transformMessages(compacted, model);
ok("Pi AI provider transform emits no synthetic missing results", syntheticCount(compactedProviderMessages) === 0);
ok("every remaining tool call has exactly one matching result",
  orphanIds(compactedProviderMessages).length === 0 && callIds(compactedProviderMessages).length === resultIds(compactedProviderMessages).length);
const compactOk = compacted.find((message) => message.role === "toolResult" && message.toolCallId === "sum-ok");
const compactError = compacted.find((message) => message.role === "toolResult" && message.toolCallId === "sum-error");
ok("compact success result preserves call identity and short Raw ref",
  compactOk?.toolName === "bash" && compactOk.content?.[0]?.text.includes("Raw output ref: t1") && compactOk.details === undefined && !JSON.stringify(compactOk).includes("RAW_OK_DETAIL"));
ok("compact error result preserves error state and short Raw ref",
  compactError?.isError === true && compactError.content?.[0]?.text.includes("Raw output ref: t2") && compactError.content?.[0]?.text.includes("error result"));
ok("partial summary leaves unpruned call/result and assistant prose unchanged",
  compacted.find((message) => message.role === "toolResult" && message.toolCallId === "live") === messages[3] &&
  compacted.find((message) => message.role === "assistant")?.content.some((block) => block.text === "Keep this prose"));
ok("summary refs remain in the provider context", compacted.includes(summary));
const noIndex = new ToolCallIndexer();
ok("unindexed context returns the original array unchanged", pruneMessages(messages, noIndex) === messages);
const queryApi = { registerTool(tool) { this.tool = tool; } };
registerQueryTool(queryApi, indexer);
const errorRaw = await queryApi.tool.execute("query", { toolCallIds: ["t2"] }, undefined, undefined, {});
ok("context_tree_query still restores the summarized error result", errorRaw.content[0].text.includes("RAW_ERROR_DETAIL"));
const secondRaw = await queryApi.tool.execute("query", { toolCallIds: ["t3"] }, undefined, undefined, {});
ok("context_tree_query still restores multi-call raw content", secondRaw.content[0].text.includes("RAW_SECOND_DETAIL"));
