// Phase37: semantics for the protection guard — active-identifier resolution and
// structured status/subject relations. Type-only import from
// ./summary-protection.ts keeps this module free of a runtime cycle.
import type { ProtectedCategory, ProtectedItem, ProtectedRelation, ProtectedTier } from "./summary-protection.js";

// Identifier roles. Each label is a distinct role: values may differ across
// roles (GitHub HEAD vs VPS DEPLOYED_SHA vs BUILD_ID) without being a conflict.
// BASE_SHA is a comparison origin, never a current value, so it is tier 2.
const IDENTIFIER_ROLES: { role: string; label: string; category: ProtectedCategory; tier: ProtectedTier }[] = [
  { role: "final-sha", label: "FINAL_SHA", category: "final-sha", tier: 1 },
  { role: "head-sha", label: "HEAD", category: "head-sha", tier: 1 },
  { role: "current-sha", label: "CURRENT_SHA", category: "current-sha", tier: 1 },
  { role: "deployed-sha", label: "DEPLOYED_SHA", category: "deployed-sha", tier: 1 },
  { role: "active-sha", label: "ACTIVE_SHA", category: "active-sha", tier: 1 },
  { role: "build-id", label: "BUILD_ID", category: "build-id", tier: 1 },
  { role: "release", label: "RELEASE", category: "release", tier: 1 },
  { role: "base-sha", label: "BASE_SHA", category: "sha", tier: 2 },
];

export interface IdentifierPair {
  role: string;
  value: string;
  /** Nearest preceding tool-call subject, or "unknown" when it cannot be told. */
  subject: string;
  category: ProtectedCategory;
  tier: ProtectedTier;
}

// Commands whose output is an authoritative statement of the current HEAD.
// Anything else (git log/show/diff/rev-list) is historical evidence only.
const AUTHORITATIVE_HEAD = /(?:rev-parse|symbolic-ref|describe|status\s+-b)/i;

function toolLineAtIndex(rawText: string, index: number): string {
  const before = rawText.slice(0, index);
  const toolIndex = before.lastIndexOf("\nTool:");
  return before.slice(toolIndex + 1).split("\n")[0] ?? "";
}

/** Public alias used by the deterministic core builder. */
export function subjectForValue(rawText: string, value: string): string {
  const index = rawText.indexOf(value);
  return index < 0 ? "unknown" : subjectAtIndex(rawText, index);
}

/**
 * The single authoritative subject resolver: nearest preceding tool-call
 * subject (path, owner/repo or tool name). Every caller — identifier
 * extraction, core construction and guard validation — uses this.
 */
export function subjectAtIndex(rawText: string, index: number): string {
  // Only a line that actually starts a tool call can carry the subject. Text
  // before the first tool block (assistant prose) is not call-local.
  const before = rawText.slice(0, index);
  const lines = before.split("\n");
  let line = "";
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].startsWith("Tool: ")) { line = lines[i]; break; }
  }
  if (line === "") return "unknown";
  const path = line.match(/(?:\/[\w.@+-]+)+/);
  if (path) return path[0];
  const repo = line.match(/\b[\w.-]+\/[\w.-]+\b/);
  if (repo) return repo[0];
  const tool = line.match(/Tool:\s*(\w+)/);
  return tool ? tool[1] : "unknown";
}

function subjectAt(rawText: string, index: number): string {
  return subjectAtIndex(rawText, index);
}

export interface IdentifierResolution {
  items: ProtectedItem[];
  pairs: IdentifierPair[];
  /** Roles whose same-role/same-subject values disagree (fail closed). */
  ambiguous: string[];
  /** A labelled value hit its capture cap without a legitimate terminator. */
  oversized: boolean;
}

/**
 * Resolves labelled identifiers per role and subject. Cross-role disagreement is
 * normal; only the same role with contradictory values (or an unknown subject
 * with several values) is ambiguous and fails closed.
 */
