import { scryptSync } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const demoPassword = "SpendLensDemo!2026";
const roles = [
  "OWNER",
  "ADMIN",
  "FINANCE_MANAGER",
  "ACCOUNTANT",
  "EMPLOYEE",
  "REVIEWER",
  "ML_ENGINEER",
  "AUDITOR",
  "VIEWER"
] as const;
const permissions = [
  "tenant.manage",
  "users.manage",
  "workspace.manage",
  "documents.upload",
  "documents.read",
  "documents.delete",
  "ocr.run",
  "ocr.review",
  "annotations.manage",
  "expenses.create",
  "expenses.read",
  "expenses.update",
  "expenses.approve",
  "budgets.manage",
  "reports.export",
  "ai.use",
  "ai.manage",
  "models.train",
  "models.promote",
  "admin.health.read",
  "admin.events.read",
  "admin.events.publish",
  "admin.jobs.read",
  "admin.jobs.manage",
  "admin.cache.read",
  "admin.cache.manage",
  "admin.audit.read",
  "admin.audit.manage",
  "api_keys.manage",
  "webhooks.manage"
] as const;
type RoleCode = (typeof roles)[number];
type PermissionCode = (typeof permissions)[number];

const rolePermissions: Record<RoleCode, readonly PermissionCode[]> = {
  OWNER: permissions,
  ADMIN: permissions.filter((permission) => permission !== "tenant.manage"),
  FINANCE_MANAGER: [
    "documents.read",
    "ocr.review",
    "expenses.create",
    "expenses.read",
    "expenses.update",
    "expenses.approve",
    "budgets.manage",
    "reports.export",
    "ai.use"
  ],
  ACCOUNTANT: ["documents.read", "expenses.read", "reports.export", "admin.audit.read"],
  EMPLOYEE: ["documents.upload", "documents.read", "ocr.run", "expenses.create", "expenses.read"],
  REVIEWER: ["documents.read", "ocr.review", "annotations.manage", "expenses.read", "expenses.update", "ai.use"],
  ML_ENGINEER: [
    "documents.read",
    "ocr.run",
    "annotations.manage",
    "ai.use",
    "ai.manage",
    "models.train",
    "models.promote",
    "admin.health.read",
    "admin.events.read",
    "admin.jobs.read",
    "admin.jobs.manage",
    "admin.cache.read"
  ],
  AUDITOR: ["documents.read", "expenses.read", "reports.export", "admin.audit.read"],
  VIEWER: ["documents.read", "expenses.read"]
};

async function main() {
  const tenant = await prisma.tenant.upsert({
    where: { slug: "demo" },
    update: { name: "Pusula Teknoloji" },
    create: { name: "Pusula Teknoloji", slug: "demo" }
  });

  const existingWorkspace = await prisma.workspace.findFirst({
    where: { tenantId: tenant.id, name: { in: ["Merkez Operasyonları", "Demo Workspace"] } },
    orderBy: { createdAt: "asc" }
  });
  const workspace = existingWorkspace
    ? await prisma.workspace.update({
        where: { id: existingWorkspace.id },
        data: { name: "Merkez Operasyonları", kind: "BUSINESS", archivedAt: null }
      })
    : await prisma.workspace.create({
        data: { tenantId: tenant.id, name: "Merkez Operasyonları", kind: "BUSINESS" }
      });

  const owner = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: "demo.owner@spendlens.local" } },
    update: { displayName: "Deniz Özkan", passwordHash: hashDemoPassword(demoPassword), disabledAt: null },
    create: {
      tenantId: tenant.id,
      email: "demo.owner@spendlens.local",
      displayName: "Deniz Özkan",
      passwordHash: hashDemoPassword(demoPassword)
    }
  });

  await seedRolesAndPermissions(tenant.id, owner.id);
  await seedDemoUsers(tenant.id);

  await prisma.businessProfile.upsert({
    where: { id: `demo-business-${workspace.id}` },
    update: {
      legalName: "Pusula Teknoloji A.Ş.",
      taxIdentifier: "1111111111",
      defaultCurrency: "TRY"
    },
    create: {
      id: `demo-business-${workspace.id}`,
      tenantId: tenant.id,
      workspaceId: workspace.id,
      legalName: "Pusula Teknoloji A.Ş.",
      taxIdentifier: "1111111111",
      defaultCurrency: "TRY"
    }
  });

  const categories = await seedCategories(tenant.id);
  const merchants = await seedMerchants(tenant.id, categories);
  const paymentMethod = await seedPaymentMethod(tenant.id);
  await normalizeLegacyDemoLabels(tenant.id, workspace.id);
  await seedBudgets(tenant.id, workspace.id, categories);
  const demoExpenses = await seedExpenses(tenant.id, workspace.id, owner.id, categories, merchants, paymentMethod.id);
  await seedExpenseDetails(tenant.id, owner.id, demoExpenses);
  await seedApprovalWorkflows(tenant.id, workspace.id, owner.id, demoExpenses);
  await seedReimbursementAndRecurring(tenant.id, workspace.id, owner.id, merchants, demoExpenses);
  await seedExpensePolicy(tenant.id, workspace.id, owner.id);

  console.log(
    JSON.stringify(
      {
        demoTenant: "demo",
        demoWorkspace: "Merkez Operasyonları",
        demoUser: "demo.owner@spendlens.local",
        demoPassword,
        note: "Synthetic local demo credentials only; do not use for production."
      },
      null,
      2
    )
  );
}

