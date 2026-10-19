import { verifyRawRecord } from "./raw-integrity.js";
import type { ToolCallRecord } from "./types.js";

type RawIndexRecord = ToolCallRecord & Record<string, any>;
const RAW_INTEGRITY_CONFLICT = "invalid-raw-integrity-conflict";

function hasRawIntegrityFields(record: RawIndexRecord | undefined): boolean {
  return record !== undefined && (
    Object.prototype.hasOwnProperty.call(record, "__contextPruneRawSha256") ||
    Object.prototype.hasOwnProperty.call(record, "__contextPruneRawByteLength")
  );
}

function hasValidRawIntegrity(record: RawIndexRecord | undefined): boolean {
  if (!record || typeof record.__contextPruneRawSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.__contextPruneRawSha256) ||
      !Number.isSafeInteger(record.__contextPruneRawByteLength) ||
      record.__contextPruneRawByteLength < 0) return false;
  return verifyRawRecord(record) === undefined;
}

function integrityMatches(left: RawIndexRecord, right: RawIndexRecord): boolean {
  return typeof right.__contextPruneRawSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(right.__contextPruneRawSha256) &&
    Number.isSafeInteger(right.__contextPruneRawByteLength) &&
    right.__contextPruneRawByteLength >= 0 &&
    left.__contextPruneRawSha256 === right.__contextPruneRawSha256 &&
    left.__contextPruneRawByteLength === right.__contextPruneRawByteLength;
}

function preserveVerifiedRaw(previous: RawIndexRecord, incoming: RawIndexRecord): RawIndexRecord {
  const merged = {
    ...previous,
    ...incoming,
    resultText: previous.resultText,
    __contextPruneRawSha256: previous.__contextPruneRawSha256,
    __contextPruneRawByteLength: previous.__contextPruneRawByteLength,
  } as RawIndexRecord;
  delete merged.__contextPruneRawOnly;
  delete merged.__contextPruneRawUpdate;
  return merged;
}

function failClosedMerge(
  previous: RawIndexRecord | undefined,
  incoming: RawIndexRecord,
): RawIndexRecord {
  const source = previous ?? incoming;
  const byteLength = Number.isSafeInteger(source.__contextPruneRawByteLength)
    ? source.__contextPruneRawByteLength
    : -1;
  const merged = {
    ...(previous ?? {}),
    ...incoming,
    resultText: source.resultText ?? "",
    __contextPruneRawSha256: RAW_INTEGRITY_CONFLICT,
    __contextPruneRawByteLength: byteLength,
  } as RawIndexRecord;
  delete merged.__contextPruneRawUpdate;
  if (incoming.__contextPruneRawOnly === true) {
    merged.__contextPruneRawOnly = true;
  } else {
    delete merged.__contextPruneRawOnly;
  }
  return merged;
}

export function mergePersistedRawUpdate(
  previousRecord: ToolCallRecord | undefined,
  incomingRecord: ToolCallRecord,
): ToolCallRecord {
  const previous = previousRecord as RawIndexRecord | undefined;
  const incoming = incomingRecord as RawIndexRecord;
  const previousHasIntegrity = hasRawIntegrityFields(previous);
  const incomingHasIntegrity = hasRawIntegrityFields(incoming);

  if (!previous) {
    if (incoming.__contextPruneRawUpdate === true ||
        (incomingHasIntegrity && !hasValidRawIntegrity(incoming))) {
      return failClosedMerge(undefined, incoming);
    }
    return incomingRecord;
  }

  if (previousHasIntegrity && !hasValidRawIntegrity(previous)) {
    return failClosedMerge(previous, incoming);
  }
  if (!previousHasIntegrity) {
    if (incoming.__contextPruneRawUpdate === true ||
        (incomingHasIntegrity && !hasValidRawIntegrity(incoming))) {
      return failClosedMerge(previous, incoming);
    }
    return incomingRecord;
  }

  if (incoming.__contextPruneRawUpdate === true) {
    if (incoming.resultText === "" && integrityMatches(previous, incoming)) {
      return preserveVerifiedRaw(previous, incoming);
    }
    return failClosedMerge(previous, incoming);
  }
  if (incoming.__contextPruneRawOnly === true) {
    if (incomingHasIntegrity && hasValidRawIntegrity(incoming) && integrityMatches(previous, incoming)) {
      return incomingRecord;
    }
    return failClosedMerge(previous, incoming);
  }
  if (incomingHasIntegrity && !integrityMatches(previous, incoming)) {
    return failClosedMerge(previous, incoming);
  }
  return preserveVerifiedRaw(previous, incoming);
}
