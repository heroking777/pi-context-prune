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

export type SummarizerPromptMode = "default" | "concise" | "faithful";

/**
 * `summarizerPromptMode` wins; `conciseSummaryMode` is kept for backwards
 * compatibility with the Phase2 setting.
 */
export function summarizerPromptMode(config?: Partial<ContextPruneConfig> | null): SummarizerPromptMode {
  if (config && (config.summarizerPromptMode === "concise" || config.summarizerPromptMode === "faithful")) {
    return config.summarizerPromptMode;
  }
  return config?.conciseSummaryMode === true ? "concise" : "default";
}

export function summarizerSystemPrompt(config?: Partial<ContextPruneConfig> | null): string {
  const mode = summarizerPromptMode(config);
  if (mode === "concise") return SYSTEM_PROMPT_CONCISE;
  if (mode === "faithful") return SYSTEM_PROMPT_FAITHFUL;
  return SYSTEM_PROMPT;
}
