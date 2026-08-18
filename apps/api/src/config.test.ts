import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

describe("loadConfig", () => {
  it("parses string booleans without treating false as truthy", () => {
    expect(loadConfig({ SPENDLENS_USE_MEMORY_ADAPTERS: "false" }).SPENDLENS_USE_MEMORY_ADAPTERS).toBe(false);
    expect(loadConfig({ SPENDLENS_USE_MEMORY_ADAPTERS: "0" }).SPENDLENS_USE_MEMORY_ADAPTERS).toBe(false);
    expect(loadConfig({ SPENDLENS_USE_MEMORY_ADAPTERS: "true" }).SPENDLENS_USE_MEMORY_ADAPTERS).toBe(true);
    expect(loadConfig({ SPENDLENS_USE_MEMORY_ADAPTERS: "1" }).SPENDLENS_USE_MEMORY_ADAPTERS).toBe(true);
  });

  it("keeps external LLM providers disabled unless explicitly configured", () => {
    const defaults = loadConfig({});
    expect(defaults.LLM_ENABLED).toBe(false);
    expect(defaults.LLM_PROVIDER).toBe("disabled");
    expect(defaults.GEMINI_MODEL).toBe("gemini-3.1-flash-lite");
    expect(defaults.ZAI_MODEL).toBe("glm-5.1");
    expect(defaults.LLM_STORE_RAW_INPUTS).toBe(false);
    expect(defaults.WEBHOOK_SECRET_ENCRYPTION_KEY).toBe("development_webhook_secret_key_change_me");

    const enabled = loadConfig({ LLM_ENABLED: "true", LLM_PROVIDER: "zai", ZAI_THINKING_ENABLED: "true" });
    expect(enabled.LLM_ENABLED).toBe(true);
    expect(enabled.LLM_PROVIDER).toBe("zai");
    expect(enabled.ZAI_THINKING_ENABLED).toBe(true);
  });
});
