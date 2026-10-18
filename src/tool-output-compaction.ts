import type {
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import type { ToolCallIndexer } from "./indexer.js";
import type { ToolCallRecord } from "./types.js";
import { CUSTOM_TYPE_INDEX } from "./types.js";

const MIN_OUTPUT_CHARS = 1_000;
const MIN_SAVED_CHARS = 400;
const COMPACTION_MARKER = "contextPruneOutputCompaction";

export interface OutputCompaction {
  kind: "test" | "build" | "lint" | "search";
  text: string;
  removedChars: number;
}

function commandText(event: ToolResultEvent): string {
  const input = event.input ?? {};
  const value = input.command ?? input.pattern;
  if (typeof value !== "string") return "";
  return value.trim().replace(/^cd\s+(?:"[^"]+"|'[^']+'|[^&\n]+)\s*&&\s*/, "");
}

function outputKind(event: ToolResultEvent): OutputCompaction["kind"] | null {
  const command = commandText(event);
  if (event.toolName === "grep" || /^(?:rg|grep)\s/.test(command)) return "search";
  if (/^(?:npm\s+(?:run\s+)?test|pnpm\s+test|yarn\s+test|bun\s+test|cargo\s+test|go\s+test|pytest|python\s+-m\s+pytest|vitest|jest)\b/.test(command)) return "test";
  if (/^(?:npm\s+run\s+lint|pnpm\s+lint|yarn\s+lint|bun\s+lint|eslint|biome\s+check|ruff\s+check|prettier\s+--check|flake8|golangci-lint\s+run)\b/.test(command)) return "lint";
  if (/^(?:npm\s+run\s+(?:build|check)|pnpm\s+(?:build|check)|yarn\s+(?:build|check)|bun\s+build|cargo\s+(?:build|check)|go\s+build|tsc\b|npx\s+tsc\b)\b/.test(command)) return "build";
  return null;
}

function explicitTestSummary(lines: string[]): string | null {
  const node = lines.filter((line) => /^# (?:tests|pass|fail|duration_ms)\b/.test(line));
  if (node.some((line) => /^# fail (?!0\b)\d+/.test(line))) return null;
  if (node.some((line) => /^# tests \d+/.test(line)) && node.some((line) => /^# pass \d+/.test(line)) && node.some((line) => /^# fail 0(?:\s|$)/.test(line))) {
    return node.filter((line) => /^# (?:tests|pass|fail)\b/.test(line)).join("\n");
  }
  const summary = lines.find((line) => /(?:test result:\s*ok\.|\b\d+\s+(?:tests?\s+)?passed\b|tests?:\s*\d+\s+passed\b)/i.test(line));
  if (!summary || /\b\d+\s+(?:failed|failures?)\b/i.test(summary) && !/\b0\s+(?:failed|failures?)\b/i.test(summary)) return null;
  if (!/\b0\s+(?:failed|failures?)\b/i.test(summary) && !/test result:\s*ok\./i.test(summary) && !/\btests?:\s*\d+\s+passed\b/i.test(summary)) return null;
  return summary;
}

function compactTests(text: string): string | null {
  const lines = text.split(/\r?\n/);
  const summary = explicitTestSummary(lines);
  if (!summary) return null;
  const protectedEvidence = /[\\/]|\b[0-9a-f]{40,64}\b|\b[\w.-]+\.(?:ts|tsx|js|jsx|py|go|rs|json|ya?ml|toml|md|sh)\b/i;
  if (lines.some((line) => protectedEvidence.test(line))) return null;
  const allowed = /^(?:\s*|# (?:tests|suites|pass|fail|duration_ms)\b.*|(?:>\s.*)|(?:PASS|✓|✔|ok\s+\S+|\s*✓\s).*|Test Suites:.*|Tests:.*|Snapshots:.*|Time:.*|Ran all test suites\.?|\s*\d+\.\.\d+\s*)$/;
  if (lines.some((line) => !allowed.test(line))) return null;
  const commands = lines.filter((line) => /^>\s/.test(line));
  return [...commands, `Test run successful\n${summary}`].join("\n");
}

function compactBuild(text: string): string | null {
  const lines = text.split(/\r?\n/);
  const progress = /^\s*(?:Compiling|Checking|Building|Downloading|Downloaded|Fetching|Fetched|Transforming)\s+[^/\\]*$/;
  const critical = /\b(?:error|failed|failure|warning|warn|panic|fatal|exception)\b|\b[0-9a-f]{40,64}\b/i;
  const isProgress = (line: string) => progress.test(line) && !critical.test(line);
  const omitted = lines.filter(isProgress);
  if (omitted.length === 0 || omitted.join("\n").length < MIN_SAVED_CHARS) return null;
  const retained = lines.filter((line) => !isProgress(line));
  return [...retained, `[${omitted.length} routine build-progress lines omitted; original saved for retrieval]`].filter(Boolean).join("\n");
}

function compactLint(text: string): string | null {
  const lines = text.split(/\r?\n/);
  const progress = /^\s*(?:Linting|Checking|Scanning|Analyzing|Analyzed)\s+[^/\\]*$/;
  const critical = /\b(?:error|failed|failure|warning|warn|panic|fatal|exception)\b|\b[0-9a-f]{40,64}\b/i;
  const isProgress = (line: string) => progress.test(line) && !critical.test(line);
  const omitted = lines.filter(isProgress);
  if (omitted.length === 0 || omitted.join("\n").length < MIN_SAVED_CHARS) return null;
  const retained = lines.filter((line) => !isProgress(line));
  return [...retained, `[${omitted.length} routine lint-progress lines omitted; original saved for retrieval]`].filter(Boolean).join("\n");
}

function compactSearch(text: string): string | null {
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return null;
  const grouped: string[] = [];
  for (let i = 0; i < lines.length;) {
    const first = /^(.*?):(\d+):(.*)$/.exec(lines[i]);
    if (!first) {
      grouped.push(lines[i++]);
      continue;
    }
    const matches = [{ number: first[2], content: first[3] }];
    let next = i + 1;
    while (next < lines.length) {
      const match = /^(.*?):(\d+):(.*)$/.exec(lines[next]);
      if (!match || match[1] !== first[1]) break;
      matches.push({ number: match[2], content: match[3] });
      next++;
    }
    if (matches.length > 1) {
      grouped.push(`${first[1]}:`, ...matches.map(({ number, content }) => `  ${number}:${content}`));
    } else grouped.push(lines[i]);
    i = next;
  }
  const compacted: string[] = [];
  for (let i = 0; i < grouped.length;) {
    let next = i + 1;
    while (next < grouped.length && grouped[next] === grouped[i]) next++;
    const count = next - i;
    compacted.push(count > 1 ? `${grouped[i]} [repeated ${count} times]` : grouped[i]);
    i = next;
  }
  const result = compacted.join("\n");
  return result === text ? null : result;
}

export function compactToolOutput(event: ToolResultEvent): OutputCompaction | null {
  const block = event.content[0];
  if (event.isError || event.content.length !== 1 || block?.type !== "text") return null;
  if ((event.details as Record<string, unknown> | undefined)?.[COMPACTION_MARKER]) return null;
  const text = block.text;
  if (typeof text !== "string" || text.length < MIN_OUTPUT_CHARS) return null;
  if (text.split(/\r?\n/).some((line) => Buffer.byteLength(line) > DEFAULT_MAX_BYTES / 2)) return null;
  const kind = outputKind(event);
  if (!kind) return null;
  const compacted = kind === "test" ? compactTests(text)
    : kind === "build" ? compactBuild(text)
      : kind === "lint" ? compactLint(text)
        : compactSearch(text);
  if (!compacted || text.length - compacted.length < MIN_SAVED_CHARS) return null;
  return { kind, text: compacted, removedChars: text.length - compacted.length };
}

function currentTurnIndex(ctx: ExtensionContext): number {
  return ctx.sessionManager.getBranch().filter((entry: any) =>
    entry.type === "message" && entry.message?.role === "assistant",
  ).length;
}

function mergeDetails(details: unknown, metadata: Record<string, unknown>): Record<string, unknown> {
  const base = details && typeof details === "object" && !Array.isArray(details)
    ? details as Record<string, unknown>
    : {};
  return { ...base, [COMPACTION_MARKER]: metadata };
}

export function registerToolOutputCompaction(
  pi: ExtensionAPI,
  indexer: ToolCallIndexer,
  isEnabled: () => boolean,
): void {
  pi.on("tool_result", async (event, ctx) => {
    try {
      if (!isEnabled() || indexer.getRecord(event.toolCallId)) return {};
      const outcome = compactToolOutput(event);
      const block = event.content[0];
      if (!outcome || block?.type !== "text") return {};
      const rawText = block.text;
      const record: ToolCallRecord & { __contextPruneRawOnly: true } = {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.input,
        resultText: rawText,
        isError: false,
        turnIndex: currentTurnIndex(ctx),
        timestamp: Date.now(),
        __contextPruneRawOnly: true,
      };
      pi.appendEntry(CUSTOM_TYPE_INDEX, { toolCalls: [record] });
      indexer.indexPersistedRecord(record);
      const rawRef = indexer.getSearchRef(event.toolCallId);
      if (!rawRef) return {};
      const metadata = {
        kind: outcome.kind,
        rawRef,
        originalChars: rawText.length,
        compactedChars: outcome.text.length,
      };
      return {
        content: [{ ...block, text: `${outcome.text}\n\n[Raw output ref: ${rawRef}; retrieve with context_tree_query.]` }],
        details: mergeDetails(event.details, metadata),
      };
    } catch {
      return {};
    }
  });
}
