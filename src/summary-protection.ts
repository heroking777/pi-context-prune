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
  /** `missing` = an enforced item was dropped; `overflow` = too many to verify. */
  reason: "missing" | "overflow";
  /** Opaque retry-suppression key (no raw content). */
  key: string;
  missingCategories: ProtectedCategory[];
  missingCount: number;
}

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
} {
  const seen = new Set<string>();
  const out: ProtectedItem[] = [];
  const counts = new Map<ProtectedCategory, number>();
  const overflow = new Set<ProtectedCategory>();
  let scanned = 0;
  for (const extractor of EXTRACTORS) {
    if (scanned >= MAX_TOTAL_MATCHES) break;
    const regex = new RegExp(extractor.regex.source, extractor.regex.flags);
    for (const match of rawText.matchAll(regex)) {
      scanned += 1;
      if (scanned > MAX_TOTAL_MATCHES) break;
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
  return { items: out, overflowCategories: [...overflow], scanned };
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
}

/**
 * Verifies that enforced protected items survive into the summary. Returns
 * `ok:false` when any enforced item is missing or any enforced category
 * overflowed (so unverified items are never silently passed), letting the
 * caller reject the summary and keep the raw output on the existing restore
 * path.
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
  return { ok: missing.length === 0 && overflow.length === 0, checked: items.length, required, missing, advisoryMissing, overflow };
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

// ── Phase32: retry suppression for protection failures ────────────────────
// In-memory and bounded. Keyed on batch content + protection policy, so an
// input or config change re-evaluates the batch. Process-scoped: after a restart
// the batch may be attempted once more (and re-recorded), keeping raw intact
// while avoiding unbounded automatic retries within one session.
const MAX_PROTECTION_FAILURES = 256;
const protectionFailures = new Map<string, "missing" | "overflow">();

export function protectionFailureCount(): number {
  return protectionFailures.size;
}

export function clearProtectionFailures(): void {
  protectionFailures.clear();
}

export function getSuppressedProtectionFailure(key: string): "missing" | "overflow" | undefined {
  return protectionFailures.get(key);
}

export function rememberProtectionFailure(key: string, reason: "missing" | "overflow"): void {
  if (protectionFailures.has(key)) protectionFailures.delete(key);
  protectionFailures.set(key, reason);
  while (protectionFailures.size > MAX_PROTECTION_FAILURES) {
    const oldest = protectionFailures.keys().next().value;
    if (oldest === undefined) break;
    protectionFailures.delete(oldest);
  }
}

/** Reason a verdict rejects the summary: overflow dominates missing items. */
export function protectionRejectionReason(verdict: ProtectionVerdict): "missing" | "overflow" {
  return verdict.overflow.length > 0 ? "overflow" : "missing";
}

/** Category names for the rejection notice (never raw values). */
export function protectionRejectionCategories(verdict: ProtectionVerdict): string {
  return [...new Set([...verdict.missing.map((item) => item.category), ...verdict.overflow])].join(", ");
}

export function protectionFailureResult(
  key: string,
  reason: "missing" | "overflow",
  missing: ProtectedItem[] = [],
): ProtectionFailureResult {
  return {
    [PROTECTION_FAILURE_MARKER]: true,
    reason,
    key,
    missingCategories: [...new Set(missing.map((item) => item.category))] as ProtectionFailureResult["missingCategories"],
    missingCount: missing.length,
  };
}
