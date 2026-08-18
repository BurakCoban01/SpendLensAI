import type { FastifyInstance } from "fastify";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { permissions, type PermissionCode } from "@spendlens/shared";
import { ApiKeyService } from "./api-keys";
import { authenticateRequest, requirePermission } from "./routes";
import { AuthError, AuthService } from "./service";

const permissionValues = [...permissions] as [PermissionCode, ...PermissionCode[]];

const CreateApiKeySchema = z.object({
  name: z.string().trim().min(2).max(120),
  scopes: z.array(z.enum(permissionValues)).min(1),
  expiresAt: z.string().datetime().nullable().optional()
});

export async function registerApiKeyRoutes(app: FastifyInstance, auth: AuthService, apiKeys: ApiKeyService): Promise<void> {
  app.post("/api-keys", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "api_keys.manage");
      const body = CreateApiKeySchema.parse(request.body);
      const result = await apiKeys.createApiKey({
        principal,
        name: body.name,
        scopes: body.scopes,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        correlationId: correlationId(request)
      });
      reply.code(201);
      return result;
    } catch (error) {
      return sendApiKeyError(reply, error);
    }
  });

  app.get("/api-keys", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "api_keys.manage");
      return { apiKeys: await apiKeys.listApiKeys(principal, { correlationId: correlationId(request) }) };
    } catch (error) {
      return sendApiKeyError(reply, error);
    }
  });

  app.delete("/api-keys/:id", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "api_keys.manage");
      const params = z.object({ id: z.string().min(1) }).parse(request.params);
      await apiKeys.revokeApiKey(principal, params.id, { correlationId: correlationId(request) });
      reply.code(204);
      return null;
    } catch (error) {
      return sendApiKeyError(reply, error);
    }
  });

  app.get("/api-keys/automation-check", async (request, reply) => {
    try {
      const tenantId = z.string().min(1).parse(request.headers["x-tenant-id"]);
      const authorization = request.headers.authorization;
      if (!authorization?.startsWith("ApiKey ")) {
        throw new AuthError("MISSING_API_KEY", 401);
      }
      const principal = await apiKeys.authenticate(authorization.slice("ApiKey ".length), tenantId);
      requirePermission(auth, principal, "documents.read");
      return { ok: true, principal };
    } catch (error) {
      return sendApiKeyError(reply, error);
    }
  });
}

function sendApiKeyError(reply: { code(statusCode: number): unknown }, error: unknown) {
  if (error instanceof z.ZodError) {
    reply.code(400);
    return { error: { code: "VALIDATION_ERROR", issues: error.issues } };
  }
  if (error instanceof AuthError) {
    reply.code(error.statusCode);
    return { error: { code: error.code } };
  }
  reply.code(500);
  return { error: { code: "INTERNAL_ERROR" } };
}

function correlationId(request: FastifyRequest): string | null {
  const value = request.headers["x-correlation-id"];
  return typeof value === "string" ? value : null;
}