async function seedDemoUsers(tenantId: string) {
  const definitions = [
    { email: "finans.yoneticisi@spendlens.local", displayName: "Elif Kaya", role: "FINANCE_MANAGER" },
    { email: "calisan@spendlens.local", displayName: "Mert Yılmaz", role: "EMPLOYEE" },
    { email: "inceleme.uzmani@spendlens.local", displayName: "Selin Aydın", role: "REVIEWER" },
    { email: "denetci@spendlens.local", displayName: "Aslı Demir", role: "AUDITOR" },
    { email: "model.uzmani@spendlens.local", displayName: "Can Eren", role: "ML_ENGINEER" }
  ] as const;

  for (const definition of definitions) {
    const user = await prisma.user.upsert({
      where: { tenantId_email: { tenantId, email: definition.email } },
      update: { displayName: definition.displayName, passwordHash: hashDemoPassword(demoPassword), disabledAt: null },
      create: { tenantId, email: definition.email, displayName: definition.displayName, passwordHash: hashDemoPassword(demoPassword) }
    });
    const role = await prisma.role.findUnique({ where: { tenantId_code: { tenantId, code: definition.role } }, select: { id: true } });
    if (!role) throw new Error(`DEMO_ROLE_NOT_FOUND:${definition.role}`);
    await prisma.userRole.upsert({
      where: { tenantId_userId_roleId: { tenantId, userId: user.id, roleId: role.id } },
      update: {},
      create: { tenantId, userId: user.id, roleId: role.id }
    });
  }
}

async function seedRolesAndPermissions(tenantId: string, ownerUserId: string) {
  await prisma.permission.createMany({
    data: permissions.map((code) => ({ code, description: code })),
    skipDuplicates: true
  });

  const permissionRows = await prisma.permission.findMany({
    where: { code: { in: [...permissions] } },
    select: { id: true, code: true }
  });
  const permissionIdByCode = new Map(permissionRows.map((permission) => [permission.code, permission.id]));

  let ownerRoleId: string | null = null;
  for (const role of roles) {
    const created = await prisma.role.upsert({
      where: { tenantId_code: { tenantId, code: role } },
      update: { name: humanizeRole(role) },
      create: { tenantId, code: role, name: humanizeRole(role) },
      select: { id: true, code: true }
    });
    if (role === "OWNER") ownerRoleId = created.id;

    const allowedPermissionIds = rolePermissions[role]
      .map((permission) => permissionIdByCode.get(permission))
      .filter((permissionId): permissionId is string => Boolean(permissionId));
    await prisma.rolePermission.deleteMany({
      where: { tenantId, roleId: created.id, permissionId: { notIn: allowedPermissionIds } }
    });
    await prisma.rolePermission.createMany({
      data: allowedPermissionIds.map((permissionId) => ({ tenantId, roleId: created.id, permissionId })),
      skipDuplicates: true
    });
  }

  if (!ownerRoleId) throw new Error("OWNER_ROLE_NOT_CREATED");
  await prisma.userRole.upsert({
    where: { tenantId_userId_roleId: { tenantId, userId: ownerUserId, roleId: ownerRoleId } },
    update: {},
    create: { tenantId, userId: ownerUserId, roleId: ownerRoleId }
  });
}

