import { appendFileSync } from "node:fs";
import { join } from "node:path";

export const RAW_WEBSOCKET_SEND = Symbol.for("pi.api-send-cap.raw-websocket-send");
const fetchExpressions = ["(options?.fetch??globalThis.fetch)", "(options?.fetch ?? globalThis.fetch)"];
const autoTransportExpressions = ["transport=options?.transport||\"auto\"", "const transport = options?.transport || \"auto\";"];
const websocketConstructorPattern = /socket\s*=\s*new WebSocketCtor\(url,\s*\{\s*headers:\s*wsHeaders\s*\}\);?/g;
const responseCreatePattern = /socket\.send\(JSON\.stringify\(\{\s*type:\s*["']response\.create["'],\s*\.\.\.requestBody\s*\}\)\);?/g;

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
  for (const name of ["__PI_API_SEND_CAP_FETCH", "__PI_API_SEND_CAP_WRAP_WEBSOCKET", "__PI_API_SEND_CAP_RESPONSE_CREATE"]) {
    if (typeof globalThis[name] !== "function") throw new Error(`Missing ${name}; refusing network`);
  }
  let source = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString("utf8");
  const fetchExpr = fetchExpressions.find((candidate) => source.includes(candidate));
  const fetchCount = fetchExpr ? source.split(fetchExpr).length - 1 : 0;
  const constructorCount = source.match(websocketConstructorPattern)?.length ?? 0;
  const responseCreateCount = source.match(responseCreatePattern)?.length ?? 0;
  if (!fetchExpr || fetchCount !== 1 || !autoTransportExpressions.some((needle) => source.includes(needle)) ||
      !source.includes("globalThis.WebSocket") || constructorCount !== 1 || responseCreateCount !== 1) {
    throw new Error("Codex transport/send boundary changed; refusing unguarded API sends");
  }
  source = source.replace(fetchExpr, "(globalThis.__PI_API_SEND_CAP_FETCH)");
  source = source.replace(websocketConstructorPattern,
    "socket = new (globalThis.__PI_API_SEND_CAP_WRAP_WEBSOCKET(WebSocketCtor))(url, { headers: wsHeaders });");
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
