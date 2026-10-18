// Phase49: protected-value extractor tables with explicit resource limits.
// Type-only import keeps this module free of a runtime cycle.
import type { ProtectedCategory, ProtectedTier } from "./summary-protection.js";

export const MAX_PER_CATEGORY = 25;
export const MAX_TIER1_SCAN = 4000;
export const MAX_TIER2_SCAN = 4000;

export interface Extractor {
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
  /** Hard cap on the captured value length. */
  maxValue?: number;
  /** Characters that legitimately terminate the value. */
  terminators?: string;
  /** Word-bounded values (identifiers) must not be followed by a word char. */
  wordBounded?: boolean;
}

// Tier 1 — current working state. Active commit/build/release identifiers are
// resolved separately (see ./summary-protection-semantics.ts) so that
// BASE_SHA is never treated as the current revision and conflicting values
// fail closed.
export const TIER1_EXTRACTORS: Extractor[] = [
  { category: "decision", tier: 1, enforce: "all", countsTowardScan: true,
    regex: /\bDECISION\s*[=:]\s*([^\s,;]{1,400})/gi, group: 1, maxValue: 400, terminators: " \t,;\n" },
  { category: "decision", tier: 1, enforce: "all", countsTowardScan: true,
    regex: /\bdecided\s+to\s+([^.;\n]{1,300})/gi, group: 1, maxValue: 300, terminators: ".;\n" },
  { category: "task", tier: 1, enforce: "all", countsTowardScan: true,
    regex: /\bUNFINISHED_TASK\s*[=:]\s*([^;\n]{1,2000})/gi, group: 1, maxValue: 2000, terminators: ";\n" },
  { category: "task", tier: 1, enforce: "all", countsTowardScan: true,
    regex: /\bTODO\s*[=:]\s*([^;\n]{1,2000})/gi, group: 1, maxValue: 2000, terminators: ";\n" },
  { category: "next", tier: 1, enforce: "all", countsTowardScan: true,
    regex: /\bNEXT(?:_ACTION|_TASK|_STEP)?\s*[=:]\s*([^;\n]{1,2000})/gi, group: 1, maxValue: 2000, terminators: ";\n" },
  { category: "rollback", tier: 1, enforce: "all", countsTowardScan: true,
    regex: /\bROLLBACK\s*[=:]\s*([^;\n]{1,2000})/gi, group: 1, maxValue: 2000, terminators: ";\n" },
  { category: "status", tier: 1, enforce: "all", countsTowardScan: true, upper: true,
    regex: /\b(FAIL|HOLD|BLOCKED|UNKNOWN)\b/g, group: 1 },
  { category: "error", tier: 1, enforce: "last", countsTowardScan: false, exact: true,
    regex: /\b[A-Z][A-Za-z0-9]{0,200}(?:Error|Exception|Failure)\b/g, maxValue: 200, wordBounded: true },
  { category: "error", tier: 1, enforce: "last", countsTowardScan: false,
    regex: /\bERROR\s*[:=]\s*([^\n]{1,2000})/g, group: 1, maxValue: 2000, terminators: "\n" },
];

// Tier 2 — retrievable detail, never blocking.
export const TIER2_EXTRACTORS: Extractor[] = [
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
