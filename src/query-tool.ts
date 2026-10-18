import { Type } from "@sinclair/typebox";
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolCallIndexer } from "./indexer.js";

export function registerQueryTool(pi: ExtensionAPI, indexer: ToolCallIndexer): void {
  pi.registerTool({
    name: "context_tree_query",
    label: "Query Original Tool History",
    description:
      "Retrieve original tool call results by short ref. Large results are paged with startLine/lineLimit so the complete raw output remains recoverable.",
    promptSnippet: "Retrieve original tool outputs by short ref",
    promptGuidelines: [
      "Use context_tree_query with a ref from a pruner summary or a [Raw output ref] marker to recover original tool output.",
      "For large raw results, follow the next-page instruction with startLine and a bounded lineLimit until all pages are retrieved.",
    ],
    parameters: Type.Object({
      toolCallIds: Type.Array(Type.String({ description: "One or more short refs or tool call IDs to retrieve" }), {
        description: "List of short refs or toolCallIds to look up",
      }),
      startLine: Type.Optional(Type.Integer({ minimum: 1, description: "1-based line offset for paged raw retrieval" })),
      lineLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: DEFAULT_MAX_LINES, description: "Maximum lines per raw page" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const foundRecords: Record<string, any> = {};
      const blocks: string[] = [];

      // Overlapping ranges and explicit refs must not emit the same raw record twice.
      const requested = [...new Set(params.toolCallIds.flatMap((id) => indexer.expandRef(id)))];

      for (const id of requested) {
        const record = indexer.getRecord(id);

        if (!record) {
          blocks.push(`## toolRef: ${id}\n(not found in index — may not have been summarized yet)`);
          continue;
        }

        foundRecords[id] = record;

        const status = record.isError ? "ERROR" : "OK";
        const header = [
          `## toolRef: ${id}`,
          `Tool: ${record.toolName}`,
          `Args: ${JSON.stringify(record.args, null, 2)}`,
          `Status: ${status}`,
          `Turn: ${record.turnIndex}`,
          "",
        ].join("\n");

        const lines = record.resultText.split("\n");
        const startLine = typeof params.startLine === "number" && Number.isInteger(params.startLine) && params.startLine > 0
          ? params.startLine
          : 1;
        const lineLimit = typeof params.lineLimit === "number" && Number.isInteger(params.lineLimit) && params.lineLimit > 0
          ? Math.min(params.lineLimit, DEFAULT_MAX_LINES)
          : DEFAULT_MAX_LINES;
        const page = lines.slice(startLine - 1).join("\n");
        const t = truncateHead(page, {
          maxLines: lineLimit,
          maxBytes: DEFAULT_MAX_BYTES,
        });

        let body = t.content;
        const nextLine = startLine + t.outputLines;
        if (t.truncated || nextLine <= lines.length) {
          body += `\n[Raw page: lines ${startLine}-${nextLine - 1} of ${lines.length}; retrieve next page with startLine=${nextLine}.]`;
        }

        blocks.push(`${header}\n${body}`);
      }

      const combined = blocks.join("\n\n---\n\n");

      return {
        content: [{ type: "text", text: combined }],
        details: { results: foundRecords },
      };
    },
  });
}
