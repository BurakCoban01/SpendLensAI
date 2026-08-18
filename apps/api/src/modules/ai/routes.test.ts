import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app";

async function registerOwner(app: FastifyInstance) {
  const suffix = Math.random().toString(36).slice(2);
  const response = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: {
      tenantName: `AI Tenant ${suffix}`,
      tenantSlug: `ai-${suffix}`,
      workspaceName: "AI Workspace",
      email: `ai-${suffix}@example.com`,
      displayName: "AI Owner",
      password: "very-secure-password"
    }
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { tokens: { accessToken: string } };
}

describe("AI routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("reports disabled provider status without requiring external keys", async () => {
    app = await buildApp({ config: { SPENDLENS_USE_MEMORY_ADAPTERS: true } });
    const auth = await registerOwner(app);

    const response = await app.inject({
      method: "GET",
      url: "/ai/providers/status",
      headers: { authorization: `Bearer ${auth.tokens.accessToken}` }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      provider: "disabled",
      enabled: false,
      configured: false,
      rawInputStorage: false
    });
  });

  it("blocks extraction assistance when no provider is configured", async () => {
    app = await buildApp({ config: { SPENDLENS_USE_MEMORY_ADAPTERS: true } });
    const auth = await registerOwner(app);

    const response = await app.inject({
      method: "POST",
      url: "/ai/extraction/assist",
      headers: { authorization: `Bearer ${auth.tokens.accessToken}` },
      payload: { ocrText: "GENEL TOPLAM 72,05 TL" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: { code: "LLM_PROVIDER_DISABLED" } });
  });
});
