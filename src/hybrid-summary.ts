// Phase47/48: hybrid summary assembly.
//
// Stage A (deterministic) extracts the protected core from raw tool output and
// renders it in the exact form the guard validates. Stage B hands only the
// remaining noncritical lines to the LLM. Stage C concatenates the two; the
// caller re-validates the assembled text with the single existing guard.
//
// Integrity rules: deduplication is per (role/category, subject, value) so two
// subjects never collapse; protected values are never truncated; a line that
// cannot be rendered safely fails closed before any provider call.
import { extractProtectedItemsDetailed, verifyProtectedSummary } from "./summary-protection.js";
import { extractStatusPairs, resolveIdentifiers } from "./summary-protection-semantics.js";

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
const MARKER_LINE = /^(?:UNFINISHED_TASK|TODO|NEXT(?:_ACTION|_TASK|_STEP)?|ROLLBACK|DECISION)\s*[=:]/i;
const MAX_CORE_LINES = 60;
const MAX_RENDERED_LINE = 2000;

export interface ProtectedCore {
  ok: boolean;
  core: string;
  notesInput: string;
  itemCount: number;
  reason?: string;
}

function lineFor(rawText: string, value: string): string {
  const index = rawText.indexOf(value);
  if (index < 0) return value;
  const start = rawText.lastIndexOf("\n", index) + 1;
  const end = rawText.indexOf("\n", index);
  return rawText.slice(start, end < 0 ? rawText.length : end).trim();
}

/** Renders one protected line without ever truncating the required value. */
function render(subject: string, text: string, value: string): string {
  const body = text.length > MAX_RENDERED_LINE ? value : text;
  return `- ${subject} | ${body}`;
}

export function buildProtectedCore(rawText: string): ProtectedCore {
  const extraction = extractProtectedItemsDetailed(rawText);
  if (extraction.ambiguousActive.length > 0) {
    return { ok: false, core: "", notesInput: "", itemCount: 0, reason: `ambiguous:${extraction.ambiguousActive.join(",")}` };
  }
  const lines: string[] = [];
  const seen = new Set<string>();
  const seenLines = new Set<string>();
  const protectedValues = new Set<string>();
  const protectedLines = new Set<string>();

  const identifiers = resolveIdentifiers(rawText).pairs.filter((pair) => pair.tier === 1);
  for (const pair of identifiers) {
    const label = ROLE_LABEL[pair.role];
    if (!label) continue;
    const key = `id|${label}|${pair.subject}|${pair.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    protectedValues.add(pair.value);
    lines.push(`- ${pair.subject} | ${label}=${pair.value}`);
  }

  for (const pair of extractStatusPairs(rawText)) {
    const key = `st|${pair.subject}|${pair.status}`;
    if (seen.has(key)) continue;
    seen.add(key);
    protectedValues.add(`${pair.subject}: ${pair.status}`);
    lines.push(`- ${pair.subject}: ${pair.status}`);
  }

  const markers = extraction.items.filter((item) => MARKER_CATEGORIES.has(item.category) && item.tier === 1);
  for (const item of markers) {
    let from = 0;
    for (;;) {
      const index = rawText.indexOf(item.value, from);
      if (index < 0) break;
      from = index + item.value.length;
      const subject = subjectAtFrom(rawText, index);
      const key = `m|${item.category}|${subject}|${item.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      protectedValues.add(item.value);
      const line = lineFor(rawText, item.value);
      protectedLines.add(line);
      const rendered = render(subject, line, item.value);
      if (seenLines.has(rendered)) continue;
      seenLines.add(rendered);
      lines.push(rendered);
    }
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

  const notesInput = rawText
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return false;
      if (MARKER_LINE.test(trimmed)) return false;
      if (protectedLines.has(trimmed)) return false;
      for (const value of protectedValues) if (trimmed.includes(value)) return false;
      return true;
    })
    .join("\n");

  return { ok: true, core, notesInput, itemCount: lines.length };
}

function subjectAtFrom(rawText: string, index: number): string {
  const before = rawText.slice(0, index);
  const toolIndex = before.lastIndexOf("\nTool:");
  const line = before.slice(toolIndex + 1).split("\n")[0] ?? "";
  const path = line.match(/(?:\/[\w.@+-]+)+/);
  if (path) return path[0];
  const repo = line.match(/\b[\w.-]+\/[\w.-]+\b/);
  return repo ? repo[0] : "unknown";
}

/** Assembles the final summary: deterministic core first, LLM notes second. */
export function assembleHybridSummary(core: string, llmNotes: string): string {
  const notes = llmNotes.trim();
  return notes.length === 0 ? `## Protected state\n${core}` : `## Protected state\n${core}\n\n## Notes\n${notes}`;
}
