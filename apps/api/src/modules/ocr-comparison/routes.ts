import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { authenticateRequest, requirePermission } from "../auth/routes";
import { AuthError, AuthService } from "../auth/service";
import type { JobService } from "../jobs/service";
import { OcrComparisonError, OcrComparisonService } from "./service";

const ParamsSchema = z.object({ id: z.string().min(1) });
const OcrTokenSchema = z.object({
  text: z.string().max(500),
  confidence: z.number().min(0).max(1),
  bbox: z.tuple([z.number().nonnegative(), z.number().nonnegative(), z.number().nonnegative(), z.number().nonnegative()]),
  pageNumber: z.number().int().positive().optional()
});
const OcrRunSchema = z.object({
  engine: z.enum(["TESSERACT", "CUSTOM_CRNN"]),
  text: z.string().max(200_000).default(""),
  confidence: z.number().min(0).max(1),
  tokens: z.array(OcrTokenSchema).max(5000).optional(),
  latencyMs: z.number().int().nonnegative().optional(),
  failed: z.boolean().optional(),
  failureReason: z.string().max(1000).optional()
});
const CompareSchema = z.object({
  runs: z.array(OcrRunSchema).min(1).max(3),
  groundTruthText: z.string().max(200_000).optional(),
  defaultCurrency: z.enum(["TRY", "USD", "EUR", "GBP"]).default("TRY")
});

export async function registerOcrComparisonRoutes(
  app: FastifyInstance,
  auth: AuthService,
  service: OcrComparisonService,
  jobs?: JobService
): Promise<void> {
  app.post("/documents/:id/ocr-runs/compare", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "ocr.run");
      const params = ParamsSchema.parse(request.params);
      const body = CompareSchema.parse(request.body);
      const comparison = await service.compare({
        principal,
        documentFileId: params.id,
        runs: body.runs.map((run) => ({
          engine: run.engine,
          text: run.text,
          confidence: run.confidence,
          ...(run.tokens !== undefined ? { tokens: run.tokens } : {}),
          ...(run.latencyMs !== undefined ? { latencyMs: run.latencyMs } : {}),
          ...(run.failed !== undefined ? { failed: run.failed } : {}),
          ...(run.failureReason !== undefined ? { failureReason: run.failureReason } : {})
        })),
        ...(body.groundTruthText !== undefined ? { groundTruthText: body.groundTruthText } : {}),
        defaultCurrency: body.defaultCurrency,
        correlationId: correlationId(request)
      });
      const chainedExtractionJob = await enqueueExtractionFromComparison(jobs, principal, comparison);
      reply.code(201);
      return serializeForJson({ ...comparison, chainedExtractionJob });
    } catch (error) {
      return sendOcrComparisonError(reply, error);
    }
  });

  app.get("/documents/:id/ocr-runs", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "documents.read");
      const params = ParamsSchema.parse(request.params);
      return serializeForJson({ jobs: await service.list(principal, params.id) });
    } catch (error) {
      return sendOcrComparisonError(reply, error);
    }
  });
}

async function enqueueExtractionFromComparison(
  jobs: JobService | undefined,
  principal: Awaited<ReturnType<typeof authenticateRequest>>,
  comparison: Awaited<ReturnType<OcrComparisonService["compare"]>>
) {
  const text = comparison.comparison.selectedText.trim();
  if (!jobs || !text || comparison.comparison.selectedEngine === "NONE") return null;
  const result = await jobs.enqueue({
    principal,
    queue: "extraction",
    jobType: "extraction.from_text",
    dedupeKey: `extraction:${comparison.job.documentFileId}:${comparison.job.id}`,
    payload: {
      documentFileId: comparison.job.documentFileId,
      text,
      sourceEngine: comparison.comparison.selectedEngine
    },
    aggregateId: comparison.job.id
  });
  return result.job;
}

function sendOcrComparisonError(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError) {
    reply.code(400);
    return { error: { code: "VALIDATION_ERROR", issues: error.issues } };
  }
  if (error instanceof AuthError) {
    reply.code(error.statusCode);
    return { error: { code: error.code } };
  }
  if (error instanceof OcrComparisonError) {
    reply.code(error.statusCode);
    return { error: { code: error.code } };
  }
  reply.code(500);
  return { error: { code: "INTERNAL_ERROR" } };
}

function serializeForJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, nested) => (typeof nested === "bigint" ? nested.toString() : nested)));
}

function correlationId(request: { headers: Record<string, unknown>; id: string }): string {
  const header = request.headers["x-correlation-id"];
  return typeof header === "string" && header.trim().length > 0 ? header.trim() : request.id;
}
