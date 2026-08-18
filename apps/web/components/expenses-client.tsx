"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  apiRequest,
  authHeaders,
  type AuthResponse,
  type ExpenseAttachmentSummary,
  type DocumentSummary,
  type ExpenseAiAnalysis,
  type ExpenseCommentSummary,
  type ExpensePolicyEvaluationSummary,
  type ExpensePolicySummary,
  type ExpenseSummary,
  type ImportBatchSummary,
  type PrincipalResponse,
  type ReimbursementClaimItemSummary,
  type ReimbursementClaimSummary,
  type RecurringExpenseSummary,
  type SubscriptionSummary,
  type WorkspaceSummary
} from "../lib/api";
import { readSession } from "../lib/session";
import { useLocale } from "../lib/locale";
import { AppShell } from "./app-shell";
import { SessionRecoveryActions } from "./session-recovery-actions";

type ExpensesState =
  | { kind: "loading" }
  | { kind: "anonymous" }
  | {
      kind: "ready";
      session: AuthResponse;
      principal: PrincipalResponse["principal"];
      workspaces: WorkspaceSummary[];
      selectedWorkspaceId: string;
      documents: DocumentSummary[];
      expenses: ExpenseSummary[];
      nextCursor: string | null;
      commentsByExpenseId: Record<string, ExpenseCommentSummary[]>;
      attachmentsByExpenseId: Record<string, ExpenseAttachmentSummary[]>;
      importBatches: ImportBatchSummary[];
      expensePolicies: ExpensePolicySummary[];
      reimbursementClaims: ReimbursementClaimEntry[];
      subscriptions: SubscriptionSummary[];
      recurringExpenses: RecurringExpenseSummary[];
    }
  | { kind: "error"; message: string };

type ReimbursementClaimEntry = {
  claim: ReimbursementClaimSummary;
  items: ReimbursementClaimItemSummary[];
};

type SubmitState = { kind: "idle" } | { kind: "submitting" } | { kind: "success" } | { kind: "error"; message: string };
type EditState = { kind: "idle" } | { kind: "submitting"; expenseId: string } | { kind: "error"; expenseId: string; message: string };
type ArchiveState = { kind: "idle" } | { kind: "submitting"; expenseId: string } | { kind: "error"; expenseId: string; message: string };
type CommentState = { kind: "idle" } | { kind: "submitting"; expenseId: string } | { kind: "error"; expenseId: string; message: string };
type SplitState = { kind: "idle" } | { kind: "submitting"; expenseId: string } | { kind: "error"; expenseId: string; message: string };
type AttachmentState =
  | { kind: "idle" }
  | { kind: "submitting"; expenseId: string }
  | { kind: "error"; expenseId: string; message: string }
  | { kind: "success"; expenseId: string; message: string };
type ImportState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; importedRows: number; failedRows: number }
  | { kind: "error"; message: string };
type SubscriptionState = { kind: "idle" } | { kind: "detecting" } | { kind: "success"; count: number } | { kind: "error"; message: string };
type RecurringState =
  | { kind: "idle" }
  | { kind: "creating"; expenseId: string }
  | { kind: "generating"; recurringExpenseId: string }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };
type ReimbursementState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "transitioning"; claimId: string; action: "approve" | "reject" | "paid" }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };
type PolicyState =
  | { kind: "idle" }
  | { kind: "creating" }
  | { kind: "evaluating"; expenseId: string }
  | { kind: "archiving"; policyId: string }
  | { kind: "success"; message: string; evaluations: Record<string, ExpensePolicyEvaluationSummary> }
  | { kind: "error"; message: string; evaluations: Record<string, ExpensePolicyEvaluationSummary> };
type AnalysisState =
  | { kind: "idle" }
  | { kind: "loading"; expenseId: string }
  | { kind: "ready"; byExpenseId: Record<string, ExpenseAiAnalysis> }
  | { kind: "error"; message: string; byExpenseId: Record<string, ExpenseAiAnalysis> };

const currencies = ["TRY", "USD", "EUR", "GBP"] as const;