async function seedCategories(tenantId: string) {
  const definitions = [
    ["market", "Market", "#2f7d62"],
    ["ulasim", "Ulaşım", "#2f6f9f"],
    ["yemek", "Yemek", "#9f5f2f"],
    ["akaryakit", "Akaryakıt", "#8d4f6f"],
    ["ofis", "Ofis", "#56607a"],
    ["abonelik", "Abonelik", "#6d5f9f"]
  ] as const;
  const result = new Map<string, { id: string; name: string }>();
  for (const [slug, name, color] of definitions) {
    const category = await prisma.expenseCategory.upsert({
      where: { tenantId_slug: { tenantId, slug } },
      update: { name, color },
      create: { tenantId, slug, name, color },
      select: { id: true, name: true, slug: true }
    });
    result.set(category.slug, category);
  }
  return result;
}

async function seedMerchants(tenantId: string, categories: Map<string, { id: string }>) {
  const definitions = [
    ["MAVI MARKET", "mavi market", "market"],
    ["İstanbul Metro", "istanbul metro", "ulasim"],
    ["Shell", "shell", "akaryakit"],
    ["Ofis Depo", "ofis depo", "ofis"],
    ["SaaS Muhasebe", "saas muhasebe", "abonelik"],
    ["Lokanta 34", "lokanta 34", "yemek"],
    ["Şehir Taksi", "sehir taksi", "ulasim"],
    ["FiberNet", "fibernet", "abonelik"],
    ["Hızlı Kurye", "hizli kurye", "ulasim"]
  ] as const;
  const result = new Map<string, { id: string; name: string }>();
  for (const [name, normalizedName, categorySlug] of definitions) {
    const merchant = await prisma.merchant.upsert({
      where: { tenantId_normalizedName: { tenantId, normalizedName } },
      update: { name, categoryId: categories.get(categorySlug)?.id ?? null },
      create: { tenantId, name, normalizedName, categoryId: categories.get(categorySlug)?.id ?? null },
      select: { id: true, name: true, normalizedName: true }
    });
    result.set(merchant.normalizedName, merchant);
  }
  return result;
}

async function seedPaymentMethod(tenantId: string) {
  const existing = await prisma.paymentMethod.findFirst({
    where: { tenantId, name: { in: ["Pusula Kurumsal Kart", "Demo Corporate Card", "Demo Kurumsal Kart"] } }
  });
  if (existing) {
    return prisma.paymentMethod.update({
      where: { id: existing.id },
      data: { name: "Pusula Kurumsal Kart", type: "CARD", maskedLast4: "4242" }
    });
  }
  return prisma.paymentMethod.create({
    data: { tenantId, name: "Pusula Kurumsal Kart", type: "CARD", maskedLast4: "4242" }
  });
}

async function normalizeLegacyDemoLabels(tenantId: string, workspaceId: string) {
  const budgetRenames = [
    ["Demo Operasyon Bütçesi", "Pazarlama ve Etkinlik"],
    ["Demo Sunum Bütçesi", "Eğitim ve Gelişim"],
    ["Ofis Operasyonu", "Ofis Donanım"]
  ] as const;
  for (const [legacyName, name] of budgetRenames) {
    await prisma.budget.updateMany({ where: { tenantId, workspaceId, name: legacyName }, data: { name } });
  }
  await prisma.expense.updateMany({
    where: { tenantId, workspaceId, title: "Demo Sunumu İş Gideri" },
    data: { title: "Etkinlik organizasyon gideri" }
  });
}

