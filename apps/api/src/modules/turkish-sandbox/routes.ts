import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  parseTurkishSandboxDocument,
  turkishSandboxDocumentKinds,
  type Money,
  type TurkishSandboxParsedDocument
} from "@spendlens/shared";
import { authenticateRequest, requirePermission } from "../auth/routes";
import { AuthError, type AuthService } from "../auth/service";

const ParseTurkishSandboxDocumentSchema = z.object({
  kind: z.enum(turkishSandboxDocumentKinds),
  content: z.string().trim().min(1).max(512_000)
});

export async function registerTurkishSandboxRoutes(app: FastifyInstance, auth: AuthService): Promise<void> {
  app.post("/sandbox/turkish/parse", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "ocr.run");
      const body = ParseTurkishSandboxDocumentSchema.parse(request.body);
      const parsed = parseTurkishSandboxDocument(body);
      return { parsed: serializeParsedDocument(parsed) };
    } catch (error) {
      return sendSandboxError(reply, error);
    }
  });
}

function serializeParsedDocument(document: TurkishSandboxParsedDocument) {
  return {
    ...document,
    subtotal: serializeMoney(document.subtotal),
    taxTotal: serializeMoney(document.taxTotal),
    total: serializeMoney(document.total),
    payableAmount: serializeMoney(document.payableAmount),
    lineItems: document.lineItems.map((item) => ({
      ...item,
      unitPrice: serializeMoney(item.unitPrice),
      lineTotal: serializeMoney(item.lineTotal),
      taxAmount: serializeMoney(item.taxAmount)
    }))
  };
}

function serializeMoney(value: Money | null) {
  return value ? { amountMinor: value.amountMinor.toString(), currency: value.currency } : null;
}

function sendSandboxError(reply: FastifyReply, error: unknown) {
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
