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
import { TIER1_EXTRACTORS, TIER2_EXTRACTORS, MAX_PER_CATEGORY, MAX_TIER1_SCAN, MAX_TIER2_SCAN, type Extractor } from "./summary-protection-extractors.js";
import { parseRecords, verifyStructuredSummary } from "./protected-records.js";
import { resolveIdentifiers, checkIdentifierRelations, checkStatusRelations, checkMarkerSubjects, type IdentifierPair } from "./summary-protection-semantics.js";

export type ProtectedCategory =
  | "active-sha"
  | "final-sha"
  | "head-sha"
  | "current-sha"
  | "deployed-sha"
  | "build-id"
  | "release"
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


// Extractor tables and their resource limits live in
// ./summary-protection-extractors.ts (Phase49) so this module stays bounded.


function collect(rawText: string, extractors: Extractor[], budget: number): { items: ProtectedItem[]; overflow: ProtectedCategory[]; scanned: number; truncated: boolean; oversized: boolean } {
  const seen = new Set<string>();
  const out: ProtectedItem[] = [];
  const counts = new Map<ProtectedCategory, number>();
  const overflow = new Set<ProtectedCategory>();
  let scanned = 0;
  let truncated = false;
  let oversized = false;
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
      // Phase49: a value that hits its capture cap without a legitimate
      // terminator is incomplete; fail closed instead of accepting a prefix.
      if (extractor.maxValue !== undefined && raw.length >= extractor.maxValue) {
        const nextChar = rawText[(match.index ?? 0) + match[0].length] ?? "";
        const terminated = extractor.wordBounded === true
          ? !/[A-Za-z0-9]/.test(nextChar)
          : nextChar === "" || (extractor.terminators ?? "").includes(nextChar);
        if (!terminated) oversized = true;
      }
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
  return { items: out, overflow: [...overflow], scanned, truncated, oversized };
}

export interface ProtectionExtraction {
  items: ProtectedItem[];
  overflowCategories: ProtectedCategory[];
  scanned: number;
  truncated: boolean;
  tier2Truncated: boolean;
  oversized: boolean;
  ambiguousActive: string[];
}

function collectTier1(rawText: string): { items: ProtectedItem[]; overflowCategories: ProtectedCategory[]; scanned: number; truncated: boolean; oversized: boolean; ambiguousActive: string[] } {
  const scan = collect(rawText, TIER1_EXTRACTORS, MAX_TIER1_SCAN);
  const identifiers = resolveIdentifiers(rawText);
  return { items: [...identifiers.items, ...scan.items], overflowCategories: scan.overflow, scanned: scan.scanned, truncated: scan.truncated, oversized: scan.oversized || identifiers.oversized, ambiguousActive: identifiers.ambiguous };
}

/**
 * Extracts protected items. Tier 1 is scanned first with a hard budget (a
 * truncated tier-1 scan fails closed); tier 2 uses a separate budget and is
 * reported without blocking.
 */
export function extractProtectedItemsDetailed(rawText: string): ProtectionExtraction {
  const tier1 = collectTier1(rawText);
  const tier2 = collect(rawText, TIER2_EXTRACTORS, MAX_TIER2_SCAN);
  return {
    items: [...tier1.items, ...tier2.items],
    overflowCategories: tier1.overflowCategories,
    scanned: tier1.scanned + tier2.scanned,
    truncated: tier1.truncated,
    tier2Truncated: tier2.truncated,
    oversized: tier1.oversized,
    ambiguousActive: tier1.ambiguousActive,
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
  /** A protected value hit its capture cap without a legitimate terminator. */
  oversized: boolean;
  tier1Count: number;
  tier2Count: number;
  tier2Omitted: number;
  relationsChecked: number;
  unresolvedRelations: ProtectedRelation[];
  contradictions: ProtectedRelation[];
  identifierUnresolved: IdentifierPair[];
  identifierContradictions: IdentifierPair[];
  /** Task/next items whose subject is not preserved next to them. */
  unboundTasks: ProtectedItem[];
  /** Semantic content that cannot be verified mechanically (never a pass). */
  unverifiableRelations: number;
  ambiguousActive: string[];
}


/**
 * Verifies tier-1 working state against the summary. Tier-2 detail may be
 * omitted because it stays retrievable from the index; it is counted, not
 * enforced. A tier-1 scan truncation or tier-1 overflow fails closed.
 */
export function verifyProtectedSummary(rawText: string, summaryText: string): ProtectionVerdict {
  const structured = parseRecords(summaryText);
  if (structured.length > 0) return verifyStructuredSummary(rawText, summaryText, structured);
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
  // Conflicting active identifiers can never be verified: fail closed.
  for (const category of extraction.ambiguousActive) {
    required += 1;
    missing.push({ category: category as ProtectedItem["category"], value: "<ambiguous>", exact: true, tier: 1 });
  }
  let tier2Omitted = 0;
  for (const item of tier2) {
    if (!isPresent(summaryText, item.value, item.exact)) tier2Omitted += 1;
    else advisoryMissing.push(item);
  }
  const relations = checkStatusRelations(rawText, summaryText);
  const identifiers = checkIdentifierRelations(rawText, summaryText);
  const unboundTasks = checkMarkerSubjects(rawText, summaryText, tier1.filter((item) => ["task", "next", "rollback", "error", "decision"].includes(item.category)));
  const unresolvedRelations = [...relations.unresolved, ...relations.contradictions];
  return {
    ok: missing.length === 0 && extraction.overflowCategories.length === 0 && !extraction.truncated && !extraction.oversized &&
      unresolvedRelations.length === 0 && relations.unverifiable === 0 &&
      identifiers.unresolved.length === 0 && identifiers.contradictions.length === 0 && unboundTasks.length === 0,
    checked: extraction.items.length,
    required,
    missing,
    advisoryMissing,
    overflow: extraction.overflowCategories,
    truncated: extraction.truncated,
    oversized: extraction.oversized,
    tier1Count: tier1.length,
    tier2Count: tier2.length,
    tier2Omitted,
    relationsChecked: unresolvedRelations.length + relations.unverifiable,
    unresolvedRelations,
    contradictions: relations.contradictions,
    identifierUnresolved: identifiers.unresolved,
    identifierContradictions: identifiers.contradictions,
    unboundTasks,
    unverifiableRelations: relations.unverifiable,
    ambiguousActive: extraction.ambiguousActive,
  };
}

/** Reason a verdict rejects the summary: incomplete scan and overflow dominate missing items. */
export function protectionRejectionReason(verdict: ProtectionVerdict): "missing" | "overflow" | "incomplete" {
  if (verdict.truncated) return "incomplete";
  if (verdict.oversized) return "overflow";
  return verdict.overflow.length > 0 ? "overflow" : "missing";
}

/** Category names for the rejection notice (never raw values). */
export function protectionRejectionCategories(verdict: ProtectionVerdict): string {
  return [...new Set([
    ...verdict.missing.map((item) => item.category),
    ...(verdict.unresolvedRelations.length > 0 ? ["relation" as const] : []),
    ...verdict.identifierUnresolved.map((pair) => pair.category),
    ...verdict.identifierContradictions.map((pair) => pair.category),
    ...verdict.overflow,
  ])].join(", ");
}

export { protectionFailureKey, protectionSignature } from "./summary-protection-key.js";
