import { createHash } from "node:crypto";
import { CurrencyCodeSchema } from "@spendlens/shared";
import type { AuditRepository } from "../audit/types";
import type { AuthPrincipal } from "../auth/types";
import type { CacheService } from "../cache/service";
import type { DocumentRepository } from "../documents/types";
import type { ExpenseRepository, StoredExpense } from "../expenses/types";
import type { BudgetRepository, BudgetWithUsage, FinanceInsightAnalytics, MonthlySpendAnalytics, StoredBudget } from "./types";

export class BudgetError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode = 400
  ) {
    super(code);
  }
}

export class BudgetService {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly expenses: ExpenseRepository,
    private readonly budgets: BudgetRepository,
    private readonly cache?: CacheService,
    private readonly audit?: AuditRepository
  ) {}

  async create(input: {
    principal: AuthPrincipal;
    workspaceId: string;
    name: string;
    currency: string;
    amountMinor: string;
    alertPercent?: number;
    categoryId?: string | null;
    month?: string;
  }) {
    await this.assertWorkspace(input.principal.tenantId, input.workspaceId);
    const currency = CurrencyCodeSchema.parse(input.currency);
    const budget = await this.budgets.create({
      tenantId: input.principal.tenantId,
      workspaceId: input.workspaceId,
      categoryId: input.categoryId ?? null,
      name: input.name.trim(),
      currency,
      amountMinor: parseMinor(input.amountMinor),
      alertPercent: input.alertPercent ?? 80
    });
    const [usage] = await this.buildUsage(input.principal.tenantId, input.workspaceId, [budget], input.month ?? currentMonthKey());
    await this.auditBudgetCreated(input.principal, budget, usage ?? null, input.month ?? currentMonthKey());
    return { budget, usage };
  }

  async list(principal: AuthPrincipal, workspaceId: string, month = currentMonthKey()) {
    await this.assertWorkspace(principal.tenantId, workspaceId);
    const { startsAt, endsAt } = monthRange(month);
    const budgets = await this.budgets.list({ tenantId: principal.tenantId, workspaceId });
    const expenses = (await this.expenses.list({ tenantId: principal.tenantId, workspaceId })).filter((expense) =>
      isWithin(expense.occurredAt, startsAt, endsAt)
    );
    const cacheKey = dashboardBudgetUsageCacheKey(principal.tenantId, workspaceId, month, dashboardFingerprint(expenses, budgets));
    const cached = await this.readCachedBudgetUsage(cacheKey);
    if (cached) return cached;
    const usage = await this.buildUsageFromExpenses(principal.tenantId, budgets, startsAt, endsAt, expenses);
    await this.rememberBudgetUsage(cacheKey, usage);
    return usage;
  }

  async monthlySpend(principal: AuthPrincipal, workspaceId: string, month = currentMonthKey()): Promise<MonthlySpendAnalytics> {
    await this.assertWorkspace(principal.tenantId, workspaceId);
    const { startsAt, endsAt } = monthRange(month);
    const expenses = await this.expenses.list({ tenantId: principal.tenantId, workspaceId });
    const inMonth = expenses.filter((expense) => isWithin(expense.occurredAt, startsAt, endsAt));
    const currency = inMonth[0]?.currency ?? "TRY";
    const budgets = await this.budgets.list({ tenantId: principal.tenantId, workspaceId });
    const cacheKey = dashboardMonthlySpendCacheKey(
      principal.tenantId,
      workspaceId,
      month,
      dashboardFingerprint(inMonth, budgets)
    );
    const cached = await this.readCachedMonthlySpend(cacheKey);
    if (cached) return cached;

    const analytics = {
      workspaceId,
      month,
      currency,
      totalMinor: sum(inMonth.map((expense) => expense.amountMinor)),
      businessMinor: sum(inMonth.filter((expense) => expense.businessExpense).map((expense) => expense.amountMinor)),
      reimbursableMinor: sum(inMonth.filter((expense) => expense.reimbursable).map((expense) => expense.amountMinor)),
      expenseCount: inMonth.length,
      budgetUsage: await this.buildUsageFromExpenses(principal.tenantId, budgets, startsAt, endsAt, inMonth)
    };
    await this.rememberMonthlySpend(cacheKey, analytics);
    return analytics;
  }

  async financeInsights(principal: AuthPrincipal, workspaceId: string, month = currentMonthKey()): Promise<FinanceInsightAnalytics> {
    await this.assertWorkspace(principal.tenantId, workspaceId);
    const { startsAt, endsAt } = monthRange(month);
    const previousRange = previousMonthRange(month);
    const expenses = await this.expenses.list({ tenantId: principal.tenantId, workspaceId });
    const activeExpenses = expenses.filter((expense) => !expense.archivedAt && expense.status !== "ARCHIVED");
    const inMonth = activeExpenses.filter((expense) => isWithin(expense.occurredAt, startsAt, endsAt));
    const previousMonth = activeExpenses.filter((expense) => isWithin(expense.occurredAt, previousRange.startsAt, previousRange.endsAt));
    const budgets = await this.budgets.list({ tenantId: principal.tenantId, workspaceId });
    const cacheKey = dashboardFinanceInsightsCacheKey(
      principal.tenantId,
      workspaceId,
      month,
      financeInsightsFingerprint(activeExpenses, budgets)
    );
    const cached = await this.readCachedFinanceInsights(cacheKey);
    if (cached) return cached;
    const budgetUsage = await this.buildUsageFromExpenses(principal.tenantId, budgets, startsAt, endsAt, inMonth);
    const currency = inMonth[0]?.currency ?? previousMonth[0]?.currency ?? "TRY";
    const totalMinor = sum(inMonth.map((expense) => expense.amountMinor));
    const previousTotalMinor = sum(previousMonth.map((expense) => expense.amountMinor));
    const budgetAlerts = budgetUsage.map((usage) => ({
      budgetId: usage.budget.id,
      name: usage.budget.name,
      severity: usage.utilizationPercent >= 100 ? "over" : usage.alertTriggered ? "warning" : "ok",
      utilizationPercent: usage.utilizationPercent,
      remainingMinor: usage.remainingMinor
    })) satisfies FinanceInsightAnalytics["budgetAlerts"];
    const forecast = buildFinanceForecast(inMonth, budgetUsage, totalMinor, previousTotalMinor, startsAt, endsAt);
    const anomalySummary = buildFinanceAnomalySummary(inMonth, totalMinor, budgetAlerts);

    const analytics = {
      workspaceId,
      month,
      currency,
      generatedAt: new Date(),
      weeklySpend: buildWeeklySpend(inMonth, startsAt, endsAt),
      categoryBreakdown: buildCategoryBreakdown(inMonth, totalMinor),
      merchantBreakdown: buildMerchantBreakdown(inMonth),
      paymentMethodBreakdown: buildPaymentMethodBreakdown(inMonth),
      cashflow: {
        incomeMinor: 0n,
        spendMinor: totalMinor,
        netMinor: -totalMinor,
        businessMinor: sum(inMonth.filter((expense) => expense.businessExpense).map((expense) => expense.amountMinor)),
        reimbursableMinor: sum(inMonth.filter((expense) => expense.reimbursable).map((expense) => expense.amountMinor))
      },
      trend: {
        currentMonthMinor: totalMinor,
        previousMonthMinor: previousTotalMinor,
        deltaMinor: totalMinor - previousTotalMinor,
        deltaPercent: previousTotalMinor === 0n ? null : Number(((totalMinor - previousTotalMinor) * 10_000n) / previousTotalMinor) / 100
      },
      forecast,
      budgetAlerts,
      anomalySummary,
      recommendations: buildFinanceRecommendations({
        forecast,
        budgetAlerts,
        anomalySummary,
        reimbursableMinor: sum(inMonth.filter((expense) => expense.reimbursable).map((expense) => expense.amountMinor)),
        budgetCount: budgets.length
      })
    };
    await this.rememberFinanceInsights(cacheKey, analytics);
    return analytics;
  }

  private async buildUsage(tenantId: string, workspaceId: string, budgets: StoredBudget[], month: string): Promise<BudgetWithUsage[]> {
    const { startsAt, endsAt } = monthRange(month);
    const expenses = (await this.expenses.list({ tenantId, workspaceId })).filter((expense) => isWithin(expense.occurredAt, startsAt, endsAt));
    return this.buildUsageFromExpenses(tenantId, budgets, startsAt, endsAt, expenses);
  }

  private async buildUsageFromExpenses(
    tenantId: string,
    budgets: StoredBudget[],
    startsAt: Date,
    endsAt: Date,
    expenses: StoredExpense[]
  ): Promise<BudgetWithUsage[]> {
    return Promise.all(
      budgets.map(async (budget) => {
        const matchingExpenses = expenses.filter((expense) => expense.currency === budget.currency && (!budget.categoryId || expense.categoryId === budget.categoryId));
        const spentMinor = sum(matchingExpenses.map((expense) => expense.amountMinor));
        const period = await this.budgets.upsertPeriod({ tenantId, budgetId: budget.id, startsAt, endsAt, spentMinor });
        const utilizationPercent = budget.amountMinor === 0n ? 0 : Number((spentMinor * 10_000n) / budget.amountMinor) / 100;
        return {
          budget,
          period,
          utilizationPercent,
          alertTriggered: utilizationPercent >= budget.alertPercent,
          remainingMinor: budget.amountMinor - spentMinor
        };
      })
    );
  }

  private async readCachedMonthlySpend(key: string): Promise<MonthlySpendAnalytics | null> {
    try {
      const cached = await this.cache?.getHotState<Record<string, unknown>>(key);
      return reviveMonthlySpend(cached);
    } catch {
      return null;
    }
  }

  private async rememberMonthlySpend(key: string, analytics: MonthlySpendAnalytics): Promise<void> {
    try {
      await this.cache?.setHotState({
        key,
        value: serializeMonthlySpend(analytics),
        ttlSeconds: 5 * 60
      });
    } catch {
      // Dashboard cache is an optimization; expense, budget and period rows remain authoritative.
    }
  }

  private async readCachedFinanceInsights(key: string): Promise<FinanceInsightAnalytics | null> {
    try {
      const cached = await this.cache?.getHotState<Record<string, unknown>>(key);
      return reviveFinanceInsights(cached);
    } catch {
      return null;
    }
  }

  private async rememberFinanceInsights(key: string, analytics: FinanceInsightAnalytics): Promise<void> {
    try {
      await this.cache?.setHotState({
        key,
        value: serializeFinanceInsights(analytics),
        ttlSeconds: 5 * 60
      });
    } catch {
      // Dashboard cache is an optimization; expense, budget and period rows remain authoritative.
    }
  }

  private async readCachedBudgetUsage(key: string): Promise<BudgetWithUsage[] | null> {
    try {
      const cached = await this.cache?.getHotState<CachedBudgetUsageList>(key);
      return reviveBudgetUsage(cached);
    } catch {
      return null;
    }
  }

  private async rememberBudgetUsage(key: string, usage: BudgetWithUsage[]): Promise<void> {
    try {
      await this.cache?.setHotState({
        key,
        value: { budgetUsage: serializeBudgetUsage(usage) },
        ttlSeconds: 5 * 60
      });
    } catch {
      // Dashboard cache is an optimization; expense, budget and period rows remain authoritative.
    }
  }

  private async assertWorkspace(tenantId: string, workspaceId: string) {
    if (!(await this.documents.workspaceExists(tenantId, workspaceId))) {
      throw new BudgetError("WORKSPACE_NOT_FOUND", 404);
    }
  }

  private async auditBudgetCreated(
    principal: AuthPrincipal,
    budget: StoredBudget,
    usage: BudgetWithUsage | null,
    month: string
  ): Promise<void> {
    try {
      await this.audit?.create({
        tenantId: principal.tenantId,
        actorUserId: principal.userId,
        action: "budget.created",
        resourceType: "Budget",
        resourceId: budget.id,
        metadata: {
          workspaceId: budget.workspaceId,
          currency: budget.currency,
          amountMinor: budget.amountMinor.toString(),
          alertPercent: budget.alertPercent,
          categoryScoped: budget.categoryId !== null,
          categoryIdPresent: budget.categoryId !== null,
          month,
          spentMinor: usage?.period.spentMinor.toString() ?? null,
          utilizationPercent: usage?.utilizationPercent ?? null,
          alertTriggered: usage?.alertTriggered ?? null
        },
        correlationId: principal.sessionId
      });
    } catch {
      // Budget persistence is authoritative; audit failures should not block finance setup.
    }
  }
}

