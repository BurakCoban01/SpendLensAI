export type StoredBudget = {
  id: string;
  tenantId: string;
  workspaceId: string;
  categoryId: string | null;
  name: string;
  currency: string;
  amountMinor: bigint;
  alertPercent: number;
  createdAt: Date;
  updatedAt: Date;
};

export type StoredBudgetPeriod = {
  id: string;
  tenantId: string;
  budgetId: string;
  startsAt: Date;
  endsAt: Date;
  spentMinor: bigint;
  createdAt: Date;
  updatedAt: Date;
};

export type BudgetRepository = {
  create(input: {
    tenantId: string;
    workspaceId: string;
    categoryId?: string | null;
    name: string;
    currency: "TRY" | "USD" | "EUR" | "GBP";
    amountMinor: bigint;
    alertPercent: number;
  }): Promise<StoredBudget>;
  list(input: { tenantId: string; workspaceId: string }): Promise<StoredBudget[]>;
  upsertPeriod(input: {
    tenantId: string;
    budgetId: string;
    startsAt: Date;
    endsAt: Date;
    spentMinor: bigint;
  }): Promise<StoredBudgetPeriod>;
};

export type BudgetWithUsage = {
  budget: StoredBudget;
  period: StoredBudgetPeriod;
  utilizationPercent: number;
  alertTriggered: boolean;
  remainingMinor: bigint;
};

export type MonthlySpendAnalytics = {
  workspaceId: string;
  month: string;
  currency: string;
  totalMinor: bigint;
  businessMinor: bigint;
  reimbursableMinor: bigint;
  expenseCount: number;
  budgetUsage: BudgetWithUsage[];
};

export type FinanceInsightSeverity = "info" | "warning" | "critical";

export type FinanceInsightAnalytics = {
  workspaceId: string;
  month: string;
  currency: string;
  generatedAt: Date;
  weeklySpend: Array<{
    weekStart: Date;
    weekEnd: Date;
    totalMinor: bigint;
    expenseCount: number;
  }>;
  categoryBreakdown: Array<{
    categoryId: string;
    totalMinor: bigint;
    expenseCount: number;
    sharePercent: number;
  }>;
  merchantBreakdown: Array<{
    merchant: string;
    totalMinor: bigint;
    expenseCount: number;
  }>;
  paymentMethodBreakdown: Array<{
    paymentMethod: string;
    totalMinor: bigint;
    expenseCount: number;
  }>;
  cashflow: {
    incomeMinor: bigint;
    spendMinor: bigint;
    netMinor: bigint;
    businessMinor: bigint;
    reimbursableMinor: bigint;
  };
  trend: {
    currentMonthMinor: bigint;
    previousMonthMinor: bigint;
    deltaMinor: bigint;
    deltaPercent: number | null;
  };
  forecast: {
    observedDayCount: number;
    monthDayCount: number;
    dailyAverageMinor: bigint;
    projectedMonthEndMinor: bigint;
    projectedDeltaFromPreviousMinor: bigint;
    projectedBudgetUtilizationPercent: number | null;
    largestBudgetRisk: {
      budgetId: string;
      name: string;
      projectedUtilizationPercent: number;
      projectedOverspendMinor: bigint;
    } | null;
  };
  budgetAlerts: Array<{
    budgetId: string;
    name: string;
    severity: "ok" | "warning" | "over";
    utilizationPercent: number;
    remainingMinor: bigint;
  }>;
  anomalySummary: Array<{
    code: string;
    severity: FinanceInsightSeverity;
    count: number;
    evidence: Record<string, string | number | boolean | null>;
  }>;
  recommendations: Array<{
    code: "PROJECTED_OVER_BUDGET" | "HIGH_RUN_RATE" | "REIMBURSABLE_FOLLOW_UP" | "NO_BUDGET";
    severity: FinanceInsightSeverity;
    message: string;
    evidence: Record<string, string | number | boolean | null>;
  }>;
};
