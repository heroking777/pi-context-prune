import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CapturedBatch, IndexEntryData, ToolCallRecord } from "./types.js";
import { CUSTOM_TYPE_INDEX, CUSTOM_TYPE_SUMMARY } from "./types.js";
import {
  buildShortToolCallRefs,
  normalizeSummaryToolCallRefs,
  type SummaryToolCallRef,
} from "./summary-refs.js";

export interface IndexSearchOptions {
  limit?: unknown;
  errorsOnly?: boolean;
}

/** Upper bound on a search query, so a huge query cannot force unbounded work. */
export const MAX_SEARCH_QUERY_CHARS = 512;
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 20;

/**
 * Coerces any caller-supplied limit into an integer in [1, MAX_SEARCH_LIMIT].
 * NaN, Infinity, non-numbers and out-of-range values fall back safely instead
 * of yielding an unbounded result set.
 */
export function sanitizeSearchLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SEARCH_LIMIT;
  const floored = Math.floor(value);
  if (floored < 1) return 1;
  return Math.min(floored, MAX_SEARCH_LIMIT);
}

/**
 * Validates a search query. Empty or whitespace-only queries are rejected so
 * they can never be treated as "match everything", and oversized queries are
 * rejected instead of scanned.
 */
export function validateSearchQuery(query: unknown):
  | { ok: true; query: string }
  | { ok: false; reason: "empty" | "too-long"; message: string } {
  const text = typeof query === "string" ? query : "";
  if (text.trim().length === 0) {
    return { ok: false, reason: "empty", message: "A non-empty search query is required; an empty query is not treated as match-all." };
  }
  if (text.length > MAX_SEARCH_QUERY_CHARS) {
    return { ok: false, reason: "too-long", message: `Search query is too long (${text.length} chars); the maximum is ${MAX_SEARCH_QUERY_CHARS}.` };
  }
  return { ok: true, query: text };
}

export interface IndexSearchResult {
  records: ToolCallRecord[];
  matchCount: number;
}

const SEARCH_REF_PREFIX = "s-";
const SEARCH_REF_HEX_CHARS = 16;

/**
 * Derives the opaque search ref for a tool call. The ref is a truncated
 * SHA-256 of the id, so it is stable across session reconstruction, bounded in
 * length, and never reveals the underlying id. The `s-` prefix cannot collide
 * with existing `t<n>` summary refs.
 */
export function deriveSearchRef(toolCallId: string, hexChars: number = SEARCH_REF_HEX_CHARS): string {
  return `${SEARCH_REF_PREFIX}${createHash("sha256").update(toolCallId).digest("hex").slice(0, hexChars)}`;
}

export class ToolCallIndexer {
  private index = new Map<string, ToolCallRecord>();
  private aliasToToolCallId = new Map<string, string>();
  private toolCallIdToAlias = new Map<string, string>();
  private searchRefToToolCallId = new Map<string, string>();
  private toolCallIdToSearchRef = new Map<string, string>();
  private ambiguousSearchRefs = new Set<string>();
  private nextShortAliasNumber = 1;

  /** Overridable so tests can force a hash collision and prove fail-closed behavior. */
  protected deriveSearchRefFor(toolCallId: string): string {
    return deriveSearchRef(toolCallId);
  }

  private registerSearchRef(toolCallId: string): void {
    const ref = this.deriveSearchRefFor(toolCallId);
    const existing = this.searchRefToToolCallId.get(ref);
    if (existing !== undefined && existing !== toolCallId) {
      // Collision: never resolve this ref to a guessed record.
      this.ambiguousSearchRefs.add(ref);
      return;
    }
    this.searchRefToToolCallId.set(ref, toolCallId);
    this.toolCallIdToSearchRef.set(toolCallId, ref);
  }

  /**
   * Rebuilds the in-memory index from session history by scanning all
   * custom entries with customType === CUSTOM_TYPE_INDEX.
   */
  reconstructFromSession(ctx: ExtensionContext): void {
    this.index.clear();
    this.aliasToToolCallId.clear();
    this.toolCallIdToAlias.clear();
    this.searchRefToToolCallId.clear();
    this.toolCallIdToSearchRef.clear();
    this.ambiguousSearchRefs.clear();
    this.nextShortAliasNumber = 1;

    const branch = ctx.sessionManager.getBranch();
    for (const entry of branch) {
      if (entry.type === "custom" && (entry as any).customType === CUSTOM_TYPE_INDEX) {
        const data = (entry as any).data as IndexEntryData;
        if (data && Array.isArray(data.toolCalls)) {
          for (const toolCall of data.toolCalls) {
            this.index.set(toolCall.toolCallId, toolCall);
            this.registerSearchRef(toolCall.toolCallId);
          }
        }
        continue;
      }

      if (entry.type === "custom_message" && (entry as any).customType === CUSTOM_TYPE_SUMMARY) {
        const refs = normalizeSummaryToolCallRefs((entry as any).details);
        this.registerSummaryRefs(refs);
      }
    }
  }

  /**
   * Returns true if the given toolCallId has been summarized (exists in index).
   */
  isSummarized(toolCallId: string): boolean {
    return this.index.has(toolCallId);
  }

  /**
   * Returns the full runtime index map.
   */
  getIndex(): Map<string, ToolCallRecord> {
    return this.index;
  }

