import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { ToolCallIndexer } from "./indexer.js";
import type { ToolCallRecord } from "./types.js";

export const MAX_RAW_RECORD_BYTES = 8 * 1024 * 1024;
export const MAX_RAW_SESSION_BYTES = 64 * 1024 * 1024;
export const MAX_RAW_SESSION_RECORDS = 512;

const MINIMIZER_BUDGETS: Record<string, number> = {
  default: 6 * 1024,
  bash: 6 * 1024,
  read: 6 * 1024,
  edit: 6 * 1024,
  write: 6 * 1024,
  grep: 4 * 1024,
  find: 4 * 1024,
  ls: 4 * 1024,
};

export interface VerifiedRaw {
  text: string;
  sha256: string;
  byteLength: number;
  sourcePath?: string;
  sourceSize?: number;
  sourceMtimeMs?: number;
}

export type RawReadResult =
  | { ok: true; raw: VerifiedRaw }
  | { ok: false; reason: string };

function detailsOf(event: ToolResultEvent): Record<string, any> {
  return event.details && typeof event.details === "object"
    ? event.details as Record<string, any>
    : {};
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function budgetFor(toolName: string): number {
  const perTool = process.env[`PI_TRM_BUDGET_${toolName.toUpperCase()}`];
  const raw = perTool ?? process.env.PI_TRM_BUDGET;
  if (raw === undefined) return MINIMIZER_BUDGETS[toolName] ?? MINIMIZER_BUDGETS.default;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.round(parsed)
    : MINIMIZER_BUDGETS[toolName] ?? MINIMIZER_BUDGETS.default;
}

export function minimizerMayShorten(event: ToolResultEvent): boolean {
  if (event.isError || process.env.PI_TOOLRESULT_MINIMIZE === "0") return false;
  const largestText = event.content
    .filter((block) => block.type === "text")
    .reduce((largest, block) => Math.max(largest, Buffer.byteLength(block.text, "utf8")), 0);
  return largestText > budgetFor(event.toolName);
}

export function shouldCaptureRaw(event: ToolResultEvent, compactionEligible: boolean): boolean {
  const details = detailsOf(event);
  const alreadyMinimized = event.content.some((block) =>
    block.type === "text" && block.text.includes("[toolresult-minimize] truncated"),
  );
  return compactionEligible || alreadyMinimized || typeof details.fullOutputPath === "string" ||
    details.truncation?.truncated === true || minimizerMayShorten(event);
}

function tmpPath(path: string): string | undefined {
  try {
    const root = realpathSync(tmpdir());
    const candidate = realpathSync(path);
    const rel = relative(root, candidate);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
    return candidate;
  } catch {
    return undefined;
  }
}

function decodeUtf8(bytes: Buffer): string | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return Buffer.from(text, "utf8").equals(bytes) ? text : undefined;
  } catch {
    return undefined;
  }
}

