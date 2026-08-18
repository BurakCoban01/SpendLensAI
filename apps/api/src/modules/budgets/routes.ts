import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { authenticateRequest, requirePermission } from "../auth/routes";
import { AuthError, AuthService } from "../auth/service";
import { BudgetError, BudgetService } from "./service";

const CreateBudgetSchema = z.object({
  workspaceId: z.string().min(1),
  name: z.string().trim().min(1).max(160),
  currency: z.enum(["TRY", "USD", "EUR", "GBP"]).default("TRY"),
  amountMinor: z.string().regex(/^\d+$/),
  alertPercent: z.number().int().min(1).max(100).optional(),
  categoryId: z.string().min(1).nullable().optional(),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional()
});
const WorkspaceMonthQuerySchema = z.object({
  workspaceId: z.string().min(1),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional()
});

export async function registerBudgetRoutes(app: FastifyInstance, auth: AuthService, budgets: BudgetService): Promise<void> {
  app.post("/budgets", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "budgets.manage");
      const body = CreateBudgetSchema.parse(request.body);
      reply.code(201);
      return serializeForJson(
        await budgets.create({
          principal,
          workspaceId: body.workspaceId,
          name: body.name,
          currency: body.currency,
          amountMinor: body.amountMinor,
          ...(body.alertPercent !== undefined ? { alertPercent: body.alertPercent } : {}),
          ...(body.categoryId !== undefined ? { categoryId: body.categoryId } : {}),
          ...(body.month !== undefined ? { month: body.month } : {})
        })
      );
    } catch (error) {
      return sendBudgetError(reply, error);
    }
  });

  app.get("/budgets", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "expenses.read");
      const query = WorkspaceMonthQuerySchema.parse(request.query);
      return serializeForJson({ budgets: await budgets.list(principal, query.workspaceId, query.month) });
    } catch (error) {
      return sendBudgetError(reply, error);
    }
  });

  app.get("/analytics/monthly-spend", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "expenses.read");
      const query = WorkspaceMonthQuerySchema.parse(request.query);
      return serializeForJson({ analytics: await budgets.monthlySpend(principal, query.workspaceId, query.month) });
    } catch (error) {
      return sendBudgetError(reply, error);
    }
  });

  app.get("/analytics/finance-insights", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "expenses.read");
      const query = WorkspaceMonthQuerySchema.parse(request.query);
      return serializeForJson({ analytics: await budgets.financeInsights(principal, query.workspaceId, query.month) });
    } catch (error) {
      return sendBudgetError(reply, error);
    }
  });
}

function sendBudgetError(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError) {
    reply.code(400);
    return { error: { code: "VALIDATION_ERROR", issues: error.issues } };
  }
  if (error instanceof AuthError) {
    reply.code(error.statusCode);
    return { error: { code: error.code } };
  }
  if (error instanceof BudgetError) {
    reply.code(error.statusCode);
    return { error: { code: error.code } };
  }
  reply.code(500);
  return { error: { code: "INTERNAL_ERROR" } };
}

function serializeForJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, nested) => (typeof nested === "bigint" ? nested.toString() : nested)));
}
