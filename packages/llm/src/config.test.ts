import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeProviderConfiguration,
  resolveDefaultModel,
  resolveModeratorModel,
  selectedProviderKind,
} from "./config";

describe("provider configuration", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses Codex-specific models with the OpenAI model as a fallback", () => {
    vi.stubEnv("OPENAI_MODEL", "shared-model");
    expect(resolveDefaultModel("codex")).toBe("shared-model");

    vi.stubEnv("CODEX_MODEL", "codex-model");
    vi.stubEnv("CODEX_MODERATOR_MODEL", "codex-moderator");
    expect(resolveDefaultModel("codex")).toBe("codex-model");
    expect(resolveModeratorModel("codex-model", "codex")).toBe("codex-moderator");
  });

  it("reports Codex login mode without claiming that credentials were inspected", () => {
    vi.stubEnv("CODEX_MODEL", "codex-model");
    expect(describeProviderConfiguration("codex")).toEqual({
      provider: "codex",
      providerReady: true,
      liveModelConfigured: true,
      authentication: "codex_login",
      statusDetail: "Codex login mode configured",
    });
  });

  it("rejects unsupported providers and missing live defaults", () => {
    expect(() => selectedProviderKind("other")).toThrow("Unsupported LLM_PROVIDER");
    vi.stubEnv("OPENAI_MODEL", "");
    vi.stubEnv("CODEX_MODEL", "");
    expect(() => resolveDefaultModel("codex")).toThrow("CODEX_MODEL or OPENAI_MODEL");
  });
});
