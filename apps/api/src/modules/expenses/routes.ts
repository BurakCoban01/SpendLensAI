import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticateRequest, requirePermission } from "../auth/routes";
import { AuthError, AuthService } from "../auth/service";
import { ExpenseError, ExpenseService } from "./service";

const CreateManualExpenseSchema = z.object({
  workspaceId: z.string().min(1),
  title: z.string().trim().min(1).max(180),
  description: z.string().trim().max(1000).nullable().optional(),
  currency: z.enum(["TRY", "USD", "EUR", "GBP"]).default("TRY"),
  amountMinor: z.string().regex(/^-?\d+$/),
  taxMinor: z.string().regex(/^-?\d+$/).nullable().optional(),
  occurredAt: z.string().datetime(),
  merchantName: z.string().trim().min(1).max(180).nullable().optional(),
  paymentMethodName: z.string().trim().min(1).max(120).nullable().optional(),
  reimbursable: z.boolean().optional(),
  businessExpense: z.boolean().optional(),
  projectCode: z.string().trim().max(80).nullable().optional(),
  costCenter: z.string().trim().max(80).nullable().optional()
});

const ListQuerySchema = z.object({
  workspaceId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
  status: z.enum(["DRAFT", "EXTRACTED", "NEEDS_REVIEW", "APPROVED", "REJECTED", "REIMBURSED", "ARCHIVED"]).optional(),
  search: z.string().trim().max(120).optional()
});
const WorkspaceQuerySchema = z.object({ workspaceId: z.string().min(1) });
const ImportCsvSchema = z.object({
  workspaceId: z.string().min(1),
  source: z.string().trim().min(1).max(120).nullable().optional(),
  csvText: z.string().min(1).max(200_000)
});
const ParamsSchema = z.object({ id: z.string().min(1) });
const CreateExpenseFromDocumentSchema = z
  .object({
    forceNonExpenseDocument: z.boolean().optional()
  })
  .optional();
