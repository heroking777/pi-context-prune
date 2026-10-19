import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

export const RAW_WEBSOCKET_SEND = Symbol.for("pi.api-send-cap.raw-websocket-send");
const fetchExpressions = ["(options?.fetch??globalThis.fetch)", "(options?.fetch ?? globalThis.fetch)"];
const autoTransport = ["transport=options?.transport||\"auto\"", 'const transport = options?.transport || "auto";'];
const websocketConstructor = /socket\s*=\s*new WebSocketCtor\(url,\s*\{\s*headers:\s*wsHeaders\s*\}\);?/g;
const responseCreate = /socket\.send\(JSON\.stringify\(\{\s*type:\s*["']response\.create["'],\s*\.\.\.requestBody\s*\}\)\)/g;
const retryLoop = /for\s*\(\s*let\s+attempt\s*=\s*0\s*;\s*attempt\s*<=\s*maxRetries\s*;\s*attempt\+\+\s*\)\s*\{/g;
const fallbackCall = /recordWebSocketSseFallback\(cacheSessionId\)/g;
const acquireCall = /options\?\.signal\s*,\s*websocketConnectTimeoutMs\s*,\s*options\?\.env\s*\)/g;
const acquireSignature = /async function acquireWebSocket\(([^)]*)\)\s*\{/g;
const connectSignature = /async function connectWebSocket\(([^)]*)\)\s*\{/g;
const connectCall = /connectWebSocket\(url\s*,\s*headers\s*,\s*signal\s*,\s*connectTimeoutMs\s*,\s*env\s*\)/g;
const bundleStart = 'transport=options?.transport||"auto",startEmitted';
const sourceStart = 'const transport = options?.transport || "auto";';

export function sendResponseCreate(socket, payload, target, budget, onBlocked) {
  captureSafeToolSchema(payload);
  try {
    const consume = socket[Symbol.for("pi.api-send-cap.consume-websocket-reservation")];
    if (typeof consume !== "function" || !consume.call(socket)) budget.reserve("websocket.send", target);
  } catch (error) {
    onBlocked(error, target);
    throw error;
  }
  const rawSend = socket[RAW_WEBSOCKET_SEND];
  return typeof rawSend === "function" ? rawSend.call(socket, payload) : socket.send(payload);
}

function captureSafeToolSchema(payload) {
  const path = process.env.PI_API_SEND_CAP_SCHEMA_CAPTURE;
  if (!path) return;
  const tools = JSON.parse(payload).tools ?? [];
  const query = Array.isArray(tools) ? tools.find((tool) => tool.name === "context_tree_query") : undefined;
  appendFileSync(path, `${JSON.stringify({
    event: "request-tool-schema", toolCount: Array.isArray(tools) ? tools.length : 0,
    contextTreeQueryPresent: Boolean(query),
    contextTreeQuerySchemaSha256: query ? createHash("sha256").update(JSON.stringify(query.parameters ?? {})).digest("hex") : null,
  })}\n`, { mode: 0o600 });
}

function validateProviderSource(url, source, sourceBytes, budget, fetchExpr) {
  const checks = {
    fetchExpressionUnique: Boolean(fetchExpr) && source.split(fetchExpr).length === 2,
    autoTransportIdentified: autoTransport.some((text) => source.includes(text)),
    websocketGlobalIdentified: source.includes("globalThis.WebSocket"),
    websocketConstructorUnique: source.match(websocketConstructor)?.length === 1,
    responseCreateUnique: source.match(responseCreate)?.length === 1,
    streamEntryUnique: source.split(bundleStart).length === 2 || source.split(sourceStart).length === 2,
    bundleOperationContextUnique: !source.includes(bundleStart) || source.split("isWebSocketSseFallbackActive(cacheSessionId);if(websocketDisabledForSession").length === 2,
    fallbackBranchesIdentified: source.match(fallbackCall)?.length === 2,
    retryLoopUnique: source.match(retryLoop)?.length === 1,
    acquireCallUnique: source.match(acquireCall)?.length === 1,
    acquireSignatureUnique: source.match(acquireSignature)?.length === 1,
    connectCallsUnique: source.match(connectCall)?.length === 3,
    connectSignatureUnique: source.match(connectSignature)?.length === 1,
  };
  const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  if (failedChecks.length) rejectProviderSource(url, sourceBytes, failedChecks, checks, budget);
  return source.includes(bundleStart);
}

function rejectProviderSource(url, sourceBytes, failedChecks, checks, budget) {
  const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
  appendFileSync(join(budget.directory, "provider-boundary-rejected.jsonl"), `${JSON.stringify({
    event: "provider-boundary-rejected", moduleUrl: url, sourceSha256,
    sourceBytes: sourceBytes.length, failedChecks, checks,
  })}\n`, { mode: 0o600 });
  throw new Error(`Codex transport/send boundary changed; refusing unguarded API sends (${failedChecks.join(",")})`);
}

function validateTransformedSource(url, sourceBytes, source, budget) {
  const checks = {
    guardedFetchPresent: source.includes("__PI_API_SEND_CAP_FETCH_FOR_ATTEMPT"),
    websocketWrapperPresent: source.includes("__PI_API_SEND_CAP_WRAP_WEBSOCKET"),
    responseCreateGuardPresent: source.includes("__PI_API_SEND_CAP_RESPONSE_CREATE"),
    operationContextPresent: source.includes("__piApiOperationId:operationId") || source.includes("__piApiOperationId: operationId"),
    retryEventPresent: source.includes("fetch-attempt"),
    fallbackEventPresent: source.includes("sse-fallback-selected"),
    websocketRequestIdPresent: source.includes("__PI_API_SEND_CAP_WS_ATTEMPT(operationId)"),
  };
  const failures = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  if (failures.length) rejectProviderSource(url, sourceBytes, failures, checks, budget);
}

function transformProviderSource(source, fetchExpr, bundled) {
  if (bundled) {
    source = source.replace(bundleStart, `transport=options?.transport||"auto",operationId=globalThis.__PI_API_SEND_CAP_BEGIN_OPERATION(),startEmitted`);
    source = source.replace("isWebSocketSseFallbackActive(cacheSessionId);if(websocketDisabledForSession", "isWebSocketSseFallbackActive(cacheSessionId);options={...options,__piApiOperationId:operationId};if(websocketDisabledForSession");
  } else {
    source = source.replace(sourceStart, `${sourceStart} const operationId = globalThis.__PI_API_SEND_CAP_BEGIN_OPERATION(); options = { ...options, __piApiOperationId: operationId };`);
  }
  source = source.replace(fetchExpr, "(globalThis.__PI_API_SEND_CAP_FETCH_FOR_ATTEMPT(operationId, attempt))");
  source = source.replaceAll(fallbackCall, '(globalThis.__PI_API_SEND_CAP_EVENT(operationId, "sse-fallback-selected"),recordWebSocketSseFallback(cacheSessionId))');
  source = source.replace(retryLoop, (match) => `${match}globalThis.__PI_API_SEND_CAP_EVENT(operationId, "fetch-attempt", { retry_attempt: attempt + 1, retry: attempt > 0, transport: "sse" });`);
  source = source.replace(acquireCall, "options?.signal,websocketConnectTimeoutMs,options?.env,options?.__piApiOperationId)");
  source = source.replace(acquireSignature, (_match, args) => `async function acquireWebSocket(${args},operationId){`);
  source = source.replaceAll(connectCall, "connectWebSocket(url,headers,signal,connectTimeoutMs,env,operationId)");
  source = source.replace(connectSignature, (_match, args) => `async function connectWebSocket(${args},operationId){let requestId=globalThis.__PI_API_SEND_CAP_WS_ATTEMPT(operationId);`);
  source = source.replace(websocketConstructor, "socket=new (globalThis.__PI_API_SEND_CAP_WRAP_WEBSOCKET(WebSocketCtor,operationId,requestId))(url,{headers:wsHeaders})");
  return source.replace(responseCreate, 'globalThis.__PI_API_SEND_CAP_RESPONSE_CREATE(socket,JSON.stringify({type:"response.create",...requestBody}),url)');
}

export function patchCodexProvider(url, loaded, budget) {
  if (!url.includes("openai-codex-responses")) return loaded;
  if (loaded.source === undefined) throw new Error("Codex provider source unavailable; refusing network");
  for (const name of ["__PI_API_SEND_CAP_FETCH_FOR_ATTEMPT", "__PI_API_SEND_CAP_WRAP_WEBSOCKET", "__PI_API_SEND_CAP_RESPONSE_CREATE", "__PI_API_SEND_CAP_BEGIN_OPERATION", "__PI_API_SEND_CAP_EVENT", "__PI_API_SEND_CAP_WS_ATTEMPT"]) {
    if (typeof globalThis[name] !== "function") throw new Error(`Missing ${name}; refusing network`);
  }
  const sourceBytes = typeof loaded.source === "string" ? Buffer.from(loaded.source) : Buffer.from(loaded.source);
  const source = sourceBytes.toString("utf8");
  const fetchExpr = fetchExpressions.find((candidate) => source.includes(candidate));
  const bundled = validateProviderSource(url, source, sourceBytes, budget, fetchExpr);
  const patched = transformProviderSource(source, fetchExpr, bundled);
  validateTransformedSource(url, sourceBytes, patched, budget);
  const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
  appendFileSync(join(budget.directory, "provider-path.jsonl"), `${JSON.stringify({
    url, sourceSha256, sourceBytes: sourceBytes.length,
    transport: "websocket-auto-with-sse-fetch-fallback", fetchRedirectedToGuard: true,
    resolvedWebSocketConstructorWrapped: true, responseCreateSendGuarded: true, operationScopedInstrumentation: true,
  })}\n`, { mode: 0o600 });
  globalThis.__PI_API_SEND_CAP_PROVIDER_VERIFIED = true;
  return { ...loaded, source: patched };
}
