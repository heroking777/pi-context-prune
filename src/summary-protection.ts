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

const MAX_PER_CATEGORY = 25;

interface Extractor {
  category: ProtectedCategory;
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
 * Extracts protected items from raw batch text. Bounded per category so a huge
 * batch cannot make verification unbounded.
 */
export function extractProtectedItems(rawText: string): ProtectedItem[] {
  const seen = new Set<string>();
  const out: ProtectedItem[] = [];
  const counts = new Map<ProtectedCategory, number>();
  for (const extractor of EXTRACTORS) {
    const regex = new RegExp(extractor.regex.source, extractor.regex.flags);
    for (const match of rawText.matchAll(regex)) {
      const raw = extractor.group === undefined ? match[0] : match[extractor.group];
      if (raw === undefined || raw.length === 0) continue;
      const item = normalize({ category: extractor.category, value: raw, exact: extractor.exact ?? false, upper: extractor.upper });
      const key = `${item.category}\u0000${item.exact ? item.value : item.value.toLowerCase()}`;
      if (seen.has(key)) continue;
      const count = counts.get(item.category) ?? 0;
      if (count >= MAX_PER_CATEGORY) continue;
      counts.set(item.category, count + 1);
      seen.add(key);
      out.push(item);
    }
  }
  return out;
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
}

/**
 * Verifies that enforced protected items survive into the summary. Returns
 * `ok:false` when any enforced item is missing so the caller can reject the
 * summary and keep the raw output on the existing restore path.
 */
export function verifyProtectedSummary(rawText: string, summaryText: string): ProtectionVerdict {
  const items = extractProtectedItems(rawText);
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
  return { ok: missing.length === 0, checked: items.length, required, missing, advisoryMissing };
}

/** Stable short signature for logging without exposing raw values. */
export function protectionSignature(items: ProtectedItem[]): string {
  return createHash("sha256").update(items.map((i) => `${i.category}:${i.value}`).join("|")).digest("hex").slice(0, 12);
}