const AttachmentParamsSchema = z.object({ id: z.string().min(1), documentFileId: z.string().min(1) });
const AttachmentSchema = z.object({
  documentFileId: z.string().min(1),
  label: z.string().max(80).optional().nullable(),
  note: z.string().max(500).optional().nullable(),
  primary: z.boolean().optional()
});
const ReimbursementClaimSchema = z.object({
  workspaceId: z.string().min(1),
  expenseIds: z.array(z.string().trim().min(1)).min(1).max(100)
});
const ExpensePolicySchema = z.object({
  workspaceId: z.string().min(1),
  name: z.string().trim().min(1).max(160),
  ruleType: z.enum([
    "MAX_AMOUNT_BY_CATEGORY",
    "RECEIPT_REQUIRED_ABOVE",
    "PROJECT_REQUIRED",
    "ALLOWED_CATEGORIES",
    "DUPLICATE_RECEIPT_REJECTION"
  ]),
  severity: z.enum(["warning", "block"]).default("warning"),
  config: z.record(z.unknown()).default({})
});
const DecisionSchema = z.object({ reason: z.string().trim().max(1000).nullable().optional() });
const CommentSchema = z.object({ body: z.string().trim().min(1).max(2000) });
const RecurringSchema = z.object({
  cadence: z.enum(["weekly", "monthly"]),
  nextDueAt: z.string().datetime()
});
const SplitExpenseSchema = z.object({
  allocations: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(180),
        amountMinor: z.string().regex(/^-?\d+$/),
        taxMinor: z.string().regex(/^-?\d+$/).nullable().optional(),
        projectCode: z.string().trim().max(80).nullable().optional(),
        costCenter: z.string().trim().max(80).nullable().optional(),
        businessExpense: z.boolean().optional(),
        reimbursable: z.boolean().optional()
      })
    )
    .min(2)
    .max(12)
});
const UpdateExpenseSchema = CreateManualExpenseSchema.omit({ workspaceId: true, currency: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "At least one field must be updated");

export async function registerExpenseRoutes(app: FastifyInstance, auth: AuthService, expenses: ExpenseService): Promise<void> {
  app.post("/expenses", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "expenses.create");
      const body = CreateManualExpenseSchema.parse(request.body);
      reply.code(201);
      return serializeForJson(
        await expenses.createManual({
          principal,
          workspaceId: body.workspaceId,
          title: body.title,
          currency: body.currency,
          amountMinor: body.amountMinor,
          occurredAt: body.occurredAt,
          ...(body.merchantName !== undefined ? { merchantName: body.merchantName } : {}),
          ...(body.paymentMethodName !== undefined ? { paymentMethodName: body.paymentMethodName } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.taxMinor !== undefined ? { taxMinor: body.taxMinor } : {}),
          ...(body.reimbursable !== undefined ? { reimbursable: body.reimbursable } : {}),
          ...(body.businessExpense !== undefined ? { businessExpense: body.businessExpense } : {}),
          ...(body.projectCode !== undefined ? { projectCode: body.projectCode } : {}),
          ...(body.costCenter !== undefined ? { costCenter: body.costCenter } : {}),
          correlationId: correlationId(request)
        })
      );
    } catch (error) {
      return sendExpenseError(reply, error);
    }
  });

  app.post("/documents/:id/expense", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "expenses.create");
      const params = ParamsSchema.parse(request.params);
      const body = CreateExpenseFromDocumentSchema.parse(request.body) ?? {};
      reply.code(201);
      return serializeForJson(
        await expenses.createFromLatestExtraction({
          principal,
          documentFileId: params.id,
          forceNonExpenseDocument: body.forceNonExpenseDocument === true,
          correlationId: correlationId(request)
        })
      );
    } catch (error) {
      return sendExpenseError(reply, error);
    }
  });

  app.get("/expenses", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "expenses.read");
      const query = ListQuerySchema.parse(request.query);
      return serializeForJson(
        await expenses.listPage({
          principal,
          limit: query.limit,
          ...(query.workspaceId ? { workspaceId: query.workspaceId } : {}),
          ...(query.cursor ? { cursor: query.cursor } : {}),
          ...(query.status ? { status: query.status } : {}),
          ...(query.search ? { search: query.search } : {})
        })
      );
    } catch (error) {
      return sendExpenseError(reply, error);
    }
  });

  app.get("/approvals/sla", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "expenses.approve");
      const query = WorkspaceQuerySchema.parse(request.query);
      return serializeForJson(await expenses.listApprovalSla({ principal, workspaceId: query.workspaceId }));
    } catch (error) {
      return sendExpenseError(reply, error);
    }
  });

  app.post("/expenses/imports", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "expenses.create");
      const body = ImportCsvSchema.parse(request.body);
      reply.code(201);
      return serializeForJson(
        await expenses.importCsv({
          principal,
          workspaceId: body.workspaceId,
          csvText: body.csvText,
          ...(body.source !== undefined ? { source: body.source } : {}),
          correlationId: correlationId(request)
        })
      );
    } catch (error) {
      return sendExpenseError(reply, error);
    }
  });

  app.get("/expenses/imports", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "expenses.read");
      const query = WorkspaceQuerySchema.parse(request.query);
      return serializeForJson(await expenses.listImportBatches({ principal, workspaceId: query.workspaceId }));
    } catch (error) {
      return sendExpenseError(reply, error);
    }
  });

  app.get("/subscriptions", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "expenses.read");
      const query = WorkspaceQuerySchema.parse(request.query);
      return serializeForJson(await expenses.listSubscriptions({ principal, workspaceId: query.workspaceId }));
    } catch (error) {
      return sendExpenseError(reply, error);
    }
  });

  app.post("/subscriptions/detect", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "expenses.update");
      const query = WorkspaceQuerySchema.parse(request.query);
      return serializeForJson(await expenses.detectSubscriptions({ principal, workspaceId: query.workspaceId, correlationId: correlationId(request) }));
    } catch (error) {
      return sendExpenseError(reply, error);
    }
  });

  app.get("/recurring-expenses", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "expenses.read");
      const query = WorkspaceQuerySchema.parse(request.query);
      return serializeForJson(await expenses.listRecurring({ principal, workspaceId: query.workspaceId }));
    } catch (error) {
      return sendExpenseError(reply, error);
    }
  });

  app.get("/reimbursement-claims", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "expenses.read");
      const query = WorkspaceQuerySchema.parse(request.query);
      return serializeForJson(await expenses.listReimbursementClaims({ principal, workspaceId: query.workspaceId }));
    } catch (error) {
      return sendExpenseError(reply, error);
    }
  });

  app.post("/reimbursement-claims", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "expenses.create");
      const body = ReimbursementClaimSchema.parse(request.body);
      reply.code(201);
      return serializeForJson(
        await expenses.createReimbursementClaim({
          principal,
          workspaceId: body.workspaceId,
          expenseIds: body.expenseIds,
          correlationId: correlationId(request)
        })
      );
    } catch (error) {
      return sendExpenseError(reply, error);
    }
  });

  app.post("/reimbursement-claims/:id/approve", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "expenses.approve");
      const params = ParamsSchema.parse(request.params);
      const body = DecisionSchema.parse(request.body ?? {});
      return serializeForJson(
        await expenses.approveReimbursementClaim({
          principal,
          claimId: params.id,
          reason: body.reason ?? null,
          correlationId: correlationId(request)
        })
      );
    } catch (error) {
      return sendExpenseError(reply, error);
    }
  });

  app.post("/reimbursement-claims/:id/reject", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "expenses.approve");
      const params = ParamsSchema.parse(request.params);
      const body = DecisionSchema.parse(request.body ?? {});
      return serializeForJson(
        await expenses.rejectReimbursementClaim({
          principal,
          claimId: params.id,
          reason: body.reason ?? null,
          correlationId: correlationId(request)
        })
      );
    } catch (error) {
      return sendExpenseError(reply, error);
    }
  });

  app.post("/reimbursement-claims/:id/mark-paid", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "expenses.approve");
      const params = ParamsSchema.parse(request.params);
      const body = DecisionSchema.parse(request.body ?? {});
      return serializeForJson(
        await expenses.markReimbursementPaid({
          principal,
          claimId: params.id,
          reason: body.reason ?? null,
          correlationId: correlationId(request)
        })
      );
    } catch (error) {
      return sendExpenseError(reply, error);
    }
  });

  app.get("/expense-policies", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "expenses.read");
      const query = WorkspaceQuerySchema.parse(request.query);
      return serializeForJson(await expenses.listExpensePolicies({ principal, workspaceId: query.workspaceId }));
    } catch (error) {
      return sendExpenseError(reply, error);
    }
  });

  app.post("/expense-policies", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "expenses.approve");
      const body = ExpensePolicySchema.parse(request.body);
      reply.code(201);
      return serializeForJson(
        await expenses.createExpensePolicy({
          principal,
          workspaceId: body.workspaceId,
          name: body.name,
          ruleType: body.ruleType,
          severity: body.severity,
          config: body.config,
          correlationId: correlationId(request)
        })
      );
    } catch (error) {
      return sendExpenseError(reply, error);
    }
  });

  app.delete("/expense-policies/:id", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "expenses.approve");
      const params = ParamsSchema.parse(request.params);
      return serializeForJson(await expenses.archiveExpensePolicy({ principal, policyId: params.id, correlationId: correlationId(request) }));
    } catch (error) {
      return sendExpenseError(reply, error);
    }
  });

  app.get("/expenses/:id/policy-evaluation", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "expenses.read");
      const params = ParamsSchema.parse(request.params);
      return serializeForJson(await expenses.evaluateExpensePolicy({ principal, expenseId: params.id }));
    } catch (error) {
      return sendExpenseError(reply, error);
    }
  });

  app.post("/expenses/:id/recurring", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "expenses.update");
      const params = ParamsSchema.parse(request.params);
      const body = RecurringSchema.parse(request.body);
      reply.code(201);
      return serializeForJson(
        await expenses.createRecurring({
          principal,
          expenseId: params.id,
          cadence: body.cadence,
          nextDueAt: body.nextDueAt,
          correlationId: correlationId(request)
        })
      );
    } catch (error) {
      return sendExpenseError(reply, error);
    }
  });

  app.post("/recurring-expenses/:id/generate", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "expenses.create");
      const params = ParamsSchema.parse(request.params);
      reply.code(201);
      return serializeForJson(
        await expenses.generateRecurring({
          principal,
          recurringExpenseId: params.id,
          correlationId: correlationId(request)
        })
      );
    } catch (error) {
      return sendExpenseError(reply, error);
    }
  });

  app.get("/expenses/:id/comments", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "expenses.read");
      const params = ParamsSchema.parse(request.params);
      return serializeForJson(await expenses.listComments({ principal, expenseId: params.id }));
    } catch (error) {
      return sendExpenseError(reply, error);
    }
  });

  app.get("/expenses/:id/attachments", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "expenses.read");
      const params = ParamsSchema.parse(request.params);
      return serializeForJson(await expenses.listAttachments({ principal, expenseId: params.id }));
    } catch (error) {
      return sendExpenseError(reply, error);
    }
  });

  app.post("/expenses/:id/attachments", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "expenses.update");
      const params = ParamsSchema.parse(request.params);
      const body = AttachmentSchema.parse(request.body);
      reply.code(201);
      return serializeForJson(
        await expenses.attachDocument({
          principal,
          expenseId: params.id,
          documentFileId: body.documentFileId,
          ...(body.label !== undefined ? { label: body.label } : {}),
          ...(body.note !== undefined ? { note: body.note } : {}),
          ...(body.primary !== undefined ? { primary: body.primary } : {}),
          correlationId: correlationId(request)
        })
      );
    } catch (error) {
      return sendExpenseError(reply, error);
    }
  });

  app.delete("/expenses/:id/attachments/:documentFileId", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "expenses.update");
      const params = AttachmentParamsSchema.parse(request.params);
      return serializeForJson(
        await expenses.detachDocument({
          principal,
          expenseId: params.id,
          documentFileId: params.documentFileId,
          correlationId: correlationId(request)
        })
      );
    } catch (error) {
      return sendExpenseError(reply, error);
    }
  });

  app.post("/expenses/:id/comments", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "expenses.update");
      const params = ParamsSchema.parse(request.params);
      const body = CommentSchema.parse(request.body);
      reply.code(201);
      return serializeForJson(await expenses.addComment({ principal, expenseId: params.id, body: body.body, correlationId: correlationId(request) }));
    } catch (error) {
      return sendExpenseError(reply, error);
    }
  });

  app.patch("/expenses/:id", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "expenses.update");
      const params = ParamsSchema.parse(request.params);
      const body = UpdateExpenseSchema.parse(request.body);
      return serializeForJson(
        await expenses.update({
          principal,
          expenseId: params.id,
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.amountMinor !== undefined ? { amountMinor: body.amountMinor } : {}),
          ...(body.taxMinor !== undefined ? { taxMinor: body.taxMinor } : {}),
          ...(body.occurredAt !== undefined ? { occurredAt: body.occurredAt } : {}),
          ...(body.merchantName !== undefined ? { merchantName: body.merchantName } : {}),
          ...(body.paymentMethodName !== undefined ? { paymentMethodName: body.paymentMethodName } : {}),
          ...(body.reimbursable !== undefined ? { reimbursable: body.reimbursable } : {}),
          ...(body.businessExpense !== undefined ? { businessExpense: body.businessExpense } : {}),
          ...(body.projectCode !== undefined ? { projectCode: body.projectCode } : {}),
          ...(body.costCenter !== undefined ? { costCenter: body.costCenter } : {}),
          correlationId: correlationId(request)
        })
      );
    } catch (error) {
      return sendExpenseError(reply, error);
    }
  });

  app.post("/expenses/:id/split", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "expenses.update");
      const params = ParamsSchema.parse(request.params);
      const body = SplitExpenseSchema.parse(request.body);
      reply.code(201);
      return serializeForJson(
        await expenses.split({
          principal,
          expenseId: params.id,
          correlationId: correlationId(request),
          allocations: body.allocations.map((allocation) => ({
            title: allocation.title,
            amountMinor: allocation.amountMinor,
            ...(allocation.taxMinor !== undefined ? { taxMinor: allocation.taxMinor } : {}),
            ...(allocation.projectCode !== undefined ? { projectCode: allocation.projectCode } : {}),
            ...(allocation.costCenter !== undefined ? { costCenter: allocation.costCenter } : {}),
            ...(allocation.businessExpense !== undefined ? { businessExpense: allocation.businessExpense } : {}),
            ...(allocation.reimbursable !== undefined ? { reimbursable: allocation.reimbursable } : {})
          }))
        })
      );
    } catch (error) {
      return sendExpenseError(reply, error);
    }
  });

  app.get("/expenses/:id/ai-analysis", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "expenses.read");
      const params = ParamsSchema.parse(request.params);
      return serializeForJson(await expenses.analyze({ principal, expenseId: params.id, persist: false }));
    } catch (error) {
      return sendExpenseError(reply, error);
    }
  });

  app.post("/expenses/:id/ai-analysis", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "expenses.update");
      const params = ParamsSchema.parse(request.params);
      return serializeForJson(await expenses.analyze({ principal, expenseId: params.id, persist: true, correlationId: correlationId(request) }));
    } catch (error) {
      return sendExpenseError(reply, error);
    }
  });

  app.post("/expenses/:id/approve", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "expenses.approve");
      const params = ParamsSchema.parse(request.params);
      const body = DecisionSchema.parse(request.body ?? {});
      return serializeForJson(
        await expenses.approve({ principal, expenseId: params.id, reason: body.reason ?? null, correlationId: correlationId(request) })
      );
    } catch (error) {
      return sendExpenseError(reply, error);
    }
  });

  app.post("/expenses/:id/reject", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "expenses.approve");
      const params = ParamsSchema.parse(request.params);
      const body = DecisionSchema.parse(request.body ?? {});
      return serializeForJson(
        await expenses.reject({ principal, expenseId: params.id, reason: body.reason ?? null, correlationId: correlationId(request) })
      );
    } catch (error) {
      return sendExpenseError(reply, error);
    }
  });

  app.post("/expenses/:id/archive", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "expenses.update");
      const params = ParamsSchema.parse(request.params);
      const body = DecisionSchema.parse(request.body ?? {});
      return serializeForJson(
        await expenses.archive({ principal, expenseId: params.id, reason: body.reason ?? null, correlationId: correlationId(request) })
      );
    } catch (error) {
      return sendExpenseError(reply, error);
    }
  });
}

function sendExpenseError(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError) {
    reply.code(400);
    return { error: { code: "VALIDATION_ERROR", issues: error.issues } };
  }
  if (error instanceof AuthError) {
    reply.code(error.statusCode);
    return { error: { code: error.code } };
  }
  if (error instanceof ExpenseError) {
    reply.code(error.statusCode);
    return { error: { code: error.code, issues: error.issues } };
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
