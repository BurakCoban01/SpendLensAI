import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { authenticateRequest, requirePermission } from "../auth/routes";
import { AuthError, type AuthService } from "../auth/service";
import { AuditError, AuditService } from "./service";

const ListQuerySchema = z.object({
  action: z.string().trim().min(1).max(120).optional(),
  resourceType: z.string().trim().min(1).max(80).optional(),
  actorUserId: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

const ExportSchema = z.object({
  action: z.string().trim().min(1).max(120).optional(),
  resourceType: z.string().trim().min(1).max(80).optional(),
  actorUserId: z.string().trim().min(1).max(120).optional(),
  limit: z.number().int().min(1).max(1000).default(1000)
});

const RetentionSchema = z.object({
  retentionDays: z.number().int().min(1).max(3650),
  dryRun: z.boolean().default(true),
  confirm: z.boolean().default(false)
});

export async function registerAuditRoutes(app: FastifyInstance, auth: AuthService, audit: AuditService): Promise<void> {
  app.get("/admin/audit", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "admin.audit.read");
      const query = ListQuerySchema.parse(request.query);
      const result = await audit.list(principal, {
        ...(query.action ? { action: query.action } : {}),
        ...(query.resourceType ? { resourceType: query.resourceType } : {}),
        ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
        limit: query.limit
      });
      return {
        summary: result.summary,
        logs: result.logs.map(serializeLog)
      };
    } catch (error) {
      return sendAuditError(reply, error);
    }
  });

  app.post("/admin/audit/export", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "admin.audit.read");
      const body = ExportSchema.parse(request.body ?? {});
      const result = await audit.exportLogs(principal, {
        ...(body.action ? { action: body.action } : {}),
        ...(body.resourceType ? { resourceType: body.resourceType } : {}),
        ...(body.actorUserId ? { actorUserId: body.actorUserId } : {}),
        limit: body.limit
      });
      return {
        ...result,
        generatedAt: result.generatedAt.toISOString()
      };
    } catch (error) {
      return sendAuditError(reply, error);
    }
  });

  app.post("/admin/audit/retention", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "admin.audit.manage");
      const body = RetentionSchema.parse(request.body ?? {});
      const result = await audit.retention({
        principal,
        retentionDays: body.retentionDays,
        dryRun: body.dryRun,
        confirm: body.confirm
      });
      return {
        ...result,
        cutoff: result.cutoff.toISOString(),
        sample: result.sample.map(serializeLog)
      };
    } catch (error) {
      return sendAuditError(reply, error);
    }
  });
}

function serializeLog(log: {
  id: string;
  tenantId: string;
  actorUserId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: Record<string, unknown> | null;
  ipHash: string | null;
  userAgent: string | null;
  correlationId: string | null;
  createdAt: Date;
}) {
  return {
    ...log,
    createdAt: log.createdAt.toISOString()
  };
}

function sendAuditError(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError) {
    reply.code(400);
    return { error: { code: "VALIDATION_ERROR", issues: error.issues } };
  }
  if (error instanceof AuthError || error instanceof AuditError) {
    reply.code(error.statusCode);
    return { error: { code: error.code } };
  }
  reply.code(500);
  return { error: { code: "INTERNAL_ERROR" } };
}
