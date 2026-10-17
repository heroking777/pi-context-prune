import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  MAX_SEARCH_QUERY_CHARS,
  sanitizeSearchLimit,
  validateSearchQuery,
  type ToolCallIndexer,
} from "./indexer.js";

const MAX_DISPLAY_ID = 80;

/**
 * Renders an id for the human-readable line without letting control characters
 * or the `|`/backtick delimiters forge extra metadata. The exact id is always
 * preserved in `details` so retrieval is never weakened.
 */
function displayId(id: string): string {
  let cleaned = "";
  for (const ch of id) {
    const code = ch.codePointAt(0) ?? 0;
    cleaned += code < 0x20 || code === 0x7f || ch === "|" || ch === "`" ? "_" : ch;
  }
  return cleaned.length > MAX_DISPLAY_ID ? `${cleaned.slice(0, MAX_DISPLAY_ID)}…` : cleaned;
}

const MAX_MATCHES = 20;

/**
 * Explicit, call-only search over the pruner index. It exists so information
 * that was indexed without a visible short ref (size-floor batches) can still
 * be found by keyword. It never injects raw tool output: it returns only
 * identifiers and safe metadata, and retrieval stays with context_tree_query.
 */
export function registerIndexSearchTool(pi: ExtensionAPI, indexer: ToolCallIndexer): void {
  pi.registerTool({
    name: "context_index_search",
    label: "Search Pruned Tool Index",
    description:
      "Search tool call outputs that were pruned or summarized away, when you do not have a short ref. " +
      "Matches keywords against tool names, arguments and stored output text, and returns only short refs, " +
      "ids and safe metadata. Retrieve the full original output afterwards with context_tree_query.",
    promptSnippet: "Find pruned tool outputs by keyword",
    promptGuidelines: [
      "Use context_index_search when you need a pruned tool output but have no short ref (for example after a size-floor skip or a context compaction).",
      "Search returns identifiers only. Call context_tree_query with the returned ref or id to read the original output.",
      "If search reports no match, the content is not in the index; do not assume it exists.",
    ],
    parameters: Type.Object({
      query: Type.String({ maxLength: MAX_SEARCH_QUERY_CHARS, description: "Keyword(s) to match against pruned tool names, arguments and output text (non-empty, max 512 chars)" }),
      limit: Type.Optional(Type.Number({ description: `Maximum matches to return (1-${MAX_MATCHES}, default 5)` })),
      errorsOnly: Type.Optional(Type.Boolean({ description: "Only return tool calls whose result was an error" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const validation = validateSearchQuery(params.query);
      if (!validation.ok) {
        return {
          content: [{ type: "text", text: `## index search error\n${validation.message}` }],
          details: { error: validation.reason, matchCount: 0, returned: 0, refs: [] },
        };
      }
      const query = validation.query;
      const { records, matchCount } = indexer.searchRecords(query, {
        limit: sanitizeSearchLimit(params.limit),
        errorsOnly: params.errorsOnly === true,
      });

      const lines: string[] = [`## index search: ${JSON.stringify(query)}`];
      if (matchCount === 0) {
        lines.push(
          "No indexed tool output matches this query. Only summarized or size-floor-skipped calls are indexed; " +
            "nothing was invented.",
        );
      } else {
        lines.push(
          `${matchCount} match(es) in the pruner index` +
            (records.length < matchCount ? `, showing first ${records.length}` : "") +
            ". Use context_tree_query with a ref or id to read the original output.",
        );
        for (const record of records) {
          const ref = indexer.getShortId(record.toolCallId);
          lines.push(
            `- ref: ${ref ?? "(none)"} | id: ${displayId(record.toolCallId)} | tool: ${record.toolName} | ` +
              `turn: ${record.turnIndex} | status: ${record.isError ? "ERROR" : "OK"} | bytes: ${record.resultText.length}`,
          );
        }
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          query,
          matchCount,
          returned: records.length,
          refs: records.map((record) => ({
            id: record.toolCallId,
            ref: indexer.getShortId(record.toolCallId) ?? null,
            tool: record.toolName,
            error: record.isError,
          })),
        },
      };
    },
  });
}
