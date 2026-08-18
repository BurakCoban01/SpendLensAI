import { PrismaClient } from "@prisma/client";
import type { BudgetRepository, StoredBudget, StoredBudgetPeriod } from "./types";

export class PrismaBudgetRepository implements BudgetRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: Parameters<BudgetRepository["create"]>[0]): Promise<StoredBudget> {
    return this.prisma.budget.create({
      data: {
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        categoryId: input.categoryId ?? null,
        name: input.name,
        currency: input.currency,
        amountMinor: input.amountMinor,
        alertPercent: input.alertPercent
      }
    });
  }

  async list(input: { tenantId: string; workspaceId: string }): Promise<StoredBudget[]> {
    return this.prisma.budget.findMany({
      where: { tenantId: input.tenantId, workspaceId: input.workspaceId },
      orderBy: { createdAt: "desc" }
    });
  }

  async upsertPeriod(input: Parameters<BudgetRepository["upsertPeriod"]>[0]): Promise<StoredBudgetPeriod> {
    return this.prisma.budgetPeriod.upsert({
      where: {
        tenantId_budgetId_startsAt_endsAt: {
          tenantId: input.tenantId,
          budgetId: input.budgetId,
          startsAt: input.startsAt,
          endsAt: input.endsAt
        }
      },
      create: {
        tenantId: input.tenantId,
        budgetId: input.budgetId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        spentMinor: input.spentMinor
      },
      update: {
        spentMinor: input.spentMinor
      }
    });
  }
}