function parseMinor(value: string): bigint {
  if (!/^\d+$/.test(value)) throw new BudgetError("INVALID_MINOR_AMOUNT", 400);
  return BigInt(value);
}

function monthRange(month: string): { startsAt: Date; endsAt: Date } {
  const match = /^(?<year>\d{4})-(?<month>\d{2})$/.exec(month);
  const year = Number(match?.groups?.year);
  const monthNumber = Number(match?.groups?.month);
  if (!match || monthNumber < 1 || monthNumber > 12) throw new BudgetError("INVALID_MONTH", 400);
  const startsAt = new Date(Date.UTC(year, monthNumber - 1, 1));
  const endsAt = new Date(Date.UTC(year, monthNumber, 1));
  return { startsAt, endsAt };
}

function previousMonthRange(month: string): { startsAt: Date; endsAt: Date } {
  const { startsAt } = monthRange(month);
  const previous = new Date(Date.UTC(startsAt.getUTCFullYear(), startsAt.getUTCMonth() - 1, 1));
  const previousMonthKey = `${previous.getUTCFullYear()}-${(previous.getUTCMonth() + 1).toString().padStart(2, "0")}`;
  return monthRange(previousMonthKey);
}

function currentMonthKey(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${(now.getUTCMonth() + 1).toString().padStart(2, "0")}`;
}

function isWithin(value: Date, startsAt: Date, endsAt: Date): boolean {
  return value.getTime() >= startsAt.getTime() && value.getTime() < endsAt.getTime();
}

function sum(values: bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}

function buildWeeklySpend(expenses: StoredExpense[], startsAt: Date, endsAt: Date): FinanceInsightAnalytics["weeklySpend"] {
  const weeklySpend: FinanceInsightAnalytics["weeklySpend"] = [];
  for (let weekStartMs = startsAt.getTime(); weekStartMs < endsAt.getTime(); weekStartMs += 7 * 24 * 60 * 60 * 1000) {
    const weekStart = new Date(weekStartMs);
    const weekEnd = new Date(Math.min(weekStartMs + 7 * 24 * 60 * 60 * 1000, endsAt.getTime()));
    const inWeek = expenses.filter((expense) => isWithin(expense.occurredAt, weekStart, weekEnd));
    weeklySpend.push({
      weekStart,
      weekEnd,
      totalMinor: sum(inWeek.map((expense) => expense.amountMinor)),
      expenseCount: inWeek.length
    });
  }
  return weeklySpend;
}

function buildCategoryBreakdown(expenses: StoredExpense[], totalMinor: bigint): FinanceInsightAnalytics["categoryBreakdown"] {
  const byCategory = groupSpend(expenses, (expense) => expense.categoryId ?? "uncategorized");
  return Array.from(byCategory.entries())
    .map(([categoryId, summary]) => ({
      categoryId,
      totalMinor: summary.totalMinor,
      expenseCount: summary.expenseCount,
      sharePercent: percent(summary.totalMinor, totalMinor)
    }))
    .sort(sortBySpendThenName((entry) => entry.categoryId));
}

function buildMerchantBreakdown(expenses: StoredExpense[]): FinanceInsightAnalytics["merchantBreakdown"] {
  const byMerchant = groupSpend(expenses, (expense) => expense.merchantName?.trim() || expense.title.trim() || "Unspecified");
  return Array.from(byMerchant.entries())
    .map(([merchant, summary]) => ({
      merchant,
      totalMinor: summary.totalMinor,
      expenseCount: summary.expenseCount
    }))
    .sort(sortBySpendThenName((entry) => entry.merchant));
}

function buildPaymentMethodBreakdown(expenses: StoredExpense[]): FinanceInsightAnalytics["paymentMethodBreakdown"] {
  const byPaymentMethod = groupSpend(expenses, (expense) => expense.paymentMethodName?.trim() || "Unspecified");
  return Array.from(byPaymentMethod.entries())
    .map(([paymentMethod, summary]) => ({
      paymentMethod,
      totalMinor: summary.totalMinor,
      expenseCount: summary.expenseCount
    }))
    .sort(sortBySpendThenName((entry) => entry.paymentMethod));
}

function groupSpend(expenses: StoredExpense[], keyFor: (expense: StoredExpense) => string): Map<string, { totalMinor: bigint; expenseCount: number }> {
  const grouped = new Map<string, { totalMinor: bigint; expenseCount: number }>();
  for (const expense of expenses) {
    const key = keyFor(expense);
    const existing = grouped.get(key) ?? { totalMinor: 0n, expenseCount: 0 };
    grouped.set(key, { totalMinor: existing.totalMinor + expense.amountMinor, expenseCount: existing.expenseCount + 1 });
  }
  return grouped;
}

function buildFinanceAnomalySummary(
  expenses: StoredExpense[],
  totalMinor: bigint,
  budgetAlerts: FinanceInsightAnalytics["budgetAlerts"]
): FinanceInsightAnalytics["anomalySummary"] {
  const anomalies: FinanceInsightAnalytics["anomalySummary"] = [];
  if (expenses.length > 1) {
    const averageMinor = totalMinor / BigInt(expenses.length);
    const highAmountExpenses = expenses.filter((expense) => averageMinor > 0n && expense.amountMinor >= averageMinor * 2n);
    if (highAmountExpenses.length > 0) {
      const largestAmountMinor = highAmountExpenses.reduce((largest, expense) => (expense.amountMinor > largest ? expense.amountMinor : largest), 0n);
      anomalies.push({
        code: "HIGH_AMOUNT_VS_MONTHLY_AVERAGE",
        severity: "warning",
        count: highAmountExpenses.length,
        evidence: { averageAmountMinor: averageMinor.toString(), largestAmountMinor: largestAmountMinor.toString() }
      });
    }
  }
  const weekendBusinessExpenses = expenses.filter((expense) => {
    const day = expense.occurredAt.getUTCDay();
    return expense.businessExpense && (day === 0 || day === 6);
  });
  if (weekendBusinessExpenses.length > 0) {
    anomalies.push({
      code: "WEEKEND_BUSINESS_EXPENSE",
      severity: "info",
      count: weekendBusinessExpenses.length,
      evidence: { latestExpenseAt: weekendBusinessExpenses.at(-1)?.occurredAt.toISOString() ?? null }
    });
  }
  const overBudget = budgetAlerts.filter((alert) => alert.severity === "over");
  if (overBudget.length > 0) {
    anomalies.push({
      code: "BUDGET_OVER_UTILIZED",
      severity: "critical",
      count: overBudget.length,
      evidence: { highestUtilizationPercent: Math.max(...overBudget.map((alert) => alert.utilizationPercent)) }
    });
  }
  const reimbursableMinor = sum(expenses.filter((expense) => expense.reimbursable).map((expense) => expense.amountMinor));
  if (totalMinor > 0n && reimbursableMinor * 100n >= totalMinor * 60n) {
    anomalies.push({
      code: "REIMBURSABLE_CONCENTRATION",
      severity: "info",
      count: expenses.filter((expense) => expense.reimbursable).length,
      evidence: { reimbursableSharePercent: percent(reimbursableMinor, totalMinor) }
    });
  }
  return anomalies;
}

function buildFinanceForecast(
  expenses: StoredExpense[],
  budgetUsage: BudgetWithUsage[],
  totalMinor: bigint,
  previousTotalMinor: bigint,
  startsAt: Date,
  endsAt: Date
): FinanceInsightAnalytics["forecast"] {
  const observedDayCount = new Set(expenses.map((expense) => expense.occurredAt.toISOString().slice(0, 10))).size;
  const monthDayCount = Math.max(1, Math.round((endsAt.getTime() - startsAt.getTime()) / (24 * 60 * 60 * 1000)));
  const dailyAverageMinor = observedDayCount === 0 ? 0n : totalMinor / BigInt(observedDayCount);
  const projectedMonthEndMinor = dailyAverageMinor * BigInt(monthDayCount);
  const projectedDeltaFromPreviousMinor = projectedMonthEndMinor - previousTotalMinor;
  const totalBudgetMinor = sum(budgetUsage.map((usage) => usage.budget.amountMinor));
  const projectedBudgetUtilizationPercent = totalBudgetMinor === 0n ? null : percent(projectedMonthEndMinor, totalBudgetMinor);
  const largestBudgetRisk =
    budgetUsage
      .map((usage) => {
        const projectedSpentMinor = observedDayCount === 0 ? 0n : (usage.period.spentMinor / BigInt(observedDayCount)) * BigInt(monthDayCount);
        return {
          budgetId: usage.budget.id,
          name: usage.budget.name,
          projectedUtilizationPercent: percent(projectedSpentMinor, usage.budget.amountMinor),
          projectedOverspendMinor: projectedSpentMinor > usage.budget.amountMinor ? projectedSpentMinor - usage.budget.amountMinor : 0n
        };
      })
      .sort((left, right) =>
        right.projectedUtilizationPercent === left.projectedUtilizationPercent
          ? right.projectedOverspendMinor > left.projectedOverspendMinor
            ? 1
            : -1
          : right.projectedUtilizationPercent - left.projectedUtilizationPercent
      )[0] ?? null;

  return {
    observedDayCount,
    monthDayCount,
    dailyAverageMinor,
    projectedMonthEndMinor,
    projectedDeltaFromPreviousMinor,
    projectedBudgetUtilizationPercent,
    largestBudgetRisk
  };
}

function buildFinanceRecommendations(input: {
  forecast: FinanceInsightAnalytics["forecast"];
  budgetAlerts: FinanceInsightAnalytics["budgetAlerts"];
  anomalySummary: FinanceInsightAnalytics["anomalySummary"];
  reimbursableMinor: bigint;
  budgetCount: number;
}): FinanceInsightAnalytics["recommendations"] {
  const recommendations: FinanceInsightAnalytics["recommendations"] = [];
  if (input.budgetCount === 0) {
    recommendations.push({
      code: "NO_BUDGET",
      severity: "info",
      message: "Create a monthly budget so projected utilization can be tracked against a plan.",
      evidence: { budgetCount: 0 }
    });
  }
  if ((input.forecast.projectedBudgetUtilizationPercent ?? 0) >= 100 || (input.forecast.largestBudgetRisk?.projectedOverspendMinor ?? 0n) > 0n) {
    recommendations.push({
      code: "PROJECTED_OVER_BUDGET",
      severity: "critical",
      message: "Projected month-end spend is above at least one configured budget.",
      evidence: {
        projectedBudgetUtilizationPercent: input.forecast.projectedBudgetUtilizationPercent,
        largestBudgetRiskName: input.forecast.largestBudgetRisk?.name ?? null,
        projectedOverspendMinor: input.forecast.largestBudgetRisk?.projectedOverspendMinor.toString() ?? "0"
      }
    });
  }
  if (input.forecast.projectedDeltaFromPreviousMinor > 0n && input.forecast.observedDayCount > 0) {
    recommendations.push({
      code: "HIGH_RUN_RATE",
      severity: input.anomalySummary.some((anomaly) => anomaly.severity === "critical") ? "warning" : "info",
      message: "Current observed-day run rate is projected above the previous month.",
      evidence: {
        projectedDeltaFromPreviousMinor: input.forecast.projectedDeltaFromPreviousMinor.toString(),
        observedDayCount: input.forecast.observedDayCount,
        dailyAverageMinor: input.forecast.dailyAverageMinor.toString()
      }
    });
  }
  if (input.reimbursableMinor > 0n) {
    recommendations.push({
      code: "REIMBURSABLE_FOLLOW_UP",
      severity: "info",
      message: "Review reimbursable expenses before month-end reporting.",
      evidence: { reimbursableMinor: input.reimbursableMinor.toString() }
    });
  }
  return recommendations.slice(0, 4);
}

function percent(part: bigint, total: bigint): number {
  if (total === 0n) return 0;
  return Number((part * 10_000n) / total) / 100;
}

function sortBySpendThenName<T extends { totalMinor: bigint }>(nameFor: (entry: T) => string): (left: T, right: T) => number {
  return (left, right) => (right.totalMinor === left.totalMinor ? nameFor(left).localeCompare(nameFor(right)) : right.totalMinor > left.totalMinor ? 1 : -1);
}

export function dashboardMonthlySpendCacheKey(tenantId: string, workspaceId: string, month: string, fingerprint: string): string {
  return `dashboard:${tenantId}:monthly-spend:${workspaceId}:${month}:${fingerprint}`;
}

export function dashboardBudgetUsageCacheKey(tenantId: string, workspaceId: string, month: string, fingerprint: string): string {
  return `dashboard:${tenantId}:budget-usage:${workspaceId}:${month}:${fingerprint}`;
}

export function dashboardFinanceInsightsCacheKey(tenantId: string, workspaceId: string, month: string, fingerprint: string): string {
  return `dashboard:${tenantId}:finance-insights:${workspaceId}:${month}:${fingerprint}`;
}

function dashboardFingerprint(expenses: StoredExpense[], budgets: StoredBudget[]): string {
  const expenseInput = expenses
    .map((expense) => ({
      id: expense.id,
      amountMinor: expense.amountMinor.toString(),
      currency: expense.currency,
      occurredAt: expense.occurredAt.toISOString(),
      businessExpense: expense.businessExpense,
      reimbursable: expense.reimbursable,
      categoryId: expense.categoryId,
      updatedAt: expense.updatedAt.toISOString()
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const budgetInput = budgets
    .map((budget) => ({
      id: budget.id,
      categoryId: budget.categoryId,
      currency: budget.currency,
      amountMinor: budget.amountMinor.toString(),
      alertPercent: budget.alertPercent,
      updatedAt: budget.updatedAt.toISOString()
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return createHash("sha256").update(JSON.stringify({ expenses: expenseInput, budgets: budgetInput })).digest("hex");
}

function financeInsightsFingerprint(expenses: StoredExpense[], budgets: StoredBudget[]): string {
  const expenseInput = expenses
    .map((expense) => ({
      id: expense.id,
      title: expense.title,
      amountMinor: expense.amountMinor.toString(),
      currency: expense.currency,
      occurredAt: expense.occurredAt.toISOString(),
      status: expense.status,
      archivedAt: expense.archivedAt?.toISOString() ?? null,
      businessExpense: expense.businessExpense,
      reimbursable: expense.reimbursable,
      categoryId: expense.categoryId,
      merchantName: expense.merchantName,
      paymentMethodName: expense.paymentMethodName,
      updatedAt: expense.updatedAt.toISOString()
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const budgetInput = budgets
    .map((budget) => ({
      id: budget.id,
      categoryId: budget.categoryId,
      currency: budget.currency,
      amountMinor: budget.amountMinor.toString(),
      alertPercent: budget.alertPercent,
      name: budget.name,
      updatedAt: budget.updatedAt.toISOString()
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return createHash("sha256").update(JSON.stringify({ expenses: expenseInput, budgets: budgetInput })).digest("hex");
}

type CachedMonthlySpendAnalytics = {
  workspaceId: string;
  month: string;
  currency: string;
  totalMinor: string;
  businessMinor: string;
  reimbursableMinor: string;
  expenseCount: number;
  budgetUsage: CachedBudgetUsage[];
};

type CachedBudgetUsageList = {
  budgetUsage: CachedBudgetUsage[];
};

type CachedBudgetUsage = {
  budget: CachedBudget;
  period: CachedBudgetPeriod;
  utilizationPercent: number;
  alertTriggered: boolean;
  remainingMinor: string;
};

type CachedFinanceInsightAnalytics = {
  workspaceId: string;
  month: string;
  currency: string;
  generatedAt: string;
  weeklySpend: Array<{
    weekStart: string;
    weekEnd: string;
    totalMinor: string;
    expenseCount: number;
  }>;
  categoryBreakdown: Array<{
    categoryId: string;
    totalMinor: string;
    expenseCount: number;
    sharePercent: number;
  }>;
  merchantBreakdown: Array<{
    merchant: string;
    totalMinor: string;
    expenseCount: number;
  }>;
  paymentMethodBreakdown: Array<{
    paymentMethod: string;
    totalMinor: string;
    expenseCount: number;
  }>;
  cashflow: {
    incomeMinor: string;
    spendMinor: string;
    netMinor: string;
    businessMinor: string;
    reimbursableMinor: string;
  };
  trend: {
    currentMonthMinor: string;
    previousMonthMinor: string;
    deltaMinor: string;
    deltaPercent: number | null;
  };
  forecast: {
    observedDayCount: number;
    monthDayCount: number;
    dailyAverageMinor: string;
    projectedMonthEndMinor: string;
    projectedDeltaFromPreviousMinor: string;
    projectedBudgetUtilizationPercent: number | null;
    largestBudgetRisk: {
      budgetId: string;
      name: string;
      projectedUtilizationPercent: number;
      projectedOverspendMinor: string;
    } | null;
  };
  budgetAlerts: Array<{
    budgetId: string;
    name: string;
    severity: "ok" | "warning" | "over";
    utilizationPercent: number;
    remainingMinor: string;
  }>;
  anomalySummary: Array<{
    code: string;
    severity: "info" | "warning" | "critical";
    count: number;
    evidence: Record<string, string | number | boolean | null>;
  }>;
  recommendations: Array<{
    code: "PROJECTED_OVER_BUDGET" | "HIGH_RUN_RATE" | "REIMBURSABLE_FOLLOW_UP" | "NO_BUDGET";
    severity: "info" | "warning" | "critical";
    message: string;
    evidence: Record<string, string | number | boolean | null>;
  }>;
};

type CachedBudget = {
  id: string;
  tenantId: string;
  workspaceId: string;
  categoryId: string | null;
  name: string;
  currency: string;
  amountMinor: string;
  alertPercent: number;
  createdAt: string;
  updatedAt: string;
};

type CachedBudgetPeriod = {
  id: string;
  tenantId: string;
  budgetId: string;
  startsAt: string;
  endsAt: string;
  spentMinor: string;
  createdAt: string;
  updatedAt: string;
};

function serializeMonthlySpend(analytics: MonthlySpendAnalytics): CachedMonthlySpendAnalytics {
  return {
    workspaceId: analytics.workspaceId,
    month: analytics.month,
    currency: analytics.currency,
    totalMinor: analytics.totalMinor.toString(),
    businessMinor: analytics.businessMinor.toString(),
    reimbursableMinor: analytics.reimbursableMinor.toString(),
    expenseCount: analytics.expenseCount,
    budgetUsage: serializeBudgetUsage(analytics.budgetUsage)
  };
}

function serializeBudgetUsage(budgetUsage: BudgetWithUsage[]): CachedBudgetUsage[] {
  return budgetUsage.map((usage) => ({
      budget: {
        ...usage.budget,
        amountMinor: usage.budget.amountMinor.toString(),
        createdAt: usage.budget.createdAt.toISOString(),
        updatedAt: usage.budget.updatedAt.toISOString()
      },
      period: {
        ...usage.period,
        spentMinor: usage.period.spentMinor.toString(),
        startsAt: usage.period.startsAt.toISOString(),
        endsAt: usage.period.endsAt.toISOString(),
        createdAt: usage.period.createdAt.toISOString(),
        updatedAt: usage.period.updatedAt.toISOString()
      },
      utilizationPercent: usage.utilizationPercent,
      alertTriggered: usage.alertTriggered,
      remainingMinor: usage.remainingMinor.toString()
    }));
}

function serializeFinanceInsights(analytics: FinanceInsightAnalytics): CachedFinanceInsightAnalytics {
  return {
    workspaceId: analytics.workspaceId,
    month: analytics.month,
    currency: analytics.currency,
    generatedAt: analytics.generatedAt.toISOString(),
    weeklySpend: analytics.weeklySpend.map((week) => ({
      weekStart: week.weekStart.toISOString(),
      weekEnd: week.weekEnd.toISOString(),
      totalMinor: week.totalMinor.toString(),
      expenseCount: week.expenseCount
    })),
    categoryBreakdown: analytics.categoryBreakdown.map((entry) => ({
      ...entry,
      totalMinor: entry.totalMinor.toString()
    })),
    merchantBreakdown: analytics.merchantBreakdown.map((entry) => ({
      ...entry,
      totalMinor: entry.totalMinor.toString()
    })),
    paymentMethodBreakdown: analytics.paymentMethodBreakdown.map((entry) => ({
      ...entry,
      totalMinor: entry.totalMinor.toString()
    })),
    cashflow: {
      incomeMinor: analytics.cashflow.incomeMinor.toString(),
      spendMinor: analytics.cashflow.spendMinor.toString(),
      netMinor: analytics.cashflow.netMinor.toString(),
      businessMinor: analytics.cashflow.businessMinor.toString(),
      reimbursableMinor: analytics.cashflow.reimbursableMinor.toString()
    },
    trend: {
      currentMonthMinor: analytics.trend.currentMonthMinor.toString(),
      previousMonthMinor: analytics.trend.previousMonthMinor.toString(),
      deltaMinor: analytics.trend.deltaMinor.toString(),
      deltaPercent: analytics.trend.deltaPercent
    },
    forecast: {
      observedDayCount: analytics.forecast.observedDayCount,
      monthDayCount: analytics.forecast.monthDayCount,
      dailyAverageMinor: analytics.forecast.dailyAverageMinor.toString(),
      projectedMonthEndMinor: analytics.forecast.projectedMonthEndMinor.toString(),
      projectedDeltaFromPreviousMinor: analytics.forecast.projectedDeltaFromPreviousMinor.toString(),
      projectedBudgetUtilizationPercent: analytics.forecast.projectedBudgetUtilizationPercent,
      largestBudgetRisk: analytics.forecast.largestBudgetRisk
        ? {
            ...analytics.forecast.largestBudgetRisk,
            projectedOverspendMinor: analytics.forecast.largestBudgetRisk.projectedOverspendMinor.toString()
          }
        : null
    },
    budgetAlerts: analytics.budgetAlerts.map((alert) => ({
      ...alert,
      remainingMinor: alert.remainingMinor.toString()
    })),
    anomalySummary: analytics.anomalySummary,
    recommendations: analytics.recommendations
  };
}

function reviveMonthlySpend(value: Record<string, unknown> | null | undefined): MonthlySpendAnalytics | null {
  if (!isCachedMonthlySpend(value)) return null;
  return {
    workspaceId: value.workspaceId,
    month: value.month,
    currency: value.currency,
    totalMinor: BigInt(value.totalMinor),
    businessMinor: BigInt(value.businessMinor),
    reimbursableMinor: BigInt(value.reimbursableMinor),
    expenseCount: value.expenseCount,
    budgetUsage: reviveBudgetUsage({ budgetUsage: value.budgetUsage }) ?? []
  };
}

function reviveBudgetUsage(value: Record<string, unknown> | null | undefined): BudgetWithUsage[] | null {
  if (!isCachedBudgetUsageList(value)) return null;
  return value.budgetUsage.map((usage) => ({
      budget: {
        ...usage.budget,
        amountMinor: BigInt(usage.budget.amountMinor),
        createdAt: new Date(usage.budget.createdAt),
        updatedAt: new Date(usage.budget.updatedAt)
      },
      period: {
        ...usage.period,
        spentMinor: BigInt(usage.period.spentMinor),
        startsAt: new Date(usage.period.startsAt),
        endsAt: new Date(usage.period.endsAt),
        createdAt: new Date(usage.period.createdAt),
        updatedAt: new Date(usage.period.updatedAt)
      },
      utilizationPercent: usage.utilizationPercent,
      alertTriggered: usage.alertTriggered,
      remainingMinor: BigInt(usage.remainingMinor)
    }));
}

function reviveFinanceInsights(value: Record<string, unknown> | null | undefined): FinanceInsightAnalytics | null {
  if (!isCachedFinanceInsights(value)) return null;
  return {
    workspaceId: value.workspaceId,
    month: value.month,
    currency: value.currency,
    generatedAt: new Date(value.generatedAt),
    weeklySpend: value.weeklySpend.map((week) => ({
      weekStart: new Date(week.weekStart),
      weekEnd: new Date(week.weekEnd),
      totalMinor: BigInt(week.totalMinor),
      expenseCount: week.expenseCount
    })),
    categoryBreakdown: value.categoryBreakdown.map((entry) => ({
      ...entry,
      totalMinor: BigInt(entry.totalMinor)
    })),
    merchantBreakdown: value.merchantBreakdown.map((entry) => ({
      ...entry,
      totalMinor: BigInt(entry.totalMinor)
    })),
    paymentMethodBreakdown: value.paymentMethodBreakdown.map((entry) => ({
      ...entry,
      totalMinor: BigInt(entry.totalMinor)
    })),
    cashflow: {
      incomeMinor: BigInt(value.cashflow.incomeMinor),
      spendMinor: BigInt(value.cashflow.spendMinor),
      netMinor: BigInt(value.cashflow.netMinor),
      businessMinor: BigInt(value.cashflow.businessMinor),
      reimbursableMinor: BigInt(value.cashflow.reimbursableMinor)
    },
    trend: {
      currentMonthMinor: BigInt(value.trend.currentMonthMinor),
      previousMonthMinor: BigInt(value.trend.previousMonthMinor),
      deltaMinor: BigInt(value.trend.deltaMinor),
      deltaPercent: value.trend.deltaPercent
    },
    forecast: {
      observedDayCount: value.forecast.observedDayCount,
      monthDayCount: value.forecast.monthDayCount,
      dailyAverageMinor: BigInt(value.forecast.dailyAverageMinor),
      projectedMonthEndMinor: BigInt(value.forecast.projectedMonthEndMinor),
      projectedDeltaFromPreviousMinor: BigInt(value.forecast.projectedDeltaFromPreviousMinor),
      projectedBudgetUtilizationPercent: value.forecast.projectedBudgetUtilizationPercent,
      largestBudgetRisk: value.forecast.largestBudgetRisk
        ? {
            ...value.forecast.largestBudgetRisk,
            projectedOverspendMinor: BigInt(value.forecast.largestBudgetRisk.projectedOverspendMinor)
          }
        : null
    },
    budgetAlerts: value.budgetAlerts.map((alert) => ({
      ...alert,
      remainingMinor: BigInt(alert.remainingMinor)
    })),
    anomalySummary: value.anomalySummary,
    recommendations: value.recommendations
  };
}

function isCachedMonthlySpend(value: unknown): value is CachedMonthlySpendAnalytics {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as CachedMonthlySpendAnalytics;
  return (
    typeof candidate.workspaceId === "string" &&
    typeof candidate.month === "string" &&
    typeof candidate.currency === "string" &&
    isIntegerString(candidate.totalMinor) &&
    isIntegerString(candidate.businessMinor) &&
    isIntegerString(candidate.reimbursableMinor) &&
    Number.isInteger(candidate.expenseCount) &&
    Array.isArray(candidate.budgetUsage) &&
    candidate.budgetUsage.every(isCachedBudgetUsage)
  );
}

function isCachedBudgetUsageList(value: unknown): value is CachedBudgetUsageList {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as CachedBudgetUsageList;
  return Array.isArray(candidate.budgetUsage) && candidate.budgetUsage.every(isCachedBudgetUsage);
}

function isCachedBudgetUsage(value: unknown): value is CachedBudgetUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const usage = value as CachedBudgetUsage;
  return (
    isCachedBudget(usage.budget) &&
    isCachedBudgetPeriod(usage.period) &&
    Number.isFinite(usage.utilizationPercent) &&
    typeof usage.alertTriggered === "boolean" &&
    isIntegerString(usage.remainingMinor)
  );
}

function isCachedFinanceInsights(value: unknown): value is CachedFinanceInsightAnalytics {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as CachedFinanceInsightAnalytics;
  return (
    typeof candidate.workspaceId === "string" &&
    typeof candidate.month === "string" &&
    typeof candidate.currency === "string" &&
    isDateString(candidate.generatedAt) &&
    Array.isArray(candidate.weeklySpend) &&
    candidate.weeklySpend.every(isCachedWeeklySpend) &&
    Array.isArray(candidate.categoryBreakdown) &&
    candidate.categoryBreakdown.every(isCachedCategoryBreakdown) &&
    Array.isArray(candidate.merchantBreakdown) &&
    candidate.merchantBreakdown.every(isCachedMerchantBreakdown) &&
    Array.isArray(candidate.paymentMethodBreakdown) &&
    candidate.paymentMethodBreakdown.every(isCachedPaymentMethodBreakdown) &&
    isCachedCashflow(candidate.cashflow) &&
    isCachedTrend(candidate.trend) &&
    isCachedForecast(candidate.forecast) &&
    Array.isArray(candidate.budgetAlerts) &&
    candidate.budgetAlerts.every(isCachedBudgetAlert) &&
    Array.isArray(candidate.anomalySummary) &&
    candidate.anomalySummary.every(isCachedAnomalySummary) &&
    Array.isArray(candidate.recommendations) &&
    candidate.recommendations.every(isCachedRecommendation)
  );
}

function isCachedWeeklySpend(value: unknown): value is CachedFinanceInsightAnalytics["weeklySpend"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const week = value as CachedFinanceInsightAnalytics["weeklySpend"][number];
  return isDateString(week.weekStart) && isDateString(week.weekEnd) && isIntegerString(week.totalMinor) && Number.isInteger(week.expenseCount);
}

function isCachedCategoryBreakdown(value: unknown): value is CachedFinanceInsightAnalytics["categoryBreakdown"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as CachedFinanceInsightAnalytics["categoryBreakdown"][number];
  return typeof entry.categoryId === "string" && isIntegerString(entry.totalMinor) && Number.isInteger(entry.expenseCount) && Number.isFinite(entry.sharePercent);
}

function isCachedMerchantBreakdown(value: unknown): value is CachedFinanceInsightAnalytics["merchantBreakdown"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as CachedFinanceInsightAnalytics["merchantBreakdown"][number];
  return typeof entry.merchant === "string" && isIntegerString(entry.totalMinor) && Number.isInteger(entry.expenseCount);
}

function isCachedPaymentMethodBreakdown(value: unknown): value is CachedFinanceInsightAnalytics["paymentMethodBreakdown"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as CachedFinanceInsightAnalytics["paymentMethodBreakdown"][number];
  return typeof entry.paymentMethod === "string" && isIntegerString(entry.totalMinor) && Number.isInteger(entry.expenseCount);
}

function isCachedCashflow(value: unknown): value is CachedFinanceInsightAnalytics["cashflow"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const cashflow = value as CachedFinanceInsightAnalytics["cashflow"];
  return (
    isIntegerString(cashflow.incomeMinor) &&
    isIntegerString(cashflow.spendMinor) &&
    isIntegerString(cashflow.netMinor) &&
    isIntegerString(cashflow.businessMinor) &&
    isIntegerString(cashflow.reimbursableMinor)
  );
}

function isCachedTrend(value: unknown): value is CachedFinanceInsightAnalytics["trend"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const trend = value as CachedFinanceInsightAnalytics["trend"];
  return (
    isIntegerString(trend.currentMonthMinor) &&
    isIntegerString(trend.previousMonthMinor) &&
    isIntegerString(trend.deltaMinor) &&
    (trend.deltaPercent === null || Number.isFinite(trend.deltaPercent))
  );
}

function isCachedForecast(value: unknown): value is CachedFinanceInsightAnalytics["forecast"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const forecast = value as CachedFinanceInsightAnalytics["forecast"];
  return (
    Number.isInteger(forecast.observedDayCount) &&
    Number.isInteger(forecast.monthDayCount) &&
    isIntegerString(forecast.dailyAverageMinor) &&
    isIntegerString(forecast.projectedMonthEndMinor) &&
    isIntegerString(forecast.projectedDeltaFromPreviousMinor) &&
    (forecast.projectedBudgetUtilizationPercent === null || Number.isFinite(forecast.projectedBudgetUtilizationPercent)) &&
    (forecast.largestBudgetRisk === null || isCachedLargestBudgetRisk(forecast.largestBudgetRisk))
  );
}

function isCachedLargestBudgetRisk(value: unknown): value is NonNullable<CachedFinanceInsightAnalytics["forecast"]["largestBudgetRisk"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const risk = value as NonNullable<CachedFinanceInsightAnalytics["forecast"]["largestBudgetRisk"]>;
  return (
    typeof risk.budgetId === "string" &&
    typeof risk.name === "string" &&
    Number.isFinite(risk.projectedUtilizationPercent) &&
    isIntegerString(risk.projectedOverspendMinor)
  );
}

function isCachedBudgetAlert(value: unknown): value is CachedFinanceInsightAnalytics["budgetAlerts"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const alert = value as CachedFinanceInsightAnalytics["budgetAlerts"][number];
  return (
    typeof alert.budgetId === "string" &&
    typeof alert.name === "string" &&
    (alert.severity === "ok" || alert.severity === "warning" || alert.severity === "over") &&
    Number.isFinite(alert.utilizationPercent) &&
    isIntegerString(alert.remainingMinor)
  );
}

function isCachedAnomalySummary(value: unknown): value is CachedFinanceInsightAnalytics["anomalySummary"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const anomaly = value as CachedFinanceInsightAnalytics["anomalySummary"][number];
  return (
    typeof anomaly.code === "string" &&
    (anomaly.severity === "info" || anomaly.severity === "warning" || anomaly.severity === "critical") &&
    Number.isInteger(anomaly.count) &&
    isPlainEvidence(anomaly.evidence)
  );
}

function isCachedRecommendation(value: unknown): value is CachedFinanceInsightAnalytics["recommendations"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const recommendation = value as CachedFinanceInsightAnalytics["recommendations"][number];
  return (
    (recommendation.code === "PROJECTED_OVER_BUDGET" ||
      recommendation.code === "HIGH_RUN_RATE" ||
      recommendation.code === "REIMBURSABLE_FOLLOW_UP" ||
      recommendation.code === "NO_BUDGET") &&
    (recommendation.severity === "info" || recommendation.severity === "warning" || recommendation.severity === "critical") &&
    typeof recommendation.message === "string" &&
    isPlainEvidence(recommendation.evidence)
  );
}

function isPlainEvidence(value: unknown): value is Record<string, string | number | boolean | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(
    (entry) => entry === null || typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean"
  );
}

function isCachedBudget(value: unknown): value is CachedBudget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const budget = value as CachedBudget;
  return (
    typeof budget.id === "string" &&
    typeof budget.tenantId === "string" &&
    typeof budget.workspaceId === "string" &&
    (budget.categoryId === null || typeof budget.categoryId === "string") &&
    typeof budget.name === "string" &&
    typeof budget.currency === "string" &&
    isIntegerString(budget.amountMinor) &&
    Number.isInteger(budget.alertPercent) &&
    isDateString(budget.createdAt) &&
    isDateString(budget.updatedAt)
  );
}

function isCachedBudgetPeriod(value: unknown): value is CachedBudgetPeriod {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const period = value as CachedBudgetPeriod;
  return (
    typeof period.id === "string" &&
    typeof period.tenantId === "string" &&
    typeof period.budgetId === "string" &&
    isDateString(period.startsAt) &&
    isDateString(period.endsAt) &&
    isIntegerString(period.spentMinor) &&
    isDateString(period.createdAt) &&
    isDateString(period.updatedAt)
  );
}

function isIntegerString(value: unknown): value is string {
  return typeof value === "string" && /^-?\d+$/.test(value);
}

function isDateString(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(new Date(value).getTime());
}
