import { randomUUID } from "node:crypto";
import type { BudgetRepository, StoredBudget, StoredBudgetPeriod } from "./types";

export class InMemoryBudgetRepository implements BudgetRepository {
  private budgets = new Map<string, StoredBudget>();
  private periods = new Map<string, StoredBudgetPeriod>();

  async create(input: Parameters<BudgetRepository["create"]>[0]): Promise<StoredBudget> {
    const now = new Date();
    const budget: StoredBudget = {
      id: randomUUID(),
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      categoryId: input.categoryId ?? null,
      name: input.name,
      currency: input.currency,
      amountMinor: input.amountMinor,
      alertPercent: input.alertPercent,
      createdAt: now,
      updatedAt: now
    };
    this.budgets.set(budget.id, budget);
    return budget;
  }

  async list(input: { tenantId: string; workspaceId: string }): Promise<StoredBudget[]> {
    return [...this.budgets.values()].filter(
      (budget) => budget.tenantId === input.tenantId && budget.workspaceId === input.workspaceId
    );
  }

  async upsertPeriod(input: Parameters<BudgetRepository["upsertPeriod"]>[0]): Promise<StoredBudgetPeriod> {
    const key = `${input.tenantId}:${input.budgetId}:${input.startsAt.toISOString()}:${input.endsAt.toISOString()}`;
    const existing = this.periods.get(key);
    const now = new Date();
    const period: StoredBudgetPeriod = {
      id: existing?.id ?? randomUUID(),
      tenantId: input.tenantId,
      budgetId: input.budgetId,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      spentMinor: input.spentMinor,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    this.periods.set(key, period);
    return period;
  }
}
