import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { authenticateRequest, requirePermission } from "../auth/routes";
import { AuthError, AuthService } from "../auth/service";
import { ModelError, ModelService } from "./service";

const TrainCategorySchema = z.object({
  seed: z.number().int().min(0).max(1_000_000).default(42),
  samplesPerCategory: z.number().int().min(4).max(64).default(12)
});
const TrainCategoryFullSchema = z.object({
  seed: z.number().int().min(0).max(1_000_000).default(42),
  samplesPerCategory: z.number().int().min(65).max(2048).default(128)
});
const TrainCustomOcrSchema = z.object({
  seed: z.number().int().min(0).max(1_000_000).default(42),
  samples: z.number().int().min(8).max(64).default(16),
  epochs: z.number().int().min(1).max(3).default(1)
});
const TrainCustomOcrFullSchema = z.object({
  seed: z.number().int().min(0).max(1_000_000).default(42),
  samples: z.number().int().min(65).max(50_000).default(2048),
  epochs: z.number().int().min(2).max(20).default(8)
});
const TrainCustomOcrFromDatasetExportSchema = z.object({
  workspaceId: z.string().min(1),
  exportJobId: z.string().min(1),
  seed: z.number().int().min(0).max(1_000_000).default(42),
  samples: z.number().int().min(8).max(64).default(16),
  epochs: z.number().int().min(1).max(3).default(1)
});
const OcrBenchmarkSchema = z.object({
  seed: z.number().int().min(0).max(1_000_000).default(42),
  samples: z.number().int().min(1).max(64).default(8),
  split: z.enum(["all", "train", "validation", "test"]).default("all"),
  skipTesseract: z.boolean().default(false)
});
const ParamsSchema = z.object({ id: z.string().min(1) });

export async function registerModelRoutes(
  app: FastifyInstance,
  auth: AuthService,
  models: ModelService,
  configuredOcrEngines: { tesseract: boolean; customOcr: boolean }
): Promise<void> {
  app.get("/models/ocr-capabilities", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "ocr.run");
      return serializeForJson(await models.ocrCapabilities(principal, configuredOcrEngines));
    } catch (error) {
      return sendModelError(reply, error);
    }
  });

  app.get("/models", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "models.train");
      return serializeForJson(await models.overview(principal));
    } catch (error) {
      return sendModelError(reply, error);
    }
  });

  app.post("/models/category/smoke-train", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "models.train");
      const body = TrainCategorySchema.parse(request.body ?? {});
      reply.code(201);
      return serializeForJson(
        await models.trainCategorySmoke({
          principal,
          seed: body.seed,
          samplesPerCategory: body.samplesPerCategory
        })
      );
    } catch (error) {
      return sendModelError(reply, error);
    }
  });

  app.post("/models/category/full-train", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "models.train");
      const body = TrainCategoryFullSchema.parse(request.body ?? {});
      reply.code(201);
      return serializeForJson(
        await models.trainCategoryFull({
          principal,
          seed: body.seed,
          samplesPerCategory: body.samplesPerCategory
        })
      );
    } catch (error) {
      return sendModelError(reply, error);
    }
  });

  app.post("/models/custom-ocr/smoke-train", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "models.train");
      const body = TrainCustomOcrSchema.parse(request.body ?? {});
      reply.code(201);
      return serializeForJson(
        await models.trainCustomOcrSmoke({
          principal,
          seed: body.seed,
          samples: body.samples,
          epochs: body.epochs
        })
      );
    } catch (error) {
      return sendModelError(reply, error);
    }
  });

  app.post("/models/custom-ocr/full-train", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "models.train");
      const body = TrainCustomOcrFullSchema.parse(request.body ?? {});
      reply.code(201);
      return serializeForJson(
        await models.trainCustomOcrFull({
          principal,
          seed: body.seed,
          samples: body.samples,
          epochs: body.epochs
        })
      );
    } catch (error) {
      return sendModelError(reply, error);
    }
  });

  app.post("/models/custom-ocr/train-from-dataset-export", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "models.train");
      const body = TrainCustomOcrFromDatasetExportSchema.parse(request.body ?? {});
      reply.code(201);
      return serializeForJson(
        await models.trainCustomOcrFromDatasetExport({
          principal,
          workspaceId: body.workspaceId,
          exportJobId: body.exportJobId,
          seed: body.seed,
          samples: body.samples,
          epochs: body.epochs
        })
      );
    } catch (error) {
      return sendModelError(reply, error);
    }
  });

  app.post("/models/:id/promote", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "models.promote");
      const params = ParamsSchema.parse(request.params);
      return serializeForJson(await models.promote({ principal, modelVersionId: params.id }));
    } catch (error) {
      return sendModelError(reply, error);
    }
  });

  app.post("/models/:id/ocr-benchmark", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "models.train");
      const params = ParamsSchema.parse(request.params);
      const body = OcrBenchmarkSchema.parse(request.body ?? {});
      reply.code(201);
      return serializeForJson(
        await models.benchmarkCustomOcr({
          principal,
          modelVersionId: params.id,
          seed: body.seed,
          samples: body.samples,
          split: body.split,
          skipTesseract: body.skipTesseract
        })
      );
    } catch (error) {
      return sendModelError(reply, error);
    }
  });

  app.post("/models/:id/rollback", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "models.promote");
      const params = ParamsSchema.parse(request.params);
      return serializeForJson(await models.rollback({ principal, modelVersionId: params.id }));
    } catch (error) {
      return sendModelError(reply, error);
    }
  });
}

function sendModelError(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError) {
    reply.code(400);
    return { error: { code: "VALIDATION_ERROR", issues: error.issues } };
  }
  if (error instanceof AuthError) {
    reply.code(error.statusCode);
    return { error: { code: error.code } };
  }
  if (error instanceof ModelError) {
    reply.code(error.statusCode);
    return { error: { code: error.code, ...(error.details !== undefined ? { details: error.details } : {}) } };
  }
  reply.code(500);
  return { error: { code: "INTERNAL_ERROR" } };
}

function serializeForJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, nested) => (typeof nested === "bigint" ? nested.toString() : nested)));
}
