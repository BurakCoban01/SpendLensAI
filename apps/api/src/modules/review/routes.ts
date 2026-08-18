import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { authenticateRequest, requirePermission } from "../auth/routes";
import { AuthError, AuthService } from "../auth/service";
import { ReviewError, ReviewService } from "./service";

const ParamsSchema = z.object({ id: z.string().min(1) });

const CreateTaskSchema = z.object({
  reasonCodes: z.array(z.string().min(1).max(80)).min(1).max(12),
  assignedToId: z.string().min(1).nullable().optional(),
  dueAt: z.string().datetime().nullable().optional()
});

const ListTasksQuerySchema = z.object({
  workspaceId: z.string().min(1).optional(),
  status: z.enum(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELED"]).optional(),
  assignedToId: z.string().min(1).nullable().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});
const AssignTaskSchema = z.object({
  assignedToId: z.string().min(1).nullable().optional()
});
const RunEscalationsSchema = z.object({
  workspaceId: z.string().min(1).optional(),
  dryRun: z.boolean().optional(),
  maxActions: z.number().int().min(1).max(25).optional()
});
const RejectTaskSchema = z.object({
  rejectionReason: z.string().trim().min(1).max(500)
});

const CreateCorrectionSchema = z.object({
  fieldName: z.string().trim().min(1).max(120).nullable().optional(),
  beforeValue: z.string().max(2000).nullable().optional(),
  afterValue: z.string().trim().min(1).max(2000),
  createAnnotation: z.boolean().optional(),
  annotationLabel: z.string().trim().min(1).max(120).nullable().optional(),
  annotationPayload: z.unknown().optional()
});

const CreateAnnotationSchema = z.object({
  label: z.string().trim().min(1).max(120),
  payload: z.record(z.unknown())
});

const SuggestionsQuerySchema = z.object({
  workspaceId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

export async function registerReviewRoutes(app: FastifyInstance, auth: AuthService, reviews: ReviewService): Promise<void> {
  app.post("/documents/:id/review-tasks", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "ocr.review");
      const params = ParamsSchema.parse(request.params);
      const body = CreateTaskSchema.parse(request.body);
      reply.code(201);
      return serializeForJson(
        await reviews.createTask({
          principal,
          documentFileId: params.id,
          reasonCodes: body.reasonCodes,
          assignedToId: body.assignedToId ?? null,
          dueAt: body.dueAt ?? null
        })
      );
    } catch (error) {
      return sendReviewError(reply, error);
    }
  });

  app.get("/review/tasks", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "ocr.review");
      const query = ListTasksQuerySchema.parse(request.query);
      return serializeForJson({
        reviewTasks: await reviews.listTasks({
          principal,
          ...(query.workspaceId !== undefined ? { workspaceId: query.workspaceId } : {}),
          ...(query.status !== undefined ? { status: query.status } : {}),
          ...(query.assignedToId !== undefined ? { assignedToId: query.assignedToId } : {}),
          limit: query.limit
        })
      });
    } catch (error) {
      return sendReviewError(reply, error);
    }
  });

  app.get("/review/reviewers", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "ocr.review");
      return serializeForJson({ reviewers: await reviews.listAssignableReviewers(principal) });
    } catch (error) {
      return sendReviewError(reply, error);
    }
  });

  app.get("/review/workload", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "ocr.review");
      const query = SuggestionsQuerySchema.parse(request.query);
      return serializeForJson(
        await reviews.workload({
          principal,
          ...(query.workspaceId !== undefined ? { workspaceId: query.workspaceId } : {})
        })
      );
    } catch (error) {
      return sendReviewError(reply, error);
    }
  });

  app.get("/review/rebalance-suggestions", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "ocr.review");
      const query = SuggestionsQuerySchema.parse(request.query);
      return serializeForJson(
        await reviews.rebalanceSuggestions({
          principal,
          ...(query.workspaceId !== undefined ? { workspaceId: query.workspaceId } : {})
        })
      );
    } catch (error) {
      return sendReviewError(reply, error);
    }
  });

  app.post("/review/tasks/:id/assign", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "ocr.review");
      const params = ParamsSchema.parse(request.params);
      const body = AssignTaskSchema.parse(request.body ?? {});
      return serializeForJson(
        await reviews.assignTask({
          principal,
          reviewTaskId: params.id,
          ...(body.assignedToId !== undefined ? { assignedToId: body.assignedToId } : {})
        })
      );
    } catch (error) {
      return sendReviewError(reply, error);
    }
  });

  app.post("/review/escalations/run", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "ocr.review");
      requirePermission(auth, principal, "users.manage");
      const body = RunEscalationsSchema.parse(request.body ?? {});
      return serializeForJson(
        await reviews.runEscalations({
          principal,
          ...(body.workspaceId !== undefined ? { workspaceId: body.workspaceId } : {}),
          ...(body.dryRun !== undefined ? { dryRun: body.dryRun } : {}),
          ...(body.maxActions !== undefined ? { maxActions: body.maxActions } : {})
        })
      );
    } catch (error) {
      return sendReviewError(reply, error);
    }
  });

  app.post("/review/tasks/:id/complete", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "ocr.review");
      const params = ParamsSchema.parse(request.params);
      return serializeForJson(await reviews.completeTask({ principal, reviewTaskId: params.id }));
    } catch (error) {
      return sendReviewError(reply, error);
    }
  });

  app.post("/review/tasks/:id/reject", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "ocr.review");
      const params = ParamsSchema.parse(request.params);
      const body = RejectTaskSchema.parse(request.body);
      return serializeForJson(
        await reviews.rejectTask({
          principal,
          reviewTaskId: params.id,
          rejectionReason: body.rejectionReason
        })
      );
    } catch (error) {
      return sendReviewError(reply, error);
    }
  });

  app.post("/documents/:id/corrections", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "ocr.review");
      const params = ParamsSchema.parse(request.params);
      const body = CreateCorrectionSchema.parse(request.body);
      reply.code(201);
      return serializeForJson(
        await reviews.createCorrection({
          principal,
          documentFileId: params.id,
          afterValue: body.afterValue,
          ...(body.fieldName !== undefined ? { fieldName: body.fieldName } : {}),
          ...(body.beforeValue !== undefined ? { beforeValue: body.beforeValue } : {}),
          ...(body.createAnnotation !== undefined ? { createAnnotation: body.createAnnotation } : {}),
          ...(body.annotationLabel !== undefined ? { annotationLabel: body.annotationLabel } : {}),
          ...(body.annotationPayload !== undefined ? { annotationPayload: body.annotationPayload } : {})
        })
      );
    } catch (error) {
      return sendReviewError(reply, error);
    }
  });

  app.get("/documents/:id/corrections", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "ocr.review");
      const params = ParamsSchema.parse(request.params);
      return serializeForJson({ corrections: await reviews.listCorrections(principal, params.id) });
    } catch (error) {
      return sendReviewError(reply, error);
    }
  });

  app.post("/documents/:id/annotations", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "annotations.manage");
      const params = ParamsSchema.parse(request.params);
      const body = CreateAnnotationSchema.parse(request.body);
      reply.code(201);
      return serializeForJson(
        await reviews.createAnnotation({
          principal,
          documentFileId: params.id,
          label: body.label,
          payload: body.payload
        })
      );
    } catch (error) {
      return sendReviewError(reply, error);
    }
  });

  app.get("/documents/:id/annotations", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "annotations.manage");
      const params = ParamsSchema.parse(request.params);
      return serializeForJson({ annotations: await reviews.listAnnotations(principal, params.id) });
    } catch (error) {
      return sendReviewError(reply, error);
    }
  });

  app.get("/active-learning/suggestions", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "annotations.manage");
      const query = SuggestionsQuerySchema.parse(request.query);
      return serializeForJson({
        suggestions: await reviews.listActiveLearningSuggestions({
          principal,
          ...(query.workspaceId !== undefined ? { workspaceId: query.workspaceId } : {}),
          limit: query.limit
        })
      });
    } catch (error) {
      return sendReviewError(reply, error);
    }
  });
}

function sendReviewError(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError) {
    reply.code(400);
    return { error: { code: "VALIDATION_ERROR", issues: error.issues } };
  }
  if (error instanceof AuthError) {
    reply.code(error.statusCode);
    return { error: { code: error.code } };
  }
  if (error instanceof ReviewError) {
    reply.code(error.statusCode);
    return { error: { code: error.code } };
  }
  reply.code(500);
  return { error: { code: "INTERNAL_ERROR" } };
}

function serializeForJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, nested) => (typeof nested === "bigint" ? nested.toString() : nested)));
}
