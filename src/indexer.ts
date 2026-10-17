import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CapturedBatch, IndexEntryData, ToolCallRecord } from "./types.js";
import { CUSTOM_TYPE_INDEX, CUSTOM_TYPE_SUMMARY } from "./types.js";
import {
  buildShortToolCallRefs,
  normalizeSummaryToolCallRefs,
  type SummaryToolCallRef,
} from "./summary-refs.js";

export interface IndexSearchOptions {
  limit?: number;
  errorsOnly?: boolean;
}

export interface IndexSearchResult {
  records: ToolCallRecord[];
  matchCount: number;
}

export class ToolCallIndexer {
  private index = new Map<string, ToolCallRecord>();
  private aliasToToolCallId = new Map<string, string>();
  private toolCallIdToAlias = new Map<string, string>();
  private nextShortAliasNumber = 1;

  /**
   * Rebuilds the in-memory index from session history by scanning all
   * custom entries with customType === CUSTOM_TYPE_INDEX.
   */
  reconstructFromSession(ctx: ExtensionContext): void {
    this.index.clear();
    this.aliasToToolCallId.clear();
    this.toolCallIdToAlias.clear();
    this.nextShortAliasNumber = 1;

    const branch = ctx.sessionManager.getBranch();
    for (const entry of branch) {
      if (entry.type === "custom" && (entry as any).customType === CUSTOM_TYPE_INDEX) {
        const data = (entry as any).data as IndexEntryData;
        if (data && Array.isArray(data.toolCalls)) {
          for (const toolCall of data.toolCalls) {
            this.index.set(toolCall.toolCallId, toolCall);
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
  resolveToolCallId(toolCallIdOrAlias: string): string | undefined {
    if (this.index.has(toolCallIdOrAlias)) return toolCallIdOrAlias;
    return this.aliasToToolCallId.get(toolCallIdOrAlias);
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
   * Returns the model-visible short ref for a tool call, if one was allocated.
   */
  getShortId(toolCallId: string): string | undefined {
    return this.toolCallIdToAlias.get(toolCallId);
  }

  /**
   * Keyword search over indexed tool calls. Matching may read result text and
   * args, but callers only receive safe metadata (no raw output) so search can
   * neither leak secrets nor fabricate records that are not indexed.
   */
  searchRecords(query: string, options: IndexSearchOptions = {}): IndexSearchResult {
    const needle = query.trim().toLowerCase();
    const limit = Math.min(Math.max(options.limit ?? 5, 1), 20);
    const matches: ToolCallRecord[] = [];
    for (const record of this.index.values()) {
      if (options.errorsOnly && !record.isError) continue;
      if (needle) {
        const haystack = `${record.toolName}\n${JSON.stringify(record.args ?? {})}\n${record.resultText}`.toLowerCase();
        if (!haystack.includes(needle)) continue;
      }
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
      records.push(record);
    }

    pi.appendEntry(CUSTOM_TYPE_INDEX, { toolCalls: records } as IndexEntryData);
  }
}
