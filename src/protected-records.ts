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

/** Parses structured records from arbitrary summary text (malformed lines ignored). */
export function parseRecords(text: string): ProtectedRecord[] {
  const out: ProtectedRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(PREFIX)) continue;
    try {
      const parsed = JSON.parse(trimmed.slice(PREFIX.length));
      if (parsed && typeof parsed.c === "string" && typeof parsed.s === "string" && typeof parsed.v === "string") {
        out.push({ c: parsed.c, s: parsed.s, v: parsed.v, ...(typeof parsed.r === "string" ? { r: parsed.r } : {}) });
      }
    } catch {
      // A malformed record is not a record; the guard fails closed separately.
    }
  }
  return out;
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
  for (const pair of resolveIdentifiers(rawText).pairs) {
    if (pair.tier !== 1) continue;
    const label = ROLE_LABEL[pair.role];
    if (label) push({ c: "id", r: label, s: pair.subject, v: pair.value });
  }
  for (const pair of extractStatusPairs(rawText)) push({ c: "st", s: pair.subject, v: pair.status });
  const markers = extraction.items.filter((item) => item.tier === 1 && MARKER_CATEGORIES.has(item.category));
  for (const item of markers) {
    let from = 0;
    for (;;) {
      const index = rawText.indexOf(item.value, from);
      if (index < 0) break;
      from = index + item.value.length;
      push({ c: item.category, s: subjectAtIndex(rawText, index), v: item.value });
    }
  }
  if (records.length > MAX_RECORDS) return { ok: false, records, reason: "record-overflow" };
  return { ok: true, records };
}

function keyOf(record: ProtectedRecord): string {
  return JSON.stringify([record.c, record.r ?? null, record.s, record.v]);
}

export interface RecordVerification {
  missing: ProtectedRecord[];
  contradictions: ProtectedRecord[];
}

/**
 * Exact tuple comparison. A record is accepted only when category, role, value
 * and subject all match; the same value under another subject is a
 * contradiction, not a pass.
 */
export function verifyRecords(expected: ProtectedRecord[], actual: ProtectedRecord[]): RecordVerification {
  const actualKeys = new Set(actual.map(keyOf));
  const missing: ProtectedRecord[] = [];
  const contradictions: ProtectedRecord[] = [];
  for (const record of expected) {
    if (actualKeys.has(keyOf(record))) continue;
    const sameValue = actual.some(
      (candidate) => candidate.c === record.c && candidate.v === record.v && (candidate.r ?? null) === (record.r ?? null),
    );
    (sameValue ? contradictions : missing).push(record);
  }
  return { missing, contradictions };
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
export function verifyStructuredSummary(rawText: string, summaryText: string, structured: ProtectedRecord[]): ProtectionVerdict {
  const extraction = extractProtectedItemsDetailed(rawText);
  const expected = expectedRecords(rawText);
  const verification = expected.ok ? verifyRecords(expected.records, structured) : { missing: [], contradictions: [] };
  const missing = verification.missing.map(recordToItem);
  const identifierContradictions = verification.contradictions
    .filter((record) => record.c === "id")
    .map((record) => ({ role: record.r ?? "", value: record.v, subject: record.s, category: "active-sha" as const, tier: 1 as const }));
  const statusContradictions = verification.contradictions
    .filter((record) => record.c === "st")
    .map((record) => ({ status: record.v, subject: record.s }));
  const unboundTasks = verification.contradictions
    .filter((record) => record.c !== "id" && record.c !== "st")
    .map(recordToItem);
  const tier2 = extraction.items.filter((item) => item.tier === 2);
  const tier2Omitted = tier2.filter((item) => !summaryText.includes(item.value)).length;
  const ok = expected.ok && missing.length === 0 && verification.contradictions.length === 0 &&
    !extraction.truncated && !extraction.oversized && extraction.overflowCategories.length === 0;
  return {
    ok,
    checked: structured.length,
    required: expected.records.length,
    missing,
    advisoryMissing: [],
    overflow: extraction.overflowCategories,
    truncated: extraction.truncated,
    oversized: extraction.oversized,
    tier1Count: expected.records.length,
    tier2Count: tier2.length,
    tier2Omitted,
    relationsChecked: structured.filter((record) => record.c === "st").length,
    unresolvedRelations: [],
    contradictions: statusContradictions,
    identifierUnresolved: [],
    identifierContradictions,
    unboundTasks,
    unverifiableRelations: 0,
    ambiguousActive: extraction.ambiguousActive,
  };
}