async function seedBudgets(tenantId: string, workspaceId: string, categories: Map<string, { id: string }>) {
  const { startsAt, endsAt } = currentMonthWindow();
  // legacyNames are lookup-only aliases for older ASCII seed rows; persisted display names stay Turkish.
  const definitions = [
    { name: "Aylık Market Bütçesi", legacyNames: ["Aylik Market Butcesi"], categorySlug: "market", amountMinor: 25_000_00n, spentMinor: 16_250_00n },
    { name: "Ulaşım ve Akaryakıt", legacyNames: ["Ulasim ve Akaryakit"], categorySlug: "akaryakit", amountMinor: 45_000_00n, spentMinor: 41_400_00n },
    { name: "Ofis Operasyon", legacyNames: [], categorySlug: "ofis", amountMinor: 15_000_00n, spentMinor: 16_800_00n }
  ];

  for (const definition of definitions) {
    const existing = await prisma.budget.findFirst({
      where: { tenantId, workspaceId, name: { in: [definition.name, ...definition.legacyNames] } }
    });
    const data = {
      tenantId,
      workspaceId,
      name: definition.name,
      categoryId: categories.get(definition.categorySlug)?.id ?? null,
      currency: "TRY",
      amountMinor: definition.amountMinor,
      alertPercent: 80
    };
    const budget = existing
      ? await prisma.budget.update({ where: { id: existing.id }, data })
      : await prisma.budget.create({ data });

    await prisma.budgetPeriod.upsert({
      where: { tenantId_budgetId_startsAt_endsAt: { tenantId, budgetId: budget.id, startsAt, endsAt } },
      update: { spentMinor: definition.spentMinor },
      create: { tenantId, budgetId: budget.id, startsAt, endsAt, spentMinor: definition.spentMinor }
    });
  }
}

async function seedExpenses(
  tenantId: string,
  workspaceId: string,
  ownerUserId: string,
  categories: Map<string, { id: string }>,
  merchants: Map<string, { id: string }>,
  paymentMethodId: string
) {
  const expenses = demoExpenseDefinitions();
  const persisted: Array<{ id: string; title: string; status: string; amountMinor: bigint }> = [];

  for (const expense of expenses) {
    const data: Prisma.ExpenseUncheckedCreateInput = {
      tenantId,
      workspaceId,
      title: expense.title,
      merchantId: merchants.get(expense.merchant)?.id ?? null,
      categoryId: categories.get(expense.category)?.id ?? null,
      paymentMethodId,
      status: expense.status,
      currency: "TRY",
      amountMinor: expense.amountMinor,
      taxMinor: expense.taxMinor,
      occurredAt: expense.occurredAt,
      businessExpense: expense.businessExpense,
      reimbursable: expense.reimbursable,
      projectCode: expense.projectCode,
      costCenter: expense.costCenter,
      createdById: ownerUserId
    };
    const existingRows = await prisma.expense.findMany({
      where: { tenantId, workspaceId, title: { in: [expense.title, ...expense.legacyTitles] } },
      orderBy: { createdAt: "asc" }
    });
    const existing = existingRows[0] ?? null;
    if (existing) {
      persisted.push(await prisma.expense.update({ where: { id: existing.id }, data, select: { id: true, title: true, status: true, amountMinor: true } }));
    } else {
      persisted.push(await prisma.expense.create({ data, select: { id: true, title: true, status: true, amountMinor: true } }));
    }
  }
  return persisted;
}

type DemoExpenseDefinition = {
  title: string;
  legacyTitles: string[];
  merchant: string;
  category: string;
  amountMinor: bigint;
  taxMinor: bigint;
  occurredAt: Date;
  status: "DRAFT" | "EXTRACTED" | "NEEDS_REVIEW" | "APPROVED" | "REJECTED" | "REIMBURSED" | "ARCHIVED";
  businessExpense: boolean;
  reimbursable: boolean;
  projectCode?: string;
  costCenter?: string;
};

