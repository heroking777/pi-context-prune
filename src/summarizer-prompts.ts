// Phase2 (AI-INPUT-CONTEXT-OPT-027) and Phase3 (AI-INPUT-CONTEXT-OPT-028):
// summarizer system prompts.
//
//   "default"  -> A  (original SYSTEM_PROMPT — byte-identical to upstream 1.4.0)
//   "concise"  -> B  (grouping + explicit preserve list; faster, lower volume)
//   "faithful" -> C  (A + a verbatim-identifier and re-verification mandate)
//
// Selection never changes the refs footer or the original-output recovery path:
// those are appended structurally after the model output.
import type { ContextPruneConfig } from "./types.js";

export const SYSTEM_PROMPT = `You are summarizing a batch of tool calls made by an AI coding assistant.
For each tool call provide:
- Tool name and a one-sentence description of what it did
- Key outcome: success/failure and the most important data returned
- Any findings the future conversation needs to remember

Keep each tool call to 1-3 bullet points. Be concise.`;

export const SYSTEM_PROMPT_CONCISE = `You are summarizing a batch of tool calls made by an AI coding assistant so it can keep working without re-reading the raw output.

Group by DISTINCT TARGET (same file, path, module or project => ONE entry):
- Merge repeated or similar calls on the same target into a single line; do not give each call its own bullet.
- Tool name(s) and what was done, in one short line.
- Key outcome: success/failure plus the single most important piece of data returned.

Preserve exactly (do not paraphrase, summarise or abbreviate these):
- SHA-1/SHA-256 hashes and commit SHAs
- file paths and directory names
- important commands
- error strings and exit codes
- identifiers the future work must reference

Always state, even if short:
- decisions made
- unresolved issues and open questions
- next actions

Never merge these away (state them explicitly):
- before/after differences for edits
- verification results
- any failure -> fix -> success transition (name the failing symptom and the fix)

Collapse routine successful calls into one grouped line. Do not restate a command that produced no finding.
Use the fewest bullets that carry the above; keep each bullet short and avoid long sentences.`;

export const SYSTEM_PROMPT_FAITHFUL = SYSTEM_PROMPT + `

Keep these EXACTLY as they appear - never abbreviate, truncate, round or paraphrase:
- commit SHAs and HEAD / deployed / verified revisions (write the full hash, never a shortened form)
- file paths, important commands, error strings and exit codes

Also always state briefly, in addition to the above:
- what failed, how it was fixed, and the result of re-verification
- test counts
- decisions made, unresolved items, and next actions

Do not list identifiers that are not needed for the next steps.`;

// Phase 31 (protected compression): opt-in policy. The target length is a goal,
// not a hard cap: protected information always wins over the target. Mechanical
// truncation is explicitly forbidden and never performed.
export const SYSTEM_PROMPT_PROTECTED_COMPRESSED = `Compress this batch of tool calls for the agent that continues the work.
Output bullets only. No preamble, no headings, no restating commands or file lists that stay retrievable from the index.

Merge: duplicate or repeated successes into one line; consecutive operations on one subject (repo, file, service) into one entry; failure -> fix -> re-verification into one entry naming the symptom and the fix.
Drop: noise, progress output, completed intermediate detail, long path/SHA lists.

Keep verbatim, once each, with its subject on the same line:
- active commit/build/release: "subject ROLE=value"
- status: "subject: FAIL|HOLD|BLOCKED" plus the reason
- unresolved error: the error identifier or string and any non-zero exit code
- decision: "DECISION=..."
- every unfinished task: "UNFINISHED_TASK: <exact text>" and its "NEXT_ACTION: ..."
- rollback: "ROLLBACK=..." with the condition
Never drop a protected line to fit the target length.`;

export const SYSTEM_PROMPT_HYBRID_NOTES = `Compress the noncritical notes from this tool-call batch for the agent.
Bullets only, no preamble, no headings.
Merge repeated successes; drop noise, progress output and completed intermediate detail.
Do NOT repeat or rephrase identifiers, commit/build/release values, statuses, decisions, unfinished tasks, next actions or rollback lines: those are preserved separately by the program and must not be restated.
Describe only what happened and any explanation that helps the next step.`;

export type SummarizerPromptMode = "default" | "concise" | "faithful" | "protected" | "hybrid";

/** Default target when protected compression is enabled but no target is set. */
export const PROTECTED_SUMMARY_DEFAULT_TARGET_CHARS = 3900;

export function summarizerPromptMode(config?: Partial<ContextPruneConfig> | null): SummarizerPromptMode {
  if (config?.protectedSummaryHybrid === true) return "hybrid";
  if (config?.protectedSummaryCompression === true) return "protected";
  if (config && (config.summarizerPromptMode === "concise" || config.summarizerPromptMode === "faithful")) {
    return config.summarizerPromptMode;
  }
  return config?.conciseSummaryMode === true ? "concise" : "default";
}

export function summarizerSystemPrompt(config?: Partial<ContextPruneConfig> | null): string {
  const mode = summarizerPromptMode(config);
  if (mode === "protected") return protectedCompressionPrompt(config);
  if (mode === "hybrid") return SYSTEM_PROMPT_HYBRID_NOTES;
  if (mode === "concise") return SYSTEM_PROMPT_CONCISE;
  if (mode === "faithful") return SYSTEM_PROMPT_FAITHFUL;
  return SYSTEM_PROMPT;
}

function protectedTargetChars(config?: Partial<ContextPruneConfig> | null): number {
  const value = config?.protectedSummaryTargetChars;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : PROTECTED_SUMMARY_DEFAULT_TARGET_CHARS;
}

function protectedCompressionPrompt(config?: Partial<ContextPruneConfig> | null): string {
  return (
    SYSTEM_PROMPT_PROTECTED_COMPRESSED +
    `\n\nAim for about ${protectedTargetChars(config)} characters. This is a soft target: if important protected information needs more room, exceed it. ` +
    "Never cut off or summarise away protected information to hit the target."
  );
}
