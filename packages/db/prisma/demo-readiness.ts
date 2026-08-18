import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

try {
  const tenant = await prisma.tenant.findUnique({ where: { slug: "demo" } });
  if (!tenant) throw new Error("Demo tenant bulunamadı.");
  const workspace = await prisma.workspace.findFirst({
    where: { tenantId: tenant.id, archivedAt: null },
    orderBy: { createdAt: "asc" }
  });
  if (!workspace) throw new Error("Aktif demo çalışma alanı bulunamadı.");

  const [
    users,
    documents,
    expenses,
    expenseStatuses,
    budgets,
    periods,
    approvalStates,
    exportTypes,
    ocrJobs,
    extractions
  ] = await Promise.all([
    prisma.user.count({ where: { tenantId: tenant.id, disabledAt: null } }),
    prisma.documentFile.count({ where: { tenantId: tenant.id, workspaceId: workspace.id, deletedAt: null } }),
    prisma.expense.findMany({
      where: { tenantId: tenant.id, workspaceId: workspace.id, archivedAt: null },
      select: { occurredAt: true }
    }),
    prisma.expense.groupBy({
      by: ["status"],
      where: { tenantId: tenant.id, workspaceId: workspace.id },
      _count: true
    }),
    prisma.budget.findMany({
      where: { tenantId: tenant.id, workspaceId: workspace.id },
      select: { id: true, amountMinor: true, alertPercent: true }
    }),
    prisma.budgetPeriod.findMany({
      where: { tenantId: tenant.id, startsAt: { lte: new Date() }, endsAt: { gte: new Date() } },
      orderBy: { updatedAt: "desc" }
    }),
    prisma.approvalWorkflow.groupBy({
      by: ["state"],
      where: { tenantId: tenant.id, workspaceId: workspace.id },
      _count: true
    }),
    prisma.exportJob.groupBy({
      by: ["type"],
      where: { tenantId: tenant.id, workspaceId: workspace.id, status: "SUCCEEDED" },
      _count: true
    }),
    prisma.oCRJob.count({ where: { tenantId: tenant.id } }),
    prisma.extractionJob.count({ where: { tenantId: tenant.id, status: "SUCCEEDED" } })
  ]);

  const months = new Set(expenses.map((expense) => expense.occurredAt.toISOString().slice(0, 7)));
  const statusSet = new Set<string>(expenseStatuses.map((entry) => entry.status));
  const approvalStateSet = new Set(approvalStates.map((entry) => entry.state));
  const latestPeriodByBudget = new Map<string, (typeof periods)[number]>();
  for (const period of periods) {
    if (!latestPeriodByBudget.has(period.budgetId)) latestPeriodByBudget.set(period.budgetId, period);
  }
  const utilization = budgets.map((budget) => {
    const spent = latestPeriodByBudget.get(budget.id)?.spentMinor ?? 0n;
    return Number(spent) / Math.max(1, Number(budget.amountMinor));
  });

  const checks = {
    users: users >= 6,
    documents: documents >= 20,
    expenses: expenses.length >= 25,
    expenseMonths: months.size >= 3,
    expenseStates: ["DRAFT", "NEEDS_REVIEW", "APPROVED", "REJECTED", "REIMBURSED"].every((state) => statusSet.has(state)),
    budgets: budgets.length >= 3,
    budgetHealthy: utilization.some((ratio) => ratio > 0 && ratio < 0.8),
    budgetNearLimit: utilization.some((ratio) => ratio >= 0.8 && ratio <= 1),
    budgetExceeded: utilization.some((ratio) => ratio > 1),
    approvalStates: ["PENDING", "APPROVED", "REJECTED"].every((state) => approvalStateSet.has(state)),
    reports: exportTypes.length >= 3,
    ocrJobs: ocrJobs > 0,
    extractions: extractions > 0
  };
  const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  const result = {
    tenant: tenant.name,
    workspace: workspace.name,
    counts: {
      users,
      documents,
      expenses: expenses.length,
      expenseMonths: months.size,
      budgets: budgets.length,
      reportTypes: exportTypes.length,
      ocrJobs,
      successfulExtractions: extractions
    },
    states: {
      expenses: expenseStatuses.map((entry) => `${entry.status}:${entry._count}`),
      approvals: approvalStates.map((entry) => `${entry.state}:${entry._count}`)
    },
    checks,
    ready: failed.length === 0
  };
  console.log(JSON.stringify(result, null, 2));
  if (failed.length > 0) throw new Error(`Demo readiness başarısız: ${failed.join(", ")}`);
} finally {
  await prisma.$disconnect();
}
