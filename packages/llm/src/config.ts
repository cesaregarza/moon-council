import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Environment variables win; environment-file read errors must not silently select fake mode. */
export function loadProviderEnvironment(): void {
  const path = fileURLToPath(new URL("../../../.env", import.meta.url));
  if (existsSync(path)) process.loadEnvFile(path);
}

export const DecisionProviderKinds = ["fake", "openai", "codex", "codex_direct"] as const;
export type DecisionProviderKind = (typeof DecisionProviderKinds)[number];

/** Both Codex transports authenticate with the same `codex login` credentials. */
export function usesCodexLogin(kind: DecisionProviderKind): boolean {
  return kind === "codex" || kind === "codex_direct";
}

export interface ProviderConfiguration {
  provider: DecisionProviderKind;
  providerReady: boolean;
  liveModelConfigured: boolean;
  authentication: "none" | "api_key" | "codex_login";
  statusDetail: string;
}

export function selectedProviderKind(value = process.env.LLM_PROVIDER ?? "fake"): DecisionProviderKind {
  if (DecisionProviderKinds.includes(value as DecisionProviderKind)) return value as DecisionProviderKind;
  throw new Error(`Unsupported LLM_PROVIDER: ${value}`);
}

export function resolveDefaultModel(kind = selectedProviderKind()): string {
  if (kind === "fake") return "fake-model";
  const model = usesCodexLogin(kind)
    ? process.env.CODEX_MODEL?.trim() || process.env.OPENAI_MODEL?.trim()
    : process.env.OPENAI_MODEL?.trim();
  if (model) return model;
  throw new Error(
    usesCodexLogin(kind)
      ? `CODEX_MODEL or OPENAI_MODEL is required when LLM_PROVIDER=${kind}`
      : "OPENAI_MODEL is required when LLM_PROVIDER=openai",
  );
}

export function resolveModeratorModel(defaultModel: string, kind = selectedProviderKind()): string {
  if (usesCodexLogin(kind)) {
    return process.env.CODEX_MODERATOR_MODEL?.trim() || process.env.OPENAI_MODERATOR_MODEL?.trim() || defaultModel;
  }
  return process.env.OPENAI_MODERATOR_MODEL?.trim() || defaultModel;
}

export function describeProviderConfiguration(kind = selectedProviderKind()): ProviderConfiguration {
  if (kind === "fake") {
    return {
      provider: kind,
      providerReady: true,
      liveModelConfigured: false,
      authentication: "none",
      statusDetail: "Deterministic fake mode",
    };
  }
  if (kind === "openai") {
    const ready = Boolean(process.env.OPENAI_API_KEY?.trim() && process.env.OPENAI_MODEL?.trim());
    return {
      provider: kind,
      providerReady: ready,
      liveModelConfigured: ready,
      authentication: "api_key",
      statusDetail: ready ? "OpenAI API key configured" : "Set OPENAI_API_KEY and OPENAI_MODEL",
    };
  }
  const ready = Boolean(process.env.CODEX_MODEL?.trim() || process.env.OPENAI_MODEL?.trim());
  const transport = kind === "codex_direct" ? "Codex login direct Responses transport" : "Codex login mode configured";
  return {
    provider: kind,
    providerReady: ready,
    liveModelConfigured: ready,
    authentication: "codex_login",
    statusDetail: ready ? transport : "Set CODEX_MODEL or OPENAI_MODEL",
  };
}
