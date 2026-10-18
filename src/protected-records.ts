// Phase50: structured protected records.
//
// A protected record is a tuple (category, subject, value[, role]) rendered as a
// single `@rec {json}` line. The deterministic core emits these records and the
// guard verifies them by exact tuple equality — never by substring proximity.
// The same `expectedRecords` function is the single authority for both.
import { extractProtectedItemsDetailed, type ProtectedItem, type ProtectionVerdict } from "./summary-protection.js";
import { extractStatusPairs, resolveIdentifiers, subjectAtIndex } from "./summary-protection-semantics.js";

export interface ProtectedRecord {
  /** `id`, `st`, or a marker category (task/next/rollback/decision/error). */
  c: string;
  /** Exact subject from the authoritative resolver. */
  s: string;
  /** Exact value (or status word for `st`). */
  v: string;
  /** Role label for `id` records. */
  r?: string;
  /** True when no meaningful subject could be established (explicit unknown). */
  u?: true;
}

export const ROLE_LABEL: Record<string, string> = {
  "final-sha": "FINAL_SHA",
  "head-sha": "HEAD",
  "current-sha": "CURRENT_SHA",
  "deployed-sha": "DEPLOYED_SHA",
  "active-sha": "ACTIVE_SHA",
  "build-id": "BUILD_ID",
  release: "RELEASE",
};
export const MARKER_CATEGORIES = new Set(["decision", "task", "next", "rollback", "error"]);
const PREFIX = "@rec ";
const MAX_RECORDS = 200;

export function renderRecord(record: ProtectedRecord): string {
  return PREFIX + JSON.stringify(record);
}

const VALID_CATEGORIES = new Set(["id", "st", "task", "next", "rollback", "decision", "error"]);
const VALID_ROLES = new Set(Object.values(ROLE_LABEL));

/** A line is record-intended when it starts with `@rec` as a token. */
export function isRecordIntended(line: string): boolean {
  return /^@rec(?:\s|$|\{)/.test(line.trim());
}

export interface StrictParse {
  ok: boolean;
  records: ProtectedRecord[];
  malformed: number;
  intended: number;
}

function validateRecord(value: unknown): ProtectedRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.c !== "string" || !VALID_CATEGORIES.has(record.c)) return null;
  if (typeof record.s !== "string" || record.s.length === 0) return null;
  if (typeof record.v !== "string" || record.v.length === 0) return null;
  if (record.r !== undefined) {
    if (record.c !== "id" || typeof record.r !== "string" || !VALID_ROLES.has(record.r)) return null;
  }
  if (record.u !== undefined && record.u !== true) return null;
  for (const key of Object.keys(record)) {
    if (!["c", "s", "v", "r", "u"].includes(key)) return null;
  }
  const base: ProtectedRecord = { c: record.c, s: record.s, v: record.v };
  if (record.r !== undefined) base.r = record.r as string;
  if (record.u === true) base.u = true;
  return base;
}

/**
 * Strict parser for structured summaries. Every `@rec`-intended line must be a
 * valid record; malformed, unknown-category or unsupported-shape lines make the
 * whole parse invalid (the caller then fails closed instead of downgrading to
 * prose verification). Exact duplicate tuples collapse; near-duplicates are kept
 * and rejected later by set verification.
 */
export function parseRecordsStrict(text: string): StrictParse {
  const records: ProtectedRecord[] = [];
  const seen = new Set<string>();
  let malformed = 0;
  let intended = 0;
  for (const line of text.split("\n")) {
    if (!isRecordIntended(line)) continue;
    intended += 1;
    const body = line.trim().slice(PREFIX.length).trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      malformed += 1;
      continue;
    }
    const record = validateRecord(parsed);
    if (!record) {
      malformed += 1;
      continue;
    }
    const key = JSON.stringify(record);
    if (seen.has(key)) continue;
    seen.add(key);
    records.push(record);
  }
  return { ok: malformed === 0, records, malformed, intended };
}

/** Convenience wrapper returning only the parsed records. */
export function parseRecords(text: string): ProtectedRecord[] {
  return parseRecordsStrict(text).records;
}

export interface ExpectedRecords {
  ok: boolean;
  records: ProtectedRecord[];
  reason?: string;
}

/**
 * Derives the authoritative record set for a raw batch. Ambiguous identifiers,
 * oversized values and record overflow are explicit failures.
 */
