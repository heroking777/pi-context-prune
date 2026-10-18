import type { ToolCallIndexer } from "./indexer.js";

const RAW_REF_GUIDANCE = "Retrieve the full original output with context_tree_query.";

/**
 * Replaces a summarized result with a compact ref while preserving its toolCallId,
 * toolName, and error state. Keep the original if no safe query ref is available.
 */
function compactResult(message: any, indexer: ToolCallIndexer): any {
  const ref = indexer.getSearchRef(message.toolCallId);
  if (!ref) return message;

  const outcome = message.isError === true ? "error result" : "result";
  const text = `Original ${outcome} was summarized. [Raw output ref: ${ref}; ${RAW_REF_GUIDANCE}]`;
  const content = message.content;
  if (Array.isArray(content) && content.length === 1 && content[0]?.type === "text" &&
      content[0].text === text && message.details === undefined) return message;

  return { ...message, content: [{ type: "text", text }], details: undefined };
}

/**
 * Compacts indexed tool results without orphaning their assistant tool-call blocks.
 * The compact result keeps the original call ID and exposes its summary/search ref.
 */
export function pruneMessages(messages: any[], indexer: ToolCallIndexer): any[] {
  let changed = false;
  const compacted = messages.map((message) => {
    if (message.role !== "toolResult" || !indexer.isSummarized(message.toolCallId)) return message;
    const result = compactResult(message, indexer);
    if (result !== message) changed = true;
    return result;
  });
  return changed ? compacted : messages;
}
