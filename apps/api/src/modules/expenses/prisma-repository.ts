import { Prisma, PrismaClient } from "@prisma/client";
import { expenseCategoryLabels } from "@spendlens/shared";
import type {
  ApprovalSlaItem,
  CreateExpenseInput,
  ExpenseRepository,
  StoredApprovalWorkflow,
  StoredExpenseComment,
  StoredExpense,
  StoredExpenseLineItem,
  StoredExpensePolicy,
  StoredImportBatch,
  StoredMLCategoryPrediction,
  StoredReimbursementClaimExpense,
  StoredRecurringExpense,
  StoredSubscription
} from "./types";

export class PrismaExpenseRepository implements ExpenseRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateExpenseInput): Promise<{ expense: StoredExpense; lineItems: StoredExpenseLineItem[] }> {
    return this.prisma.$transaction(async (tx) => {
      const merchant = input.merchantName
        ? await tx.merchant.upsert({
            where: { tenantId_normalizedName: { tenantId: input.tenantId, normalizedName: normalizeName(input.merchantName) } },
            create: { tenantId: input.tenantId, name: input.merchantName, normalizedName: normalizeName(input.merchantName) },
            update: { name: input.merchantName },
            select: { id: true }
          })
        : null;
      const paymentMethod = input.paymentMethodName
        ? await tx.paymentMethod.create({
            data: { tenantId: input.tenantId, name: input.paymentMethodName, type: input.paymentMethodName },
            select: { id: true }
          })
        : null;
      const expense = await tx.expense.create({
        data: {
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          merchantId: merchant?.id ?? null,
          paymentMethodId: paymentMethod?.id ?? null,
          documentId: input.documentId ?? null,
          status: input.status ?? "DRAFT",
          title: input.title,
          description: input.description ?? null,
          currency: input.currency,
          amountMinor: input.amountMinor,
          taxMinor: input.taxMinor ?? 0n,
          occurredAt: input.occurredAt,
          reimbursable: input.reimbursable ?? false,
          businessExpense: input.businessExpense ?? false,
          projectCode: input.projectCode ?? null,
          costCenter: input.costCenter ?? null,
          duplicateGroup: input.duplicateGroup ?? null,
          createdById: input.createdById
        }
      });
      if (input.lineItems?.length) {
        await tx.expenseLineItem.createMany({
          data: input.lineItems.map((item) => ({
            tenantId: input.tenantId,
            expenseId: expense.id,
            name: item.name,
            quantity: new Prisma.Decimal(item.quantity ?? "1"),
            unitPriceMinor: item.unitPriceMinor ?? item.totalMinor,
            taxRateBps: item.taxRateBps ?? null,
            totalMinor: item.totalMinor
          }))
        });
      }
      const lineItems = await tx.expenseLineItem.findMany({ where: { tenantId: input.tenantId, expenseId: expense.id } });
      await tx.approvalWorkflow.create({
        data: {
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          targetType: "Expense",
          targetId: expense.id,
          state: "PENDING",
          slaDueAt: addHours(expense.createdAt, DEFAULT_APPROVAL_SLA_HOURS),
          slaStatus: "ON_TRACK",
          slaHours: DEFAULT_APPROVAL_SLA_HOURS
        }
      });
      return {
        expense: {
          ...expense,
          merchantName: input.merchantName ?? null,
          paymentMethodName: input.paymentMethodName ?? null
        },
        lineItems: lineItems.map((item) => ({ ...item, quantity: item.quantity.toString() }))
      };
    });
  }

  async list(input: { tenantId: string; workspaceId?: string }): Promise<StoredExpense[]> {
    const expenses = await this.prisma.expense.findMany({
      where: { tenantId: input.tenantId, archivedAt: null, ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}) },
      orderBy: { occurredAt: "desc" }
    });
    const merchantIds = [...new Set(expenses.map((expense) => expense.merchantId).filter(Boolean))] as string[];
    const paymentMethodIds = [...new Set(expenses.map((expense) => expense.paymentMethodId).filter(Boolean))] as string[];
    const [merchants, paymentMethods] = await Promise.all([
      merchantIds.length
        ? this.prisma.merchant.findMany({ where: { tenantId: input.tenantId, id: { in: merchantIds } }, select: { id: true, name: true } })
        : [],
      paymentMethodIds.length
        ? this.prisma.paymentMethod.findMany({
            where: { tenantId: input.tenantId, id: { in: paymentMethodIds } },
            select: { id: true, name: true }
          })
        : []
    ]);
    const merchantNames = new Map(merchants.map((merchant) => [merchant.id, merchant.name]));
    const paymentMethodNames = new Map(paymentMethods.map((paymentMethod) => [paymentMethod.id, paymentMethod.name]));
    return expenses.map((expense) => ({
      ...expense,
      merchantName: expense.merchantId ? merchantNames.get(expense.merchantId) ?? null : null,
      paymentMethodName: expense.paymentMethodId ? paymentMethodNames.get(expense.paymentMethodId) ?? null : null
    }));
  }

  async listPage(input: Parameters<ExpenseRepository["listPage"]>[0]): ReturnType<ExpenseRepository["listPage"]> {
    const search = input.search?.trim();
    const matchingMerchantIds = search
      ? (
          await this.prisma.merchant.findMany({
            where: { tenantId: input.tenantId, name: { contains: search, mode: "insensitive" } },
            select: { id: true }
          })
        ).map((merchant) => merchant.id)
      : [];
    const expenses = await this.prisma.expense.findMany({
      where: {
        tenantId: input.tenantId,
        archivedAt: null,
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        ...(input.status ? { status: input.status } : {}),
        ...(search
          ? {
              OR: [
                { title: { contains: search, mode: "insensitive" } },
                { description: { contains: search, mode: "insensitive" } },
                ...(matchingMerchantIds.length ? [{ merchantId: { in: matchingMerchantIds } }] : [])
              ]
            }
          : {})
      },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: input.limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {})
    });
    const hasMore = expenses.length > input.limit;
    const page = expenses.slice(0, input.limit);
    return {
      expenses: await this.withRelatedNames(page, input.tenantId),
      nextCursor: hasMore ? page.at(-1)?.id ?? null : null
    };
  }

  async createImportBatch(input: Parameters<ExpenseRepository["createImportBatch"]>[0]): Promise<StoredImportBatch> {
    return this.prisma.$transaction(async (tx) => {
      const importBatch = await tx.importBatch.create({
        data: {
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          source: input.source,
          status: input.status,
          stats: input.stats as Prisma.InputJsonValue,
          createdById: input.createdById,
          completedAt: new Date()
        }
      });
      return importBatch;
    });
  }

  async listImportBatches(input: Parameters<ExpenseRepository["listImportBatches"]>[0]): Promise<StoredImportBatch[]> {
    return this.prisma.importBatch.findMany({
      where: { tenantId: input.tenantId, workspaceId: input.workspaceId },
      orderBy: { createdAt: "desc" }
    });
  }

  async findById(input: { tenantId: string; expenseId: string }): Promise<StoredExpense | null> {
    const [expense] = await this.withRelatedNames(
      await this.prisma.expense.findMany({
        where: { id: input.expenseId, tenantId: input.tenantId, archivedAt: null }
      }),
      input.tenantId
    );
    return expense ?? null;
  }

  async update(input: Parameters<ExpenseRepository["update"]>[0]): Promise<StoredExpense | null> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.expense.findFirst({
        where: { id: input.expenseId, tenantId: input.tenantId, archivedAt: null }
      });
      if (!existing) return null;

      const merchant =
        input.merchantName === undefined
          ? undefined
          : input.merchantName
            ? await tx.merchant.upsert({
                where: { tenantId_normalizedName: { tenantId: input.tenantId, normalizedName: normalizeName(input.merchantName) } },
                create: { tenantId: input.tenantId, name: input.merchantName, normalizedName: normalizeName(input.merchantName) },
                update: { name: input.merchantName },
                select: { id: true }
              })
            : null;
      const paymentMethod =
        input.paymentMethodName === undefined
          ? undefined
          : input.paymentMethodName
            ? await tx.paymentMethod.create({
                data: { tenantId: input.tenantId, name: input.paymentMethodName, type: input.paymentMethodName },
                select: { id: true }
              })
            : null;

      const data: Prisma.ExpenseUpdateInput = {};
      if (input.title !== undefined) data.title = input.title;
      if (input.description !== undefined) data.description = input.description;
      if (input.amountMinor !== undefined) data.amountMinor = input.amountMinor;
      if (input.taxMinor !== undefined) data.taxMinor = input.taxMinor;
      if (input.occurredAt !== undefined) data.occurredAt = input.occurredAt;
      if (merchant !== undefined) data.merchantId = merchant?.id ?? null;
      if (paymentMethod !== undefined) data.paymentMethodId = paymentMethod?.id ?? null;
      if (input.reimbursable !== undefined) data.reimbursable = input.reimbursable;
      if (input.businessExpense !== undefined) data.businessExpense = input.businessExpense;
      if (input.projectCode !== undefined) data.projectCode = input.projectCode;
      if (input.costCenter !== undefined) data.costCenter = input.costCenter;

      const expense = await tx.expense.update({ where: { id: existing.id }, data });
      const [storedExpense] = await this.withRelatedNames([expense], input.tenantId);
      return storedExpense ?? null;
    });
  }

  async listAttachments(input: Parameters<ExpenseRepository["listAttachments"]>[0]) {
    return this.prisma.expenseAttachment.findMany({
      where: { tenantId: input.tenantId, expenseId: input.expenseId, detachedAt: null },
      orderBy: { attachedAt: "asc" }
    });
  }

  async attachDocument(input: Parameters<ExpenseRepository["attachDocument"]>[0]): ReturnType<ExpenseRepository["attachDocument"]> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.expense.findFirst({
        where: { id: input.expenseId, tenantId: input.tenantId, archivedAt: null }
      });
      if (!existing) return null;
      const existingAttachment = await tx.expenseAttachment.findFirst({
        where: { tenantId: input.tenantId, expenseId: existing.id, documentFileId: input.documentFileId, detachedAt: null }
      });
      const attachment =
        existingAttachment ??
        (await tx.expenseAttachment.create({
          data: {
            tenantId: input.tenantId,
            expenseId: existing.id,
            documentFileId: input.documentFileId,
            label: input.label ?? null,
            note: input.note ?? null,
            attachedById: input.actorUserId
          }
        }));
      const shouldPromote = input.primary === true || !existing.documentId;
      const expense = await tx.expense.update({
        where: { id: existing.id },
        data: { documentId: shouldPromote ? input.documentFileId : existing.documentId }
      });
      const [storedExpense] = await this.withRelatedNames([expense], input.tenantId);
      return storedExpense ? { expense: storedExpense, attachment } : null;
    });
  }

  async detachDocument(input: Parameters<ExpenseRepository["detachDocument"]>[0]): ReturnType<ExpenseRepository["detachDocument"]> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.expense.findFirst({
        where: { id: input.expenseId, tenantId: input.tenantId, archivedAt: null }
      });
      if (!existing) return null;
      const existingAttachment = await tx.expenseAttachment.findFirst({
        where: { tenantId: input.tenantId, expenseId: existing.id, documentFileId: input.documentFileId, detachedAt: null }
      });
      if (!existingAttachment && existing.documentId !== input.documentFileId) return null;
      const detachedAt = new Date();
      const attachment =
        existingAttachment !== null
          ? await tx.expenseAttachment.update({
              where: { id: existingAttachment.id },
              data: { detachedAt }
            })
          : await tx.expenseAttachment.create({
              data: {
                tenantId: input.tenantId,
                expenseId: existing.id,
                documentFileId: input.documentFileId,
                attachedById: input.actorUserId,
                attachedAt: existing.createdAt,
                detachedAt
              }
            });
      const nextPrimary =
        existing.documentId === input.documentFileId
          ? await tx.expenseAttachment.findFirst({
              where: { tenantId: input.tenantId, expenseId: existing.id, detachedAt: null },
              orderBy: { attachedAt: "asc" }
            })
          : null;
      const expense = await tx.expense.update({
        where: { id: existing.id },
        data: { documentId: existing.documentId === input.documentFileId ? nextPrimary?.documentFileId ?? null : existing.documentId }
      });
      const [storedExpense] = await this.withRelatedNames([expense], input.tenantId);
      return storedExpense ? { expense: storedExpense, attachment } : null;
    });
  }

  async archive(input: Parameters<ExpenseRepository["archive"]>[0]): Promise<StoredExpense | null> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.expense.findFirst({
        where: { id: input.expenseId, tenantId: input.tenantId, archivedAt: null }
      });
      if (!existing) return null;
      const expense = await tx.expense.update({
        where: { id: existing.id },
        data: { status: "ARCHIVED", archivedAt: new Date() }
      });
      const [storedExpense] = await this.withRelatedNames([expense], input.tenantId);
      return storedExpense ?? null;
    });
  }

  async createReimbursementClaim(input: Parameters<ExpenseRepository["createReimbursementClaim"]>[0]) {
    return this.prisma.$transaction(async (tx) => {
      const expenses = await tx.expense.findMany({
        where: {
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          id: { in: input.expenseIds },
          archivedAt: null
        }
      });
      if (expenses.length !== input.expenseIds.length) return null;
      const totalMinor = expenses.reduce((total, expense) => total + expense.amountMinor, 0n);
      const claim = await tx.reimbursementClaim.create({
        data: {
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          claimantId: input.claimantId,
          status: "NEEDS_REVIEW",
          totalMinor,
          currency: expenses[0]?.currency ?? "TRY",
          submittedAt: new Date()
        }
      });
      await tx.reimbursementClaimExpense.createMany({
        data: expenses.map((expense) => ({
          tenantId: input.tenantId,
          claimId: claim.id,
          expenseId: expense.id,
          amountMinor: expense.amountMinor
        }))
      });
      const items = await tx.reimbursementClaimExpense.findMany({ where: { tenantId: input.tenantId, claimId: claim.id } });
      return {
        claim,
        items,
        expenses: await this.withRelatedNames(expenses, input.tenantId)
      };
    });
  }

  async listReimbursementClaims(input: Parameters<ExpenseRepository["listReimbursementClaims"]>[0]) {
    const claims = await this.prisma.reimbursementClaim.findMany({
      where: { tenantId: input.tenantId, workspaceId: input.workspaceId },
      orderBy: { createdAt: "desc" }
    });
    const items = claims.length
      ? await this.prisma.reimbursementClaimExpense.findMany({
          where: { tenantId: input.tenantId, claimId: { in: claims.map((claim) => claim.id) } },
          orderBy: { createdAt: "asc" }
        })
      : [];
    const itemsByClaim = new Map<string, StoredReimbursementClaimExpense[]>();
    for (const item of items) {
      itemsByClaim.set(item.claimId, [...(itemsByClaim.get(item.claimId) ?? []), item]);
    }
    return claims.map((claim) => ({ claim, items: itemsByClaim.get(claim.id) ?? [] }));
  }

  async findReimbursementClaimById(input: Parameters<ExpenseRepository["findReimbursementClaimById"]>[0]) {
    const claim = await this.prisma.reimbursementClaim.findFirst({
      where: { tenantId: input.tenantId, id: input.claimId }
    });
    if (!claim) return null;
    const items = await this.prisma.reimbursementClaimExpense.findMany({
      where: { tenantId: input.tenantId, claimId: claim.id },
      orderBy: { createdAt: "asc" }
    });
    return { claim, items };
  }

  async transitionReimbursementClaim(input: Parameters<ExpenseRepository["transitionReimbursementClaim"]>[0]) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.reimbursementClaim.findFirst({
        where: { id: input.claimId, tenantId: input.tenantId }
      });
      if (!existing) return null;
      const items = await tx.reimbursementClaimExpense.findMany({ where: { tenantId: input.tenantId, claimId: existing.id } });
      const claim = await tx.reimbursementClaim.update({
        where: { id: existing.id },
        data: {
          status: input.status,
          ...(input.status === "REIMBURSED" ? { paidAt: new Date() } : {})
        }
      });
      if (input.status === "REIMBURSED" && items.length) {
        await tx.expense.updateMany({
          where: { tenantId: input.tenantId, id: { in: items.map((item) => item.expenseId) }, archivedAt: null },
          data: { status: "REIMBURSED" }
        });
      }
      const expenses = items.length
        ? await tx.expense.findMany({ where: { tenantId: input.tenantId, id: { in: items.map((item) => item.expenseId) } } })
        : [];
      return {
        claim,
        items,
        expenses: await this.withRelatedNames(expenses, input.tenantId)
      };
    });
  }

  async createExpensePolicy(input: Parameters<ExpenseRepository["createExpensePolicy"]>[0]): Promise<StoredExpensePolicy> {
    return this.prisma.$transaction(async (tx) => {
      const policy = await tx.expensePolicy.create({
        data: {
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          name: input.name,
          ruleType: input.ruleType,
          config: input.config as Prisma.InputJsonValue,
          severity: input.severity,
          createdById: input.actorUserId
        }
      });
      return policy;
    });
  }

  async listExpensePolicies(input: Parameters<ExpenseRepository["listExpensePolicies"]>[0]): Promise<StoredExpensePolicy[]> {
    return this.prisma.expensePolicy.findMany({
      where: {
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        ...(input.includeInactive ? {} : { active: true })
      },
      orderBy: { createdAt: "asc" }
    });
  }

  async archiveExpensePolicy(input: Parameters<ExpenseRepository["archiveExpensePolicy"]>[0]): Promise<StoredExpensePolicy | null> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.expensePolicy.findFirst({
        where: { id: input.policyId, tenantId: input.tenantId, active: true }
      });
      if (!existing) return null;
      const policy = await tx.expensePolicy.update({ where: { id: existing.id }, data: { active: false } });
      return policy;
    });
  }

  async listComments(input: Parameters<ExpenseRepository["listComments"]>[0]): Promise<StoredExpenseComment[]> {
    const existing = await this.prisma.expense.findFirst({
      where: { id: input.expenseId, tenantId: input.tenantId, archivedAt: null },
      select: { id: true }
    });
    if (!existing) return [];
    return this.prisma.expenseComment.findMany({
      where: { tenantId: input.tenantId, expenseId: input.expenseId },
      orderBy: { createdAt: "asc" }
    });
  }

  async addComment(input: Parameters<ExpenseRepository["addComment"]>[0]): Promise<StoredExpenseComment | null> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.expense.findFirst({
        where: { id: input.expenseId, tenantId: input.tenantId, archivedAt: null },
        select: { id: true, workspaceId: true }
      });
      if (!existing) return null;
      const comment = await tx.expenseComment.create({
        data: {
          tenantId: input.tenantId,
          expenseId: input.expenseId,
          authorId: input.actorUserId,
          body: input.body
        }
      });
      return comment;
    });
  }

  async listSubscriptions(input: Parameters<ExpenseRepository["listSubscriptions"]>[0]): Promise<StoredSubscription[]> {
    return this.prisma.subscription.findMany({
      where: { tenantId: input.tenantId, workspaceId: input.workspaceId, active: true },
      orderBy: [{ name: "asc" }, { createdAt: "desc" }]
    });
  }

  async upsertSubscription(input: Parameters<ExpenseRepository["upsertSubscription"]>[0]): Promise<StoredSubscription> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.subscription.findFirst({
        where: {
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          name: input.name,
          amountMinor: input.amountMinor,
          currency: input.currency,
          cadence: input.cadence,
          active: true
        }
      });
      const subscription = existing
        ? await tx.subscription.update({
            where: { id: existing.id },
            data: {
              merchantId: input.merchantId ?? existing.merchantId,
              detectedFromExpenseId: input.detectedFromExpenseId
            }
          })
        : await tx.subscription.create({
            data: {
              tenantId: input.tenantId,
              workspaceId: input.workspaceId,
              merchantId: input.merchantId ?? null,
              name: input.name,
              amountMinor: input.amountMinor,
              currency: input.currency,
              cadence: input.cadence,
              detectedFromExpenseId: input.detectedFromExpenseId
            }
          });
      return subscription;
    });
  }

  async listRecurring(input: Parameters<ExpenseRepository["listRecurring"]>[0]): Promise<StoredRecurringExpense[]> {
    const rules = await this.prisma.recurringExpense.findMany({
      where: { tenantId: input.tenantId, workspaceId: input.workspaceId, active: true },
      orderBy: { nextDueAt: "asc" }
    });
    return this.withRecurringMerchantNames(rules, input.tenantId);
  }

  async createRecurringFromExpense(input: Parameters<ExpenseRepository["createRecurringFromExpense"]>[0]): Promise<StoredRecurringExpense | null> {
    return this.prisma.$transaction(async (tx) => {
      const expense = await tx.expense.findFirst({
        where: { id: input.expenseId, tenantId: input.tenantId, archivedAt: null }
      });
      if (!expense) return null;
      const rule = await tx.recurringExpense.create({
        data: {
          tenantId: input.tenantId,
          workspaceId: expense.workspaceId,
          merchantId: expense.merchantId,
          amountMinor: expense.amountMinor,
          currency: expense.currency,
          cadence: input.cadence,
          nextDueAt: input.nextDueAt
        }
      });
      const [storedRule] = await this.withRecurringMerchantNames([rule], input.tenantId);
      return storedRule ?? null;
    });
  }

  async findRecurringById(input: Parameters<ExpenseRepository["findRecurringById"]>[0]): Promise<StoredRecurringExpense | null> {
    const rule = await this.prisma.recurringExpense.findFirst({
      where: { id: input.recurringExpenseId, tenantId: input.tenantId, active: true }
    });
    if (!rule) return null;
    const [storedRule] = await this.withRecurringMerchantNames([rule], input.tenantId);
    return storedRule ?? null;
  }

  async advanceRecurring(input: Parameters<ExpenseRepository["advanceRecurring"]>[0]): Promise<StoredRecurringExpense | null> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.recurringExpense.findFirst({
        where: { id: input.recurringExpenseId, tenantId: input.tenantId, active: true }
      });
      if (!existing) return null;
      const rule = await tx.recurringExpense.update({
        where: { id: existing.id },
        data: { nextDueAt: input.nextDueAt }
      });
      const [storedRule] = await this.withRecurringMerchantNames([rule], input.tenantId);
      return storedRule ?? null;
    });
  }

  async saveCategoryPrediction(input: Parameters<ExpenseRepository["saveCategoryPrediction"]>[0]): Promise<StoredMLCategoryPrediction> {
    return this.prisma.$transaction(async (tx) => {
      const category = await tx.expenseCategory.upsert({
        where: { tenantId_slug: { tenantId: input.tenantId, slug: input.categoryKey } },
        create: {
          tenantId: input.tenantId,
          slug: input.categoryKey,
          name: expenseCategoryLabels[input.categoryKey],
          color: categoryColor(input.categoryKey)
        },
        update: {
          name: expenseCategoryLabels[input.categoryKey],
          color: categoryColor(input.categoryKey)
        }
      });
      await tx.expense.updateMany({
        where: { tenantId: input.tenantId, id: input.expenseId, archivedAt: null },
        data: { categoryId: category.id }
      });
      const prediction = await tx.mLCategoryPrediction.create({
        data: {
          tenantId: input.tenantId,
          expenseId: input.expenseId,
          documentFileId: input.documentFileId ?? null,
          categoryId: category.id,
          confidence: new Prisma.Decimal(input.confidence.toFixed(4)),
          explanation: {
            prediction: input.prediction,
            anomalies: input.anomalies,
            model: input.model,
            categoryKey: input.categoryKey
          }
        }
      });
      return {
        ...prediction,
        confidence: prediction.confidence.toString()
      };
    });
  }

  async transitionStatus(input: Parameters<ExpenseRepository["transitionStatus"]>[0]) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.expense.findFirst({
        where: { id: input.expenseId, tenantId: input.tenantId, archivedAt: null }
      });
      if (!existing) return null;
      const expense = await tx.expense.update({
        where: { id: existing.id },
        data: { status: input.status }
      });
      const existingWorkflow = await tx.approvalWorkflow.findFirst({
        where: { tenantId: input.tenantId, targetType: "Expense", targetId: existing.id }
      });
      const slaDueAt = existingWorkflow?.slaDueAt ?? addHours(existing.createdAt, DEFAULT_APPROVAL_SLA_HOURS);
      const finalSla = finalizeApprovalSla(input.status, slaDueAt, new Date());
      const approvalWorkflow = existingWorkflow
        ? await tx.approvalWorkflow.update({
            where: { id: existingWorkflow.id },
            data: {
              state: input.status,
              approverId: input.actorUserId,
              policySnapshot: { reason: input.reason ?? null, previousStatus: existing.status, policyEvaluation: input.policyEvaluation ?? null },
              slaStatus: finalSla.slaStatus,
              slaBreachedAt: finalSla.slaBreachedAt
            }
          })
        : await tx.approvalWorkflow.create({
            data: {
              tenantId: input.tenantId,
              workspaceId: existing.workspaceId,
              targetType: "Expense",
              targetId: existing.id,
              state: input.status,
              approverId: input.actorUserId,
              policySnapshot: { reason: input.reason ?? null, previousStatus: existing.status, policyEvaluation: input.policyEvaluation ?? null },
              slaDueAt,
              slaStatus: finalSla.slaStatus,
              slaBreachedAt: finalSla.slaBreachedAt,
              slaHours: DEFAULT_APPROVAL_SLA_HOURS
            }
          });
      const [storedExpense] = await this.withRelatedNames([expense], input.tenantId);
      return {
        expense: storedExpense as StoredExpense,
        approvalWorkflow
      };
    });
  }

  async listApprovalSla(input: Parameters<ExpenseRepository["listApprovalSla"]>[0]): Promise<ApprovalSlaItem[]> {
    const now = input.now ?? new Date();
    const expenses = await this.list({ tenantId: input.tenantId, workspaceId: input.workspaceId });
    const workflows = expenses.length
      ? await this.prisma.approvalWorkflow.findMany({
          where: {
            tenantId: input.tenantId,
            workspaceId: input.workspaceId,
            targetType: "Expense",
            targetId: { in: expenses.map((expense) => expense.id) }
          }
        })
      : [];
    const workflowsByExpenseId = new Map(workflows.map((workflow) => [workflow.targetId, workflow]));
    return expenses.map((expense) => {
      const workflow =
        workflowsByExpenseId.get(expense.id) ?? createPendingApprovalWorkflow(input.tenantId, expense.workspaceId, expense.id, expense.createdAt);
      return buildApprovalSlaItem(expense, workflow, now);
    });
  }

  private async withRelatedNames(expenses: Awaited<ReturnType<PrismaClient["expense"]["findMany"]>>, tenantId: string): Promise<StoredExpense[]> {
    const merchantIds = [...new Set(expenses.map((expense) => expense.merchantId).filter(Boolean))] as string[];
    const paymentMethodIds = [...new Set(expenses.map((expense) => expense.paymentMethodId).filter(Boolean))] as string[];
    const [merchants, paymentMethods] = await Promise.all([
      merchantIds.length
        ? this.prisma.merchant.findMany({ where: { tenantId, id: { in: merchantIds } }, select: { id: true, name: true } })
        : [],
      paymentMethodIds.length
        ? this.prisma.paymentMethod.findMany({
            where: { tenantId, id: { in: paymentMethodIds } },
            select: { id: true, name: true }
          })
        : []
    ]);
    const merchantNames = new Map(merchants.map((merchant) => [merchant.id, merchant.name]));
    const paymentMethodNames = new Map(paymentMethods.map((paymentMethod) => [paymentMethod.id, paymentMethod.name]));
    return expenses.map((expense) => ({
      ...expense,
      merchantName: expense.merchantId ? merchantNames.get(expense.merchantId) ?? null : null,
      paymentMethodName: expense.paymentMethodId ? paymentMethodNames.get(expense.paymentMethodId) ?? null : null
    }));
  }

  private async withRecurringMerchantNames(
    rules: Awaited<ReturnType<PrismaClient["recurringExpense"]["findMany"]>>,
    tenantId: string
  ): Promise<StoredRecurringExpense[]> {
    const merchantIds = [...new Set(rules.map((rule) => rule.merchantId).filter(Boolean))] as string[];
    const merchants = merchantIds.length
      ? await this.prisma.merchant.findMany({ where: { tenantId, id: { in: merchantIds } }, select: { id: true, name: true } })
      : [];
    const merchantNames = new Map(merchants.map((merchant) => [merchant.id, merchant.name]));
    return rules.map((rule) => ({
      ...rule,
      merchantName: rule.merchantId ? merchantNames.get(rule.merchantId) ?? null : null
    }));
  }
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function categoryColor(categoryKey: string): string {
  const colors: Record<string, string> = {
    market: "#0f766e",
    ulasim: "#2563eb",
    yemek: "#b45309",
    akaryakit: "#dc2626",
    konaklama: "#7c3aed",
    ofis: "#4b5563",
    saglik: "#059669",
    egitim: "#0891b2",
    abonelik: "#9333ea",
    kargo: "#ca8a04",
    vergi_harc: "#be123c",
    diger: "#64748b"
  };
  return colors[categoryKey] ?? "#64748b";
}

