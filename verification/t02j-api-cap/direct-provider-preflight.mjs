import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.PI_AI_PROVIDER_MODULE;
if (!modulePath) throw new Error("Set PI_AI_PROVIDER_MODULE to the installed pi-ai Codex provider module");
const providerUrl = modulePath.startsWith("file:") ? modulePath : pathToFileURL(resolve(modulePath)).href;
const { streamSimple } = await import(providerUrl);
const output = process.env.PI_API_SEND_CAP_PROVIDER_CAPTURE;
const model = {
  provider: "openai-codex",
  id: "gpt-6-luna",
  api: "openai-codex-responses",
  baseUrl: process.env.PI_API_SEND_CAP_TEST_BASE_URL ?? "https://chatgpt.com",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 16384,
};
const context = {
  systemPrompt: "Use context_tree_query for Raw refs; page with startByte and concatenate page bodies.",
  messages: [{ role: "user", content: [{ type: "text", text: "offline provider-path check" }], timestamp: Date.now() }],
  tools: [{
    name: "context_tree_query",
    description: "Retrieve full tool output from a Raw reference.",
    parameters: {
      type: "object",
      properties: { toolCallIds: { type: "array", items: { type: "string" } } },
      required: ["toolCallIds"],
    },
  }],
};
const testHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
const testClaims = Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: `offline-${randomBytes(8).toString("hex")}` },
})).toString("base64url");
const options = {
  apiKey: `${testHeader}.${testClaims}.offline`,
  transport: process.env.PI_API_SEND_CAP_TEST_TRANSPORT ?? "auto",
  maxRetries: 0,
  websocketConnectTimeoutMs: 100,
  onPayload(payload) {
    if (output) {
      const tools = Array.isArray(payload?.tools) ? payload.tools : [];
      appendFileSync(output, `${JSON.stringify({
        phase: "provider-payload",
        provider: model.provider,
        model: model.id,
        querySchemaPresent: tools.some((tool) => tool.name === "context_tree_query"),
        toolNames: tools.map((tool) => tool.name),
      })}\n`);
    }
    return payload;
  },
};

for await (const _event of streamSimple(model, context, options)) {
  // The dry-run preloader exits at the guarded boundary before any transport.
}
