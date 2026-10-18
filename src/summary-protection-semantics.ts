// Phase37: semantics for the protection guard — active-identifier resolution and
// structured status/subject relations. Type-only import from
// ./summary-protection.ts keeps this module free of a runtime cycle.
import type { ProtectedItem, ProtectedRelation } from "./summary-protection.js";

// Commit-like labels. BASE_SHA is deliberately excluded: it is a base, never the
// current revision.
const COMMIT_LABELS = ["CURRENT_SHA", "ACTIVE_SHA", "DEPLOYED_SHA", "FINAL_SHA", "HEAD"];
const BUILD_LABELS = ["BUILD_ID"];
const RELEASE_LABELS = ["RELEASE"];

function labeledValues(rawText: string, labels: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const label of labels) {
    const regex = new RegExp(`\\b${label}\\s*[=:]\\s*([A-Za-z0-9._/-]{2,})`, "gi");
    const values = [...rawText.matchAll(regex)].map((match) => match[1]).filter((value): value is string => typeof value === "string");
    if (values.length > 0) out.set(label, values);
  }
  return out;
}

export interface ActiveIdentifiers {
  items: ProtectedItem[];
  /** Identifier classes that have conflicting values (fail closed). */
  ambiguous: string[];
}

/**
 * Resolves the active commit/build/release identifiers. Commit-like labels that
 * disagree with each other are ambiguous (never guessed); BASE_SHA is not a
 * current value; build and release identifiers are kept as separate classes and
 * are never substituted for one another.
 */
export function resolveActiveIdentifiers(rawText: string): ActiveIdentifiers {
  const items: ProtectedItem[] = [];
  const ambiguous: string[] = [];

  const commitValues = new Set<string>();
  for (const values of labeledValues(rawText, COMMIT_LABELS).values()) for (const value of values) commitValues.add(value);
  if (commitValues.size > 1) ambiguous.push("active-sha");
  else if (commitValues.size === 1) items.push({ category: "active-sha", value: [...commitValues][0], exact: true, tier: 1 });

  for (const [category, labels] of [["build-id", BUILD_LABELS], ["release", RELEASE_LABELS]] as const) {
    for (const values of labeledValues(rawText, [...labels]).values()) {
      const distinct = [...new Set(values)];
      if (distinct.length > 1) ambiguous.push(category);
      else if (distinct.length === 1) items.push({ category, value: distinct[0], exact: true, tier: 1 });
    }
  }
  return { items, ambiguous };
}

const STATUS_WORD = /\b(FAIL|HOLD|BLOCKED)\b/gi;
const PAIR_REGEXES = [
  /([A-Za-z0-9_.:/-]{2,40})\s*[:=]\s*(FAIL|HOLD|BLOCKED)\b/gi,
  /\b(FAIL|HOLD|BLOCKED)\s+(?:for|on|in)\s+([A-Za-z0-9_.:/-]{2,40})/gi,
];

function normalizePair(first: string, second: string): ProtectedRelation | null {
  const firstIsStatus = /^(FAIL|HOLD|BLOCKED)$/i.test(first);
  const status = (firstIsStatus ? first : second).toUpperCase();
  const subject = (firstIsStatus ? second : first).trim();
  if (!subject) return null;
  return { status, subject };
}

/** Structured status/subject pairs in text order. */
export function extractStatusPairs(text: string): ProtectedRelation[] {
  const out: ProtectedRelation[] = [];
  for (const regex of PAIR_REGEXES) {
    for (const match of text.matchAll(new RegExp(regex.source, regex.flags))) {
      const pair = normalizePair(match[1], match[2]);
      if (pair) out.push(pair);
    }
  }
  return out;
}

function pairKey(subject: string, status: string): string {
  return `${subject.toLowerCase()}\u0000${status.toUpperCase()}`;
}

export interface RelationCheck {
  unresolved: ProtectedRelation[];
  /** Structured statuses with no machine-readable subject (semantic UNKNOWN). */
  unverifiable: number;
  /** Subjects whose summary status differs from the raw status. */
  contradictions: ProtectedRelation[];
}

/**
 * Verifies every structured raw pair against the summary's structured pairs.
 * A subject mapped to a different status in the summary is a contradiction and
 * is rejected (e.g. raw `JRA=FAIL, Boat=PASS` vs summary `JRA=PASS, Boat=FAIL`).
 * Status words without any structured subject are reported as unverifiable
 * UNKNOWN rather than passed.
 */
export function checkStatusRelations(rawText: string, summaryText: string): RelationCheck {
  const rawPairs = extractStatusPairs(rawText);
  const summaryPairs = new Set(extractStatusPairs(summaryText).map((pair) => pairKey(pair.subject, pair.status)));
  const unresolved: ProtectedRelation[] = [];
  const contradictions: ProtectedRelation[] = [];
  for (const pair of rawPairs) {
    if (summaryPairs.has(pairKey(pair.subject, pair.status))) continue;
    const sameSummary = extractStatusPairs(summaryText).some((candidate) => candidate.subject.toLowerCase() === pair.subject.toLowerCase());
    (sameSummary ? contradictions : unresolved).push(pair);
  }
  const statusCount = [...rawText.matchAll(new RegExp(STATUS_WORD.source, STATUS_WORD.flags))].length;
  const covered = new Set(rawPairs.map((pair) => `${pair.status}\u0000${pair.subject.toLowerCase()}`)).size;
  const unverifiable = Math.max(0, statusCount - covered);
  return { unresolved, unverifiable, contradictions };
}
