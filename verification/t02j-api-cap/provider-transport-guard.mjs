import { appendFileSync } from "node:fs";
import { join } from "node:path";

export const RAW_WEBSOCKET_SEND = Symbol.for("pi.api-send-cap.raw-websocket-send");
const fetchExpressions = ["(options?.fetch??globalThis.fetch)", "(options?.fetch ?? globalThis.fetch)"];
const autoTransportExpressions = ["transport=options?.transport||\"auto\"", "const transport = options?.transport || \"auto\";"];
const websocketConstructorPattern = /socket\s*=\s*new WebSocketCtor\(url,\s*\{\s*headers:\s*wsHeaders\s*\}\);?/g;
const responseCreatePattern = /socket\.send\(JSON\.stringify\(\{\s*type:\s*["']response\.create["'],\s*\.\.\.requestBody\s*\}\)\);?/g;
const streamStart = 'const transport = options?.transport || "auto";';
const fallbackStatement = "recordWebSocketSseFallback(cacheSessionId);";
const retryLoop = "for (let attempt = 0; attempt <= maxRetries; attempt++) {";
const providerStreamCall = "}, httpTimeoutMs, websocketConnectTimeoutMs, cacheSessionId, accountId, grammarToolInputProperties, options);";
const processSignature = "async function processWebSocketStream(url, body, headers, output, stream, model, onStart, idleTimeoutMs, websocketConnectTimeoutMs, cacheSessionId, accountId, grammarToolInputProperties, options) {";
const acquireCall = "options?.signal, websocketConnectTimeoutMs, options?.env);";
const acquireSignature = "async function acquireWebSocket(url, headers, sessionId, accountId, signal, connectTimeoutMs, env) {";
const connectSignature = "async function connectWebSocket(url, headers, signal, connectTimeoutMs = DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS, env) {";
const connectCall = "connectWebSocket(url, headers, signal, connectTimeoutMs, env)";

export function sendResponseCreate(socket, payload, target, budget, onBlocked) {
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

export function patchCodexProvider(url, loaded, budget) {
  if (!url.includes("openai-codex-responses")) return loaded;
  if (loaded.source === undefined) throw new Error("Codex provider source unavailable; refusing network");
  for (const name of ["__PI_API_SEND_CAP_FETCH_FOR_ATTEMPT", "__PI_API_SEND_CAP_WRAP_WEBSOCKET", "__PI_API_SEND_CAP_RESPONSE_CREATE", "__PI_API_SEND_CAP_BEGIN_OPERATION", "__PI_API_SEND_CAP_EVENT", "__PI_API_SEND_CAP_WS_ATTEMPT"]) {
    if (typeof globalThis[name] !== "function") throw new Error(`Missing ${name}; refusing network`);
  }
  let source = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString("utf8");
  const fetchExpr = fetchExpressions.find((candidate) => source.includes(candidate));
  const fetchCount = fetchExpr ? source.split(fetchExpr).length - 1 : 0;
  const constructorCount = source.match(websocketConstructorPattern)?.length ?? 0;
  const responseCreateCount = source.match(responseCreatePattern)?.length ?? 0;
  if (!fetchExpr || fetchCount !== 1 || !autoTransportExpressions.some((needle) => source.includes(needle)) ||
      !source.includes("globalThis.WebSocket") || constructorCount !== 1 || responseCreateCount !== 1 ||
      source.split(streamStart).length !== 2 || source.split(fallbackStatement).length !== 3 || source.split(retryLoop).length !== 2 ||
      source.split(providerStreamCall).length !== 2 || source.split(processSignature).length !== 2 ||
      source.split(acquireCall).length !== 2 || source.split(acquireSignature).length !== 2 ||
      source.split(connectSignature).length !== 2 || source.split(connectCall).length !== 4) {
    throw new Error("Codex transport/send boundary changed; refusing unguarded API sends");
  }
  source = source.replace(streamStart, `${streamStart} const operationId = globalThis.__PI_API_SEND_CAP_BEGIN_OPERATION();`);
  source = source.replace(fetchExpr, "(globalThis.__PI_API_SEND_CAP_FETCH_FOR_ATTEMPT(operationId, attempt))");
  source = source.replace(providerStreamCall, "}, httpTimeoutMs, websocketConnectTimeoutMs, cacheSessionId, accountId, grammarToolInputProperties, options, operationId);");
  source = source.replace(processSignature, processSignature.replace(") {", ", operationId) {"));
  source = source.replace(acquireCall, "options?.signal, websocketConnectTimeoutMs, options?.env, operationId);");
  source = source.replace(acquireSignature, acquireSignature.replace(") {", ", operationId) {"));
  source = source.replaceAll(connectCall, "connectWebSocket(url, headers, signal, connectTimeoutMs, env, operationId)");
  source = source.replace(connectSignature, `${connectSignature.replace(") {", ", operationId) {")} const requestId = globalThis.__PI_API_SEND_CAP_WS_ATTEMPT(operationId);`);
  source = source.replace(websocketConstructorPattern,
    "socket = new (globalThis.__PI_API_SEND_CAP_WRAP_WEBSOCKET(WebSocketCtor, operationId, requestId))(url, { headers: wsHeaders });");
  source = source.replaceAll(fallbackStatement,
    'globalThis.__PI_API_SEND_CAP_EVENT(operationId, "sse-fallback-selected");');
  source = source.replace(retryLoop, `${retryLoop} globalThis.__PI_API_SEND_CAP_EVENT(operationId, "fetch-attempt", { retry_attempt: attempt + 1, retry: attempt > 0, transport: "sse" });`);
  source = source.replace(responseCreatePattern,
    'globalThis.__PI_API_SEND_CAP_RESPONSE_CREATE(socket, JSON.stringify({ type: "response.create", ...requestBody }), url)');
  appendFileSync(join(budget.directory, "provider-path.jsonl"), `${JSON.stringify({
    url,
    transport: "websocket-auto-with-sse-fetch-fallback",
    fetchRedirectedToGuard: true,
    resolvedWebSocketConstructorWrapped: true,
    responseCreateSendGuarded: true,
  })}\n`, { mode: 0o600 });
  globalThis.__PI_API_SEND_CAP_PROVIDER_VERIFIED = true;
  return { ...loaded, source };
}
