import type { ToolCallRecord } from "./types.js";

type RawIndexRecord = ToolCallRecord & Record<string, any>;

export function mergePersistedRawUpdate(
  previousRecord: ToolCallRecord | undefined,
  incomingRecord: ToolCallRecord,
): ToolCallRecord {
  const previous = previousRecord as RawIndexRecord | undefined;
  const incoming = incomingRecord as RawIndexRecord;
  const matchesRaw = previous?.__contextPruneRawOnly === true &&
    previous.__contextPruneRawSha256 === incoming.__contextPruneRawSha256 &&
    previous.__contextPruneRawByteLength === incoming.__contextPruneRawByteLength;
  if (incoming.__contextPruneRawUpdate !== true || incoming.resultText !== "" || !matchesRaw) {
    return incomingRecord;
  }
  const merged = { ...previous, ...incoming, resultText: previous?.resultText ?? "" } as RawIndexRecord;
  delete merged.__contextPruneRawOnly;
  delete merged.__contextPruneRawUpdate;
  return merged;
}
