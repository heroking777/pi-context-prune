import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  MAX_SEARCH_QUERY_CHARS,
  sanitizeSearchLimit,
  validateSearchQuery,
  type ToolCallIndexer,
} from "./indexer.js";

const MAX_MATCHES = 20;

const SEARCH_GUIDE = "Use context_tree_query with the returned ref to read the original output.";

/**
 * Explicit, call-only search over the pruner index. It exists so information
 * that was indexed without a visible short ref (size-floor batches) can still
 * be found by keyword. It never injects raw tool output and never exposes raw
 * tool call ids: it returns only opaque safe refs and safe metadata, and
 * retrieval stays with context_tree_query.
 */
export function registerIndexSearchTool(pi: ExtensionAPI, indexer: ToolCallIndexer): void {
  pi.registerTool({
    name: "context_index_search",
    label: "Search Pruned Tool Index",
    description:
      "Search tool call outputs that were pruned or summarized away, when you do not have a short ref. " +
      "Matches keywords against tool names, arguments and stored output text, and returns only short refs " +
      "and safe metadata. Retrieve the full original output afterwards with context_tree_query.",
    promptSnippet: "Find pruned tool outputs by keyword",
    promptGuidelines: [
      "Use context_index_search when you need a pruned tool output but have no short ref (for example after a size-floor skip or a context compaction).",
      "Search returns short refs only. Call context_tree_query with the returned ref to read the original output.",
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
            `. ${SEARCH_GUIDE}`,
        );
        for (const record of records) {
          const ref = indexer.getSearchRef(record.toolCallId);
          lines.push(
            `- ref: ${ref ?? "(unavailable)"} | tool: ${record.toolName} | ` +
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
            ref: indexer.getSearchRef(record.toolCallId) ?? null,
            tool: record.toolName,
            error: record.isError,
          })),
        },
      };
    },
  });
}
