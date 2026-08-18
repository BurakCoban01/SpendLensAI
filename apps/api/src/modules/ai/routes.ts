import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { authenticateRequest, requirePermission } from "../auth/routes";
import { AuthError, AuthService } from "../auth/service";
import { AiError, AiService } from "./service";

const AssistExtractionSchema = z.object({
  ocrText: z.string().min(1).max(120_000),
  deterministicSummary: z.unknown().optional()
});

export async function registerAiRoutes(app: FastifyInstance, auth: AuthService, ai: AiService): Promise<void> {
  app.get("/ai/providers/status", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "ai.use");
      return ai.status();
    } catch (error) {
      return sendAiError(reply, error);
    }
  });

  app.post("/ai/extraction/assist", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "ai.use");
      const body = AssistExtractionSchema.parse(request.body ?? {});
      return await ai.assistExtraction({
        principal,
        ocrText: body.ocrText,
        deterministicSummary: body.deterministicSummary
      });
    } catch (error) {
      return sendAiError(reply, error);
    }
  });
}

function sendAiError(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError) {
    reply.code(400);
    return { error: { code: "VALIDATION_ERROR", issues: error.issues } };
  }
  if (error instanceof AuthError) {
    reply.code(error.statusCode);
    return { error: { code: error.code } };
  }
  if (error instanceof AiError) {
    reply.code(error.statusCode);
    return { error: { code: error.code } };
  }
  reply.code(500);
  return { error: { code: "INTERNAL_ERROR" } };
}