export function resolveIdentifiers(rawText: string): IdentifierResolution {
  const pairs: IdentifierPair[] = [];
  let oversized = false;
  const MAX_IDENTIFIER_CHARS = 200;
  for (const spec of IDENTIFIER_ROLES) {
    const regex = new RegExp(`\\b${spec.label}\\s*[=:]\\s*([A-Za-z0-9._/-]{2,${MAX_IDENTIFIER_CHARS}})`, "gi");
    for (const match of rawText.matchAll(regex)) {
      const value = match[1];
      if (typeof value !== "string") continue;
      const nextChar = rawText[(match.index ?? 0) + match[0].length] ?? "";
      if (value.length >= MAX_IDENTIFIER_CHARS && /[A-Za-z0-9._/-]/.test(nextChar)) oversized = true;
      // A HEAD value is only the active HEAD when an authoritative command
      // produced it; historical log/diff values are never promoted.
      if (spec.role === "head-sha" && !AUTHORITATIVE_HEAD.test(toolLineAtIndex(rawText, match.index ?? 0))) continue;
      pairs.push({ role: spec.role, value, subject: subjectAt(rawText, match.index ?? 0), category: spec.category, tier: spec.tier });
    }
  }
  const byKey = new Map<string, Set<string>>();
  for (const pair of pairs) {
    const key = `${pair.role}\u0000${pair.subject === "unknown" ? "<unknown>" : pair.subject}`;
    if (!byKey.has(key)) byKey.set(key, new Set());
    byKey.get(key)!.add(pair.value);
  }
  const ambiguous = new Set<string>();
  for (const [key, values] of byKey) if (values.size > 1) ambiguous.add(key.split("\u0000")[0]);
  const seen = new Set<string>();
  const items: ProtectedItem[] = [];
  for (const pair of pairs) {
    const key = `${pair.category}\u0000${pair.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ category: pair.category, value: pair.value, exact: true, tier: pair.tier });
  }
  return { items, pairs, ambiguous: [...ambiguous], oversized };
}

export interface IdentifierCheck {
  unresolved: IdentifierPair[];
  contradictions: IdentifierPair[];
}

interface SummaryOccurrence extends IdentifierPair { index: number; }

function summaryIdentifierOccurrences(summaryText: string): SummaryOccurrence[] {
  const out: SummaryOccurrence[] = [];
  for (const spec of IDENTIFIER_ROLES) {
    if (spec.tier !== 1) continue;
    const regex = new RegExp(`\\b${spec.label}\\s*[=:]\\s*([A-Za-z0-9._/-]{2,})`, "gi");
    for (const match of summaryText.matchAll(regex)) {
      const value = match[1];
      if (typeof value === "string") out.push({ role: spec.role, value, subject: "summary", category: spec.category, tier: 1, index: match.index ?? 0 });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

/** Nearest raw subject token before a position, or undefined when none precedes it. */
function nearestSubject(summaryText: string, index: number, subjects: string[]): string | undefined {
  let best: { subject: string; position: number } | undefined;
  for (const subject of subjects) {
    const position = summaryText.lastIndexOf(subject, index);
    // Prefer the longest subject on a tie: a shorter prefix such as /srv/repo
    // starts at the same offset as /srv/repo/file and must not win.
    if (position >= 0 && (!best || position > best.position || (position === best.position && subject.length > best.subject.length))) {
      best = { subject, position };
    }
  }
  return best?.subject;
}

/**
 * Every tier-1 identifier must keep its role, value AND subject. When a role has
 * several subjects (so values could be swapped) the subject nearest to the
 * summary occurrence must match; otherwise the item is unresolved. A single
 * subject per role needs no explicit binding because there is nothing to swap.
 */
export function checkIdentifierRelations(rawText: string, summaryText: string): IdentifierCheck {
  const rawPairs = resolveIdentifiers(rawText).pairs.filter((pair) => pair.tier === 1);
  const subjectsByRole = new Map<string, Set<string>>();
  for (const pair of rawPairs) {
    if (pair.subject === "unknown") continue;
    if (!subjectsByRole.has(pair.role)) subjectsByRole.set(pair.role, new Set());
    subjectsByRole.get(pair.role)!.add(pair.subject);
  }
  const occurrences = summaryIdentifierOccurrences(summaryText);
  const unresolved: IdentifierPair[] = [];
  const contradictions: IdentifierPair[] = [];
  for (const pair of rawPairs) {
    const subjects = [...(subjectsByRole.get(pair.role) ?? new Set<string>())];
    const matches = occurrences.filter((occurrence) => occurrence.role === pair.role && occurrence.value === pair.value);
    if (matches.length > 0) {
      if (subjects.length <= 1) continue;
      if (pair.subject === "unknown") { unresolved.push(pair); continue; }
      const bound = matches.some((occurrence) => nearestSubject(summaryText, occurrence.index, subjects) === pair.subject);
      if (bound) continue;
      contradictions.push(pair);
      continue;
    }
    const sameRole = occurrences.some((occurrence) => occurrence.role === pair.role);
    (sameRole ? contradictions : unresolved).push(pair);
  }
  return { unresolved, contradictions };
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

/** Structured status/subject pairs with their source offset. */
export function extractStatusPairsIndexed(text: string): (ProtectedRelation & { index: number })[] {
  const out: (ProtectedRelation & { index: number })[] = [];
  for (const regex of PAIR_REGEXES) {
    for (const match of text.matchAll(new RegExp(regex.source, regex.flags))) {
      const pair = normalizePair(match[1], match[2]);
      if (pair) out.push({ ...pair, index: match.index ?? 0 });
    }
  }
  return out;
}

/** Structured status/subject pairs in text order. */
export function extractStatusPairs(text: string): ProtectedRelation[] {
  return extractStatusPairsIndexed(text).map(({ status, subject }) => ({ status, subject }));
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

/**
 * Requires each task/next marker to keep its subject nearby: the subject the
 * marker had in the raw batch must appear shortly before the marker in the
 * summary. A task without its subject cannot be safely verified.
 */
export function checkMarkerSubjects(rawText: string, summaryText: string, items: ProtectedItem[]): ProtectedItem[] {
  const universe = new Set<string>();
  for (const match of rawText.matchAll(/(?:\/[\w.@+-]+)+/g)) {
    universe.add(match[0]);
    if (universe.size >= 200) break;
  }
  const subjects = [...universe];
  const unresolved: ProtectedItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    let from = 0;
    for (;;) {
      const rawIndex = rawText.indexOf(item.value, from);
      if (rawIndex < 0) break;
      from = rawIndex + item.value.length;
      const expected = subjectAtIndex(rawText, rawIndex);
      // Only structured subjects (paths / owner-repo) are meaningful; a bare
      // tool name cannot bind a marker to a target.
      if (expected === "unknown" || !expected.includes("/")) continue;
      let bound = false;
      let cursor = 0;
      for (;;) {
        const summaryIndex = summaryText.indexOf(item.value, cursor);
        if (summaryIndex < 0) break;
        cursor = summaryIndex + item.value.length;
        // Exact structured binding: the nearest subject before this occurrence
        // must be the expected one, not merely somewhere in a 200-char window.
        if (nearestSubject(summaryText, summaryIndex, subjects) === expected) { bound = true; break; }
      }
      if (!bound) {
        const key = `${item.category}|${expected}|${item.value}`;
        if (!seen.has(key)) { seen.add(key); unresolved.push(item); }
      }
    }
  }
  return unresolved;
}
