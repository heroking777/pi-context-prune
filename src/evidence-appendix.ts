// Phase4 (AI-INPUT-CONTEXT-OPT-029) and Phase5 (AI-INPUT-CONTEXT-OPT-030):
// deterministic evidence appendix.
//
// The appendix is extracted mechanically from the raw tool output (never from the
// model summary), so identifiers the summarizer might paraphrase or drop survive
// verbatim. It is appended AFTER the model summary and the refs footer; the
// original outputs stay retrievable through context_tree_query either way.
//
// Rules are deliberately conservative: a value is only reported when it is
// mechanically identifiable, and the appendix header states that importance is
// not asserted (a regex match is not a claim that the value matters).
import type { CapturedToolCall, ContextPruneConfig } from "./types.js";

const EVIDENCE_LABEL_RE = /"?([A-Za-z][A-Za-z0-9_.-]{1,60})"?\s*[=:]\s*"?([0-9a-fA-F]{7,64})/g;
const EVIDENCE_ID_RE = /\b(target|release|deploy|rollback|build|revision|rev)[-_]([0-9a-fA-F]{7,40})\b/g;
// Only full-length hashes on an evidence-aware line are taken by the broad net.
const EVIDENCE_LONG_HASH_RE = /\b[0-9a-fA-F]{40,64}\b/g;
const EVIDENCE_CTX_RE =
  /sha|digest|commit|revision|release|manifest|artifact|rollback|deploy|verif|checksum|head|ancestor|merge-base/i;
const EVIDENCE_MAX_ENTRIES_DEFAULT = 200;

export type EvidenceRule = "LABELED" | "CONTEXT_MATCHED";

export interface EvidenceEntry {
  rule: EvidenceRule;
  label: string;
  value: string;
  ref: string;
  tool: string;
}

export interface EvidenceExtraction {
  entries: EvidenceEntry[];
  contextMatched: EvidenceEntry[];
  refs: Record<string, string>;
  failures: string[];
}

function evidenceLabelKey(label: string, value: string): string {
  return label + "\u0000" + value;
}

/** Null-safe, exception-safe serialization of one captured tool call. */
export function safeToolCallText(tc: any): string | null {
  try {
    const rawArgs = tc && tc.args !== undefined && tc.args !== null ? JSON.stringify(tc.args) : "";
    const rawResult = tc && typeof tc.resultText === "string" ? tc.resultText : "";
    return (rawArgs || "") + "\n" + rawResult;
  } catch {
    return null;
  }
}

function pushEvidence(
  out: EvidenceEntry[],
  seen: Record<string, boolean>,
  rule: EvidenceRule,
  label: string,
  value: string,
  ref: string,
  tool: string
): void {
  const key = evidenceLabelKey(label, value);
  if (seen[key]) return;
  seen[key] = true;
  out.push({ rule, label, value, ref, tool });
}

function collectLabelled(
  text: string,
  ref: string,
  tool: string,
  out: EvidenceEntry[],
  seen: Record<string, boolean>,
  claimed: Record<string, boolean>
): void {
  let m: RegExpExecArray | null;
  EVIDENCE_LABEL_RE.lastIndex = 0;
  while ((m = EVIDENCE_LABEL_RE.exec(text)) !== null) {
    if (!/[A-Za-z_]/.test(m[1])) continue;
    claimed[m[2]] = true;
    pushEvidence(out, seen, "LABELED", m[1], m[2], ref, tool);
  }
  EVIDENCE_ID_RE.lastIndex = 0;
  while ((m = EVIDENCE_ID_RE.exec(text)) !== null) {
    pushEvidence(out, seen, "LABELED", "release-id:" + m[1], m[0], ref, tool);
  }
}

function collectContextMatched(
  text: string,
  ref: string,
  tool: string,
  out: EvidenceEntry[],
  seen: Record<string, boolean>,
  claimed: Record<string, boolean>
): void {
  const lines = text.split("\n");
  for (const line of lines) {
    if (!EVIDENCE_CTX_RE.test(line)) continue;
    EVIDENCE_LONG_HASH_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = EVIDENCE_LONG_HASH_RE.exec(line)) !== null) {
      if (claimed[m[0]] || seen[m[0]]) continue;
      pushEvidence(out, seen, "CONTEXT_MATCHED", "", m[0], ref, tool);
    }
  }
}

