// Phase 31: mechanical protection check for compressed summaries.
//
// Compression must never silently drop information the next steps depend on.
// This module extracts high-confidence protected items from the raw batch and
// verifies they survive into the summary text. It is deliberately conservative:
// it only enforces categories that can be matched mechanically (identifier
// categories), and it reports advisory categories without blocking.
import { createHash } from "node:crypto";

export type ProtectedCategory =
  | "sha"
  | "path"
  | "error"
  | "status"
  | "decision"
  | "task"
  | "rollback"
  | "next"
  | "diff"
  | "verification";

export interface ProtectedItem {
  category: ProtectedCategory;
  /** Normalized value used for matching. */
  value: string;
  /** Case-sensitive comparison when true (hashes, paths, error identifiers). */
  exact: boolean;
}

const MAX_PER_CATEGORY = 25;
const MAX_TOTAL_MATCHES = 4000;

/** Internal marker distinguishing a protection rejection from a generic failure. */
export const PROTECTION_FAILURE_MARKER = "__prunerProtectionFailed";

export interface ProtectionFailureResult {
  [PROTECTION_FAILURE_MARKER]: true;
  /**
   * `missing` = an enforced item was dropped; `overflow` = too many values to
   * verify; `incomplete` = the scan limit was hit; `paused` = this session's
   * protected compression is paused after too many distinct failures;
   * `capacity` = the session table is full and this new session fails closed;
   * `unidentified` = no safe session id, so state must not be shared;
   * `in-flight` = an identical batch is already being summarized.
   */
  reason: ProtectionFailureReason;
  /** Opaque retry-suppression key (no raw content). */
  key: string;
  missingCategories: ProtectedCategory[];
  missingCount: number;
}

/** All reasons a protected summary can be rejected or suppressed. */
export type ProtectionFailureReason =
  | "missing"
  | "overflow"
  | "incomplete"
  | "paused"
  | "capacity"
  | "unidentified"
  | "in-flight";

/** Categories whose absence blocks the summary (six required + status). */
const ENFORCED: ReadonlySet<ProtectedCategory> = new Set<ProtectedCategory>([
  "sha",
  "path",
  "error",
  "status",
  "decision",
  "task",
  "rollback",
]);

interface Extractor {  category: ProtectedCategory;
  regex: RegExp;
  group?: number;
  exact?: boolean;
  upper?: boolean;
}

const EXTRACTORS: Extractor[] = [
  { category: "sha", regex: /\b[0-9a-f]{40}\b|\b[0-9a-f]{64}\b/g, exact: true },
  { category: "sha", regex: /\b(?:FINAL_SHA|BASE_SHA|COMMIT|HEAD|BUILD_ID|RELEASE)\s*[=:]\s*([A-Za-z0-9._/-]{6,})/g, group: 1, exact: true },
  { category: "path", regex: /\/[\w.@+-]+(?:\/[\w.@+-]+)*\.[A-Za-z0-9]{1,8}\b/g, exact: true },
  { category: "error", regex: /\b[A-Z][A-Za-z0-9]*(?:Error|Exception|Failure)\b/g, exact: true },
  { category: "error", regex: /\bERROR\s*[:=]\s*([^\n]{1,80})/g, group: 1 },
  { category: "error", regex: /\b(?:exit(?:\s+code)?|status)\s*[:=]?\s*([1-9]\d{0,2})\b/gi, group: 1 },
  { category: "status", regex: /\b(PASS|FAIL|HOLD|UNKNOWN|BLOCKED|SUCCESS|DEGRADED)\b/g, group: 1, upper: true },
  { category: "decision", regex: /\bDECISION\s*[=:]\s*([^\n,;]{1,80})/gi, group: 1 },
  { category: "decision", regex: /\bdecided\s+to\s+([^.;\n]{1,60})/gi, group: 1 },
  { category: "task", regex: /\bUNFINISHED_TASK\s*[=:]\s*([^\n]{1,80})/gi, group: 1 },
  { category: "task", regex: /\bTODO\s*[=:]\s*([^\n]{1,80})/gi, group: 1 },
  { category: "rollback", regex: /\bROLLBACK\s*[=:]\s*([^\n]{1,80})/gi, group: 1 },
  { category: "next", regex: /\bNEXT(?:_ACTION|_TASK|_STEP)?\s*[=:]\s*([^\n]{1,80})/gi, group: 1 },
  { category: "diff", regex: /\b(?:BEFORE|AFTER|DIFF)\s*[=:]\s*([^\n]{1,80})/gi, group: 1 },
  { category: "verification", regex: /\b(re-?verified|tests?\s+passed|tests?\s+failed)\b/gi, group: 1 },
];

function normalize(item: { category: ProtectedCategory; value: string; exact: boolean; upper?: boolean }): ProtectedItem {
  const raw = item.value.trim();
  return {
    category: item.category,
    value: item.upper ? raw.toUpperCase() : raw,
    exact: item.exact === true,
  };
}

/**
 * Extracts protected items from raw batch text with overflow detection. Bounded
 * per category and overall so a huge batch cannot make verification unbounded;
 * unlike a silent cap, exceeding a category limit is reported as overflow.
 */
