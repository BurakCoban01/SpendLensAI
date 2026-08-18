import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { authenticateRequest, requirePermission } from "../auth/routes";
import { AuthError, type AuthService } from "../auth/service";
import { CacheError, CacheService } from "./service";

const StatusQuerySchema = z.object({
  prefix: z.string().trim().min(1).max(120).default("worker-job:"),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

const AcquireLockSchema = z.object({
  key: z.string().trim().min(2).max(200),
  ttlMs: z.number().int().min(100).max(300000).default(30000)
});

const ReleaseLockSchema = z.object({
  key: z.string().trim().min(2).max(200)
});

export async function registerCacheRoutes(app: FastifyInstance, auth: AuthService, cache: CacheService): Promise<void> {
  app.get("/admin/cache", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "admin.cache.read");
      const query = StatusQuerySchema.parse(request.query);
      return cache.status(query.prefix, query.limit);
    } catch (error) {
      return sendCacheError(reply, error);
    }
  });

  app.post("/admin/cache/locks/acquire", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "admin.cache.manage");
      const body = AcquireLockSchema.parse(request.body);
      return cache.acquireLock({ principal, key: body.key, ttlMs: body.ttlMs });
    } catch (error) {
      return sendCacheError(reply, error);
    }
  });

  app.post("/admin/cache/locks/release", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "admin.cache.manage");
      const body = ReleaseLockSchema.parse(request.body);
      return cache.releaseLock({ principal, key: body.key });
    } catch (error) {
      return sendCacheError(reply, error);
    }
  });
}

function sendCacheError(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError) {
    reply.code(400);
    return { error: { code: "VALIDATION_ERROR", issues: error.issues } };
  }
  if (error instanceof AuthError || error instanceof CacheError) {
    reply.code(error.statusCode);
    return { error: { code: error.code } };
  }
  reply.code(500);
  return { error: { code: "INTERNAL_ERROR" } };
}