function demoExpenseDefinitions(): DemoExpenseDefinition[] {
  const definitions = [
    ["Haftalık mutfak alışverişi", ["Demo market fişi", "Demo market fisi"], "mavi market", "market", 7_205n, "APPROVED"],
    ["Shell motorin operasyon", [], "shell", "akaryakit", 510_000n, "APPROVED"],
    ["Ofis sarf malzemeleri", [], "ofis depo", "ofis", 325_000n, "APPROVED"],
    ["Haftalık market alışverişi", [], "mavi market", "market", 186_450n, "APPROVED"],
    ["Müşteri öğle yemeği", [], "lokanta 34", "yemek", 248_000n, "NEEDS_REVIEW"],
    ["İstanbul Metro ulaşım", [], "istanbul metro", "ulasim", 4_500n, "APPROVED"],
    ["Muhasebe yazılım aboneliği", [], "saas muhasebe", "abonelik", 149_900n, "APPROVED"],
    ["Yazıcı toner alımı", [], "ofis depo", "ofis", 438_000n, "NEEDS_REVIEW"],
    ["Saha ekibi yakıt gideri", [], "shell", "akaryakit", 620_000n, "EXTRACTED"],
    ["Ekip toplantısı ikramı", [], "lokanta 34", "yemek", 312_500n, "NEEDS_REVIEW"],
    ["Taksi ulaşım gideri", [], "sehir taksi", "ulasim", 185_000n, "NEEDS_REVIEW"],
    ["Bulut depolama aboneliği", [], "saas muhasebe", "abonelik", 89_900n, "APPROVED"],
    ["Ofis temizlik malzemeleri", [], "ofis depo", "ofis", 276_400n, "APPROVED"],
    ["İş seyahati yemek gideri", [], "lokanta 34", "yemek", 198_750n, "APPROVED"],
    ["Aylık internet hizmeti", [], "fibernet", "abonelik", 129_900n, "APPROVED"],
    ["Müşteri ziyareti akaryakıt", [], "shell", "akaryakit", 455_000n, "REIMBURSED"],
    ["Kırtasiye alımı", [], "ofis depo", "ofis", 142_600n, "APPROVED"],
    ["Eğitim materyali", [], "ofis depo", "ofis", 890_000n, "REJECTED"],
    ["Geç teslim edilen fiş", [], "mavi market", "market", 93_250n, "REJECTED"],
    ["Kurye hizmeti", [], "hizli kurye", "ulasim", 74_500n, "REIMBURSED"],
    ["Fuar ulaşım gideri", [], "istanbul metro", "ulasim", 64_000n, "EXTRACTED"],
    ["Bekleyen otopark fişi", [], "sehir taksi", "ulasim", 85_000n, "DRAFT"],
    ["Taslak konaklama gideri", [], "sehir taksi", "ulasim", 1_250_000n, "DRAFT"],
    ["Eski cihaz aksesuarı", [], "ofis depo", "ofis", 215_000n, "ARCHIVED"],
    ["Proje toplantısı yemeği", [], "lokanta 34", "yemek", 465_000n, "APPROVED"]
  ] as const;

  return definitions.map(([title, legacyTitles, merchant, category, amountMinor, status], index) => ({
    title,
    legacyTitles: [...legacyTitles],
    merchant,
    category,
    amountMinor,
    taxMinor: amountMinor / 6n,
    occurredAt: dateInRelativeMonth(-Math.floor(index / 9), (index % 9) + 2, 8 + (index % 9)),
    status,
    businessExpense: index !== 0,
    reimbursable: status === "REIMBURSED" || index === 8 || index === 19,
    ...(index % 4 === 0 ? { projectCode: "OPS-2026" } : {}),
    ...(index % 3 === 0 ? { costCenter: "MERKEZ" } : {})
  }));
}