const DEFAULT_APPROVAL_SLA_HOURS = 48;
const APPROVAL_DUE_SOON_MINUTES = 6 * 60;

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function finalizeApprovalSla(status: "APPROVED" | "REJECTED", dueAt: Date | null, decidedAt: Date) {
  if (!dueAt) return { slaStatus: status === "APPROVED" ? "MET_ON_TIME" : "REJECTED_ON_TIME", slaBreachedAt: null };
  const late = decidedAt.getTime() > dueAt.getTime();
  return {
    slaStatus: status === "APPROVED" ? (late ? "MET_LATE" : "MET_ON_TIME") : late ? "REJECTED_LATE" : "REJECTED_ON_TIME",
    slaBreachedAt: late ? dueAt : null
  };
}

function createPendingApprovalWorkflow(tenantId: string, workspaceId: string, expenseId: string, createdAt: Date): StoredApprovalWorkflow {
  return {
    id: `virtual-${expenseId}`,
    tenantId,
    workspaceId,
    targetType: "Expense",
    targetId: expenseId,
    state: "PENDING",
    approverId: null,
    policySnapshot: null,
    slaDueAt: addHours(createdAt, DEFAULT_APPROVAL_SLA_HOURS),
    slaBreachedAt: null,
    slaStatus: "ON_TRACK",
    slaHours: DEFAULT_APPROVAL_SLA_HOURS,
    createdAt,
    updatedAt: createdAt
  };
}

function buildApprovalSlaItem(expense: StoredExpense, workflow: StoredApprovalWorkflow, now: Date): ApprovalSlaItem {
  const dueAt = workflow.slaDueAt;
  const ageMinutes = Math.max(0, Math.floor((now.getTime() - expense.createdAt.getTime()) / 60000));
  const remainingMinutes = dueAt ? Math.floor((dueAt.getTime() - now.getTime()) / 60000) : null;
  const pending = workflow.state === "PENDING";
  const dynamicStatus =
    pending && remainingMinutes !== null
      ? remainingMinutes < 0
        ? "BREACHED"
        : remainingMinutes <= APPROVAL_DUE_SOON_MINUTES
          ? "DUE_SOON"
          : "ON_TRACK"
      : workflow.slaStatus;
  return {
    expense,
    workflow,
    slaStatus: dynamicStatus,
    slaDueAt: dueAt,
    slaBreachedAt: workflow.slaBreachedAt ?? (dynamicStatus === "BREACHED" ? dueAt : null),
    remainingMinutes,
    ageMinutes
  };
}
