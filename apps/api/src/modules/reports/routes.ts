import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticateRequest, requirePermission } from "../auth/routes";
import { AuthError, AuthService } from "../auth/service";
import { ReportError, ReportService } from "./service";
import { reportExportTypes } from "./types";

const CreateExportSchema = z.object({
  workspaceId: z.string().min(1),
  type: z.enum(reportExportTypes),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional()
});

const ListExportsQuerySchema = z.object({
  workspaceId: z.string().min(1)
});

export async function registerReportRoutes(app: FastifyInstance, auth: AuthService, reports: ReportService): Promise<void> {
  app.post("/reports/exports", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "reports.export");
      const body = CreateExportSchema.parse(request.body);
      reply.code(201);
      return serializeForJson(
        await reports.createExport({
          principal,
          workspaceId: body.workspaceId,
          type: body.type,
          ...(body.month !== undefined ? { month: body.month } : {}),
          correlationId: correlationId(request)
        })
      );
    } catch (error) {
      return sendReportError(reply, error);
    }
  });

  app.get("/reports/exports", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "reports.export");
      const query = ListExportsQuerySchema.parse(request.query);
      return serializeForJson({ exportJobs: await reports.listExports(principal, query.workspaceId) });
    } catch (error) {
      return sendReportError(reply, error);
    }
  });
}

function sendReportError(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError) {
    reply.code(400);
    return { error: { code: "VALIDATION_ERROR", issues: error.issues } };
  }
  if (error instanceof AuthError) {
    reply.code(error.statusCode);
    return { error: { code: error.code } };
  }
  if (error instanceof ReportError) {
    reply.code(error.statusCode);
    return { error: { code: error.code } };
  }
  reply.code(500);
  return { error: { code: "INTERNAL_ERROR" } };
}

function serializeForJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, nested) => (typeof nested === "bigint" ? nested.toString() : nested)));
}

function correlationId(request: FastifyRequest): string | null {
  const value = request.headers["x-correlation-id"];
  return typeof value === "string" ? value : request.id;
}