async function seedExpenseDetails(
  tenantId: string,
  ownerUserId: string,
  expenses: Array<{ id: string; title: string; amountMinor: bigint }>
) {
  for (const [index, expense] of expenses.slice(0, 12).entries()) {
    const firstAmount = expense.amountMinor > 1n ? (expense.amountMinor * 3n) / 5n : expense.amountMinor;
    const secondAmount = expense.amountMinor - firstAmount;
    const lines = [
      { suffix: "a", name: `${expense.title} - ana kalem`, amountMinor: firstAmount },
      { suffix: "b", name: `${expense.title} - tamamlayıcı kalem`, amountMinor: secondAmount }
    ];
    for (const line of lines) {
      await prisma.expenseLineItem.upsert({
        where: { id: `demo-line-${expense.id}-${line.suffix}` },
        update: {
          name: line.name,
          quantity: new Prisma.Decimal(1),
          unitPriceMinor: line.amountMinor,
          taxRateBps: 2_000,
          totalMinor: line.amountMinor
        },
        create: {
          id: `demo-line-${expense.id}-${line.suffix}`,
          tenantId,
          expenseId: expense.id,
          name: line.name,
          quantity: new Prisma.Decimal(1),
          unitPriceMinor: line.amountMinor,
          taxRateBps: 2_000,
          totalMinor: line.amountMinor
        }
      });
    }
    await prisma.taxBreakdown.upsert({
      where: { id: `demo-tax-${expense.id}` },
      update: {
        label: "KDV %20",
        rateBps: 2_000,
        taxableMinor: expense.amountMinor,
        taxMinor: expense.amountMinor / 6n
      },
      create: {
        id: `demo-tax-${expense.id}`,
        tenantId,
        expenseId: expense.id,
        label: "KDV %20",
        rateBps: 2_000,
        taxableMinor: expense.amountMinor,
        taxMinor: expense.amountMinor / 6n
      }
    });
    if (index < 5) {
      await prisma.expenseComment.upsert({
        where: { id: `demo-comment-${expense.id}` },
        update: { body: "Belge ve tutar kontrol edildi; gider sınıflandırması doğrulandı." },
        create: {
          id: `demo-comment-${expense.id}`,
          tenantId,
          expenseId: expense.id,
          authorId: ownerUserId,
          body: "Belge ve tutar kontrol edildi; gider sınıflandırması doğrulandı."
        }
      });
    }
  }
}

async function seedApprovalWorkflows(
  tenantId: string,
  workspaceId: string,
  approverId: string,
  expenses: Array<{ id: string; status: string }>
) {
  const approvalExamples = [
    ...expenses.filter((expense) => expense.status === "NEEDS_REVIEW" || expense.status === "EXTRACTED"),
    ...expenses.filter((expense) => expense.status === "APPROVED").slice(0, 3),
    ...expenses.filter((expense) => expense.status === "REJECTED").slice(0, 2)
  ];
  for (const [index, expense] of approvalExamples.entries()) {
    const state = expense.status === "APPROVED" ? "APPROVED" : expense.status === "REJECTED" ? "REJECTED" : "PENDING";
    const dueAt = new Date(Date.now() + (index === 1 ? -4 : 20 + index * 4) * 60 * 60 * 1000);
    const existing = await prisma.approvalWorkflow.findFirst({
      where: { tenantId, workspaceId, targetType: "Expense", targetId: expense.id },
      orderBy: { createdAt: "asc" }
    });
    const data = {
      tenantId,
      workspaceId,
      targetType: "Expense",
      targetId: expense.id,
      state,
      approverId,
      policySnapshot: { source: "demo_seed", receiptRequired: true },
      slaDueAt: dueAt,
      slaBreachedAt: state === "PENDING" && index === 1 ? new Date() : null,
      slaStatus: state === "PENDING" && index === 1 ? "BREACHED" : state === "PENDING" && index === 0 ? "DUE_SOON" : "ON_TRACK",
      slaHours: 48
    };
    if (existing) await prisma.approvalWorkflow.update({ where: { id: existing.id }, data });
    else await prisma.approvalWorkflow.create({ data });
  }
}