export function extractProtectedItemsDetailed(rawText: string): {
  items: ProtectedItem[];
  overflowCategories: ProtectedCategory[];
  scanned: number;
  truncated: boolean;
} {
  const seen = new Set<string>();
  const out: ProtectedItem[] = [];
  const counts = new Map<ProtectedCategory, number>();
  const overflow = new Set<ProtectedCategory>();
  let scanned = 0;
  let truncated = false;
  outer: for (const extractor of EXTRACTORS) {
    const regex = new RegExp(extractor.regex.source, extractor.regex.flags);
    for (const match of rawText.matchAll(regex)) {
      if (scanned >= MAX_TOTAL_MATCHES) {
        // There is at least one more match we refuse to scan: fail closed.
        truncated = true;
        break outer;
      }
      scanned += 1;
      const raw = extractor.group === undefined ? match[0] : match[extractor.group];
      if (raw === undefined || raw.length === 0) continue;
      const item = normalize({ category: extractor.category, value: raw, exact: extractor.exact ?? false, upper: extractor.upper });
      const key = `${item.category}\u0000${item.exact ? item.value : item.value.toLowerCase()}`;
      if (seen.has(key)) continue;
      const count = counts.get(item.category) ?? 0;
      counts.set(item.category, count + 1);
      if (count >= MAX_PER_CATEGORY) {
        overflow.add(item.category);
        continue;
      }
      seen.add(key);
      out.push(item);
    }
  }
  return { items: out, overflowCategories: [...overflow], scanned, truncated };
}

/**
 * Extracts protected items from raw batch text. Bounded per category so a huge
 * batch cannot make verification unbounded.
 */
export function extractProtectedItems(rawText: string): ProtectedItem[] {
  return extractProtectedItemsDetailed(rawText).items;
}

function isPresent(summaryText: string, item: ProtectedItem): boolean {
  return item.exact ? summaryText.includes(item.value) : summaryText.toLowerCase().includes(item.value.toLowerCase());
}

export interface ProtectionVerdict {
  ok: boolean;
  checked: number;
  required: number;
  missing: ProtectedItem[];
  advisoryMissing: ProtectedItem[];
  overflow: ProtectedCategory[];
  /** True when the scan limit was reached before the raw text was exhausted. */
  truncated: boolean;
}

/**
 * Verifies that enforced protected items survive into the summary. Returns
 * `ok:false` when any enforced item is missing, any enforced category
 * overflowed, or the scan was truncated (so unverified items are never
 * silently passed). The caller then rejects the summary and keeps the raw
 * output on the existing restore path.
 */
export function verifyProtectedSummary(rawText: string, summaryText: string): ProtectionVerdict {
  const extraction = extractProtectedItemsDetailed(rawText);
  const items = extraction.items;
  const missing: ProtectedItem[] = [];
  const advisoryMissing: ProtectedItem[] = [];
  let required = 0;
  for (const item of items) {
    if (!ENFORCED.has(item.category)) {
      if (!isPresent(summaryText, item)) advisoryMissing.push(item);
      continue;
    }
    required += 1;
    if (!isPresent(summaryText, item)) missing.push(item);
  }
  const overflow = extraction.overflowCategories.filter((category) => ENFORCED.has(category));
  return {
    ok: missing.length === 0 && overflow.length === 0 && !extraction.truncated,
    checked: items.length,
    required,
    missing,
    advisoryMissing,
    overflow,
    truncated: extraction.truncated,
  };
}

/**
 * Stable retry key for a batch under a given protection policy. Includes the
 * batch content and every setting that changes the compressed output, so an
 * input or config change re-evaluates the batch instead of staying suppressed.
 */
export function protectionFailureKey(rawText: string, config: {
  protectedSummaryTargetChars?: number;
  summarizerModel?: string;
  summarizerThinking?: string;
  summarizerPromptMode?: string;
  conciseSummaryMode?: boolean;
} | null): string {
  const policy = JSON.stringify([
    config?.protectedSummaryTargetChars ?? null,
    config?.summarizerModel ?? null,
    config?.summarizerThinking ?? null,
    config?.summarizerPromptMode ?? null,
    config?.conciseSummaryMode ?? null,
  ]);
  return createHash("sha256").update(rawText).update("\u0000").update(policy).digest("hex").slice(0, 24);
}

/** Stable short signature for logging without exposing raw values. */
export function protectionSignature(items: ProtectedItem[]): string {
  return createHash("sha256").update(items.map((i) => `${i.category}:${i.value}`).join("|")).digest("hex").slice(0, 12);
}

// Phase33: retry-suppression state lives in ./summary-protection-store.ts so it
// can be scoped per session and bounded without unbounded eviction re-sends.

/** Reason a verdict rejects the summary: an incomplete scan and overflow dominate missing items. */
export function protectionRejectionReason(verdict: ProtectionVerdict): "missing" | "overflow" | "incomplete" {
  if (verdict.truncated) return "incomplete";
  return verdict.overflow.length > 0 ? "overflow" : "missing";
}

/** Category names for the rejection notice (never raw values). */
export function protectionRejectionCategories(verdict: ProtectionVerdict): string {
  return [...new Set([...verdict.missing.map((item) => item.category), ...verdict.overflow])].join(", ");
}