export function readCompleteRaw(event: ToolResultEvent): RawReadResult {
  const details = detailsOf(event);
  const suppliedPath = details.fullOutputPath;
  if (suppliedPath !== undefined) {
    if (typeof suppliedPath !== "string" || !isAbsolute(suppliedPath)) {
      return { ok: false, reason: "invalid-full-output-path" };
    }
    try {
      const before = lstatSync(suppliedPath);
      const path = tmpPath(suppliedPath);
      if (!path || before.isSymbolicLink() || !before.isFile()) {
        return { ok: false, reason: "untrusted-full-output-file" };
      }
      if (before.size > MAX_RAW_RECORD_BYTES) return { ok: false, reason: "raw-record-limit" };
      const bytes = readFileSync(path);
      const after = statSync(path);
      if (before.size !== bytes.length || after.size !== bytes.length || before.mtimeMs !== after.mtimeMs) {
        return { ok: false, reason: "full-output-changed-during-read" };
      }
      const expectedBytes = details.truncation?.totalBytes;
      if (Number.isFinite(expectedBytes) && expectedBytes !== bytes.length) {
        return { ok: false, reason: "full-output-byte-count-mismatch" };
      }
      const expectedHash = details.truncation?.sha256 ?? details.rawSha256;
      if (typeof expectedHash === "string" && expectedHash !== digest(bytes)) {
        return { ok: false, reason: "full-output-sha256-mismatch" };
      }
      const text = decodeUtf8(bytes);
      if (text === undefined) return { ok: false, reason: "full-output-not-valid-utf8" };
      return {
        ok: true,
        raw: { text, sha256: digest(bytes), byteLength: bytes.length, sourcePath: path,
          sourceSize: after.size, sourceMtimeMs: after.mtimeMs },
      };
    } catch {
      return { ok: false, reason: "full-output-unavailable" };
    }
  }

  const block = event.content.length === 1 ? event.content[0] : undefined;
  if (block?.type !== "text") return { ok: false, reason: "unsupported-tool-result-content" };
  const bytes = Buffer.from(block.text, "utf8");
  const reportedBytes = details.truncation?.totalBytes;
  if (details.truncation?.truncated === true ||
      (Number.isFinite(reportedBytes) && reportedBytes > bytes.length) ||
      block.text.includes("[toolresult-minimize] truncated")) {
    return { ok: false, reason: "upstream-output-already-truncated" };
  }
  if (bytes.length > MAX_RAW_RECORD_BYTES) return { ok: false, reason: "raw-record-limit" };
  return { ok: true, raw: { text: block.text, sha256: digest(bytes), byteLength: bytes.length } };
}

export function rawStorageLimit(indexer: ToolCallIndexer, nextBytes: number): string | undefined {
  if (nextBytes > MAX_RAW_RECORD_BYTES) return "raw-record-limit";
  let count = 0;
  let totalBytes = 0;
  for (const value of indexer.getIndex().values()) {
    const record = value as ToolCallRecord & { __contextPruneRawSha256?: string; __contextPruneRawByteLength?: number };
    if (!record.__contextPruneRawSha256) continue;
    count++;
    totalBytes += record.__contextPruneRawByteLength ?? Buffer.byteLength(record.resultText, "utf8");
  }
  if (count >= MAX_RAW_SESSION_RECORDS) return "raw-session-record-limit";
  if (totalBytes + nextBytes > MAX_RAW_SESSION_BYTES) return "raw-session-byte-limit";
  return undefined;
}

export function verifyRawRecord(record: ToolCallRecord): string | undefined {
  const integrity = record as ToolCallRecord & { __contextPruneRawSha256?: string; __contextPruneRawByteLength?: number };
  if (!integrity.__contextPruneRawSha256) return undefined;
  const bytes = Buffer.from(record.resultText, "utf8");
  if (bytes.length !== integrity.__contextPruneRawByteLength || digest(bytes) !== integrity.__contextPruneRawSha256) {
    return "raw-integrity-check-failed";
  }
  return undefined;
}

export function removeVerifiedTempSource(raw: VerifiedRaw): boolean {
  if (!raw.sourcePath || raw.sourceSize === undefined || raw.sourceMtimeMs === undefined) return true;
  try {
    const path = tmpPath(raw.sourcePath);
    if (!path || path !== raw.sourcePath) return false;
    const before = lstatSync(path);
    if (before.isSymbolicLink() || !before.isFile() || before.size !== raw.sourceSize || before.mtimeMs !== raw.sourceMtimeMs) return false;
    const bytes = readFileSync(path);
    if (bytes.length !== raw.byteLength || digest(bytes) !== raw.sha256) return false;
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

export function cleanRawDetails(details: unknown, removePath: boolean): Record<string, unknown> {
  const clean = details && typeof details === "object" && !Array.isArray(details)
    ? { ...details as Record<string, unknown> }
    : {};
  if (removePath) delete clean.fullOutputPath;
  const truncation = clean.truncation;
  if (truncation && typeof truncation === "object" && !Array.isArray(truncation)) {
    const cleanTruncation = { ...truncation as Record<string, unknown> };
    delete cleanTruncation.content;
    clean.truncation = cleanTruncation;
  }
  return clean;
}
