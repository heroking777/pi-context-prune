import type { IndexSearchOptions, IndexSearchResult } from "./indexer.js";
import type { ToolCallRecord } from "./types.js";

type QueryValidation =
  | { ok: true; query: string }
  | { ok: false; reason: string; message: string };

export function searchIndexedRecords(
  index: ReadonlyMap<string, ToolCallRecord>,
  query: string,
  options: IndexSearchOptions,
  validate: (value: unknown) => QueryValidation,
  sanitizeLimit: (value: unknown) => number,
): IndexSearchResult {
  const validation = validate(query);
  if (!validation.ok) return { records: [], matchCount: 0 };
  const needle = validation.query.trim().toLowerCase();
  const limit = sanitizeLimit(options.limit);
  const matches: ToolCallRecord[] = [];
  for (const record of index.values()) {
    if (options.errorsOnly && !record.isError) continue;
    const haystack = `${record.toolName}\n${JSON.stringify(record.args ?? {})}\n${record.resultText}`.toLowerCase();
    if (haystack.includes(needle)) matches.push(record);
  }
  return { records: matches.slice(0, limit), matchCount: matches.length };
}