export function ExpensesClient() {
  const { locale } = useLocale();
  const dateLocale = locale === "tr" ? "tr-TR" : "en-US";
  const [state, setState] = useState<ExpensesState>({ kind: "loading" });
  const [submitState, setSubmitState] = useState<SubmitState>({ kind: "idle" });
  const [editState, setEditState] = useState<EditState>({ kind: "idle" });
  const [archiveState, setArchiveState] = useState<ArchiveState>({ kind: "idle" });
  const [commentState, setCommentState] = useState<CommentState>({ kind: "idle" });
  const [splitState, setSplitState] = useState<SplitState>({ kind: "idle" });
  const [attachmentState, setAttachmentState] = useState<AttachmentState>({ kind: "idle" });
  const [importState, setImportState] = useState<ImportState>({ kind: "idle" });
  const [subscriptionState, setSubscriptionState] = useState<SubscriptionState>({ kind: "idle" });
  const [recurringState, setRecurringState] = useState<RecurringState>({ kind: "idle" });
  const [reimbursementState, setReimbursementState] = useState<ReimbursementState>({ kind: "idle" });
  const [selectedReimbursementExpenseIds, setSelectedReimbursementExpenseIds] = useState<string[]>([]);
  const [policyState, setPolicyState] = useState<PolicyState>({ kind: "idle" });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailLoadingId, setDetailLoadingId] = useState<string | null>(null);
  const [listCursor, setListCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<Array<string | null>>([]);
  const [expenseSearch, setExpenseSearch] = useState("");
  const [expenseStatus, setExpenseStatus] = useState("");
  const [analysisState, setAnalysisState] = useState<AnalysisState>({ kind: "idle" });

  async function load(
    preferredWorkspaceId?: string,
    cursor: string | null = listCursor,
    filters: { search?: string; status?: string } = { search: expenseSearch, status: expenseStatus }
  ) {
    const session = readSession();
    if (!session) {
      setState({ kind: "anonymous" });
      return;
    }
    try {
      const principal = await apiRequest<PrincipalResponse>("/auth/me", {
        headers: authHeaders(session.tokens.accessToken)
      });
      const workspaces = (
        await apiRequest<{ workspaces: WorkspaceSummary[] }>("/workspaces", {
          headers: authHeaders(session.tokens.accessToken)
        })
      ).workspaces;
      const selectedWorkspaceId = preferredWorkspaceId ?? workspaces[0]?.id ?? "";
      const hasExpenseRead = principal.principal.permissions.includes("expenses.read");
      const hasDocumentRead = principal.principal.permissions.includes("documents.read");
      const expenseParams = new URLSearchParams({ workspaceId: selectedWorkspaceId, limit: "10" });
      if (cursor) expenseParams.set("cursor", cursor);
      if (filters.search?.trim()) expenseParams.set("search", filters.search.trim());
      if (filters.status) expenseParams.set("status", filters.status);
      const expensePage = selectedWorkspaceId && hasExpenseRead
        ? await apiRequest<{ expenses: ExpenseSummary[]; nextCursor: string | null }>(`/expenses?${expenseParams.toString()}`, {
              headers: authHeaders(session.tokens.accessToken)
            })
        : { expenses: [], nextCursor: null };
      const expenses = expensePage.expenses;
      const commentsByExpenseId: Record<string, ExpenseCommentSummary[]> = {};
      const attachmentsByExpenseId: Record<string, ExpenseAttachmentSummary[]> = {};
      const subscriptions = selectedWorkspaceId
        ? (
            await apiRequest<{ subscriptions: SubscriptionSummary[] }>(`/subscriptions?workspaceId=${encodeURIComponent(selectedWorkspaceId)}`, {
              headers: authHeaders(session.tokens.accessToken)
            })
          ).subscriptions
        : [];
      const recurringExpenses = selectedWorkspaceId
        ? (
            await apiRequest<{ recurringExpenses: RecurringExpenseSummary[] }>(`/recurring-expenses?workspaceId=${encodeURIComponent(selectedWorkspaceId)}`, {
              headers: authHeaders(session.tokens.accessToken)
            })
          ).recurringExpenses
        : [];
      const documents =
        selectedWorkspaceId && hasDocumentRead
          ? (
              await apiRequest<{ documents: DocumentSummary[] }>(`/documents?workspaceId=${encodeURIComponent(selectedWorkspaceId)}&limit=50`, {
                headers: authHeaders(session.tokens.accessToken)
              })
            ).documents
          : [];
      const importBatches =
        selectedWorkspaceId && hasExpenseRead
          ? (
              await apiRequest<{ importBatches: ImportBatchSummary[] }>(`/expenses/imports?workspaceId=${encodeURIComponent(selectedWorkspaceId)}`, {
                headers: authHeaders(session.tokens.accessToken)
              })
            ).importBatches
          : [];
      const reimbursementClaims =
        selectedWorkspaceId && hasExpenseRead
          ? (
              await apiRequest<{ reimbursementClaims: ReimbursementClaimEntry[] }>(
                `/reimbursement-claims?workspaceId=${encodeURIComponent(selectedWorkspaceId)}`,
                {
                  headers: authHeaders(session.tokens.accessToken)
                }
              )
            ).reimbursementClaims
          : [];
      const expensePolicies =
        selectedWorkspaceId && hasExpenseRead
          ? (
              await apiRequest<{ expensePolicies: ExpensePolicySummary[] }>(`/expense-policies?workspaceId=${encodeURIComponent(selectedWorkspaceId)}`, {
                headers: authHeaders(session.tokens.accessToken)
              })
            ).expensePolicies
          : [];
      setState({
        kind: "ready",
        session,
        principal: principal.principal,
        workspaces,
        selectedWorkspaceId,
        documents,
        expenses,
        nextCursor: expensePage.nextCursor,
        commentsByExpenseId,
        attachmentsByExpenseId,
        importBatches,
        expensePolicies,
        reimbursementClaims,
        subscriptions,
        recurringExpenses
      });
      setSelectedReimbursementExpenseIds((current) => current.filter((expenseId) => expenses.some((expense) => expense.id === expenseId)));
    } catch (caught) {
      setState({ kind: "error", message: caught instanceof Error ? caught.message : "EXPENSES_LOAD_FAILED" });
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function toggleExpenseDetail(expenseId: string) {
    if (state.kind !== "ready") return;
    if (detailId === expenseId) {
      setDetailId(null);
      return;
    }
    setDetailId(expenseId);
    if (state.commentsByExpenseId[expenseId] && state.attachmentsByExpenseId[expenseId]) return;
    setDetailLoadingId(expenseId);
    try {
      const [commentsResponse, attachmentsResponse] = await Promise.all([
        apiRequest<{ comments: ExpenseCommentSummary[] }>(`/expenses/${encodeURIComponent(expenseId)}/comments`, {
          headers: authHeaders(state.session.tokens.accessToken)
        }),
        apiRequest<{ attachments: DocumentSummary[]; attachmentMetadata: ExpenseAttachmentSummary[] }>(
          `/expenses/${encodeURIComponent(expenseId)}/attachments`,
          { headers: authHeaders(state.session.tokens.accessToken) }
        )
      ]);
      setState((current) =>
        current.kind === "ready"
          ? {
              ...current,
              commentsByExpenseId: { ...current.commentsByExpenseId, [expenseId]: commentsResponse.comments },
              attachmentsByExpenseId: { ...current.attachmentsByExpenseId, [expenseId]: attachmentsResponse.attachmentMetadata }
            }
          : current
      );
    } finally {
      setDetailLoadingId(null);
    }
  }

  function changeWorkspace(workspaceId: string) {
    setListCursor(null);
    setCursorHistory([]);
    setDetailId(null);
    void load(workspaceId, null);
  }

  function applyExpenseFilters(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.kind !== "ready") return;
    setListCursor(null);
    setCursorHistory([]);
    setDetailId(null);
    void load(state.selectedWorkspaceId, null, { search: expenseSearch, status: expenseStatus });
  }

  function showNextPage() {
    if (state.kind !== "ready" || !state.nextCursor) return;
    setCursorHistory((current) => [...current, listCursor]);
    setListCursor(state.nextCursor);
    setDetailId(null);
    void load(state.selectedWorkspaceId, state.nextCursor);
  }

  function showPreviousPage() {
    if (state.kind !== "ready" || cursorHistory.length === 0) return;
    const previousCursor = cursorHistory.at(-1) ?? null;
    setCursorHistory((current) => current.slice(0, -1));
    setListCursor(previousCursor);
    setDetailId(null);
    void load(state.selectedWorkspaceId, previousCursor);
  }

  const canCreate = state.kind === "ready" && state.principal.permissions.includes("expenses.create");
  const canRead = state.kind === "ready" && state.principal.permissions.includes("expenses.read");
  const canUpdate = state.kind === "ready" && state.principal.permissions.includes("expenses.update");
  const canApprove = state.kind === "ready" && state.principal.permissions.includes("expenses.approve");
  const canAnalyze = state.kind === "ready" && state.principal.permissions.includes("expenses.update");

  const totals = useMemo(() => {
    if (state.kind !== "ready") return [];
    const byCurrency = new Map<string, bigint>();
    for (const expense of state.expenses) {
      byCurrency.set(expense.currency, (byCurrency.get(expense.currency) ?? 0n) + BigInt(expense.amountMinor));
    }
    return Array.from(byCurrency.entries()).map(([currency, amountMinor]) => ({ currency, amountMinor }));
  }, [state]);

  async function createExpense(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.kind !== "ready" || !canCreate) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const amountMinor = parseDecimalMinor(String(form.get("amount") ?? ""));
    const taxInput = String(form.get("tax") ?? "").trim();
    const taxMinor = taxInput ? parseDecimalMinor(taxInput) : undefined;
    const occurredAt = new Date(String(form.get("occurredAt") ?? ""));
    if (!amountMinor || (taxInput && !taxMinor) || Number.isNaN(occurredAt.getTime())) {
      setSubmitState({
        kind: "error",
        message: locale === "tr" ? "Geçerli tutar, KDV/vergi ve tarih değerleri girin." : "Enter a valid amount, VAT/tax and date."
      });
      return;
    }
    setSubmitState({ kind: "submitting" });
    try {
      await apiRequest<{ expense: ExpenseSummary }>("/expenses", {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken),
        body: JSON.stringify({
          workspaceId: state.selectedWorkspaceId,
          title: form.get("title"),
          description: normalizeOptional(form.get("description")),
          currency: form.get("currency"),
          amountMinor,
          taxMinor,
          occurredAt: occurredAt.toISOString(),
          merchantName: normalizeOptional(form.get("merchantName")),
          paymentMethodName: normalizeOptional(form.get("paymentMethodName")),
          reimbursable: form.get("reimbursable") === "on",
          businessExpense: form.get("businessExpense") === "on",
          projectCode: normalizeOptional(form.get("projectCode")),
          costCenter: normalizeOptional(form.get("costCenter"))
        })
      });
      formElement.reset();
      setSubmitState({ kind: "success" });
      await load(state.selectedWorkspaceId);
    } catch (caught) {
      setSubmitState({ kind: "error", message: caught instanceof Error ? caught.message : "EXPENSE_CREATE_FAILED" });
    }
  }

  async function analyzeExpense(expenseId: string) {
    if (state.kind !== "ready" || !canAnalyze) return;
    const existing = analysisState.kind === "ready" || analysisState.kind === "error" ? analysisState.byExpenseId : {};
    setAnalysisState({ kind: "loading", expenseId });
    try {
      const analysis = await apiRequest<ExpenseAiAnalysis>(`/expenses/${encodeURIComponent(expenseId)}/ai-analysis`, {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken)
      });
      setAnalysisState({ kind: "ready", byExpenseId: { ...existing, [expenseId]: analysis } });
      await load(state.selectedWorkspaceId);
    } catch (caught) {
      setAnalysisState({
        kind: "error",
        message: caught instanceof Error ? caught.message : "EXPENSE_ANALYSIS_FAILED",
        byExpenseId: existing
      });
    }
  }

  async function updateExpense(event: React.FormEvent<HTMLFormElement>, expenseId: string) {
    event.preventDefault();
    if (state.kind !== "ready" || !canUpdate) return;
    const form = new FormData(event.currentTarget);
    const amountMinor = parseDecimalMinor(String(form.get("amount") ?? ""));
    const taxInput = String(form.get("tax") ?? "").trim();
    const taxMinor = taxInput ? parseDecimalMinor(taxInput) : "0";
    const occurredAt = new Date(String(form.get("occurredAt") ?? ""));
    if (!amountMinor || !taxMinor || Number.isNaN(occurredAt.getTime())) {
      setEditState({
        kind: "error",
        expenseId,
        message: locale === "tr" ? "Düzenleme için geçerli tutar, KDV/vergi ve tarih değerleri girin." : "Enter a valid amount, VAT/tax and date for editing."
      });
      return;
    }
    setEditState({ kind: "submitting", expenseId });
    try {
      await apiRequest<{ expense: ExpenseSummary }>(`/expenses/${encodeURIComponent(expenseId)}`, {
        method: "PATCH",
        headers: authHeaders(state.session.tokens.accessToken),
        body: JSON.stringify({
          title: form.get("title"),
          amountMinor,
          taxMinor,
          occurredAt: occurredAt.toISOString(),
          description: normalizeOptional(form.get("description")),
          merchantName: normalizeOptional(form.get("merchantName")),
          paymentMethodName: normalizeOptional(form.get("paymentMethodName")),
          reimbursable: form.get("reimbursable") === "on",
          businessExpense: form.get("businessExpense") === "on",
          projectCode: normalizeOptional(form.get("projectCode")),
          costCenter: normalizeOptional(form.get("costCenter"))
        })
      });
      setEditingId(null);
      setEditState({ kind: "idle" });
      await load(state.selectedWorkspaceId);
    } catch (caught) {
      setEditState({
        kind: "error",
        expenseId,
        message: caught instanceof Error ? caught.message : "EXPENSE_UPDATE_FAILED"
      });
    }
  }

  async function archiveExpense(expenseId: string) {
    if (state.kind !== "ready" || !canUpdate) return;
    setArchiveState({ kind: "submitting", expenseId });
    try {
      await apiRequest<{ expense: ExpenseSummary }>(`/expenses/${encodeURIComponent(expenseId)}/archive`, {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken),
        body: JSON.stringify({ reason: locale === "tr" ? "Çalışma alanı gider defterinden arşivlendi" : "Archived from the workspace expense ledger" })
      });
      setArchiveState({ kind: "idle" });
      setEditingId(null);
      await load(state.selectedWorkspaceId);
    } catch (caught) {
      setArchiveState({
        kind: "error",
        expenseId,
        message: caught instanceof Error ? caught.message : "EXPENSE_ARCHIVE_FAILED"
      });
    }
  }

  async function splitExpense(expense: ExpenseSummary) {
    if (state.kind !== "ready" || !canUpdate) return;
    const amount = BigInt(expense.amountMinor);
    const tax = BigInt(expense.taxMinor ?? "0");
    const firstAmount = amount / 2n;
    const secondAmount = amount - firstAmount;
    const firstTax = tax / 2n;
    const secondTax = tax - firstTax;
    setSplitState({ kind: "submitting", expenseId: expense.id });
    try {
      await apiRequest<{ expenses: ExpenseSummary[] }>(`/expenses/${encodeURIComponent(expense.id)}/split`, {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken),
        body: JSON.stringify({
          allocations: [
            {
              title: `${expense.title} - A`,
              amountMinor: firstAmount.toString(),
              taxMinor: firstTax.toString(),
              projectCode: expense.projectCode,
              costCenter: expense.costCenter,
              businessExpense: expense.businessExpense,
              reimbursable: expense.reimbursable
            },
            {
              title: `${expense.title} - B`,
              amountMinor: secondAmount.toString(),
              taxMinor: secondTax.toString(),
              projectCode: expense.projectCode,
              costCenter: expense.costCenter,
              businessExpense: expense.businessExpense,
              reimbursable: expense.reimbursable
            }
          ]
        })
      });
      setSplitState({ kind: "idle" });
      await load(state.selectedWorkspaceId);
    } catch (caught) {
      setSplitState({ kind: "error", expenseId: expense.id, message: caught instanceof Error ? caught.message : "EXPENSE_SPLIT_FAILED" });
    }
  }

  async function attachDocument(event: React.FormEvent<HTMLFormElement>, expenseId: string) {
    event.preventDefault();
    if (state.kind !== "ready" || !canUpdate) return;
    const form = new FormData(event.currentTarget);
    const documentFileId = String(form.get("documentFileId") ?? "");
    if (!documentFileId) {
      setAttachmentState({
        kind: "error",
        expenseId,
        message: locale === "tr" ? "Eklemeden önce bir belge seçin." : "Select a document before attaching."
      });
      return;
    }
    setAttachmentState({ kind: "submitting", expenseId });
    try {
      await apiRequest<{ expense: ExpenseSummary; attachment: DocumentSummary }>(`/expenses/${encodeURIComponent(expenseId)}/attachments`, {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken),
        body: JSON.stringify({
          documentFileId,
          label: normalizeOptional(form.get("label")),
          note: normalizeOptional(form.get("note")),
          primary: form.get("primary") === "on"
        })
      });
      setAttachmentState({
        kind: "success",
        expenseId,
        message: locale === "tr" ? "Belge gider kaydına eklendi." : "The document was attached to the expense."
      });
      await load(state.selectedWorkspaceId);
    } catch (caught) {
      setAttachmentState({ kind: "error", expenseId, message: caught instanceof Error ? caught.message : "EXPENSE_ATTACHMENT_FAILED" });
    }
  }

  async function detachDocument(expenseId: string, documentFileId: string) {
    if (state.kind !== "ready" || !canUpdate) return;
    setAttachmentState({ kind: "submitting", expenseId });
    try {
      await apiRequest<{ expense: ExpenseSummary; attachment: DocumentSummary | null }>(
        `/expenses/${encodeURIComponent(expenseId)}/attachments/${encodeURIComponent(documentFileId)}`,
        {
          method: "DELETE",
          headers: authHeaders(state.session.tokens.accessToken)
        }
      );
      setAttachmentState({
        kind: "success",
        expenseId,
        message: locale === "tr" ? "Belge gider kaydından çıkarıldı." : "The document was detached from the expense."
      });
      await load(state.selectedWorkspaceId);
    } catch (caught) {
      setAttachmentState({ kind: "error", expenseId, message: caught instanceof Error ? caught.message : "EXPENSE_DETACH_FAILED" });
    }
  }

  async function importExpenses(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.kind !== "ready" || !canCreate || !state.selectedWorkspaceId) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const csvText = String(form.get("csvText") ?? "").trim();
    if (!csvText) {
      setImportState({
        kind: "error",
        message: locale === "tr" ? "İçe aktarmadan önce CSV içeriğini yapıştırın." : "Paste the CSV content before importing."
      });
      return;
    }
    setImportState({ kind: "submitting" });
    try {
      const response = await apiRequest<{
        importBatch: ImportBatchSummary;
        expenses: ExpenseSummary[];
        errors: Array<{ row: number; field: string; code: string; message: string }>;
      }>("/expenses/imports", {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken),
        body: JSON.stringify({
          workspaceId: state.selectedWorkspaceId,
          source: normalizeOptional(form.get("source")) ?? "web-csv",
          csvText
        })
      });
      const stats = importStats(response.importBatch);
      if (response.importBatch.status === "FAILED") {
        const firstError = response.errors[0];
        setImportState({
          kind: "error",
          message: firstError ? `Satır ${firstError.row}: ${firstError.code}` : "CSV içe aktarma doğrulamadan geçemedi."
        });
      } else {
        formElement.reset();
        setImportState({ kind: "success", importedRows: stats.importedRows, failedRows: stats.failedRows });
      }
      await load(state.selectedWorkspaceId);
    } catch (caught) {
      setImportState({ kind: "error", message: caught instanceof Error ? caught.message : "EXPENSE_IMPORT_FAILED" });
    }
  }

  async function addComment(event: React.FormEvent<HTMLFormElement>, expenseId: string) {
    event.preventDefault();
    if (state.kind !== "ready" || !canUpdate) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const body = String(form.get("body") ?? "").trim();
    if (!body) {
      setCommentState({
        kind: "error",
        expenseId,
        message: locale === "tr" ? "Kaydetmeden önce bir yorum girin." : "Enter a comment before saving."
      });
      return;
    }
    setCommentState({ kind: "submitting", expenseId });
    try {
      const response = await apiRequest<{ comment: ExpenseCommentSummary }>(`/expenses/${encodeURIComponent(expenseId)}/comments`, {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken),
        body: JSON.stringify({ body })
      });
      formElement.reset();
      setState({
        ...state,
        commentsByExpenseId: {
          ...state.commentsByExpenseId,
          [expenseId]: [...(state.commentsByExpenseId[expenseId] ?? []), response.comment]
        }
      });
      setCommentState({ kind: "idle" });
    } catch (caught) {
      setCommentState({
        kind: "error",
        expenseId,
        message: caught instanceof Error ? caught.message : "EXPENSE_COMMENT_FAILED"
      });
    }
  }

  async function detectSubscriptions() {
    if (state.kind !== "ready" || !canUpdate || !state.selectedWorkspaceId) return;
    setSubscriptionState({ kind: "detecting" });
    try {
      const response = await apiRequest<{ subscriptions: SubscriptionSummary[]; detectedCount: number; analyzedExpenseCount: number }>(
        `/subscriptions/detect?workspaceId=${encodeURIComponent(state.selectedWorkspaceId)}`,
        {
          method: "POST",
          headers: authHeaders(state.session.tokens.accessToken)
        }
      );
      setState({ ...state, subscriptions: response.subscriptions });
      setSubscriptionState({ kind: "success", count: response.detectedCount });
    } catch (caught) {
      setSubscriptionState({ kind: "error", message: caught instanceof Error ? caught.message : "SUBSCRIPTION_DETECTION_FAILED" });
    }
  }

  async function createRecurring(expense: ExpenseSummary) {
    if (state.kind !== "ready" || !canUpdate) return;
    setRecurringState({ kind: "creating", expenseId: expense.id });
    const nextDueAt = new Date(expense.occurredAt);
    nextDueAt.setUTCMonth(nextDueAt.getUTCMonth() + 1);
    try {
      await apiRequest<{ recurringExpense: RecurringExpenseSummary }>(`/expenses/${encodeURIComponent(expense.id)}/recurring`, {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken),
        body: JSON.stringify({ cadence: "monthly", nextDueAt: nextDueAt.toISOString() })
      });
      setRecurringState({
        kind: "success",
        message: locale === "tr" ? "Aylık yinelenen gider kuralı kaydedildi." : "The monthly recurring expense rule was saved."
      });
      await load(state.selectedWorkspaceId);
    } catch (caught) {
      setRecurringState({ kind: "error", message: caught instanceof Error ? caught.message : "RECURRING_CREATE_FAILED" });
    }
  }

  async function generateRecurring(recurringExpenseId: string) {
    if (state.kind !== "ready" || !canCreate) return;
    setRecurringState({ kind: "generating", recurringExpenseId });
    try {
      await apiRequest<{ expense: ExpenseSummary; recurringExpense: RecurringExpenseSummary }>(
        `/recurring-expenses/${encodeURIComponent(recurringExpenseId)}/generate`,
        {
          method: "POST",
          headers: authHeaders(state.session.tokens.accessToken)
        }
      );
      setRecurringState({
        kind: "success",
        message: locale === "tr" ? "Sıradaki yinelenen gider oluşturuldu." : "The next recurring expense was created."
      });
      await load(state.selectedWorkspaceId);
    } catch (caught) {
      setRecurringState({ kind: "error", message: caught instanceof Error ? caught.message : "RECURRING_GENERATE_FAILED" });
    }
  }

  function toggleReimbursementExpense(expenseId: string) {
    setSelectedReimbursementExpenseIds((current) =>
      current.includes(expenseId) ? current.filter((candidate) => candidate !== expenseId) : [...current, expenseId]
    );
  }

  async function submitReimbursementClaim() {
    if (state.kind !== "ready" || !canCreate || selectedReimbursementExpenseIds.length === 0) return;
    setReimbursementState({ kind: "submitting" });
    try {
      await apiRequest<{ reimbursementClaim: ReimbursementClaimSummary; items: ReimbursementClaimItemSummary[]; expenses: ExpenseSummary[] }>(
        "/reimbursement-claims",
        {
          method: "POST",
          headers: authHeaders(state.session.tokens.accessToken),
          body: JSON.stringify({
            workspaceId: state.selectedWorkspaceId,
            expenseIds: selectedReimbursementExpenseIds
          })
        }
      );
      setSelectedReimbursementExpenseIds([]);
      setReimbursementState({
        kind: "success",
        message: locale === "tr" ? "Geri ödeme talebi gönderildi." : "The reimbursement claim was submitted."
      });
      await load(state.selectedWorkspaceId);
    } catch (caught) {
      setReimbursementState({ kind: "error", message: caught instanceof Error ? caught.message : "REIMBURSEMENT_SUBMIT_FAILED" });
    }
  }

  async function transitionReimbursementClaim(claimId: string, action: "approve" | "reject" | "paid") {
    if (state.kind !== "ready" || !canApprove) return;
    setReimbursementState({ kind: "transitioning", claimId, action });
    const endpoint = action === "approve" ? "approve" : action === "reject" ? "reject" : "mark-paid";
    try {
      await apiRequest<{ reimbursementClaim: ReimbursementClaimSummary; items: ReimbursementClaimItemSummary[]; expenses: ExpenseSummary[] }>(
        `/reimbursement-claims/${encodeURIComponent(claimId)}/${endpoint}`,
        {
          method: "POST",
          headers: authHeaders(state.session.tokens.accessToken),
          body: JSON.stringify({
            reason:
              locale === "tr"
                ? `Çalışma alanı gider defterinden ${action} olarak işaretlendi`
                : `Marked as ${action} from the workspace expense ledger`
          })
        }
      );
      setReimbursementState({
        kind: "success",
        message: action === "paid" ? "Talep ödendi olarak işaretlendi." : action === "approve" ? "Talep onaylandı." : "Talep reddedildi."
      });
      await load(state.selectedWorkspaceId);
    } catch (caught) {
      setReimbursementState({ kind: "error", message: caught instanceof Error ? caught.message : "REIMBURSEMENT_TRANSITION_FAILED" });
    }
  }

  function currentPolicyEvaluations(): Record<string, ExpensePolicyEvaluationSummary> {
    return policyState.kind === "success" || policyState.kind === "error" ? policyState.evaluations : {};
  }

  async function createExpensePolicy(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.kind !== "ready" || !canApprove) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const ruleType = String(form.get("ruleType") ?? "");
    const amountMinor = parseDecimalMinor(String(form.get("amount") ?? ""));
    const severity = String(form.get("severity") ?? "warning") as "warning" | "block";
    const config =
      ruleType === "RECEIPT_REQUIRED_ABOVE"
        ? { thresholdMinor: amountMinor }
        : ruleType === "MAX_AMOUNT_BY_CATEGORY"
          ? { maxAmountMinor: amountMinor }
          : ruleType === "PROJECT_REQUIRED"
            ? { onlyBusiness: true }
            : {};
    if ((ruleType === "RECEIPT_REQUIRED_ABOVE" || ruleType === "MAX_AMOUNT_BY_CATEGORY") && !amountMinor) {
      setPolicyState({
        kind: "error",
        message: locale === "tr" ? "Geçerli bir politika tutarı girin." : "Enter a valid policy amount.",
        evaluations: currentPolicyEvaluations()
      });
      return;
    }
    setPolicyState({ kind: "creating" });
    try {
      await apiRequest<{ expensePolicy: ExpensePolicySummary }>("/expense-policies", {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken),
        body: JSON.stringify({
          workspaceId: state.selectedWorkspaceId,
          name: form.get("name"),
          ruleType,
          severity,
          config
        })
      });
      formElement.reset();
      setPolicyState({
        kind: "success",
        message: locale === "tr" ? "Gider politikası kaydedildi." : "The expense policy was saved.",
        evaluations: currentPolicyEvaluations()
      });
      await load(state.selectedWorkspaceId);
    } catch (caught) {
      setPolicyState({ kind: "error", message: caught instanceof Error ? caught.message : "EXPENSE_POLICY_CREATE_FAILED", evaluations: currentPolicyEvaluations() });
    }
  }

  async function evaluateExpensePolicy(expenseId: string) {
    if (state.kind !== "ready" || !canRead) return;
    const existing = currentPolicyEvaluations();
    setPolicyState({ kind: "evaluating", expenseId });
    try {
      const response = await apiRequest<{ evaluation: ExpensePolicyEvaluationSummary }>(
        `/expenses/${encodeURIComponent(expenseId)}/policy-evaluation`,
        {
          headers: authHeaders(state.session.tokens.accessToken)
        }
      );
      setPolicyState({
        kind: "success",
        message: locale === "tr" ? "Politika değerlendirmesi güncellendi." : "The policy evaluation was updated.",
        evaluations: { ...existing, [expenseId]: response.evaluation }
      });
    } catch (caught) {
      setPolicyState({ kind: "error", message: caught instanceof Error ? caught.message : "EXPENSE_POLICY_EVALUATION_FAILED", evaluations: existing });
    }
  }

  async function archiveExpensePolicy(policyId: string) {
    if (state.kind !== "ready" || !canApprove) return;
    setPolicyState({ kind: "archiving", policyId });
    try {
      await apiRequest<{ expensePolicy: ExpensePolicySummary }>(`/expense-policies/${encodeURIComponent(policyId)}`, {
        method: "DELETE",
        headers: authHeaders(state.session.tokens.accessToken)
      });
      setPolicyState({
        kind: "success",
        message: locale === "tr" ? "Gider politikası arşivlendi." : "The expense policy was archived.",
        evaluations: currentPolicyEvaluations()
      });
      await load(state.selectedWorkspaceId);
    } catch (caught) {
      setPolicyState({ kind: "error", message: caught instanceof Error ? caught.message : "EXPENSE_POLICY_ARCHIVE_FAILED", evaluations: currentPolicyEvaluations() });
    }
  }

  if (state.kind === "loading") return <Shell locale={locale} title={locale === "tr" ? "Giderler" : "Expenses"} detail={locale === "tr" ? "Çalışma alanı giderleri yükleniyor." : "Loading workspace expenses."} />;

  if (state.kind === "anonymous") {
    return (
      <Shell locale={locale} title={locale === "tr" ? "Giderler" : "Expenses"} detail={locale === "tr" ? "Gider oluşturmak veya incelemek için önce giriş yapın." : "Sign in first to create or review expenses."}>
        <Link className="mt-6 inline-flex h-10 items-center bg-ink px-4 text-sm font-semibold text-paper" href="/login">
          {locale === "tr" ? "Giriş yap" : "Sign in"}
        </Link>
      </Shell>
    );
  }

  if (state.kind === "error") {
    return (
      <Shell locale={locale} title={locale === "tr" ? "Giderler" : "Expenses"} detail={state.message}>
        <SessionRecoveryActions locale={locale} />
      </Shell>
    );
  }

  return (
    <Shell locale={locale} title={locale === "tr" ? "Giderler" : "Expenses"} detail={`${state.principal.displayName} - ${state.expenses.length} ${locale === "tr" ? "kalıcı kayıt" : "persistent records"}`}>
      <div className="grid gap-8 xl:grid-cols-[380px_minmax(0,1fr)]">
        <section className="border-y border-black/10 py-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold">{locale === "tr" ? "Manuel gider girişi" : "Manual expense entry"}</h2>
              <p className="mt-1 text-sm text-steel">{locale === "tr" ? "Tutarlar API’ye kuruş gibi küçük para birimleriyle tam sayı olarak gönderilir." : "Amounts are sent to the API as integers in minor units such as cents."}</p>
            </div>
            <span className={canCreate ? "text-xs font-semibold uppercase tracking-normal text-signal" : "text-xs font-semibold uppercase tracking-normal text-black/35"}>
              {canCreate ? "Yetkili" : "Yetkisiz"}
            </span>
          </div>

          <form onSubmit={createExpense} className="mt-6 space-y-4">
            <Field label={locale === "tr" ? "Çalışma alanı" : "Workspace"}>
              <select
                className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal"
                value={state.selectedWorkspaceId}
                onChange={(event) => changeWorkspace(event.target.value)}
              >
                {state.workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={locale === "tr" ? "Başlık" : "Title"}>
              <input name="title" required maxLength={180} className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal" />
            </Field>
            <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
              <Field label="Tutar">
                <input name="amount" required inputMode="decimal" placeholder="1250,90" className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal" />
              </Field>
              <Field label="Para birimi">
                <select name="currency" defaultValue="TRY" className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal">
                  {currencies.map((currency) => (
                    <option key={currency} value={currency}>
                      {currency}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={locale === "tr" ? "KDV / Vergi" : "VAT / Tax"}>
                <input name="tax" inputMode="decimal" placeholder="0,00" className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal" />
              </Field>
              <Field label="Tarih">
                <input name="occurredAt" required type="datetime-local" className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal" />
              </Field>
            </div>
            <Field label={locale === "tr" ? "Açıklama" : "Description"}>
              <textarea name="description" maxLength={1000} rows={3} className="w-full resize-none border border-black/15 bg-white px-3 py-2 text-sm outline-none focus:border-signal" />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={locale === "tr" ? "Satıcı" : "Merchant"}>
                <input name="merchantName" maxLength={180} className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal" />
              </Field>
              <Field label={locale === "tr" ? "Ödeme yöntemi" : "Payment method"}>
                <input name="paymentMethodName" maxLength={120} className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal" />
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Proje">
                <input name="projectCode" maxLength={80} className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal" />
              </Field>
              <Field label="Masraf merkezi">
                <input name="costCenter" maxLength={80} className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal" />
              </Field>
            </div>
            <div className="grid gap-2 text-sm sm:grid-cols-2">
              <label className="flex items-center gap-2">
                <input name="businessExpense" type="checkbox" /> {locale === "tr" ? "İş gideri" : "Business expense"}
              </label>
              <label className="flex items-center gap-2">
                <input name="reimbursable" type="checkbox" /> {locale === "tr" ? "Geri ödenebilir" : "Reimbursable"}
              </label>
            </div>
            {submitState.kind === "error" ? <p className="text-sm font-medium text-red-700">{submitState.message}</p> : null}
            {submitState.kind === "success" ? <p className="text-sm font-medium text-signal">{locale === "tr" ? "Gider oluşturuldu." : "Expense created."}</p> : null}
            <button
              className="h-11 w-full bg-ink text-sm font-semibold text-paper hover:bg-signal disabled:cursor-not-allowed disabled:bg-black/25"
              disabled={!canCreate || !state.selectedWorkspaceId || submitState.kind === "submitting"}
            >
              {submitState.kind === "submitting" ? (locale === "tr" ? "Oluşturuluyor..." : "Creating...") : locale === "tr" ? "Gider oluştur" : "Create expense"}
            </button>
          </form>
          <ImportPanel
            canCreate={canCreate}
            importBatches={state.importBatches}
            state={importState}
            onSubmit={importExpenses}
            locale={locale}
          />
        </section>

        <section className="border-y border-black/10 py-6">
          <div className="flex flex-col gap-4 border-b border-black/10 pb-5 md:flex-row md:items-end md:justify-between">
            <div>
              <h2 className="text-xl font-semibold">{locale === "tr" ? "Çalışma alanı gider defteri" : "Workspace expense ledger"}</h2>
              <p className="mt-1 text-sm text-steel">{locale === "tr" ? "Manuel ve OCR’dan oluşturulan giderler aynı kalıcı veri modelinde tutulur." : "Manual and OCR-created expenses are stored in the same persistent data model."}</p>
            </div>
            <div className="flex flex-wrap gap-3">
              {totals.length === 0 ? <span className="text-sm text-steel">{locale === "tr" ? "Henüz harcama yok" : "No spend yet"}</span> : null}
              {totals.map((total) => (
                <span key={total.currency} className="text-sm font-semibold">
                  {formatMoney(total.amountMinor, total.currency)}
                </span>
              ))}
            </div>
          </div>
          <form className="grid gap-2 border-b border-black/10 py-4 sm:grid-cols-[minmax(0,1fr)_180px_auto]" onSubmit={applyExpenseFilters}>
            <label className="grid gap-1 text-xs font-semibold text-steel">
              {locale === "tr" ? "Gider ara" : "Search expenses"}
              <input
                value={expenseSearch}
                onChange={(event) => setExpenseSearch(event.target.value)}
                placeholder={locale === "tr" ? "Başlık veya satıcı" : "Title or merchant"}
                className="h-10 border border-black/15 bg-white px-3 text-sm text-ink outline-none focus:border-signal"
              />
            </label>
            <label className="grid gap-1 text-xs font-semibold text-steel">
              {locale === "tr" ? "Durum" : "Status"}
              <select
                value={expenseStatus}
                onChange={(event) => setExpenseStatus(event.target.value)}
                className="h-10 border border-black/15 bg-white px-3 text-sm text-ink outline-none focus:border-signal"
              >
                <option value="">{locale === "tr" ? "Tüm durumlar" : "All statuses"}</option>
                <option value="DRAFT">{locale === "tr" ? "Taslak" : "Draft"}</option>
                <option value="EXTRACTED">{locale === "tr" ? "OCR'dan çıkarıldı" : "Extracted"}</option>
                <option value="NEEDS_REVIEW">{locale === "tr" ? "İnceleme gerekiyor" : "Needs review"}</option>
                <option value="APPROVED">{locale === "tr" ? "Onaylandı" : "Approved"}</option>
                <option value="REJECTED">{locale === "tr" ? "Reddedildi" : "Rejected"}</option>
                <option value="REIMBURSED">{locale === "tr" ? "Geri ödendi" : "Reimbursed"}</option>
              </select>
            </label>
            <button className="h-10 self-end bg-ink px-4 text-sm font-semibold text-paper hover:bg-signal">
              {locale === "tr" ? "Uygula" : "Apply"}
            </button>
          </form>
          <SubscriptionPanel
            subscriptions={state.subscriptions}
            canUpdate={canUpdate}
            state={subscriptionState}
            onDetect={detectSubscriptions}
            locale={locale}
          />
          <RecurringPanel
            recurringExpenses={state.recurringExpenses}
            canCreate={canCreate}
            state={recurringState}
            onGenerate={generateRecurring}
            locale={locale}
          />
          <ReimbursementPanel
            expenses={state.expenses}
            claims={state.reimbursementClaims}
            selectedExpenseIds={selectedReimbursementExpenseIds}
            canCreate={canCreate}
            canApprove={canApprove}
            state={reimbursementState}
            onToggleExpense={toggleReimbursementExpense}
            onSubmit={submitReimbursementClaim}
            onTransition={transitionReimbursementClaim}
            locale={locale}
          />
          <PolicyPanel
            policies={state.expensePolicies}
            canApprove={canApprove}
            state={policyState}
            onCreate={createExpensePolicy}
            onArchive={archiveExpensePolicy}
            locale={locale}
          />
          {analysisState.kind === "error" ? <p className="border-b border-black/10 py-3 text-sm font-medium text-red-700">{analysisState.message}</p> : null}

          {!canRead ? (
            <div className="py-12 text-sm text-steel">{locale === "tr" ? "Bu hesap giderleri görüntüleme yetkisine sahip değil." : "This account cannot view expenses."}</div>
          ) : state.expenses.length === 0 ? (
            <div className="py-12 text-sm text-steel">{locale === "tr" ? "Bu çalışma alanında henüz gider oluşturulmamış." : "No expenses have been created in this workspace yet."}</div>
          ) : (
            <div className="divide-y divide-black/10">
              {state.expenses.map((expense) => {
                const analysis =
                  analysisState.kind === "ready" || analysisState.kind === "error"
                    ? analysisState.byExpenseId[expense.id]
                    : undefined;
                const policyEvaluation =
                  policyState.kind === "success" || policyState.kind === "error" ? policyState.evaluations[expense.id] : undefined;
                const isAnalyzing = analysisState.kind === "loading" && analysisState.expenseId === expense.id;
                const isEvaluatingPolicy = policyState.kind === "evaluating" && policyState.expenseId === expense.id;
                return (
                  <div key={expense.id} role="region" aria-label={`Gider ${expense.title}`} className="py-4">
                    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_150px_120px_120px_220px]">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold">{expense.title}</div>
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-steel">
                          <span>{new Date(expense.occurredAt).toLocaleDateString(dateLocale)}</span>
                          {expense.merchantName ? <span>{expense.merchantName}</span> : null}
                          {expense.categoryId ? <span>{locale === "tr" ? "Kategori atandı" : "Category assigned"}</span> : null}
                          {expense.projectCode ? <span>{locale === "tr" ? "Proje" : "Project"} {expense.projectCode}</span> : null}
                          {expense.costCenter ? <span>{locale === "tr" ? "Masraf" : "Cost center"} {expense.costCenter}</span> : null}
                          {expense.documentId ? <span>{locale === "tr" ? "OCR belgesi" : "OCR document"}</span> : <span>{locale === "tr" ? "Manuel" : "Manual"}</span>}
                          {(state.commentsByExpenseId[expense.id] ?? []).length ? (
                            <span>{(state.commentsByExpenseId[expense.id] ?? []).length} yorum</span>
                          ) : null}
                        </div>
                      </div>
                      <div className="text-sm font-semibold">{formatMoney(BigInt(expense.amountMinor), expense.currency)}</div>
                      <StatusBadge status={expense.status} locale={locale} />
                      <div className="text-sm text-steel">
                          {expense.businessExpense ? (locale === "tr" ? "İş gideri" : "Business expense") : locale === "tr" ? "Kişisel" : "Personal"}
                        <br />
                        {expense.reimbursable ? (locale === "tr" ? "Geri ödenebilir" : "Reimbursable") : locale === "tr" ? "Geri ödenmez" : "Not reimbursable"}
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          className="h-9 border border-black/15 px-3 text-sm font-semibold hover:border-signal"
                          onClick={() => void toggleExpenseDetail(expense.id)}
                        >
                          {detailLoadingId === expense.id
                            ? locale === "tr" ? "Yükleniyor" : "Loading"
                            : detailId === expense.id
                              ? locale === "tr" ? "Ayrıntıyı kapat" : "Close details"
                              : locale === "tr" ? "Ayrıntılar" : "Details"}
                        </button>
                        <button
                          className="h-9 border border-black/15 px-3 text-sm font-semibold hover:border-signal disabled:cursor-not-allowed disabled:text-black/35"
                          disabled={isAnalyzing || !canAnalyze}
                          onClick={() => void analyzeExpense(expense.id)}
                        >
                          {isAnalyzing ? (locale === "tr" ? "Analiz ediliyor" : "Analyzing") : canAnalyze ? (locale === "tr" ? "Analiz et" : "Analyze") : locale === "tr" ? "Yetkisiz" : "Unauthorized"}
                        </button>
                        <button
                          className="h-9 border border-black/15 px-3 text-sm font-semibold hover:border-signal disabled:cursor-not-allowed disabled:text-black/35"
                          disabled={isEvaluatingPolicy || !canRead}
                          onClick={() => void evaluateExpensePolicy(expense.id)}
                        >
                          {isEvaluatingPolicy ? (locale === "tr" ? "Kontrol ediliyor" : "Checking") : locale === "tr" ? "Politika" : "Policy"}
                        </button>
                        {canUpdate ? (
                          <button
                            className="h-9 border border-black/15 px-3 text-sm font-semibold hover:border-signal"
                            onClick={() => setEditingId(editingId === expense.id ? null : expense.id)}
                          >
                            {editingId === expense.id ? (locale === "tr" ? "Kapat" : "Close") : locale === "tr" ? "Düzenle" : "Edit"}
                          </button>
                        ) : null}
                        {canUpdate ? (
                          <button
                            className="h-9 border border-black/15 px-3 text-sm font-semibold hover:border-signal disabled:text-black/35"
                            disabled={recurringState.kind === "creating" && recurringState.expenseId === expense.id}
                            onClick={() => void createRecurring(expense)}
                          >
                            {recurringState.kind === "creating" && recurringState.expenseId === expense.id ? (locale === "tr" ? "Kaydediliyor" : "Saving") : locale === "tr" ? "Yinelenen" : "Recurring"}
                          </button>
                        ) : null}
                        {canUpdate ? (
                          <button
                            className="h-9 border border-black/15 px-3 text-sm font-semibold hover:border-signal disabled:text-black/35"
                            disabled={splitState.kind === "submitting" && splitState.expenseId === expense.id}
                            onClick={() => void splitExpense(expense)}
                          >
                            {splitState.kind === "submitting" && splitState.expenseId === expense.id ? (locale === "tr" ? "Bölünüyor" : "Splitting") : locale === "tr" ? "Böl" : "Split"}
                          </button>
                        ) : null}
                        {canUpdate ? (
                          <button
                            className="h-9 border border-black/15 px-3 text-sm font-semibold text-red-700 hover:border-red-700 disabled:text-black/35"
                            disabled={archiveState.kind === "submitting" && archiveState.expenseId === expense.id}
                            onClick={() => void archiveExpense(expense.id)}
                          >
                            {archiveState.kind === "submitting" && archiveState.expenseId === expense.id ? (locale === "tr" ? "Arşivleniyor" : "Archiving") : locale === "tr" ? "Arşivle" : "Archive"}
                          </button>
                        ) : null}
                      </div>
                    </div>
                    {archiveState.kind === "error" && archiveState.expenseId === expense.id ? (
                      <p className="mt-3 text-sm font-medium text-red-700">{archiveState.message}</p>
                    ) : null}
                    {splitState.kind === "error" && splitState.expenseId === expense.id ? (
                      <p className="mt-3 text-sm font-medium text-red-700">{splitState.message}</p>
                    ) : null}
                    {editingId === expense.id ? (
                      <form className="mt-4 grid gap-3 border-l-2 border-black/15 pl-4 md:grid-cols-2 xl:grid-cols-4" onSubmit={(event) => void updateExpense(event, expense.id)}>
                        <Field label={locale === "tr" ? "Başlık" : "Title"}>
                          <input name="title" required maxLength={180} defaultValue={expense.title} className="h-10 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal" />
                        </Field>
                        <Field label="Tutar">
                          <input name="amount" required inputMode="decimal" defaultValue={minorToDecimal(expense.amountMinor)} className="h-10 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal" />
                        </Field>
                        <Field label={locale === "tr" ? "KDV / Vergi" : "VAT / Tax"}>
                          <input name="tax" inputMode="decimal" defaultValue={minorToDecimal(expense.taxMinor ?? "0")} className="h-10 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal" />
                        </Field>
                        <Field label="Tarih">
                          <input name="occurredAt" required type="datetime-local" defaultValue={toDateTimeLocal(expense.occurredAt)} className="h-10 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal" />
                        </Field>
                        <Field label={locale === "tr" ? "Satıcı" : "Merchant"}>
                          <input name="merchantName" maxLength={180} defaultValue={expense.merchantName ?? ""} className="h-10 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal" />
                        </Field>
                        <Field label={locale === "tr" ? "Ödeme" : "Payment"}>
                          <input name="paymentMethodName" maxLength={120} defaultValue={expense.paymentMethodName ?? ""} className="h-10 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal" />
                        </Field>
                        <Field label="Proje">
                          <input name="projectCode" maxLength={80} defaultValue={expense.projectCode ?? ""} className="h-10 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal" />
                        </Field>
                        <Field label="Masraf merkezi">
                          <input name="costCenter" maxLength={80} defaultValue={expense.costCenter ?? ""} className="h-10 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal" />
                        </Field>
                        <label className="flex items-center gap-2 text-sm">
                          <input name="businessExpense" type="checkbox" defaultChecked={expense.businessExpense} /> {locale === "tr" ? "İş gideri" : "Business expense"}
                        </label>
                        <label className="flex items-center gap-2 text-sm">
                          <input name="reimbursable" type="checkbox" defaultChecked={expense.reimbursable} /> {locale === "tr" ? "Geri ödenebilir" : "Reimbursable"}
                        </label>
                        <Field label={locale === "tr" ? "Açıklama" : "Description"}>
                          <textarea name="description" maxLength={1000} defaultValue={expense.description ?? ""} rows={2} className="w-full resize-none border border-black/15 bg-white px-3 py-2 text-sm outline-none focus:border-signal" />
                        </Field>
                        <div className="flex items-end">
                          <button
                            className="h-10 w-full bg-ink px-4 text-sm font-semibold text-paper hover:bg-signal disabled:bg-black/30"
                            disabled={editState.kind === "submitting" && editState.expenseId === expense.id}
                          >
                            {editState.kind === "submitting" && editState.expenseId === expense.id ? "Kaydediliyor..." : "Kaydet"}
                          </button>
                        </div>
                        {editState.kind === "error" && editState.expenseId === expense.id ? (
                          <p className="text-sm font-medium text-red-700 md:col-span-2 xl:col-span-4">{editState.message}</p>
                        ) : null}
                      </form>
                    ) : null}
                    {analysis ? <AnalysisPanel analysis={analysis} locale={locale} /> : null}
                    {policyEvaluation ? <PolicyEvaluationPanel evaluation={policyEvaluation} /> : null}
                    {detailId === expense.id ? (
                      <>
                        <ExpenseAttachmentsPanel
                          documents={state.documents}
                          attachmentMetadata={state.attachmentsByExpenseId[expense.id] ?? []}
                          expense={expense}
                          canUpdate={canUpdate}
                          state={attachmentState}
                          onAttach={attachDocument}
                          onDetach={detachDocument}
                          locale={locale}
                        />
                        <CommentsPanel
                          comments={state.commentsByExpenseId[expense.id] ?? []}
                          expenseId={expense.id}
                          canUpdate={canUpdate}
                          commentState={commentState}
                          onSubmit={addComment}
                          locale={locale}
                        />
                      </>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
          {canRead && state.expenses.length ? (
            <div className="flex items-center justify-between border-t border-black/10 pt-4">
              <button
                type="button"
                className="h-9 border border-black/15 px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40"
                disabled={cursorHistory.length === 0}
                onClick={showPreviousPage}
              >
                {locale === "tr" ? "Önceki" : "Previous"}
              </button>
              <span className="text-xs text-steel">
                {locale === "tr" ? `Sayfa ${cursorHistory.length + 1}` : `Page ${cursorHistory.length + 1}`}
              </span>
              <button
                type="button"
                className="h-9 border border-black/15 px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40"
                disabled={!state.nextCursor}
                onClick={showNextPage}
              >
                {locale === "tr" ? "Sonraki" : "Next"}
              </button>
            </div>
          ) : null}
        </section>
      </div>
    </Shell>
  );
}

function PolicyPanel({
  policies,
  canApprove,
  state,
  onCreate,
  onArchive,
  locale
}: {
  policies: ExpensePolicySummary[];
  canApprove: boolean;
  state: PolicyState;
  onCreate: (event: React.FormEvent<HTMLFormElement>) => void;
  onArchive: (policyId: string) => void;
  locale: "tr" | "en";
}) {
  return (
    <div className="border-b border-black/10 py-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">{locale === "tr" ? "Gider politikaları" : "Expense policies"}</h3>
        <p className="text-xs text-steel">{locale === "tr" ? "Kurallar kalıcı olarak saklanır ve onaydan önce kontrol edilir." : "Rules are stored persistently and checked before approval."}</p>
      </div>
      {state.kind === "success" ? <p className="mt-2 text-sm font-medium text-signal">{state.message}</p> : null}
      {state.kind === "error" ? <p className="mt-2 text-sm font-medium text-red-700">{state.message}</p> : null}
      <form className="mt-3 grid gap-2 lg:grid-cols-[minmax(0,1fr)_180px_120px_120px_120px]" onSubmit={onCreate}>
        <input
          name="name"
          required
          maxLength={160}
          placeholder={locale === "tr" ? "Limit üstünde fiş zorunlu" : "Receipt required above limit"}
          className="h-10 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal"
        />
        <select name="ruleType" defaultValue="RECEIPT_REQUIRED_ABOVE" className="h-10 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal">
          <option value="RECEIPT_REQUIRED_ABOVE">{locale === "tr" ? "Fiş limiti" : "Receipt limit"}</option>
          <option value="MAX_AMOUNT_BY_CATEGORY">{locale === "tr" ? "Maksimum tutar" : "Maximum amount"}</option>
          <option value="PROJECT_REQUIRED">{locale === "tr" ? "Proje zorunlu" : "Project required"}</option>
          <option value="DUPLICATE_RECEIPT_REJECTION">{locale === "tr" ? "Tekrarlı fiş" : "Duplicate receipt"}</option>
        </select>
        <input
          name="amount"
          inputMode="decimal"
          placeholder={locale === "tr" ? "100,00" : "100.00"}
          className="h-10 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal"
        />
        <select name="severity" defaultValue="warning" className="h-10 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal">
          <option value="warning">{locale === "tr" ? "Uyarı" : "Warning"}</option>
          <option value="block">{locale === "tr" ? "Engelle" : "Block"}</option>
        </select>
        <button
          className="h-10 bg-ink px-3 text-sm font-semibold text-paper hover:bg-signal disabled:cursor-not-allowed disabled:bg-black/30"
          disabled={!canApprove || state.kind === "creating"}
        >
          {state.kind === "creating" ? (locale === "tr" ? "Kaydediliyor" : "Saving") : locale === "tr" ? "Kuralı kaydet" : "Save rule"}
        </button>
      </form>
      {policies.length ? (
        <div className="mt-3 divide-y divide-black/10 text-sm">
          {policies.map((policy) => (
            <div key={policy.id} className="flex flex-col gap-2 py-2 md:flex-row md:items-center md:justify-between">
              <div>
                <span className="font-semibold">{policy.name}</span>
                <span className={policy.severity === "block" ? "ml-2 text-xs font-semibold text-red-700" : "ml-2 text-xs font-semibold text-amber-700"}>
                {formatPolicySeverity(policy.severity, locale)}
              </span>
                <div className="mt-1 text-xs text-steel">{formatPolicyRule(policy.ruleType, locale)}</div>
              </div>
              <button
                className="h-8 border border-black/15 px-3 text-xs font-semibold hover:border-red-700 disabled:text-black/35"
                disabled={!canApprove || (state.kind === "archiving" && state.policyId === policy.id)}
                onClick={() => onArchive(policy.id)}
              >
                {state.kind === "archiving" && state.policyId === policy.id ? (locale === "tr" ? "Arşivleniyor" : "Archiving") : locale === "tr" ? "Arşivle" : "Archive"}
              </button>
            </div>
          ))}
        </div>
      ) : (
          <p className="mt-3 text-sm text-steel">{locale === "tr" ? "Bu çalışma alanında aktif gider politikası yok." : "There is no active expense policy in this workspace."}</p>
      )}
    </div>
  );
}

function PolicyEvaluationPanel({ evaluation }: { evaluation: ExpensePolicyEvaluationSummary }) {
  return (
    <div className="mt-4 border-l-2 border-amber-600 pl-4 text-sm">
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <span className="font-semibold">{evaluation.violations.length} politika bulgusu</span>
        <span className="text-steel">{evaluation.checkedPolicyCount} kural kontrol edildi</span>
      </div>
      {evaluation.violations.length ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {evaluation.violations.map((violation) => (
            <span key={`${violation.policyId}:${violation.code}`} className={violation.severity === "block" ? "text-xs font-semibold text-red-700" : "text-xs font-semibold text-amber-700"}>
              {violation.code.replaceAll("_", " ")}
            </span>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-xs text-steel">Aktif politika ihlali yok.</p>
      )}
    </div>
  );
}

function ReimbursementPanel({
  expenses,
  claims,
  selectedExpenseIds,
  canCreate,
  canApprove,
  state,
  onToggleExpense,
  onSubmit,
  onTransition,
  locale
}: {
  expenses: ExpenseSummary[];
  claims: ReimbursementClaimEntry[];
  selectedExpenseIds: string[];
  canCreate: boolean;
  canApprove: boolean;
  state: ReimbursementState;
  onToggleExpense: (expenseId: string) => void;
  onSubmit: () => void;
  onTransition: (claimId: string, action: "approve" | "reject" | "paid") => void;
  locale: "tr" | "en";
}) {
  const dateLocale = locale === "tr" ? "tr-TR" : "en-US";
  const claimedExpenseIds = new Set(
    claims.filter(({ claim }) => claim.status !== "REJECTED").flatMap(({ items }) => items.map((item) => item.expenseId))
  );
  const candidates = expenses.filter(
    (expense) =>
      expense.reimbursable &&
      BigInt(expense.amountMinor) > 0n &&
      !["REJECTED", "REIMBURSED", "ARCHIVED"].includes(expense.status) &&
      !claimedExpenseIds.has(expense.id)
  );
  const selectedTotal = candidates
    .filter((expense) => selectedExpenseIds.includes(expense.id))
    .reduce((total, expense) => total + BigInt(expense.amountMinor), 0n);
  const selectedCurrency = candidates.find((expense) => selectedExpenseIds.includes(expense.id))?.currency ?? "TRY";
  return (
    <div className="border-b border-black/10 py-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <h3 className="text-sm font-semibold">{locale === "tr" ? "Geri ödemeler" : "Reimbursements"}</h3>
          <p className="mt-1 text-xs text-steel">{locale === "tr" ? "Geri ödenebilir giderleri talebe ekleyin; ardından onaylayın veya ödendi olarak işaretleyin." : "Add reimbursable expenses to a claim, then approve it or mark it as paid."}</p>
        </div>
        <button
          className="h-9 border border-black/15 px-3 text-sm font-semibold hover:border-signal disabled:cursor-not-allowed disabled:text-black/35"
          disabled={!canCreate || selectedExpenseIds.length === 0 || state.kind === "submitting"}
          onClick={() => void onSubmit()}
        >
          {state.kind === "submitting" ? (locale === "tr" ? "Gönderiliyor" : "Submitting") : selectedExpenseIds.length ? `${selectedExpenseIds.length} ${locale === "tr" ? "talep gönder" : "send claims"}` : locale === "tr" ? "Talep gönder" : "Send claim"}
        </button>
      </div>
      {selectedExpenseIds.length ? (
        <p className="mt-2 text-sm font-medium text-signal">{formatMoney(selectedTotal, selectedCurrency)} {locale === "tr" ? "seçildi." : "selected."}</p>
      ) : null}
      {state.kind === "success" ? <p className="mt-2 text-sm font-medium text-signal">{state.message}</p> : null}
      {state.kind === "error" ? <p className="mt-2 text-sm font-medium text-red-700">{state.message}</p> : null}

      {candidates.length ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {candidates.slice(0, 6).map((expense) => (
            <label key={expense.id} className="flex min-h-16 items-start gap-3 border border-black/10 bg-white px-3 py-2 text-sm">
              <input
                className="mt-1"
                type="checkbox"
                checked={selectedExpenseIds.includes(expense.id)}
                onChange={() => onToggleExpense(expense.id)}
              />
              <span className="min-w-0">
                <span className="block truncate font-semibold">{expense.title}</span>
                <span className="mt-1 block text-xs text-steel">{formatMoney(BigInt(expense.amountMinor), expense.currency)}</span>
              </span>
            </label>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-sm text-steel">{locale === "tr" ? "Talebe eklenmemiş geri ödenebilir gider yok." : "There are no reimbursable expenses not yet added to a claim."}</p>
      )}

      {claims.length ? (
        <div className="mt-4 divide-y divide-black/10 text-sm">
          {claims.slice(0, 5).map(({ claim, items }) => {
            const isBusy = state.kind === "transitioning" && state.claimId === claim.id;
            return (
              <div key={claim.id} className="py-3">
                <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <div>
                    <div className="font-semibold">
                      {formatMoney(BigInt(claim.totalMinor), claim.currency)} - {formatReimbursementStatus(claim.status, locale)}
                    </div>
                    <div className="mt-1 text-xs text-steel">
                      {items.length} {locale === "tr" ? "gider" : "expenses"} - {claim.submittedAt ? `${new Date(claim.submittedAt).toLocaleDateString(dateLocale)} ${locale === "tr" ? "tarihinde gönderildi" : "submitted on"}` : locale === "tr" ? "henüz gönderilmedi" : "not submitted yet"}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      className="h-8 border border-black/15 px-3 text-xs font-semibold hover:border-signal disabled:text-black/35"
                      disabled={!canApprove || claim.status !== "NEEDS_REVIEW" || isBusy}
                      onClick={() => void onTransition(claim.id, "approve")}
                    >
                      Onayla
                    </button>
                    <button
                      className="h-8 border border-black/15 px-3 text-xs font-semibold hover:border-red-700 disabled:text-black/35"
                      disabled={!canApprove || !["NEEDS_REVIEW", "APPROVED"].includes(claim.status) || isBusy}
                      onClick={() => void onTransition(claim.id, "reject")}
                    >
                      Reddet
                    </button>
                    <button
                      className="h-8 bg-ink px-3 text-xs font-semibold text-paper hover:bg-signal disabled:bg-black/30"
                      disabled={!canApprove || claim.status !== "APPROVED" || isBusy}
                      onClick={() => void onTransition(claim.id, "paid")}
                    >
                      {isBusy && state.action === "paid" ? (locale === "tr" ? "Ödeme işleniyor" : "Processing payment") : locale === "tr" ? "Ödendi işaretle" : "Mark paid"}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function ImportPanel({
  canCreate,
  importBatches,
  state,
  onSubmit,
  locale
}: {
  canCreate: boolean;
  importBatches: ImportBatchSummary[];
  state: ImportState;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  locale: "tr" | "en";
}) {
  const dateLocale = locale === "tr" ? "tr-TR" : "en-US";
  return (
    <div className="mt-6 border-t border-black/10 pt-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold">{locale === "tr" ? "CSV içe aktarma" : "CSV import"}</h3>
          <p className="mt-1 text-xs text-steel">{locale === "tr" ? "Satırlar doğrulanır ve içe aktarma paketi kayıtları üzerinden kalıcı hale getirilir." : "Rows are validated and persisted through import batch records."}</p>
        </div>
        <span className="text-xs font-semibold uppercase tracking-normal text-steel">{importBatches.length} batch</span>
      </div>
      <form onSubmit={onSubmit} className="mt-4 space-y-3">
        <Field label={locale === "tr" ? "CSV kaynağı" : "CSV source"}>
          <input
            name="source"
            maxLength={160}
            placeholder="banka-cikti.csv"
            className="h-10 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal"
          />
        </Field>
        <Field label={locale === "tr" ? "CSV içeriği" : "CSV content"}>
          <textarea
            name="csvText"
            rows={6}
            spellCheck={false}
            placeholder={'title,merchant,amount,occurred_at,currency\nMetro ride,Istanbul Metro,"42,50",2026-05-17T08:00:00.000Z,TRY'}
            className="w-full resize-y border border-black/15 bg-white px-3 py-2 font-mono text-xs outline-none focus:border-signal"
          />
        </Field>
        {state.kind === "success" ? (
          <p className="text-sm font-medium text-signal">
            {state.importedRows} {locale === "tr" ? "içe aktarıldı" : "imported"}, {state.failedRows} {locale === "tr" ? "başarısız" : "failed"}.
          </p>
        ) : null}
        {state.kind === "error" ? <p className="text-sm font-medium text-red-700">{state.message}</p> : null}
        <button
          className="h-10 w-full bg-ink text-sm font-semibold text-paper hover:bg-signal disabled:cursor-not-allowed disabled:bg-black/25"
          disabled={!canCreate || state.kind === "submitting"}
        >
          {state.kind === "submitting" ? (locale === "tr" ? "İçe aktarılıyor..." : "Importing...") : locale === "tr" ? "CSV içe aktar" : "Import CSV"}
        </button>
      </form>
      {importBatches.length ? (
        <div className="mt-4 divide-y divide-black/10 text-sm">
          {importBatches.slice(0, 4).map((batch) => {
            const stats = importStats(batch);
            return (
              <div key={batch.id} className="py-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate font-semibold">{batch.source}</span>
                  <span className={batch.status === "FAILED" ? "text-xs font-semibold text-red-700" : "text-xs font-semibold text-signal"}>
                    {formatImportStatus(batch.status, locale)}
                  </span>
                </div>
                <div className="mt-1 text-xs text-steel">
                  {stats.importedRows} {locale === "tr" ? "içe aktarıldı" : "imported"} - {stats.failedRows} {locale === "tr" ? "başarısız" : "failed"} - {new Date(batch.createdAt).toLocaleString(dateLocale)}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="mt-4 text-sm text-steel">{locale === "tr" ? "Henüz CSV içe aktarma paketi kaydı yok." : "No CSV import batch has been saved yet."}</p>
      )}
    </div>
  );
}

function SubscriptionPanel({
  subscriptions,
  canUpdate,
  state,
  onDetect,
  locale
}: {
  subscriptions: SubscriptionSummary[];
  canUpdate: boolean;
  state: SubscriptionState;
  onDetect: () => void;
  locale: "tr" | "en";
}) {
  return (
    <div className="border-b border-black/10 py-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h3 className="text-sm font-semibold">Abonelikler</h3>
          <p className="mt-1 text-xs text-steel">{locale === "tr" ? "Tekrarlayan kalıcı giderlerden yerel olarak tespit edilir." : "Recurring persistent expenses are detected locally."}</p>
        </div>
        <button
          className="h-9 border border-black/15 px-3 text-sm font-semibold hover:border-signal disabled:cursor-not-allowed disabled:text-black/35"
          disabled={!canUpdate || state.kind === "detecting"}
          onClick={() => onDetect()}
        >
          {state.kind === "detecting" ? "Tespit ediliyor" : "Abonelikleri tespit et"}
        </button>
      </div>
      {state.kind === "success" ? <p className="mt-2 text-sm font-medium text-signal">{state.count} {locale === "tr" ? "abonelik adayı kaydedildi." : "subscription candidates saved."}</p> : null}
      {state.kind === "error" ? <p className="mt-2 text-sm font-medium text-red-700">{state.message}</p> : null}
      {subscriptions.length ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {subscriptions.map((subscription) => (
            <div key={subscription.id} className="border border-black/10 bg-white px-3 py-2 text-sm">
              <div className="font-semibold">{subscription.name}</div>
              <div className="mt-1 text-xs text-steel">
                {formatCadence(subscription.cadence, locale)} - {formatMoney(BigInt(subscription.amountMinor), subscription.currency)}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-sm text-steel">{locale === "tr" ? "Bu çalışma alanı için abonelik adayı kaydedilmemiş." : "No subscription candidate has been saved for this workspace."}</p>
      )}
    </div>
  );
}

function RecurringPanel({
  recurringExpenses,
  canCreate,
  state,
  onGenerate,
  locale
}: {
  recurringExpenses: RecurringExpenseSummary[];
  canCreate: boolean;
  state: RecurringState;
  onGenerate: (recurringExpenseId: string) => void;
  locale: "tr" | "en";
}) {
  const dateLocale = locale === "tr" ? "tr-TR" : "en-US";
  return (
    <div className="border-b border-black/10 py-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">Yinelenen giderler</h3>
        <p className="text-xs text-steel">{locale === "tr" ? "Aylık kurallar gerçek taslak gider oluşturur ve sıradaki vade tarihini ilerletir." : "Monthly rules create a real draft expense and advance the next due date."}</p>
      </div>
      {state.kind === "success" ? <p className="mt-2 text-sm font-medium text-signal">{state.message}</p> : null}
      {state.kind === "error" ? <p className="mt-2 text-sm font-medium text-red-700">{state.message}</p> : null}
      {recurringExpenses.length ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {recurringExpenses.map((rule) => (
            <div key={rule.id} className="border border-black/10 bg-white px-3 py-2 text-sm">
              <div className="font-semibold">{rule.merchantName ?? "Yinelenen gider"}</div>
              <div className="mt-1 text-xs text-steel">
                {formatCadence(rule.cadence, locale)} - {formatMoney(BigInt(rule.amountMinor), rule.currency)} - {locale === "tr" ? "sıradaki" : "next due"} {new Date(rule.nextDueAt).toLocaleDateString(dateLocale)}
              </div>
              <button
                className="mt-3 h-9 border border-black/15 px-3 text-sm font-semibold hover:border-signal disabled:text-black/35"
                disabled={!canCreate || (state.kind === "generating" && state.recurringExpenseId === rule.id)}
                onClick={() => onGenerate(rule.id)}
              >
                {state.kind === "generating" && state.recurringExpenseId === rule.id ? (locale === "tr" ? "Oluşturuluyor" : "Creating") : locale === "tr" ? "Sıradakini oluştur" : "Generate next"}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-sm text-steel">{locale === "tr" ? "Bu çalışma alanı için yinelenen gider kuralı yok." : "There is no recurring expense rule for this workspace."}</p>
      )}
    </div>
  );
}

function ExpenseAttachmentsPanel({
  documents,
  attachmentMetadata,
  expense,
  canUpdate,
  state,
  onAttach,
  onDetach,
  locale
}: {
  documents: DocumentSummary[];
  attachmentMetadata: ExpenseAttachmentSummary[];
  expense: ExpenseSummary;
  canUpdate: boolean;
  state: AttachmentState;
  onAttach: (event: React.FormEvent<HTMLFormElement>, expenseId: string) => void;
  onDetach: (expenseId: string, documentFileId: string) => void;
  locale: "tr" | "en";
}) {
  const dateLocale = locale === "tr" ? "tr-TR" : "en-US";
  const documentsById = new Map(documents.map((document) => [document.id, document]));
  const attachedRows =
    attachmentMetadata.length > 0
      ? attachmentMetadata
      : expense.documentId
        ? [
            {
              id: "primary",
              tenantId: expense.tenantId,
              expenseId: expense.id,
              documentFileId: expense.documentId,
              label: locale === "tr" ? "Birincil fiş" : "Primary receipt",
              note: null,
              attachedById: expense.createdById,
              attachedAt: expense.createdAt,
              detachedAt: null
            }
          ]
        : [];
  const firstAttachedDocument = attachedRows.length === 1 ? documentsById.get(attachedRows[0]!.documentFileId) : null;
  const isSubmitting = state.kind === "submitting" && state.expenseId === expense.id;
  return (
    <div className="mt-4 border-l-2 border-black/10 pl-4 text-sm">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h3 className="font-semibold">Ek belgeler</h3>
          <p className="mt-1 text-xs text-steel">
            {firstAttachedDocument ? `${firstAttachedDocument.originalName} ${locale === "tr" ? "eklendi" : "attached"}` : attachedRows.length ? `${attachedRows.length} ${locale === "tr" ? "ek belge kaydı" : "attached document record(s)"}` : locale === "tr" ? "Eklenmiş belge yok." : "No attached document."}
          </p>
        </div>
      </div>
      {attachedRows.length ? (
        <div className="mt-3 divide-y divide-black/10 bg-white">
          {attachedRows.map((attachment) => {
            const document = documentsById.get(attachment.documentFileId);
            const isPrimary = expense.documentId === attachment.documentFileId;
            return (
              <div key={attachment.id} className="grid gap-2 px-3 py-3 md:grid-cols-[minmax(0,1fr)_96px]">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-semibold">{document?.originalName ?? (locale === "tr" ? "Belge kullanılamıyor" : "Document unavailable")}</span>
                    {isPrimary ? <span className="text-xs font-semibold uppercase tracking-normal text-signal">Birincil</span> : null}
                  </div>
                  <p className="mt-1 text-xs text-steel">
                    {attachment.label ?? (locale === "tr" ? "Destekleyici kanıt" : "Supporting evidence")} - {new Date(attachment.attachedAt).toLocaleString(dateLocale)}
                  </p>
                  {attachment.note ? <p className="mt-1 text-xs text-steel">{attachment.note}</p> : null}
                </div>
                {canUpdate ? (
                  <button
                    className="h-9 border border-black/15 px-3 text-sm font-semibold hover:border-red-700 disabled:text-black/35"
                    disabled={isSubmitting}
                    onClick={() => onDetach(expense.id, attachment.documentFileId)}
                  >
                    {isSubmitting ? (locale === "tr" ? "Güncelleniyor" : "Updating") : locale === "tr" ? "Çıkar" : "Detach"}
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {canUpdate ? (
        <form className="mt-3 grid gap-2 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,1fr)_96px_110px]" onSubmit={(event) => onAttach(event, expense.id)}>
          <select
            name="documentFileId"
            defaultValue=""
            className="h-10 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal"
          >
            <option value="" disabled>
              {locale === "tr" ? "Belge seçin" : "Select document"}
            </option>
            {documents.map((document) => (
              <option key={document.id} value={document.id}>
                {document.originalName}
              </option>
            ))}
          </select>
          <input
            name="label"
            maxLength={80}
            placeholder="Etiket"
            className="h-10 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal"
          />
          <input
            name="note"
            maxLength={500}
            placeholder="Not"
            className="h-10 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal"
          />
          <label className="flex h-10 items-center gap-2 border border-black/10 px-3 text-sm">
            <input name="primary" type="checkbox" /> Birincil
          </label>
          <button
            className="h-10 bg-ink px-4 text-sm font-semibold text-paper hover:bg-signal disabled:bg-black/30"
            disabled={isSubmitting || documents.length === 0}
          >
            {isSubmitting ? "Kaydediliyor" : "Ekle"}
          </button>
        </form>
      ) : null}
      {state.kind === "success" && state.expenseId === expense.id ? <p className="mt-2 text-sm font-medium text-signal">{state.message}</p> : null}
      {state.kind === "error" && state.expenseId === expense.id ? <p className="mt-2 text-sm font-medium text-red-700">{state.message}</p> : null}
    </div>
  );
}

function CommentsPanel({
  comments,
  expenseId,
  canUpdate,
  commentState,
  onSubmit,
  locale
}: {
  comments: ExpenseCommentSummary[];
  expenseId: string;
  canUpdate: boolean;
  commentState: CommentState;
  onSubmit: (event: React.FormEvent<HTMLFormElement>, expenseId: string) => void;
  locale: "tr" | "en";
}) {
  const dateLocale = locale === "tr" ? "tr-TR" : "en-US";
  return (
    <div className="mt-4 border-l-2 border-black/10 pl-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">Aktivite</h3>
        <span className="text-xs text-steel">{comments.length} yorum</span>
      </div>
      {comments.length ? (
        <div className="mt-3 space-y-2">
          {comments.map((comment) => (
            <div key={comment.id} className="bg-white px-3 py-2 text-sm">
              <div className="text-xs text-steel">
                {new Date(comment.createdAt).toLocaleString(dateLocale)} - {comment.authorId.slice(0, 8)}
              </div>
              <p className="mt-1 whitespace-pre-wrap">{comment.body}</p>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-sm text-steel">{locale === "tr" ? "Henüz aktivite yorumu yok." : "No activity comment yet."}</p>
      )}
      {canUpdate ? (
        <form className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_120px]" onSubmit={(event) => onSubmit(event, expenseId)}>
          <textarea
            name="body"
            maxLength={2000}
            rows={2}
            placeholder={locale === "tr" ? "İnceleme notu ekle" : "Add review note"}
            className="w-full resize-none border border-black/15 bg-white px-3 py-2 text-sm outline-none focus:border-signal"
          />
          <button
            className="h-10 self-end bg-ink px-4 text-sm font-semibold text-paper hover:bg-signal disabled:bg-black/30"
            disabled={commentState.kind === "submitting" && commentState.expenseId === expenseId}
          >
            {commentState.kind === "submitting" && commentState.expenseId === expenseId ? "Kaydediliyor" : "Yorum ekle"}
          </button>
          {commentState.kind === "error" && commentState.expenseId === expenseId ? (
            <p className="text-sm font-medium text-red-700 sm:col-span-2">{commentState.message}</p>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}

function AnalysisPanel({ analysis, locale }: { analysis: ExpenseAiAnalysis; locale: "tr" | "en" }) {
  return (
    <div className="mt-4 border-l-2 border-signal pl-4 text-sm">
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <span className="font-semibold">{formatCategoryLabel(analysis.prediction.categoryKey, locale)}</span>
        <span className="text-steel">%{Math.round(analysis.prediction.confidence * 100)} {locale === "tr" ? "güven" : "confidence"}</span>
        <span className="text-steel">{formatCategorySource(analysis, locale)}</span>
        <span className="text-steel">{analysis.model.externalServicesUsed ? (locale === "tr" ? "Dış servis kullanıldı" : "External service used") : (locale === "tr" ? "Dış servis yok" : "No external service")}</span>
        {analysis.persistedPrediction ? <span className="text-steel">{locale === "tr" ? "Kaydedilen tahmin" : "Saved prediction"} {analysis.persistedPrediction.id.slice(0, 8)}</span> : null}
      </div>
      <div className="mt-2 text-xs text-steel">
        {analysis.prediction.matchedKeywords.length ? `${locale === "tr" ? "Eşleşenler" : "Matched"}: ${analysis.prediction.matchedKeywords.join(", ")}` : locale === "tr" ? "Kategori anahtar kelimesi eşleşmedi." : "No category keyword matched."}
      </div>
      {analysis.anomalies.length ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {analysis.anomalies.map((anomaly) => (
            <span key={anomaly.code} className={anomaly.severity === "critical" ? "text-xs font-semibold text-red-700" : "text-xs font-semibold text-amber-700"}>
              {anomaly.code.replaceAll("_", " ")}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function formatCategoryLabel(categoryKey: string, locale: "tr" | "en"): string {
  const labels: Record<string, { tr: string; en: string }> = {
    market: { tr: "Market", en: "Market" },
    ulasim: { tr: "Ulaşım", en: "Transport" },
    yemek: { tr: "Yemek", en: "Meals" },
    akaryakit: { tr: "Akaryakıt", en: "Fuel" },
    konaklama: { tr: "Konaklama", en: "Lodging" },
    ofis: { tr: "Ofis", en: "Office" },
    saglik: { tr: "Sağlık", en: "Health" },
    egitim: { tr: "Eğitim", en: "Education" },
    abonelik: { tr: "Abonelik", en: "Subscription" },
    kargo: { tr: "Kargo", en: "Cargo" },
    vergi_harc: { tr: "Vergi/harç sandbox", en: "Tax/fee sandbox" },
    diger: { tr: "Diğer", en: "Other" }
  };
  return labels[categoryKey]?.[locale] ?? categoryKey;
}

function formatCategorySource(analysis: ExpenseAiAnalysis, locale: "tr" | "en"): string {
  const source =
    analysis.model.version === "category-rules-v1"
      ? locale === "tr"
        ? "Kural tabanlı yerel model"
        : "Local rule-based model"
      : analysis.model.name;
  return locale === "tr" ? `Kaynak: ${source} (${analysis.model.version})` : `Source: ${source} (${analysis.model.version})`;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm font-medium">
      <span className="mb-2 block">{label}</span>
      {children}
    </label>
  );
}

function StatusBadge({ status, locale }: { status: ExpenseSummary["status"]; locale: "tr" | "en" }) {
  const isAttention = status === "NEEDS_REVIEW" || status === "REJECTED";
  return (
    <span className={isAttention ? "text-sm font-semibold text-red-700" : "text-sm font-semibold text-signal"}>
      {formatExpenseStatus(status, locale)}
    </span>
  );
}

function formatExpenseStatus(status: ExpenseSummary["status"], locale: "tr" | "en"): string {
  const labels: Record<string, string> =
    locale === "tr"
      ? {
          DRAFT: "Taslak",
          EXTRACTED: "OCR’dan çıkarıldı",
          NEEDS_REVIEW: "İnceleme gerekiyor",
          APPROVED: "Onaylandı",
          REJECTED: "Reddedildi",
          REIMBURSED: "Geri ödendi",
          ARCHIVED: "Arşivlendi"
        }
      : {
          DRAFT: "Draft",
          EXTRACTED: "Extracted from OCR",
          NEEDS_REVIEW: "Needs review",
          APPROVED: "Approved",
          REJECTED: "Rejected",
          REIMBURSED: "Reimbursed",
          ARCHIVED: "Archived"
        };
  return labels[status] ?? status.replaceAll("_", " ");
}

function formatReimbursementStatus(status: string, locale: "tr" | "en"): string {
  const labels: Record<string, string> =
    locale === "tr"
      ? {
          DRAFT: "Taslak",
          NEEDS_REVIEW: "İnceleme gerekiyor",
          APPROVED: "Onaylandı",
          REJECTED: "Reddedildi",
          PAID: "Ödendi"
        }
      : {
          DRAFT: "Draft",
          NEEDS_REVIEW: "Needs review",
          APPROVED: "Approved",
          REJECTED: "Rejected",
          PAID: "Paid"
        };
  return labels[status] ?? status.replaceAll("_", " ");
}

function formatImportStatus(status: string, locale: "tr" | "en"): string {
  const labels: Record<string, string> =
    locale === "tr"
      ? {
          PENDING: "Beklemede",
          PROCESSING: "İşleniyor",
          SUCCEEDED: "Tamamlandı",
          COMPLETED: "Tamamlandı",
          FAILED: "Başarısız"
        }
      : {
          PENDING: "Pending",
          PROCESSING: "Processing",
          SUCCEEDED: "Succeeded",
          COMPLETED: "Completed",
          FAILED: "Failed"
        };
  return labels[status] ?? status.replaceAll("_", " ");
}

function formatPolicySeverity(severity: string, locale: "tr" | "en"): string {
  if (severity === "block") return locale === "tr" ? "Engelle" : "Block";
  if (severity === "warning") return locale === "tr" ? "Uyarı" : "Warning";
  return severity;
}

function formatPolicyRule(ruleType: string, locale: "tr" | "en"): string {
  const labels: Record<string, string> =
    locale === "tr"
      ? {
          RECEIPT_REQUIRED_ABOVE: "Limit üstünde fiş zorunlu",
          RECEIPT_REQUIRED_ABOVE_AMOUNT: "Limit üstünde fiş zorunlu",
          MAX_AMOUNT_BY_CATEGORY: "Kategoriye göre maksimum tutar",
          PROJECT_REQUIRED: "Proje zorunlu",
          DUPLICATE_RECEIPT_REJECTION: "Tekrarlı fiş reddi"
        }
      : {
          RECEIPT_REQUIRED_ABOVE: "Receipt required above limit",
          RECEIPT_REQUIRED_ABOVE_AMOUNT: "Receipt required above limit",
          MAX_AMOUNT_BY_CATEGORY: "Maximum amount by category",
          PROJECT_REQUIRED: "Project required",
          DUPLICATE_RECEIPT_REJECTION: "Duplicate receipt rejection"
        };
  return labels[ruleType] ?? ruleType.replaceAll("_", " ");
}

function formatCadence(cadence: string, locale: "tr" | "en"): string {
  const labels: Record<string, string> =
    locale === "tr"
      ? {
          monthly: "Aylık",
          weekly: "Haftalık",
          yearly: "Yıllık"
        }
      : {
          monthly: "Monthly",
          weekly: "Weekly",
          yearly: "Yearly"
        };
  return labels[cadence] ?? cadence;
}

function Shell({ title, detail, children }: { title: string; detail: string; children?: React.ReactNode; locale: "tr" | "en" }) {
  return <AppShell title={title} detail={detail}>{children}</AppShell>;
}

function parseDecimalMinor(value: string): string | null {
  const normalized = value.trim().replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const [whole, fraction = ""] = normalized.split(".");
  return `${whole}${fraction.padEnd(2, "0")}`.replace(/^0+(?=\d)/, "") || "0";
}

function normalizeOptional(value: FormDataEntryValue | null): string | null {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized : null;
}

function formatMoney(amountMinor: bigint, currency: string): string {
  const sign = amountMinor < 0n ? "-" : "";
  const absolute = amountMinor < 0n ? -amountMinor : amountMinor;
  const major = absolute / 100n;
  const minor = absolute % 100n;
  return `${sign}${major.toString()},${minor.toString().padStart(2, "0")} ${currency}`;
}

function minorToDecimal(amountMinor: string): string {
  const value = BigInt(amountMinor);
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  return `${sign}${(absolute / 100n).toString()},${(absolute % 100n).toString().padStart(2, "0")}`;
}

function importStats(batch: ImportBatchSummary): { totalRows: number; importedRows: number; failedRows: number } {
  const stats = batch.stats && typeof batch.stats === "object" ? (batch.stats as Record<string, unknown>) : {};
  return {
    totalRows: readNumber(stats.totalRows),
    importedRows: readNumber(stats.importedRows),
    failedRows: readNumber(stats.failedRows)
  };
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toDateTimeLocal(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}
