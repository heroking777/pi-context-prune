import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { ContextPruneConfig, PruneOn, SummarizerThinking } from "./types.js";
import { DEFAULT_CONFIG, PRUNE_ON_MODES, SUMMARIZER_THINKING_LEVELS } from "./types.js";

/** Path to the extension's own settings file, independent of any project. */
export const SETTINGS_PATH = join(homedir(), ".pi", "agent", "context-prune", "settings.json");

function isPruneOn(value: unknown): value is PruneOn {
  return typeof value === "string" && PRUNE_ON_MODES.some((mode) => mode.value === value);
}

function isSummarizerThinking(value: unknown): value is SummarizerThinking {
  return typeof value === "string" && SUMMARIZER_THINKING_LEVELS.some((level) => level.value === value);
}

/** Reads ~/.pi/agent/context-prune/settings.json and returns the config (or defaults). */
export async function loadConfig(): Promise<ContextPruneConfig> {
  try {
    const raw = await readFile(SETTINGS_PATH, "utf-8");
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Validates and normalizes a raw settings object against the defaults. Exported
 * so the validation rules can be tested without touching the settings file.
 */
export function normalizeConfig(existing: unknown): ContextPruneConfig {
  const merged = { ...DEFAULT_CONFIG, ...(existing && typeof existing === "object" ? existing : {}) };
    return {
      ...merged,
      enabled: typeof merged.enabled === "boolean" ? merged.enabled : DEFAULT_CONFIG.enabled,
      showPruneStatusLine:
        typeof merged.showPruneStatusLine === "boolean"
          ? merged.showPruneStatusLine
          : DEFAULT_CONFIG.showPruneStatusLine,
      showStartupNotice:
        typeof merged.showStartupNotice === "boolean"
          ? merged.showStartupNotice
          : DEFAULT_CONFIG.showStartupNotice,
      pruneOn: isPruneOn(merged.pruneOn) ? merged.pruneOn : DEFAULT_CONFIG.pruneOn,
      summarizerThinking: isSummarizerThinking(merged.summarizerThinking)
        ? merged.summarizerThinking
        : DEFAULT_CONFIG.summarizerThinking,
      remindUnprunedCount:
        typeof merged.remindUnprunedCount === "boolean"
          ? merged.remindUnprunedCount
          : DEFAULT_CONFIG.remindUnprunedCount,
      notifySkipped:
        typeof merged.notifySkipped === "boolean" ? merged.notifySkipped : DEFAULT_CONFIG.notifySkipped,
      // OPT-001: mid-task auto-prune.
      midTaskAutoPrune:
        typeof merged.midTaskAutoPrune === "boolean" ? merged.midTaskAutoPrune : DEFAULT_CONFIG.midTaskAutoPrune,
      midTaskThresholdChars:
        Number.isFinite(merged.midTaskThresholdChars) && merged.midTaskThresholdChars >= 0
          ? merged.midTaskThresholdChars
          : DEFAULT_CONFIG.midTaskThresholdChars,
      midTaskThresholdToolCalls:
        Number.isInteger(merged.midTaskThresholdToolCalls) && merged.midTaskThresholdToolCalls >= 1
          ? merged.midTaskThresholdToolCalls
          : DEFAULT_CONFIG.midTaskThresholdToolCalls,
      // OPT-025: cooldown + size floor.
      rateLimitCooldownMs:
        Number.isFinite(merged.rateLimitCooldownMs) && merged.rateLimitCooldownMs >= 0
          ? merged.rateLimitCooldownMs
          : DEFAULT_CONFIG.rateLimitCooldownMs,
      minRawCharsForSummary:
        Number.isFinite(merged.minRawCharsForSummary) && merged.minRawCharsForSummary >= 0
          ? merged.minRawCharsForSummary
          : DEFAULT_CONFIG.minRawCharsForSummary,
      // Phase1 (OPT-026): positive integer only, otherwise null (no cap).
      summarizerMaxOutputTokens:
        Number.isInteger(merged.summarizerMaxOutputTokens) && (merged.summarizerMaxOutputTokens as number) > 0
          ? (merged.summarizerMaxOutputTokens as number)
          : null,
      // Phase2/Phase3 (OPT-027/028).
      conciseSummaryMode: merged.conciseSummaryMode === true,
      summarizerPromptMode:
        merged.summarizerPromptMode === "concise" || merged.summarizerPromptMode === "faithful"
          ? merged.summarizerPromptMode
          : "default",
      // Phase4/Phase5 (OPT-029/030).
      evidenceAppendix: merged.evidenceAppendix === true,
      evidenceAppendixMaxEntries:
        Number.isInteger(merged.evidenceAppendixMaxEntries) && (merged.evidenceAppendixMaxEntries as number) > 0
          ? (merged.evidenceAppendixMaxEntries as number)
          : 200,
      // Phase31: opt-in protected summary compression.
      protectedSummaryCompression: merged.protectedSummaryCompression === true,
      protectedSummaryTargetChars:
        Number.isInteger(merged.protectedSummaryTargetChars) && (merged.protectedSummaryTargetChars as number) >= 500
          ? Math.min(merged.protectedSummaryTargetChars as number, 20000)
          : DEFAULT_CONFIG.protectedSummaryTargetChars,
    };
}

/** Writes the full config to ~/.pi/agent/context-prune/settings.json. */
export async function saveConfig(config: ContextPruneConfig): Promise<void> {
  await mkdir(dirname(SETTINGS_PATH), { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify(config, null, 2));
}