export function extractEvidenceAppendix(toolCalls: unknown): EvidenceExtraction {
  const entries: EvidenceEntry[] = [];
  const contextMatched: EvidenceEntry[] = [];
  const seen: Record<string, boolean> = Object.create(null);
  const claimed: Record<string, boolean> = Object.create(null);
  const refs: Record<string, string> = Object.create(null);
  const failures: string[] = [];
  const list = Array.isArray(toolCalls) ? (toolCalls as CapturedToolCall[]) : [];
  for (let i = 0; i < list.length; i++) {
    const tc: any = list[i] || {};
    const ref = String(tc.toolCallId || "idx" + i);
    const tool = String(tc.toolName || "tool");
    const text = safeToolCallText(tc);
    if (text === null) {
      failures.push(ref);
      continue;
    }
    if (!refs[ref]) refs[ref] = tool;
    collectLabelled(text, ref, tool, entries, seen, claimed);
    collectContextMatched(text, ref, tool, contextMatched, seen, claimed);
  }
  return { entries, contextMatched, refs, failures };
}

export function formatEvidenceAppendix(
  toolCalls: unknown,
  config: Partial<ContextPruneConfig> | undefined,
  rawCharBudget?: number
): string {
  const configured = config && Number.isInteger(config.evidenceAppendixMaxEntries)
    ? config.evidenceAppendixMaxEntries!
    : 0;
  const maxEntries = configured > 0 ? configured : EVIDENCE_MAX_ENTRIES_DEFAULT;
  let ex: EvidenceExtraction;
  try {
    ex = extractEvidenceAppendix(toolCalls || []);
  } catch {
    // Never turn an extraction failure into a silent success: the refs footer and
    // the context_tree_query recovery path stay intact and the failure is marked.
    return '<evidence-appendix status="FAILED" note="extraction error; original outputs remain retrievable via the refs above">\n</evidence-appendix>';
  }
  const rows: string[] = [];
  let omitted = 0;
  let emitted = 0;
  for (let i = 0; i < ex.entries.length; i++) {
    if (emitted >= maxEntries) {
      omitted += ex.entries.length - i;
      break;
    }
    const e = ex.entries[i];
    rows.push(`[LABELED] ${e.label} = ${e.value} (ref=${e.ref}, ${e.tool})`);
    emitted++;
  }
  for (let i = 0; i < ex.contextMatched.length; i++) {
    if (emitted >= maxEntries) {
      omitted += ex.contextMatched.length - i;
      break;
    }
    const c = ex.contextMatched[i];
    rows.push(`[CONTEXT_MATCHED] ${c.value} (ref=${c.ref}, ${c.tool})`);
    emitted++;
  }
  if (!rows.length && !omitted && !ex.failures.length) return "";
  const head =
    '<evidence-appendix note="mechanically extracted from the raw tool output; verified verbatim; not model-generated; importance not asserted">';
  const tail = "</evidence-appendix>";
  let out = head + "\n" + rows.join("\n");
  if (omitted > 0) {
    out += `\n[TRUNCATED] ${omitted} further entr${omitted === 1 ? "y" : "ies"} omitted by evidenceAppendixMaxEntries; extraction was NOT exhaustive`;
  }
  if (ex.failures.length) {
    out += `\n[UNREADABLE] ${ex.failures.length} tool call(s) could not be parsed: ${ex.failures.slice(0, 5).join(", ")}`;
  }
  out = out + "\n" + tail;
  // Bounds the appendix against the raw output it describes. A small batch can
  // otherwise produce an appendix larger than the raw text and change the
  // pruner's oversized-skip decision. Degrading is explicit, never silent.
  if (Number.isFinite(rawCharBudget) && (rawCharBudget as number) > 0 && out.length > (rawCharBudget as number)) {
    return `<evidence-appendix status="OMITTED" reason="appendix exceeded the raw-output size budget" entries=${rows.length} budget=${rawCharBudget}>\noriginal outputs remain retrievable via the refs above; nothing was shortened\n${tail}`;
  }
  return out;
}
