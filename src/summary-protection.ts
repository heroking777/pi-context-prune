// Phase36: evidence-aware, two-tier summary protection.
//
// Tier 1 (enforced verbatim in the summary body) is the *current working state*:
// the active commit/build id, decisions, unfinished tasks, next actions,
// unresolved errors, FAIL/HOLD status and rollback instructions.
//
// Tier 2 (retrievable, not required verbatim) is detail that stays in the pruner
// index and can be found with `context_index_search` and read with
// `context_tree_query`: historical SHAs, large path lists, completed PASS
// results, diffs and transient state. Tier 2 never blocks a summary by itself.
//
// Matching is literal. Semantic relations are only checked where the raw text
// has a machine-readable structure; anything else is reported, never silently
// passed.
import { createHash } from "node:crypto";

export type ProtectedCategory =
  | "active-sha"
  | "sha"
  | "path"
  | "error"
  | "status"
  | "status-done"
  | "decision"
  | "task"
  | "next"
  | "rollback"
  | "diff"
  | "verification"
  | "relation";

export type ProtectedTier = 1 | 2;

export interface ProtectedItem {
  category: ProtectedCategory;
  /** Normalized value used for matching. */
  value: string;
  /** Case-sensitive comparison when true (hashes, paths, error identifiers). */
  exact: boolean;
  tier: ProtectedTier;
}

/** A structured FAIL/HOLD statement that must keep its subject. */
export interface ProtectedRelation {
  status: string;
  subject: string;
}

export const PROTECTION_FAILURE_MARKER = "__prunerProtectionFailed";

