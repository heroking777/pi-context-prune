import type { CapturedBatch } from "./types.js";

export interface SummaryToolCallRef {
  shortId: string;
  toolCallId: string;
}

export interface SummaryMessageDetailsLike {
  toolCallRefs?: SummaryToolCallRef[];
  toolCallIds?: string[];
}

const SHORT_ID_PREFIX = "t";
const SUMMARY_CONTEXT_TAG = "context-prune-summary";
const SUMMARY_CONTEXT_OPEN = `<${SUMMARY_CONTEXT_TAG}>`;
const SUMMARY_CONTEXT_CLOSE = `</${SUMMARY_CONTEXT_TAG}>`;
const LEGACY_SUMMARY_CONTEXT_NOTICE_LINES = [
  "Internal pruner context; not a user request.",
  "Do not answer directly; use only for prior tool-output context.",
] as const;
const LEGACY_SUMMARY_CONTEXT_NOTICE = LEGACY_SUMMARY_CONTEXT_NOTICE_LINES.join("\n");

export function buildShortToolCallRefs(
  toolCallIds: string[],
  startIndex: number,
): { refs: SummaryToolCallRef[]; nextIndex: number } {
  const refs = toolCallIds.map((toolCallId, offset) => ({
    shortId: `${SHORT_ID_PREFIX}${startIndex + offset}`,
    toolCallId,
  }));
  return { refs, nextIndex: startIndex + refs.length };
}

export function normalizeSummaryToolCallRefs(details: unknown): SummaryToolCallRef[] {
  if (!details || typeof details !== "object") return [];

  const raw = details as SummaryMessageDetailsLike;
  if (Array.isArray(raw.toolCallRefs)) {
    return raw.toolCallRefs
      .filter(
        (ref): ref is SummaryToolCallRef =>
          !!ref && typeof ref.shortId === "string" && typeof ref.toolCallId === "string",
      )
      .map((ref) => ({ shortId: ref.shortId, toolCallId: ref.toolCallId }));
  }

  if (Array.isArray(raw.toolCallIds)) {
    return raw.toolCallIds.filter((id): id is string => typeof id === "string").map((id) => ({ shortId: id, toolCallId: id }));
  }

  return [];
}

/** Collapses consecutive `tN` refs into `tA-tB` ranges (bounded, lossless). */
export function formatRefRanges(refs: SummaryToolCallRef[]): string {
  const ids = refs.map((ref) => ref.shortId);
  const numeric = ids.every((id) => /^t\d+$/.test(id));
  if (!numeric) return ids.map((id) => `\`${id}\``).join(", ");
  const numbers = [...new Set(ids.map((id) => Number(id.slice(1))))].sort((a, b) => a - b);
  const parts: string[] = [];
  let start: number | null = null;
  let prev: number | null = null;
  const flush = () => {
    if (start === null || prev === null) return;
    parts.push(start === prev ? `\`t${start}\`` : `\`t${start}-t${prev}\``);
    start = null;
    prev = null;
  };
  for (const n of numbers) {
    if (start === null) { start = n; prev = n; continue; }
    if (prev !== null && n === prev + 1) { prev = n; continue; }
    flush();
    start = n;
    prev = n;
  }
  flush();
  return parts.join(", ");
}

export function formatSummaryToolCallRefs(refs: SummaryToolCallRef[]): string {
  const searchHint = "Other pruned outputs: `context_index_search`.";
  if (refs.length === 0) {
    return `\n\n---\n${searchHint}`;
  }
  return (
    `\n\n---\n**Refs**: ${formatRefRanges(refs)}\n` +
    `Use \`context_tree_query\` (single refs or \`tA-tB\` ranges). ${searchHint}`
  );
}

export function wrapSummaryForContext(summaryText: string): string {
  const trimmed = summaryText.trim();
  if (trimmed.startsWith(SUMMARY_CONTEXT_OPEN)) {
    return trimmed;
  }

  return `${SUMMARY_CONTEXT_OPEN}\n${summaryText}\n${SUMMARY_CONTEXT_CLOSE}`;
}

export function unwrapSummaryForDisplay(content: string | unknown): string {
  const raw =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part) => {
              if (!part || typeof part !== "object") return "";
              if (!("type" in part) || (part as { type?: unknown }).type !== "text") return "";
              return "text" in part && typeof (part as { text?: unknown }).text === "string"
                ? (part as { text: string }).text
                : "";
            })
            .filter(Boolean)
            .join("\n")
        : "";

  const trimmed = raw.trim();
  if (!trimmed.startsWith(SUMMARY_CONTEXT_OPEN) || !trimmed.endsWith(SUMMARY_CONTEXT_CLOSE)) {
    return raw;
  }

  const closeStart = trimmed.lastIndexOf(SUMMARY_CONTEXT_CLOSE);
  if (closeStart <= SUMMARY_CONTEXT_OPEN.length) {
    return raw;
  }

  let inner = trimmed.slice(SUMMARY_CONTEXT_OPEN.length, closeStart).trim();
  const lines = inner.split(/\r?\n/);
  const noticePrefix = lines.slice(0, LEGACY_SUMMARY_CONTEXT_NOTICE_LINES.length).join("\n");
  const blankLineIndex = LEGACY_SUMMARY_CONTEXT_NOTICE_LINES.length;
  if (noticePrefix === LEGACY_SUMMARY_CONTEXT_NOTICE) {
    const hasSeparator = lines.length > blankLineIndex && lines[blankLineIndex].trim() === "";
    inner = lines.slice(blankLineIndex + (hasSeparator ? 1 : 0)).join("\n").trim();
  }
  return inner;
}

export function makeSummaryDetails(batch: CapturedBatch, refs: SummaryToolCallRef[]) {
  return {
    toolCallRefs: refs,
    toolNames: batch.toolCalls.map((tc) => tc.toolName),
    turnIndex: batch.turnIndex,
    timestamp: batch.timestamp,
  };
}
