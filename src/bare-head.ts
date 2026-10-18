// Phase55: authoritative bare-SHA HEAD capture.
// A value is promoted only when an exact single SHA is the OK result of a
// `git rev-parse`/`symbolic-ref` command; historical commands, error results and
// mixed output are never promoted.
import type { ProtectedRecord } from "./protected-records.js";

const AUTHORITATIVE_HEAD_COMMAND = /\bgit\b[^"]*\b(?:rev-parse|symbolic-ref)\b/;
const HISTORICAL_HEAD_COMMAND = /\b(?:log|show|diff|rev-list|reflog|cat-file|branch|for-each-ref)\b/;
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Captures an authoritative bare-SHA HEAD. Requires an exact single-SHA result
 * from a `git rev-parse`/`symbolic-ref` command on an OK tool call; historical
 * commands, error results and mixed output are ignored.
 */
export function bareHeadRecords(rawText: string, cwd?: string): { records: ProtectedRecord[]; ambiguous: string[] } {
  void cwd;
  const lines = rawText.split("\n");
  const records: ProtectedRecord[] = [];
  const bySubject = new Map<string, Set<string>>();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.startsWith("Tool: ")) continue;
    let j = i + 1;
    while (j < lines.length && !/^Result \((?:OK|ERROR)\):/.test(lines[j])) j += 1;
    if (j >= lines.length) break;
    const resultLine = lines[j];
    if (!resultLine.startsWith("Result (OK):")) { i = j; continue; }
    // The serialized tool block is pretty-printed JSON, so the command is on a
    // continuation line, not on the `Tool:` line itself.
    const block = lines.slice(i, j).join("\n");
    const command = (block.match(/"command"\s*:\s*"((?:[^"\\]|\\.)*)"/) ?? [])[1]?.replace(/\\"/g, '"') ?? "";
    if (!AUTHORITATIVE_HEAD_COMMAND.test(command) || HISTORICAL_HEAD_COMMAND.test(command)) { i = j; continue; }
    const continuation: string[] = [];
    for (let k = j + 1; k < lines.length && !lines[k].startsWith("Tool: ") && lines[k].trim() !== "---"; k += 1) continuation.push(lines[k]);
    const output = [resultLine.slice("Result (OK):".length), ...continuation].join("\n").trim();
    if (!SHA1.test(output) && !SHA256.test(output)) { i = j; continue; }
    const repo = (command.match(/(?:^|\s)-C\s+["']?([^"'\s]+)/) ?? [])[1];
    // Only an absolute explicit path establishes a subject. A relative -C and
    // the flush-time session cwd are not call-time provenance.
    const subject = repo && repo.startsWith("/") ? { s: repo } : { s: "unknown", u: true as const };
    records.push({ c: "id", r: "HEAD", ...subject, v: output });
    const values = bySubject.get(subject.s) ?? new Set<string>();
    values.add(output);
    bySubject.set(subject.s, values);
    i = j;
  }
  const ambiguous = [...bySubject.entries()].filter(([, values]) => values.size > 1).map(([subject]) => subject);
  return { records, ambiguous };
}
