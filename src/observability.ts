import { AsyncLocalStorage } from "node:async_hooks";
import type { CapturedBatch, ContextPruneConfig } from "./types.js";
import {
  defaultMetadataObserver,
  MetadataObserver,
  type FlushReason,
  type ObservationContext,
} from "./observability-log.js";
import { rawChars } from "./observability-log.js";
export { MetadataObserver, defaultMetadataObserver } from "./observability-log.js";

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

export function recordFloorSkip(batch: CapturedBatch, threshold: number): void {
  const context = contextStorage.getStore();
  const observer = context?.observer ?? defaultMetadataObserver;
  try { observer.recordFloorSkip(batch, threshold, context); } catch { /* non-fatal */ }
  if (context?.observer.enabled) {
    context.floorSkippedCallCount += batch.toolCalls.length;
    context.floorSkippedRawCharCount += rawChars(batch);
  }
}

function reasonForEvent(name: string, config: ContextPruneConfig): FlushReason {
  if (name === "turn_end") {
    if (config.pruneOn === "every-turn") return "every_turn";
    return config.midTaskAutoPrune ? "threshold" : "unknown";
  }
  if (name === "message_end") return "message_end";
  if (name === "tool_execution_end") return "tool_execution_end";
  return "unknown";
}

function wrapHandler(
  handler: (...args: any[]) => any,
  reason: FlushReason | ((config: ContextPruneConfig | null) => FlushReason),
  getConfig: () => ContextPruneConfig,
  observer: MetadataObserver,
): (...args: any[]) => any {
  return function (this: unknown, ...args: any[]) {
    let config: ContextPruneConfig | null = null;
    try { config = getConfig(); } catch { /* leave metadata unknown */ }
    const resolved = typeof reason === "function" ? reason(config) : reason;
    return withFlushObservation(resolved, config, () => handler.apply(this, args), observer);
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
          method.call(target, name, wrapHandler(handler, (config) => config ? reasonForEvent(name, config) : "unknown", getConfig, observer), ...rest);
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
