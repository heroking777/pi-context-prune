// Phase47: hybrid summary assembly.
//
// Stage A (deterministic) extracts the protected core from raw tool output and
// renders it in the exact form the guard validates. Stage B hands only the
// remaining noncritical lines to the LLM. Stage C concatenates the two; the
// caller re-validates the assembled text with the single existing guard.
import {
  extractProtectedItemsDetailed,
  verifyProtectedSummary,
  type ProtectedItem,
} from "./summary-protection.js";
import {
  extractStatusPairs,
  resolveIdentifiers,
  subjectForValue,
} from "./summary-protection-semantics.js";

const ROLE_LABEL: Record<string, string> = {
  "final-sha": "FINAL_SHA",
  "head-sha": "HEAD",
  "current-sha": "CURRENT_SHA",
  "deployed-sha": "DEPLOYED_SHA",
  "active-sha": "ACTIVE_SHA",
  "build-id": "BUILD_ID",
  release: "RELEASE",
};
const MARKER_CATEGORIES = new Set(["decision", "task", "next", "rollback", "error"]);
const MAX_CORE_LINES = 60;
const MAX_LINE_CHARS = 240;

export interface ProtectedCore {
  ok: boolean;
  core: string;
  /** Raw text with protected lines removed, for the LLM. */
  notesInput: string;
  itemCount: number;
  /** Why the core is unsafe (ambiguous identifiers, overflow, guard failure). */
  reason?: string;
}

function rawLineFor(rawText: string, value: string): string {
  const index = rawText.indexOf(value);
  if (index < 0) return value;
  const start = rawText.lastIndexOf("\n", index) + 1;
  const end = rawText.indexOf("\n", index);
  const line = rawText.slice(start, end < 0 ? rawText.length : end).trim();
  return line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) : line;
}

/**
 * Builds the deterministic protected core and the reduced LLM input.
 * Fails closed when identifiers are ambiguous, the core overflows, or the core
 * alone does not satisfy the protection guard.
 */
export function buildProtectedCore(rawText: string): ProtectedCore {
  const extraction = extractProtectedItemsDetailed(rawText);
  if (extraction.ambiguousActive.length > 0) {
    return { ok: false, core: "", notesInput: "", itemCount: 0, reason: `ambiguous:${extraction.ambiguousActive.join(",")}` };
  }
  const lines: string[] = [];
  const seen = new Set<string>();
  const coveredValues = new Set<string>();

  for (const pair of resolveIdentifiers(rawText).pairs) {
    if (pair.tier !== 1) continue;
    const label = ROLE_LABEL[pair.role];
    if (!label) continue;
    const key = `id:${label}:${pair.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    coveredValues.add(pair.value);
    lines.push(`- ${pair.subject} | ${label}=${pair.value}`);
  }

  for (const pair of extractStatusPairs(rawText)) {
    const key = `st:${pair.subject}:${pair.status}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`- ${pair.subject}: ${pair.status}`);
  }

  const markers = extraction.items.filter((item) => MARKER_CATEGORIES.has(item.category) && item.tier === 1);
  for (const item of markers) {
    const key = `m:${item.category}:${item.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    coveredValues.add(item.value);
    const subject = subjectForValue(rawText, item.value);
    lines.push(`- ${subject} | ${rawLineFor(rawText, item.value)}`);
  }

  if (lines.length > MAX_CORE_LINES) {
    return { ok: false, core: "", notesInput: "", itemCount: lines.length, reason: "core-overflow" };
  }
  const core = lines.join("\n");
  const check = verifyProtectedSummary(rawText, core);
  if (!check.ok) {
    const missing = [...new Set(check.missing.map((item) => item.category))].join(",");
    return { ok: false, core, notesInput: "", itemCount: lines.length, reason: `core-invalid:${missing || "relation"}` };
  }

  const protectedLines = new Set<string>();
  for (const item of markers) protectedLines.add(rawLineFor(rawText, item.value));
  for (const pair of resolveIdentifiers(rawText).pairs) if (pair.tier === 1) protectedLines.add(rawLineFor(rawText, pair.value));
  for (const pair of extractStatusPairs(rawText)) protectedLines.add(rawLineFor(rawText, pair.status));
  const notesInput = rawText
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return false;
      if (protectedLines.has(trimmed)) return false;
      if (/^(?:UNFINISHED_TASK|TODO|NEXT(?:_ACTION|_TASK|_STEP)?|ROLLBACK|DECISION)\s*[=:]/i.test(trimmed)) return false;
      return true;
    })
    .join("\n");

  return { ok: true, core, notesInput, itemCount: lines.length };
}

/** Assembles the final summary: deterministic core first, LLM notes second. */
export function assembleHybridSummary(core: string, llmNotes: string): string {
  const notes = llmNotes.trim();
  return notes.length === 0
    ? `## Protected state\n${core}`
    : `## Protected state\n${core}\n\n## Notes\n${notes}`;
}

/** Values the deterministic core already carries (for duplication checks). */
export function coreValues(core: string): ProtectedItem[] {
  return core
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => ({ category: "task", value: line.slice(2).slice(0, MAX_LINE_CHARS), exact: true, tier: 1 }));
}
