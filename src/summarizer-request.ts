// Model resolution and request options for the summarizer request. Extracted
// from src/summarizer.ts (behavior-preserving) to keep that module within the
// 300-line limit.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ContextPruneConfig, SummarizerThinking } from "./types.js";

export function summarizerThinkingOptions(config: ContextPruneConfig): Record<string, unknown> {
  const level: SummarizerThinking = config.summarizerThinking;
  if (level === "default") {
    return {};
  }

  const effort = level === "off" ? undefined : level;
  // Phase1 (AI-INPUT-CONTEXT-OPT-026): emit both option keys.
  //   - pi-ai's openai-completions / responses streams read `reasoningEffort`
  //   - the Command Code provider reads `reasoning`
  //     (pi-commandcode-provider src/core.ts `mappedReasoningEffort`)
  // `off` maps to `undefined` for both keys, which is each implementation's
  // documented "send no reasoning parameter" (disable) path. Nothing is sent
  // on the wire for `off`; providers without reasoning support are unaffected.
  return { reasoning: effort, reasoningEffort: effort };
}

/**
 * Returns the model to use for summarization.
 * config.summarizerModel === "default" => ctx.model
 * "provider/model-id" => ctx.modelRegistry.find(provider, modelId), fallback to ctx.model with warning
 */
export function resolveModel(config: ContextPruneConfig, ctx: ExtensionContext): any {
  if (config.summarizerModel === "default") {
    return ctx.model;
  }

  const slashIndex = config.summarizerModel.indexOf("/");
  if (slashIndex === -1) {
    ctx.ui.notify(
      `pruner: invalid summarizerModel "${config.summarizerModel}", expected "provider/model-id". Falling back to default model.`,
      "warning",
    );
    return ctx.model;
  }

  const provider = config.summarizerModel.slice(0, slashIndex);
  const modelId = config.summarizerModel.slice(slashIndex + 1);

  const found = ctx.modelRegistry.find(provider, modelId);
  if (!found) {
    ctx.ui.notify(
      `pruner: model "${config.summarizerModel}" not found in registry. Falling back to default model.`,
      "warning",
    );
    return ctx.model;
  }

  return found;
}

export function receivedTextChars(message: AssistantMessage): number {
  return message.content.reduce((sum, content) => {
    return content.type === "text" ? sum + content.text.length : sum;
  }, 0);
}
