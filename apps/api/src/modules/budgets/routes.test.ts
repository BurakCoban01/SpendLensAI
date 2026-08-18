import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app";
import { InMemoryAuthRepository } from "../auth/memory-repository";
import { InMemoryCacheStore } from "../cache/memory-store";
import { InMemoryDocumentRepository } from "../documents/memory-repository";
import { InMemoryDocumentStorage } from "../documents/storage";
import { InMemoryExpenseRepository } from "../expenses/memory-repository";
import { InMemoryBudgetRepository } from "./memory-repository";

describe("budget and monthly analytics routes", () => {
  let app: FastifyInstance;
  let accessToken: string;
  let tenantId: string;
  let budgetRepository: CountingBudgetRepository;
  let cacheStore: InMemoryCacheStore;

  beforeAll(async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const expenseRepository = new InMemoryExpenseRepository();
    budgetRepository = new CountingBudgetRepository();
    cacheStore = new InMemoryCacheStore();
    app = await buildApp({
      authRepository: new InMemoryAuthRepository(),
      documentRepository,
      documentStorage: new InMemoryDocumentStorage(),
      expenseRepository,
      budgetRepository,
      cacheStore
    });
    const register = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        tenantName: "Budget Tenant",
        tenantSlug: "budget",
        workspaceName: "Finance",
        email: "owner@example.com",
        displayName: "Owner",
        password: "very-secure-password"
      }
    });
    const body = register.json();
    accessToken = body.tokens.accessToken;
    tenantId = body.tenant.id;
    documentRepository.addWorkspace(body.tenant.id, "workspace_1");

    await createExpense("Market", "45000", true, false);
    await createExpense("Fuel", "22500", true, true);
    await createExpense("Old month", "100000", false, false, "2026-04-12T10:00:00.000Z");
  });

  afterAll(async () => {
    await app.close();
  });

  it("creates a budget and persists the matching monthly period spend", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/budgets",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        workspaceId: "workspace_1",
        name: "May operating budget",
        currency: "TRY",
        amountMinor: "60000",
        alertPercent: 80,
        month: "2026-05"
      }
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.budget.amountMinor).toBe("60000");
    expect(body.usage.period.spentMinor).toBe("67500");
    expect(body.usage.alertTriggered).toBe(true);

    const list = await app.inject({
      method: "GET",
      url: "/budgets?workspaceId=workspace_1&month=2026-05",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().budgets[0].period.spentMinor).toBe("67500");
    const budgetUsageCacheKeys = await cacheStore.listKeys(`dashboard:${tenantId}:budget-usage:workspace_1:2026-05:`, 10);
    expect(budgetUsageCacheKeys).toHaveLength(1);
    const upsertCountAfterMiss = budgetRepository.upsertPeriodCount;

    const cachedList = await app.inject({
      method: "GET",
      url: "/budgets?workspaceId=workspace_1&month=2026-05",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(cachedList.statusCode).toBe(200);
    expect(cachedList.json().budgets[0].period.spentMinor).toBe("67500");
    expect(budgetRepository.upsertPeriodCount).toBe(upsertCountAfterMiss);

    const audit = await app.inject({
      method: "GET",
      url: "/admin/audit?action=budget.created&resourceType=Budget&limit=10",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(audit.statusCode).toBe(200);
    const createdBudgetAudit = audit.json().logs.find((log: { resourceId: string }) => log.resourceId === body.budget.id);
    expect(createdBudgetAudit).toMatchObject({
      action: "budget.created",
      resourceType: "Budget",
      resourceId: body.budget.id,
      metadata: {
        workspaceId: "workspace_1",
        currency: "TRY",
        amountMinor: "60000",
        alertPercent: 80,
        categoryScoped: false,
        categoryIdPresent: false,
        month: "2026-05",
        spentMinor: "67500",
        alertTriggered: true
      }
    });
    expect(JSON.stringify(audit.json().logs)).not.toContain("May operating budget");
  });

  it("returns persisted monthly spend analytics from expense data", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/analytics/monthly-spend?workspaceId=workspace_1&month=2026-05",
      headers: { authorization: `Bearer ${accessToken}` }
    });

    expect(response.statusCode).toBe(200);
    const analytics = response.json().analytics;
    expect(analytics.totalMinor).toBe("67500");
    expect(analytics.businessMinor).toBe("67500");
    expect(analytics.reimbursableMinor).toBe("22500");
    expect(analytics.expenseCount).toBe(2);
    expect(analytics.budgetUsage[0].alertTriggered).toBe(true);

    const dashboardCacheKeys = await cacheStore.listKeys(`dashboard:${tenantId}:monthly-spend:workspace_1:2026-05:`, 10);
    expect(dashboardCacheKeys).toHaveLength(1);
    const upsertCountAfterMiss = budgetRepository.upsertPeriodCount;

    const cachedResponse = await app.inject({
      method: "GET",
      url: "/analytics/monthly-spend?workspaceId=workspace_1&month=2026-05",
      headers: { authorization: `Bearer ${accessToken}` }
    });

    expect(cachedResponse.statusCode).toBe(200);
    expect(cachedResponse.json().analytics.totalMinor).toBe("67500");
    expect(budgetRepository.upsertPeriodCount).toBe(upsertCountAfterMiss);
  });

  it("returns finance insights with persisted trend, breakdowns, cashflow and anomaly signals", async () => {
    await createExpense("Laptop repair", "160000", true, false, "2026-05-16T10:00:00.000Z", {
      merchantName: "Tech Store",
      paymentMethodName: "Corporate card"
    });
    const budget = await app.inject({
      method: "POST",
      url: "/budgets",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        workspaceId: "workspace_1",
        name: "Insights operating budget",
        currency: "TRY",
        amountMinor: "100000",
        alertPercent: 80,
        month: "2026-05"
      }
    });
    expect(budget.statusCode).toBe(201);

    const response = await app.inject({
      method: "GET",
      url: "/analytics/finance-insights?workspaceId=workspace_1&month=2026-05",
      headers: { authorization: `Bearer ${accessToken}` }
    });

    expect(response.statusCode).toBe(200);
    const analytics = response.json().analytics;
    expect(analytics.totalMinor).toBeUndefined();
    expect(analytics.cashflow.spendMinor).toBe("227500");
    expect(analytics.cashflow.incomeMinor).toBe("0");
    expect(analytics.cashflow.netMinor).toBe("-227500");
    expect(analytics.trend.previousMonthMinor).toBe("100000");
    expect(analytics.trend.deltaMinor).toBe("127500");
    expect(analytics.forecast).toMatchObject({
      observedDayCount: 2,
      monthDayCount: 31,
      dailyAverageMinor: "113750",
      projectedMonthEndMinor: "3526250",
      projectedDeltaFromPreviousMinor: "3426250"
    });
    expect(analytics.forecast.projectedBudgetUtilizationPercent).toBeGreaterThan(2000);
    expect(analytics.forecast.largestBudgetRisk).toMatchObject({
      name: "May operating budget",
      projectedOverspendMinor: "3466250"
    });
    expect(analytics.categoryBreakdown[0]).toMatchObject({
      categoryId: "uncategorized",
      totalMinor: "227500",
      expenseCount: 3,
      sharePercent: 100
    });
    expect(analytics.merchantBreakdown[0]).toMatchObject({
      merchant: "Tech Store",
      totalMinor: "160000",
      expenseCount: 1
    });
    expect(analytics.paymentMethodBreakdown[0]).toMatchObject({
      paymentMethod: "Corporate card",
      totalMinor: "160000",
      expenseCount: 1
    });
    expect(analytics.weeklySpend.some((week: { totalMinor: string; expenseCount: number }) => week.totalMinor === "160000" && week.expenseCount === 1)).toBe(true);
    expect(analytics.budgetAlerts.some((alert: { severity: string; name: string }) => alert.name === "Insights operating budget" && alert.severity === "over")).toBe(true);
    expect(analytics.anomalySummary.map((anomaly: { code: string }) => anomaly.code)).toEqual(
      expect.arrayContaining(["HIGH_AMOUNT_VS_MONTHLY_AVERAGE", "WEEKEND_BUSINESS_EXPENSE", "BUDGET_OVER_UTILIZED"])
    );
    expect(analytics.recommendations.map((recommendation: { code: string }) => recommendation.code)).toEqual(
      expect.arrayContaining(["PROJECTED_OVER_BUDGET", "HIGH_RUN_RATE", "REIMBURSABLE_FOLLOW_UP"])
    );

    const financeInsightCacheKeys = await cacheStore.listKeys(`dashboard:${tenantId}:finance-insights:workspace_1:2026-05:`, 10);
    expect(financeInsightCacheKeys).toHaveLength(1);
    const upsertCountAfterMiss = budgetRepository.upsertPeriodCount;

    const cachedResponse = await app.inject({
      method: "GET",
      url: "/analytics/finance-insights?workspaceId=workspace_1&month=2026-05",
      headers: { authorization: `Bearer ${accessToken}` }
    });

    expect(cachedResponse.statusCode).toBe(200);
    expect(cachedResponse.json().analytics.cashflow.spendMinor).toBe("227500");
    expect(cachedResponse.json().analytics.forecast.projectedMonthEndMinor).toBe("3526250");
    expect(cachedResponse.json().analytics.recommendations[0].code).toBe("PROJECTED_OVER_BUDGET");
    expect(budgetRepository.upsertPeriodCount).toBe(upsertCountAfterMiss);
  });

  it("rejects budgets for missing workspaces", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/budgets",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        workspaceId: "missing",
        name: "Missing workspace",
        currency: "TRY",
        amountMinor: "1000"
      }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("WORKSPACE_NOT_FOUND");
  });

  async function createExpense(
    title: string,
    amountMinor: string,
    businessExpense: boolean,
    reimbursable: boolean,
    occurredAt = "2026-05-12T10:00:00.000Z",
    extra: { merchantName?: string; paymentMethodName?: string } = {}
  ) {
    const response = await app.inject({
      method: "POST",
      url: "/expenses",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        workspaceId: "workspace_1",
        title,
        currency: "TRY",
        amountMinor,
        occurredAt,
        businessExpense,
        reimbursable,
        ...extra
      }
    });
    expect(response.statusCode).toBe(201);
  }
});

class CountingBudgetRepository extends InMemoryBudgetRepository {
  public upsertPeriodCount = 0;

  override async upsertPeriod(input: Parameters<InMemoryBudgetRepository["upsertPeriod"]>[0]) {
    this.upsertPeriodCount += 1;
    return super.upsertPeriod(input);
  }
}