export interface ProtectionFailureResult {
  [PROTECTION_FAILURE_MARKER]: true;
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

const MAX_PER_CATEGORY = 25;
const MAX_TIER1_SCAN = 4000;
const MAX_TIER2_SCAN = 4000;

interface Extractor {
  category: ProtectedCategory;
  tier: ProtectedTier;
  regex: RegExp;
  group?: number;
  exact?: boolean;
  upper?: boolean;
  /** `last` keeps only the most recent match as the current value. */
  enforce: "all" | "last";
  /** High-cardinality "last" extractors do not count toward the scan budget. */
  countsTowardScan: boolean;
}

// Tier 1 — current working state.
const TIER1_EXTRACTORS: Extractor[] = [
  { category: "active-sha", tier: 1, enforce: "last", countsTowardScan: false, exact: true,
    regex: /\b(?:FINAL_SHA|BASE_SHA|CURRENT_SHA|ACTIVE_SHA|DEPLOYED_SHA|HEAD|BUILD_ID|RELEASE)\s*[=:]\s*([A-Za-z0-9._/-]{6,})/gi, group: 1 },
  { category: "decision", tier: 1, enforce: "all", countsTowardScan: true,
    regex: /\bDECISION\s*[=:]\s*([^\s,;]{1,80})/gi, group: 1 },
  { category: "decision", tier: 1, enforce: "all", countsTowardScan: true,
    regex: /\bdecided\s+to\s+([^.;\n]{1,60})/gi, group: 1 },
  { category: "task", tier: 1, enforce: "all", countsTowardScan: true,
    regex: /\bUNFINISHED_TASK\s*[=:]\s*([^\n]{1,80})/gi, group: 1 },
  { category: "task", tier: 1, enforce: "all", countsTowardScan: true,
    regex: /\bTODO\s*[=:]\s*([^\n]{1,80})/gi, group: 1 },
  { category: "next", tier: 1, enforce: "all", countsTowardScan: true,
    regex: /\bNEXT(?:_ACTION|_TASK|_STEP)?\s*[=:]\s*([^\n]{1,80})/gi, group: 1 },
  { category: "rollback", tier: 1, enforce: "all", countsTowardScan: true,
    regex: /\bROLLBACK\s*[=:]\s*([^\n]{1,80})/gi, group: 1 },
  { category: "status", tier: 1, enforce: "all", countsTowardScan: true, upper: true,
    regex: /\b(FAIL|HOLD|BLOCKED|UNKNOWN)\b/g, group: 1 },
  { category: "error", tier: 1, enforce: "last", countsTowardScan: false, exact: true,
    regex: /\b[A-Z][A-Za-z0-9]*(?:Error|Exception|Failure)\b/g },
  { category: "error", tier: 1, enforce: "last", countsTowardScan: false,
    regex: /\bERROR\s*[:=]\s*([^\n]{1,80})/g, group: 1 },
];

// Tier 2 — retrievable detail, never blocking.
const TIER2_EXTRACTORS: Extractor[] = [
  { category: "sha", tier: 2, enforce: "all", countsTowardScan: true, exact: true,
    regex: /\b[0-9a-f]{40}\b|\b[0-9a-f]{64}\b/g },
  { category: "path", tier: 2, enforce: "all", countsTowardScan: true, exact: true,
    regex: /\/[\w.@+-]+(?:\/[\w.@+-]+)*\.[A-Za-z0-9]{1,8}\b/g },
  { category: "status-done", tier: 2, enforce: "all", countsTowardScan: true, upper: true,
    regex: /\b(PASS|SUCCESS|DEGRADED)\b/g, group: 1 },
  { category: "diff", tier: 2, enforce: "all", countsTowardScan: true,
    regex: /\b(?:BEFORE|AFTER|DIFF)\s*[=:]\s*([^\n]{1,80})/gi, group: 1 },
  { category: "verification", tier: 2, enforce: "all", countsTowardScan: true,
    regex: /\b(re-?verified|tests?\s+passed|tests?\s+failed)\b/gi, group: 1 },
];

const RELATION_REGEXES = [
  /([A-Za-z0-9_.:/-]{2,40})\s*[:=]\s*(FAIL|HOLD|BLOCKED)\b/g,
  /\b(FAIL|HOLD|BLOCKED)\s+(?:for|on|in)\s+([A-Za-z0-9_.:/-]{2,40})/g,
];

function collect(rawText: string, extractors: Extractor[], budget: number): { items: ProtectedItem[]; overflow: ProtectedCategory[]; scanned: number; truncated: boolean } {
  const seen = new Set<string>();
  const out: ProtectedItem[] = [];
  const counts = new Map<ProtectedCategory, number>();
  const overflow = new Set<ProtectedCategory>();
  let scanned = 0;
  let truncated = false;
  outer: for (const extractor of extractors) {
    const regex = new RegExp(extractor.regex.source, extractor.regex.flags);
    const matches = [...rawText.matchAll(regex)];
    const selected = extractor.enforce === "last" ? matches.slice(-1) : matches;
    for (const match of selected) {
      if (extractor.countsTowardScan) {
        if (scanned >= budget) { truncated = true; break outer; }
        scanned += 1;
      }
      const raw = extractor.group === undefined ? match[0] : match[extractor.group];
      if (raw === undefined || raw.length === 0) continue;
      const value = extractor.upper ? raw.trim().toUpperCase() : raw.trim();
      const key = `${extractor.category}\u0000${extractor.exact ? value : value.toLowerCase()}`;
      if (seen.has(key)) continue;
      const count = counts.get(extractor.category) ?? 0;
      if (count >= MAX_PER_CATEGORY) { overflow.add(extractor.category); continue; }
      counts.set(extractor.category, count + 1);
      seen.add(key);
      out.push({ category: extractor.category, value, exact: extractor.exact === true, tier: extractor.tier });
    }
  }
  return { items: out, overflow: [...overflow], scanned, truncated };
}

function collectRelations(rawText: string): ProtectedRelation[] {
  const seen = new Set<string>();
  const out: ProtectedRelation[] = [];
  for (const regex of RELATION_REGEXES) {
    for (const match of rawText.matchAll(new RegExp(regex.source, regex.flags))) {
      const first = match[1];
      const second = match[2];
      const status = /^(FAIL|HOLD|BLOCKED)$/i.test(first) ? first : second;
      const subject = status === first ? second : first;
      if (!status || !subject) continue;
      const key = `${status.toUpperCase()}\u0000${subject.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (out.length >= MAX_PER_CATEGORY) break;
      out.push({ status: status.toUpperCase(), subject });
    }
  }
  return out;
}

export interface ProtectionExtraction {
  items: ProtectedItem[];
  overflowCategories: ProtectedCategory[];
  scanned: number;
  truncated: boolean;
  tier2Truncated: boolean;
  relations: ProtectedRelation[];
}

/**
 * Extracts protected items. Tier 1 is scanned first with a hard budget (a
 * truncated tier-1 scan fails closed); tier 2 uses a separate budget and is
 * reported without blocking.
 */
export function extractProtectedItemsDetailed(rawText: string): ProtectionExtraction {
  const tier1 = collect(rawText, TIER1_EXTRACTORS, MAX_TIER1_SCAN);
  const tier2 = collect(rawText, TIER2_EXTRACTORS, MAX_TIER2_SCAN);
  return {
    items: [...tier1.items, ...tier2.items],
    overflowCategories: tier1.overflow,
    scanned: tier1.scanned + tier2.scanned,
    truncated: tier1.truncated,
    tier2Truncated: tier2.truncated,
    relations: collectRelations(rawText),
  };
}

export function extractProtectedItems(rawText: string): ProtectedItem[] {
  return extractProtectedItemsDetailed(rawText).items;
}

function isPresent(summaryText: string, value: string, exact: boolean): boolean {
  return exact ? summaryText.includes(value) : summaryText.toLowerCase().includes(value.toLowerCase());
}

export interface ProtectionVerdict {
  ok: boolean;
  checked: number;
  required: number;
  missing: ProtectedItem[];
  advisoryMissing: ProtectedItem[];
  overflow: ProtectedCategory[];
  truncated: boolean;
  tier1Count: number;
  tier2Count: number;
  tier2Omitted: number;
  relationsChecked: number;
  unresolvedRelations: ProtectedRelation[];
}

/**
 * Verifies tier-1 working state against the summary. Tier-2 detail may be
 * omitted because it stays retrievable from the index; it is counted, not
 * enforced. A tier-1 scan truncation or tier-1 overflow fails closed.
 */
export function verifyProtectedSummary(rawText: string, summaryText: string): ProtectionVerdict {
  const extraction = extractProtectedItemsDetailed(rawText);
  const tier1 = extraction.items.filter((item) => item.tier === 1);
  const tier2 = extraction.items.filter((item) => item.tier === 2);
  const missing: ProtectedItem[] = [];
  const advisoryMissing: ProtectedItem[] = [];
  let required = 0;
  for (const item of tier1) {
    required += 1;
    if (!isPresent(summaryText, item.value, item.exact)) missing.push(item);
  }
  let tier2Omitted = 0;
  for (const item of tier2) {
    if (!isPresent(summaryText, item.value, item.exact)) tier2Omitted += 1;
    else advisoryMissing.push(item);
  }
  const unresolvedRelations = extraction.relations.filter(
    (relation) => !isPresent(summaryText, relation.subject, false) || !isPresent(summaryText, relation.status, false),
  );
  const missingCategories: ProtectedCategory[] = missing.map((item) => item.category);
  if (unresolvedRelations.length > 0) missingCategories.push("relation");
  return {
    ok: missing.length === 0 && extraction.overflowCategories.length === 0 && !extraction.truncated && unresolvedRelations.length === 0,
    checked: extraction.items.length,
    required,
    missing,
    advisoryMissing,
    overflow: extraction.overflowCategories,
    truncated: extraction.truncated,
    tier1Count: tier1.length,
    tier2Count: tier2.length,
    tier2Omitted,
    relationsChecked: extraction.relations.length,
    unresolvedRelations,
  };
}

/** Reason a verdict rejects the summary: incomplete scan and overflow dominate missing items. */
export function protectionRejectionReason(verdict: ProtectionVerdict): "missing" | "overflow" | "incomplete" {
  if (verdict.truncated) return "incomplete";
  return verdict.overflow.length > 0 ? "overflow" : "missing";
}

/** Category names for the rejection notice (never raw values). */
export function protectionRejectionCategories(verdict: ProtectionVerdict): string {
  return [...new Set([
    ...verdict.missing.map((item) => item.category),
    ...(verdict.unresolvedRelations.length > 0 ? ["relation" as const] : []),
    ...verdict.overflow,
  ])].join(", ");
}

export { protectionFailureKey, protectionSignature } from "./summary-protection-key.js";
