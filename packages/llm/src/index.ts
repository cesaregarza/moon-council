import type { DecisionProvider } from "./provider";
import { AnthropicMessagesProvider } from "./anthropic";
import { CodexLoginProvider } from "./codex";
import { CodexDirectProvider } from "./codex-direct";
import { selectedProviderKind, type DecisionProviderKind } from "./config";
import { FakeDecisionProvider } from "./fake";
import { OpenAIResponsesProvider } from "./openai";

export * from "./anthropic";
export * from "./anthropic-pricing";
export * from "./codex";
export * from "./codex-direct";
export * from "./config";
export * from "./fake";
export * from "./openai";
export * from "./openai-cache";
export * from "./prompt";
export * from "./provider";
export * from "./spend-ledger";
export * from "./jev";

export function createDecisionProvider(
  kind: DecisionProviderKind = selectedProviderKind(),
): DecisionProvider {
  if (kind === "codex") return new CodexLoginProvider();
  if (kind === "codex_direct") return new CodexDirectProvider();
  if (kind === "openai") return new OpenAIResponsesProvider();
  if (kind === "anthropic") return new AnthropicMessagesProvider();
  if (kind === "fake") return new FakeDecisionProvider();
  throw new Error(`Unsupported LLM_PROVIDER: ${String(kind)}`);
}