async function seedReimbursementAndRecurring(
  tenantId: string,
  workspaceId: string,
  ownerUserId: string,
  merchants: Map<string, { id: string }>,
  expenses: Array<{ id: string; title: string; status: string; amountMinor: bigint }>
) {
  const reimbursed = expenses.filter((expense) => expense.status === "REIMBURSED");
  const claim = await prisma.reimbursementClaim.upsert({
    where: { id: `demo-reimbursement-${workspaceId}` },
    update: {
      status: "REIMBURSED",
      totalMinor: reimbursed.reduce((sum, expense) => sum + expense.amountMinor, 0n),
      submittedAt: dateInCurrentMonth(5, 10),
      paidAt: dateInCurrentMonth(9, 14)
    },
    create: {
      id: `demo-reimbursement-${workspaceId}`,
      tenantId,
      workspaceId,
      claimantId: ownerUserId,
      status: "REIMBURSED",
      totalMinor: reimbursed.reduce((sum, expense) => sum + expense.amountMinor, 0n),
      currency: "TRY",
      submittedAt: dateInCurrentMonth(5, 10),
      paidAt: dateInCurrentMonth(9, 14)
    }
  });
  for (const expense of reimbursed) {
    await prisma.reimbursementClaimExpense.upsert({
      where: { tenantId_claimId_expenseId: { tenantId, claimId: claim.id, expenseId: expense.id } },
      update: { amountMinor: expense.amountMinor },
      create: { tenantId, claimId: claim.id, expenseId: expense.id, amountMinor: expense.amountMinor }
    });
  }

  const subscriptionExpense = expenses.find((expense) => expense.title === "Muhasebe yazılım aboneliği");
  await prisma.subscription.upsert({
    where: { id: `demo-subscription-${workspaceId}` },
    update: { name: "Muhasebe yazılımı", amountMinor: 149_900n, active: true, detectedFromExpenseId: subscriptionExpense?.id ?? null },
    create: {
      id: `demo-subscription-${workspaceId}`,
      tenantId,
      workspaceId,
      merchantId: merchants.get("saas muhasebe")?.id ?? null,
      name: "Muhasebe yazılımı",
      amountMinor: 149_900n,
      currency: "TRY",
      cadence: "monthly",
      detectedFromExpenseId: subscriptionExpense?.id ?? null,
      active: true
    }
  });

  await prisma.recurringExpense.upsert({
    where: { id: `demo-recurring-${workspaceId}` },
    update: { amountMinor: 129_900n, nextDueAt: nextMonthDate(3), active: true },
    create: {
      id: `demo-recurring-${workspaceId}`,
      tenantId,
      workspaceId,
      merchantId: merchants.get("fibernet")?.id ?? null,
      amountMinor: 129_900n,
      currency: "TRY",
      cadence: "monthly",
      nextDueAt: nextMonthDate(3),
      active: true
    }
  });
}

async function seedExpensePolicy(tenantId: string, workspaceId: string, ownerUserId: string) {
  const existing = await prisma.expensePolicy.findFirst({
    where: { tenantId, workspaceId, name: { in: ["Yüksek tutar için fiş zorunlu", "Yuksek tutar icin fis zorunlu"] } }
  });
  const data = {
    tenantId,
    workspaceId,
    name: "Yüksek tutar için fiş zorunlu",
    ruleType: "RECEIPT_REQUIRED_ABOVE_AMOUNT",
    config: { thresholdMinor: 100000, currency: "TRY" },
    severity: "warning",
    active: true,
    createdById: ownerUserId
  };
  if (existing) {
    await prisma.expensePolicy.update({ where: { id: existing.id }, data });
  } else {
    await prisma.expensePolicy.create({ data });
  }
}

function hashDemoPassword(password: string): string {
  const params = { N: 16_384, r: 8, p: 1 } as const;
  const salt = "spendlens-demo-seed";
  const derived = scryptSync(password, salt, 64, params);
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt}$${derived.toString("base64url")}`;
}

function currentMonthWindow() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    startsAt: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)),
    endsAt: new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999))
  };
}

function dateInCurrentMonth(day: number, hour: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day, hour, 0, 0, 0));
}

function dateInRelativeMonth(monthOffset: number, day: number, hour: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthOffset, day, hour, 0, 0, 0));
}

function nextMonthDate(day: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, day, 9, 0, 0, 0));
}

function humanizeRole(role: string): string {
  return role
    .toLowerCase()
    .split("_")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    process.exit(1);
  });
