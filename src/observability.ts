import { AsyncLocalStorage } from "node:async_hooks";
import type { CapturedBatch, ContextPruneConfig } from "./types.js";
import {
  defaultMetadataObserver,
  MetadataObserver,
  type BatchCommitInfo,
  type BatchCommitOutcome,
  type FlushCommitInfo,
  type FlushReason,
  type ObservationContext,
} from "./observability-log.js";
import { rawChars } from "./observability-log.js";
export { MetadataObserver, defaultMetadataObserver } from "./observability-log.js";
export type { BatchCommitInfo, BatchCommitOutcome, FlushCommitInfo, FlushReason } from "./observability-log.js";

const contextStorage = new AsyncLocalStorage<ObservationContext>();

export function withFlushObservation<T>(
  reason: FlushReason,
  config: ContextPruneConfig | null,
  action: () => T,
  observer: MetadataObserver = defaultMetadataObserver,
): T {
  if (!observer.enabled) return action();
  return contextStorage.run(
    {
      reason, config, observer, pendingCallCount: null, pendingRawCharCount: null,
      pendingScope: "batch", floorSkippedCallCount: 0, floorSkippedRawCharCount: 0,
    },
    action,
  );
}

export function withPendingBatchMetrics<T>(batches: CapturedBatch[], action: () => T): T {
  const context = contextStorage.getStore();
  if (!context?.observer.enabled) return action();
  const pendingCallCount = batches.reduce((sum, batch) => sum + batch.toolCalls.length, context.floorSkippedCallCount);
  const pendingRawCharCount = batches.reduce((sum, batch) => sum + rawChars(batch), context.floorSkippedRawCharCount);
  return contextStorage.run({ ...context, pendingCallCount, pendingRawCharCount, pendingScope: "flush" }, action);
}

export async function measureSummary<T>(
  batch: CapturedBatch,
  config: ContextPruneConfig,
  action: () => Promise<T>,
  observer?: MetadataObserver,
): Promise<T> {
  const context = contextStorage.getStore();
  const active = observer ?? context?.observer ?? defaultMetadataObserver;
  if (!active.enabled) return action();
  let started = 0;
  try { started = performance.now(); } catch { /* latency remains unknown */ }
  let result: T | null = null;
  let threw = false;
  try {
    result = await action();
    return result;
  } catch (error) {
    threw = true;
    throw error;
  } finally {
    try {
      const elapsed = started ? Math.max(0, performance.now() - started) : null;
      active.recordSummary(batch, config, result, elapsed, context, threw);
    } catch { /* telemetry failures are non-fatal */ }
  }
}

export function recordBatchOutcome(
  batch: CapturedBatch,
  outcome: BatchCommitOutcome,
  info: BatchCommitInfo = { indexPersisted: false },
): void {
  const context = contextStorage.getStore();
  const observer = context?.observer ?? defaultMetadataObserver;
  try { observer.recordBatchOutcome(batch, outcome, info, context); } catch { /* non-fatal */ }
  if (outcome === "skipped-size-floor" && context?.observer.enabled) {
    context.floorSkippedCallCount += batch.toolCalls.length;
    context.floorSkippedRawCharCount += rawChars(batch);
  }
}

/**
 * Attaches the flush reason that the calling code actually evaluated. The
 * event-name proxy cannot prove why a flush fired, so it records no reason;
 * only these explicit scopes name a reason.
 */
export function runWithFlushReason<T>(reason: FlushReason, action: () => T): T {
  const context = contextStorage.getStore();
  if (!context?.observer.enabled) return action();
  return contextStorage.run({ ...context, reason }, action);
}

/** Records the persistence-phase result of the flush (index vs frontier/stats). */
export function recordFlushCommit(info: FlushCommitInfo): void {
  const context = contextStorage.getStore();
  const observer = context?.observer ?? defaultMetadataObserver;
  try { observer.recordFlushCommit(info, context); } catch { /* non-fatal */ }
}

function wrapHandler(
  handler: (...args: any[]) => any,
  reason: FlushReason,
  getConfig: () => ContextPruneConfig,
  observer: MetadataObserver,
): (...args: any[]) => any {
  return function (this: unknown, ...args: any[]) {
    let config: ContextPruneConfig | null = null;
    try { config = getConfig(); } catch { /* leave metadata unknown */ }
    return withFlushObservation(reason, config, () => handler.apply(this, args), observer);
  };
}

export function instrumentExtensionAPI<T extends object>(
  api: T,
  getConfig: () => ContextPruneConfig,
  entryUrl: string,
  observer: MetadataObserver = defaultMetadataObserver,
): T {
  if (!observer.enabled) return api;
  try { observer.setLoadedBuildIdentity(entryUrl); } catch { /* unknown build identity */ }
  return new Proxy(api, {
    get(target, property, receiver) {
      const method = Reflect.get(target, property, receiver);
      if (property === "on" && typeof method === "function") {
        return (name: string, handler: (...args: any[]) => any, ...rest: any[]) =>
          method.call(target, name, wrapHandler(handler, "unknown", getConfig, observer), ...rest);
      }
      if (property === "registerCommand" && typeof method === "function") {
        return (name: string, options: any, ...rest: any[]) => {
          const wrapped = options && typeof options.handler === "function"
            ? { ...options, handler: wrapHandler(options.handler, "manual_command", getConfig, observer) }
            : options;
          return method.call(target, name, wrapped, ...rest);
        };
      }
      if (property === "registerTool" && typeof method === "function") {
        return (tool: any, ...rest: any[]) => {
          const wrapped = tool?.name === "context_prune" && typeof tool.execute === "function"
            ? { ...tool, execute: wrapHandler(tool.execute, "context_prune_tool", getConfig, observer) }
            : tool;
          return method.call(target, wrapped, ...rest);
        };
      }
      return typeof method === "function" ? method.bind(target) : method;
    },
  });
}
