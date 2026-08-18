import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticateRequest, requirePermission } from "../auth/routes";
import { AuthError, AuthService } from "../auth/service";
import type { AuthPrincipal } from "../auth/types";
import { ExtractionError, ExtractionService } from "./service";
import type { ExtractionFieldPatch } from "./types";

const ParamsSchema = z.object({ id: z.string().min(1) });
const BodySchema = z.object({
  text: z.string().min(1).max(200_000),
  sourceEngine: z.enum(["TESSERACT", "CUSTOM_CRNN", "ENSEMBLE"]).nullable().default(null)
});
const CurrencySchema = z.enum(["TRY", "USD", "EUR", "GBP"]);
const MoneySchema = z.object({
  amountMinor: z.string().regex(/^-?\d+$/),
  currency: CurrencySchema
});
const ReconcileLineItemsSchema = z.object({
  lineItems: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(240),
        quantity: z.string().trim().max(80).nullable().optional(),
        unitPrice: MoneySchema.nullable().optional(),
        total: MoneySchema,
        confidence: z.number().min(0).max(1).optional()
      })
    )
    .max(200)
});
const ReconcileFieldSchema = z.discriminatedUnion("fieldName", [
  z.object({ fieldName: z.enum(["merchantName", "date", "time", "paymentMethod", "cardLast4", "receiptNumber"]), value: z.string().trim().max(240).nullable() }),
  z.object({ fieldName: z.literal("currency"), value: CurrencySchema }),
  z.object({ fieldName: z.enum(["subtotal", "discount", "taxTotal", "total"]), value: MoneySchema.nullable() })
]);
const ReconcileFieldsSchema = z.object({
  fields: z.array(ReconcileFieldSchema).max(32),
  reviewStatus: z.enum(["NEEDS_REVIEW", "APPROVED", "REJECTED"]).default("NEEDS_REVIEW"),
  reason: z.string().trim().max(500).nullable().optional()
});

export async function registerExtractionRoutes(
  app: FastifyInstance,
  auth: AuthService,
  extraction: ExtractionService
): Promise<void> {
  app.post("/documents/:id/extraction", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "ocr.run");
      const params = ParamsSchema.parse(request.params);
      const body = BodySchema.parse(request.body);
      const result = await extraction.extractFromText({
        principal,
        documentFileId: params.id,
        text: body.text,
        sourceEngine: body.sourceEngine,
        correlationId: correlationId(request)
      });
      return serializeForJson(result);
    } catch (error) {
      return sendExtractionError(request, reply, error);
    }
  });

  app.get("/documents/:id/extraction", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requireAnyPermission(principal, ["ocr.run", "ocr.review"]);
      const params = ParamsSchema.parse(request.params);
      return serializeForJson(await extraction.latestForDocument({ principal, documentFileId: params.id }));
    } catch (error) {
      return sendExtractionError(request, reply, error);
    }
  });

  app.post("/documents/:id/extraction/line-items", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "ocr.review");
      const params = ParamsSchema.parse(request.params);
      const body = ReconcileLineItemsSchema.parse(request.body);
      return serializeForJson(
        await extraction.reconcileLineItems({
          principal,
          documentFileId: params.id,
          lineItems: body.lineItems.map((item) => ({
            name: item.name,
            quantity: item.quantity ?? null,
            unitPrice: item.unitPrice ? { amountMinor: BigInt(item.unitPrice.amountMinor), currency: item.unitPrice.currency } : null,
            total: { amountMinor: BigInt(item.total.amountMinor), currency: item.total.currency },
            confidence: item.confidence ?? 1
          })),
          correlationId: correlationId(request)
        })
      );
    } catch (error) {
      return sendExtractionError(request, reply, error);
    }
  });

  app.post("/documents/:id/extraction/fields", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "ocr.review");
      const params = ParamsSchema.parse(request.params);
      const body = ReconcileFieldsSchema.parse(request.body);
      return serializeForJson(
        await extraction.reconcileFields({
          principal,
          documentFileId: params.id,
          fields: body.fields.map(toFieldPatch),
          reviewStatus: body.reviewStatus,
          reason: body.reason ?? null,
          correlationId: correlationId(request)
        })
      );
    } catch (error) {
      return sendExtractionError(request, reply, error);
    }
  });
}

function toFieldPatch(field: z.infer<typeof ReconcileFieldSchema>): ExtractionFieldPatch {
  switch (field.fieldName) {
    case "currency":
      return { fieldName: field.fieldName, value: field.value };
    case "subtotal":
    case "discount":
    case "taxTotal":
    case "total":
      return {
        fieldName: field.fieldName,
        value: field.value && typeof field.value === "object" ? { amountMinor: BigInt(field.value.amountMinor), currency: field.value.currency } : null
      };
    case "merchantName":
    case "date":
    case "time":
    case "paymentMethod":
    case "cardLast4":
    case "receiptNumber":
      return { fieldName: field.fieldName, value: typeof field.value === "string" ? field.value : null };
  }
}

function requireAnyPermission(principal: AuthPrincipal, permissions: Array<AuthPrincipal["permissions"][number]>): void {
  if (!permissions.some((permission) => principal.permissions.includes(permission))) {
    throw new AuthError("PERMISSION_DENIED", 403);
  }
}

function sendExtractionError(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError) {
    reply.code(400);
    return { error: { code: "VALIDATION_ERROR", issues: error.issues } };
  }
  if (error instanceof AuthError) {
    reply.code(error.statusCode);
    return { error: { code: error.code } };
  }
  if (error instanceof ExtractionError) {
    reply.code(error.statusCode);
    return { error: { code: error.code } };
  }
  request.log.error({ error }, "Extraction route failed");
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
