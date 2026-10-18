// Phase47/50: hybrid summary assembly with structured protected records.
//
// Stage A extracts the protected record set deterministically and renders it as
// `@rec {json}` tuples. Stage B sends only the remaining noncritical lines to the
// LLM. Stage C concatenates the two; the caller re-validates with the single
// guard, which compares records by exact tuple equality.
import { verifyProtectedSummary } from "./summary-protection.js";
import { expectedRecords, renderRecord } from "./protected-records.js";

const MARKER_LINE = /^(?:UNFINISHED_TASK|TODO|NEXT(?:_ACTION|_TASK|_STEP)?|ROLLBACK|DECISION)\s*[=:]/i;

export interface ProtectedCore {
  ok: boolean;
  core: string;
  notesInput: string;
  itemCount: number;
  reason?: string;
}

/**
 * Builds the deterministic core and the reduced LLM input. Ambiguity, oversized
 * values, record overflow or a core that does not satisfy the guard all fail
 * closed before any provider call.
 */
export function buildProtectedCore(rawText: string): ProtectedCore {
  const expected = expectedRecords(rawText);
  if (!expected.ok) {
    return { ok: false, core: "", notesInput: "", itemCount: expected.records.length, reason: expected.reason };
  }
  const core = expected.records.map(renderRecord).join("\n");
  const check = verifyProtectedSummary(rawText, core);
  if (!check.ok) {
    const missing = [...new Set(check.missing.map((item) => item.category))].join(",");
    return { ok: false, core, notesInput: "", itemCount: expected.records.length, reason: `core-invalid:${missing || "relation"}` };
  }
  const values = new Set(expected.records.map((record) => record.v));
  const notesInput = rawText
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return false;
      if (MARKER_LINE.test(trimmed)) return false;
      for (const value of values) if (value.length > 0 && trimmed.includes(value)) return false;
      return true;
    })
    .join("\n");
  return { ok: true, core, notesInput, itemCount: expected.records.length };
}

/** Assembles the final summary: deterministic core first, LLM notes second. */
export function assembleHybridSummary(core: string, llmNotes: string): string {
  const notes = llmNotes.trim();
  return notes.length === 0 ? `## Protected state\n${core}` : `## Protected state\n${core}\n\n## Notes\n${notes}`;
}
