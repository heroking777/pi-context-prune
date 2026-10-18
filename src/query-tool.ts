import { createHash } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolCallIndexer } from "./indexer.js";
import type { ToolCallRecord } from "./types.js";

interface RawIntegrityRecord extends ToolCallRecord {
  __contextPruneRawSha256?: string;
  __contextPruneRawByteLength?: number;
}

function rawDigest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function offsetForLine(bytes: Buffer, line: number): number {
  if (line <= 1) return 0;
  let offset = 0;
  for (let current = 1; current < line; current++) {
    const newline = bytes.indexOf(0x0a, offset);
    if (newline < 0) return bytes.length;
    offset = newline + 1;
  }
  return offset;
}

function lineForOffset(bytes: Buffer, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index++) {
    if (bytes[index] === 0x0a) line++;
  }
  return line;
}

function endForLineLimit(bytes: Buffer, start: number, lineLimit: number): number {
  let offset = start;
  for (let count = 0; count < lineLimit; count++) {
    const newline = bytes.indexOf(0x0a, offset);
    if (newline < 0) return bytes.length;
    offset = newline + 1;
  }
  return offset;
}

function utf8Boundary(bytes: Buffer, start: number, end: number): number {
  while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  if (end > start) return end;
  end = Math.min(bytes.length, start + 1);
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end++;
  return end;
}

function validateRecord(record: ToolCallRecord): { bytes: Buffer; sha256: string } | undefined {
  const raw = record as RawIntegrityRecord;
  const bytes = Buffer.from(record.resultText, "utf8");
  const sha256 = rawDigest(bytes);
  const hasIntegrity = raw.__contextPruneRawSha256 !== undefined || raw.__contextPruneRawByteLength !== undefined;
  if (hasIntegrity && (raw.__contextPruneRawSha256 !== sha256 || raw.__contextPruneRawByteLength !== bytes.length)) {
    return undefined;
  }
  return { bytes, sha256 };
}

function pageStart(bytes: Buffer, startLine: unknown, startByte: unknown): { byte: number; line: number } | undefined {
  if (typeof startByte === "number") {
    if (!Number.isInteger(startByte) || startByte < 0 || startByte > bytes.length) return undefined;
    if (startByte > 0 && startByte < bytes.length && (bytes[startByte] & 0xc0) === 0x80) return undefined;
    return { byte: startByte, line: lineForOffset(bytes, startByte) };
  }
  const line = typeof startLine === "number" && Number.isInteger(startLine) && startLine > 0 ? startLine : 1;
  return { byte: offsetForLine(bytes, line), line };
}

function renderRawPage(bytes: Buffer, start: { byte: number; line: number }, lineLimit: number): string {
  if (start.byte === bytes.length) return "";
  const lineEnd = endForLineLimit(bytes, start.byte, lineLimit);
  const byteEnd = Math.min(bytes.length, start.byte + DEFAULT_MAX_BYTES, lineEnd);
  const end = utf8Boundary(bytes, start.byte, byteEnd);
  if (end <= start.byte) return "[Raw page failed to advance; no content returned.]";
  const page = bytes.subarray(start.byte, end).toString("utf8");
  if (end === bytes.length) return page;
  const nextLine = start.line + page.split("\n").length - 1;
  return `${page}\n[Raw page: bytes ${start.byte}-${end - 1} of ${bytes.length}; continue with startByte=${end}, startLine=${nextLine}.]`;
}

type QueryParams = { toolCallIds: string[]; startLine?: number; startByte?: number; lineLimit?: number };

function executeQuery(indexer: ToolCallIndexer, params: QueryParams) {
  const foundRecords: Record<string, unknown> = {};
  const blocks: string[] = [];
  const requested = [...new Set(params.toolCallIds.flatMap((id) => indexer.expandRef(id)))];

  for (const id of requested) {
    const record = indexer.getRecord(id);
    if (!record) {
      blocks.push(`## toolRef: ${id}\n(not found in index — may not have been summarized yet)`);
      continue;
    }
    const validated = validateRecord(record);
    if (!validated) {
      blocks.push(`## toolRef: ${id}\n[Raw integrity validation failed; no content returned.]`);
      continue;
    }
    foundRecords[id] = record;
    const start = pageStart(validated.bytes, params.startLine, params.startByte);
    if (!start) {
      blocks.push(`## toolRef: ${id}\n[Invalid page cursor; expected a UTF-8 boundary within ${validated.bytes.length} bytes.]`);
      continue;
    }
    const status = record.isError ? "ERROR" : "OK";
    const header = [
      `## toolRef: ${id}`,
      `Tool: ${record.toolName}`,
      `Args: ${JSON.stringify(record.args, null, 2)}`,
      `Status: ${status}`,
      `Turn: ${record.turnIndex}`,
      `Raw: SHA-256 ${validated.sha256}; ${validated.bytes.length} bytes`,
      "",
    ].join("\n");
    const lineLimit = typeof params.lineLimit === "number" && Number.isInteger(params.lineLimit) && params.lineLimit > 0
      ? Math.min(params.lineLimit, DEFAULT_MAX_LINES)
      : DEFAULT_MAX_LINES;
    blocks.push(`${header}\n${renderRawPage(validated.bytes, start, lineLimit)}`);
  }
  return { content: [{ type: "text" as const, text: blocks.join("\n\n---\n\n") }], details: { results: foundRecords } };
}

export function registerQueryTool(pi: ExtensionAPI, indexer: ToolCallIndexer): void {
  pi.registerTool({
    name: "context_tree_query",
    label: "Query Original Tool History",
    description:
      "Retrieve original tool call results by short ref. Large results are paged with startLine/startByte and bounded by line and byte limits.",
    promptSnippet: "Retrieve original tool outputs by short ref",
    promptGuidelines: [
      "Use context_tree_query with a ref from a pruner summary or a [Raw output ref] marker to recover original tool output.",
      "For large raw results, follow the next-page startByte instruction; concatenate page bodies without page notices to reconstruct exact bytes.",
    ],
    parameters: Type.Object({
      toolCallIds: Type.Array(Type.String({ description: "One or more short refs or tool call IDs to retrieve" }), {
        description: "List of short refs or toolCallIds to look up",
      }),
      startLine: Type.Optional(Type.Integer({ minimum: 1, description: "1-based line offset for legacy line paging" })),
      startByte: Type.Optional(Type.Integer({ minimum: 0, description: "0-based UTF-8 byte cursor from the previous page notice" })),
      lineLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: DEFAULT_MAX_LINES, description: "Maximum lines per raw page" })),
    }),

    async execute(_toolCallId, params) {
      return executeQuery(indexer, params as QueryParams);
    },
  });
}