export function expectedRecords(rawText: string): ExpectedRecords {
  const extraction = extractProtectedItemsDetailed(rawText);
  if (extraction.ambiguousActive.length > 0) return { ok: false, records: [], reason: `ambiguous:${extraction.ambiguousActive.join(",")}` };
  if (extraction.oversized) return { ok: false, records: [], reason: "oversized" };
  const records: ProtectedRecord[] = [];
  const seen = new Set<string>();
  const push = (record: ProtectedRecord) => {
    const key = JSON.stringify(record);
    if (seen.has(key)) return;
    seen.add(key);
    records.push(record);
  };
  const subjectAt = (index: number): { s: string; u?: true } => {
    const subject = subjectAtIndex(rawText, index);
    // Only a structured subject (path / owner-repo) counts as verified; a tool
    // name or "unknown" is recorded explicitly as unresolved provenance.
    return subject.includes("/") ? { s: subject } : { s: "unknown", u: true };
  };
  for (const pair of resolveIdentifiers(rawText).pairs) {
    if (pair.tier !== 1) continue;
    const label = ROLE_LABEL[pair.role];
    if (label) push({ c: "id", r: label, ...(pair.subject.includes("/") ? { s: pair.subject } : { s: "unknown", u: true as const }), v: pair.value });
  }
  const pairs = extractStatusPairs(rawText);
  for (const pair of pairs) push({ c: "st", s: pair.subject, v: pair.status });
  // A bare FAIL/HOLD with no structured pair still has to survive: record it
  // with explicit unknown provenance instead of inventing a subject.
  if (pairs.length === 0) {
    for (const item of extraction.items.filter((entry) => entry.tier === 1 && entry.category === "status")) {
      let from = 0;
      for (;;) {
        const index = rawText.indexOf(item.value, from);
        if (index < 0) break;
        from = index + item.value.length;
        push({ c: "st", ...subjectAt(index), v: item.value });
      }
    }
  }
  const markers = extraction.items.filter((item) => item.tier === 1 && MARKER_CATEGORIES.has(item.category));
  for (const item of markers) {
    let from = 0;
    for (;;) {
      const index = rawText.indexOf(item.value, from);
      if (index < 0) break;
      from = index + item.value.length;
      push({ c: item.category, ...subjectAt(index), v: item.value });
    }
  }
  if (records.length > MAX_RECORDS) return { ok: false, records, reason: "record-overflow" };
  return { ok: true, records };
}

export interface RecordVerification {
  missing: ProtectedRecord[];
  unexpected: ProtectedRecord[];
  contradictions: ProtectedRecord[];
}

function keyOf(record: ProtectedRecord): string {
  return JSON.stringify([record.c, record.r ?? null, record.s, record.v, record.u === true]);
}

/**
 * Bidirectional exact set comparison. A record is valid only when it matches an
 * expected tuple exactly; extra records, missing records, a value attached to a
 * different subject, or a conflicting value for the same role/subject are all
 * rejected.
 */
export function verifyRecords(expected: ProtectedRecord[], actual: ProtectedRecord[]): RecordVerification {
  const expectedKeys = new Set(expected.map(keyOf));
  const actualKeys = new Set(actual.map(keyOf));
  const missing: ProtectedRecord[] = [];
  const unexpected: ProtectedRecord[] = [];
  const contradictions: ProtectedRecord[] = [];
  for (const record of expected) {
    if (actualKeys.has(keyOf(record))) continue;
    const sameIdentity = actual.some(
      (candidate) => candidate.c === record.c && (candidate.r ?? null) === (record.r ?? null) && candidate.s === record.s,
    );
    const sameValueOtherSubject = actual.some(
      (candidate) => candidate.c === record.c && (candidate.r ?? null) === (record.r ?? null) && candidate.v === record.v,
    );
    (sameIdentity || sameValueOtherSubject ? contradictions : missing).push(record);
  }
  for (const record of actual) {
    if (!expectedKeys.has(keyOf(record))) unexpected.push(record);
  }
  return { missing, unexpected, contradictions };
}

/** Maps a record back to the guard's item shape for reporting. */
export function recordToItem(record: ProtectedRecord): ProtectedItem {
  const category = record.c === "id" ? "active-sha" : record.c === "st" ? "status" : record.c;
  return { category: category as ProtectedItem["category"], value: record.v, exact: true, tier: 1 };
}

/**
 * Structural verification: every expected record must appear as an exact
 * (category, role, subject, value) tuple. A matching value under a different
 * subject is a contradiction, never a pass.
 */
export function verifyStructuredSummary(rawText: string, summaryText: string, parsed: StrictParse): ProtectionVerdict {
  const extraction = extractProtectedItemsDetailed(rawText);
  const expected = expectedRecords(rawText);
  const verification = expected.ok
    ? verifyRecords(expected.records, parsed.records)
    : { missing: [], unexpected: [], contradictions: [] };
  const contradictions = [...verification.contradictions, ...verification.unexpected];
  const missing = verification.missing.map(recordToItem);
  const identifierContradictions = contradictions
    .filter((record) => record.c === "id")
    .map((record) => ({ role: record.r ?? "", value: record.v, subject: record.s, category: "active-sha" as const, tier: 1 as const }));
  const statusContradictions = contradictions
    .filter((record) => record.c === "st")
    .map((record) => ({ status: record.v, subject: record.s }));
  const unboundTasks = contradictions
    .filter((record) => record.c !== "id" && record.c !== "st")
    .map(recordToItem);
  const tier2 = extraction.items.filter((item) => item.tier === 2);
  const tier2Omitted = tier2.filter((item) => !summaryText.includes(item.value)).length;
  const ok = parsed.ok && expected.ok && missing.length === 0 && contradictions.length === 0 &&
    !extraction.truncated && !extraction.oversized && extraction.overflowCategories.length === 0;
  return {
    ok,
    checked: parsed.records.length,
    required: expected.records.length,
    missing,
    advisoryMissing: [],
    overflow: extraction.overflowCategories,
    truncated: extraction.truncated,
    oversized: extraction.oversized,
    tier1Count: expected.records.length,
    tier2Count: tier2.length,
    tier2Omitted,
    relationsChecked: parsed.records.filter((record) => record.c === "st").length,
    unresolvedRelations: [],
    contradictions: statusContradictions,
    identifierUnresolved: [],
    identifierContradictions,
    unboundTasks,
    unverifiableRelations: parsed.malformed,
    ambiguousActive: extraction.ambiguousActive,
  };
}