  /**
   * Register short aliases for a summary message so future recovery queries can
   * resolve the short ids back to the persisted toolCallIds.
   */
  registerSummaryRefs(refs: SummaryToolCallRef[]): void {
    for (const ref of refs) {
      if (!ref.shortId || !ref.toolCallId) continue;
      if (ref.shortId !== ref.toolCallId) {
        this.aliasToToolCallId.set(ref.shortId, ref.toolCallId);
        this.toolCallIdToAlias.set(ref.toolCallId, ref.shortId);
      }
      const match = /^t(\d+)$/.exec(ref.shortId);
      if (match) {
        this.nextShortAliasNumber = Math.max(this.nextShortAliasNumber, Number(match[1]) + 1);
      }
    }
  }

  /**
   * Allocates short aliases for a batch's tool calls and registers them in the
   * runtime alias map.
   */
  allocateSummaryRefs(batch: CapturedBatch): SummaryToolCallRef[] {
    const toolCallIds = batch.toolCalls.map((tc) => tc.toolCallId);
    const { refs, nextIndex } = buildShortToolCallRefs(toolCallIds, this.nextShortAliasNumber);
    this.nextShortAliasNumber = nextIndex;
    return refs;
  }

  /**
   * Resolve a short alias or a full toolCallId to the canonical toolCallId.
   */
  /**
   * Expands a `tA-tB` short-ref range into individual refs (bounded). Returns the
   * input unchanged when it is not a range.
   */
  expandRef(ref: string): string[] {
    const match = /^t(\d+)-t(\d+)$/.exec(ref.trim());
    if (!match) return [ref];
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return [ref];
    const count = end - start + 1;
    if (count > 200) return [ref];
    return Array.from({ length: count }, (_, offset) => `t${start + offset}`);
  }

  resolveToolCallId(toolCallIdOrAlias: string): string | undefined {
    if (this.index.has(toolCallIdOrAlias)) return toolCallIdOrAlias;
    if (this.ambiguousSearchRefs.has(toolCallIdOrAlias)) return undefined;
    const aliased = this.aliasToToolCallId.get(toolCallIdOrAlias);
    if (aliased !== undefined) return aliased;
    return this.searchRefToToolCallId.get(toolCallIdOrAlias);
  }

  /**
   * Look up a single record by toolCallId or short alias (used by query tool).
   */
  getRecord(toolCallIdOrAlias: string): ToolCallRecord | undefined {
    const resolved = this.resolveToolCallId(toolCallIdOrAlias);
    if (!resolved) return undefined;
    return this.index.get(resolved);
  }

  /**
   * Looks up multiple tool call records by ID. Skips any IDs not found.
   */
  lookupToolCalls(toolCallIds: string[]): ToolCallRecord[] {
    const results: ToolCallRecord[] = [];
    for (const id of toolCallIds) {
      const record = this.getRecord(id);
      if (record !== undefined) {
        results.push(record);
      }
    }
    return results;
  }

  /**
   * Registers a record that was persisted directly to session history, keeping
   * the index and the safe search-ref map in sync (addBatch does the same for
   * the appendEntry path).
   */
  indexPersistedRecord(record: ToolCallRecord): void {
    this.index.set(record.toolCallId, record);
    this.registerSearchRef(record.toolCallId);
  }

  /**
   * Returns the model-visible short ref for a tool call, if one was allocated.
   */
  getShortId(toolCallId: string): string | undefined {
    return this.toolCallIdToAlias.get(toolCallId);
  }

  /**
   * Returns the safe ref to show for a tool call: the existing summary ref if
   * one exists, otherwise the opaque search ref. Returns undefined for a ref
   * that is ambiguous due to a (theoretical) hash collision, so callers never
   * publish a ref that could resolve to the wrong record.
   */
  getSearchRef(toolCallId: string): string | undefined {
    const alias = this.toolCallIdToAlias.get(toolCallId);
    if (alias !== undefined) return alias;
    const ref = this.toolCallIdToSearchRef.get(toolCallId) ?? this.deriveSearchRefFor(toolCallId);
    return this.ambiguousSearchRefs.has(ref) ? undefined : ref;
  }

  /**
   * Keyword search over indexed tool calls. Matching may read result text and
   * args, but callers only receive safe metadata (no raw output) so search can
   * neither leak secrets nor fabricate records that are not indexed.
   */
  searchRecords(query: string, options: IndexSearchOptions = {}): IndexSearchResult {
    const validation = validateSearchQuery(query);
    // Defensive: an empty or oversized query never scans and never matches all.
    if (!validation.ok) return { records: [], matchCount: 0 };
    const needle = validation.query.trim().toLowerCase();
    const limit = sanitizeSearchLimit(options.limit);
    const matches: ToolCallRecord[] = [];
    for (const record of this.index.values()) {
      if (options.errorsOnly && !record.isError) continue;
      const haystack = `${record.toolName}\n${JSON.stringify(record.args ?? {})}\n${record.resultText}`.toLowerCase();
      if (!haystack.includes(needle)) continue;
      matches.push(record);
    }
    return { records: matches.slice(0, limit), matchCount: matches.length };
  }

  /**
   * Adds all tool calls from a captured batch to the runtime index and
   * persists an IndexEntryData entry to the session via pi.appendEntry.
   */
  addBatch(batch: CapturedBatch, pi: ExtensionAPI): void {
    const records: ToolCallRecord[] = [];

    for (const tc of batch.toolCalls) {
      const record: ToolCallRecord = {
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: tc.args,
        resultText: tc.resultText,
        isError: tc.isError,
        turnIndex: batch.turnIndex,
        timestamp: batch.timestamp,
      };
      this.index.set(record.toolCallId, record);
      this.registerSearchRef(record.toolCallId);
      records.push(record);
    }

    pi.appendEntry(CUSTOM_TYPE_INDEX, { toolCalls: records } as IndexEntryData);
  }
}
