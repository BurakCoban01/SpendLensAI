"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  apiRequest,
  authHeaders,
  formatUserFacingError,
  type ApprovalSlaSummary,
  type AuthResponse,
  type ExpenseDecisionSummary,
  type ExpenseSummary,
  type GeneratedReportSummary,
  type PrincipalResponse,
  type WorkspaceSummary
} from "../lib/api";
import { readSession } from "../lib/session";
import { useLocale } from "../lib/locale";
import { AppShell } from "./app-shell";
import { SessionRecoveryActions } from "./session-recovery-actions";

const copy = {
  tr: {
    loading: "Onaylar",
    loadingDetail: "Onay kuyruğu yükleniyor.",
    anonymousDetail: "Gider onaylarını incelemek için önce giriş yapın.",
    signIn: "Giriş yap",
    title: "Onaylar",
    detail: "Gider onayları ve muhasebe dışa aktarımı",
    noAccess: "Bu hesap giderleri görüntüleme yetkisine sahip değil.",
    decisionContext: "Karar bağlamı",
    decisionContextDetail: "Onaylar gider durumunu günceller ve onay akışına denetlenebilir kayıt ekler.",
    workspace: "Çalışma alanı",
    reason: "Karar notu",
    latestDecision: "Son karar",
    approvalExport: "Muhasebe dışa aktarımı",
    approvalExportDetail: "Onay kanıtı CSV dosyası SLA, politika ve geri ödeme bağlamını içerir.",
    exportApproval: "Onay kanıtını dışa aktar",
    generating: "Üretiliyor...",
    pending: "Bekleyenler",
    pendingDetail: "Taslak, OCR'dan çıkarılmış veya inceleme gereken giderler onaylanabilir ya da reddedilebilir.",
    pendingCount: "bekliyor",
    noPending: "Onay bekleyen gider yok.",
    decided: "Karara bağlananlar",
    decidedCount: "kayıt",
    noDecided: "Bu çalışma alanında onaylanmış veya reddedilmiş gider yok.",
    approve: "Onayla",
    reject: "Reddet",
    exit: "Çıkış yap",
    expenses: "Giderler",
    dashboard: "Pano",
    authorized: "Yetkili",
    unauthorized: "Yetkisiz",
    workspaceLabel: "Çalışma alanı",
    decisionNoteLabel: "Karar notu",
    retryAction: "Oturumu yenileyip tekrar deneyin.",
    loadError: "Onay kuyruğu şu anda açılamadı.",
    decisionError: "Karar kaydedilemedi.",
    exportError: "Onay kanıtı şu anda oluşturulamadı.",
    openApprovalExport: "Belgeyi aç/indir"
  },
  en: {
    loading: "Approvals",
    loadingDetail: "Loading approval queue.",
    anonymousDetail: "Sign in first to review expense approvals.",
    signIn: "Sign in",
    title: "Approvals",
    detail: "Expense approvals and accounting export",
    noAccess: "This account cannot view expenses.",
    decisionContext: "Decision context",
    decisionContextDetail: "Approvals update expense status and add auditable records to the approval flow.",
    workspace: "Workspace",
    reason: "Decision note",
    latestDecision: "Latest decision",
    approvalExport: "Accounting export",
    approvalExportDetail: "Approval evidence CSV includes SLA, policy and reimbursement context.",
    exportApproval: "Export approval evidence",
    generating: "Generating...",
    pending: "Pending",
    pendingDetail: "Draft, OCR-extracted or review-needed expenses can be approved or rejected.",
    pendingCount: "pending",
    noPending: "No expenses awaiting approval.",
    decided: "Decided",
    decidedCount: "records",
    noDecided: "No approved or rejected expenses in this workspace.",
    approve: "Approve",
    reject: "Reject",
    exit: "Sign out",
    expenses: "Expenses",
    dashboard: "Dashboard",
    authorized: "Authorized",
    unauthorized: "Unauthorized",
    workspaceLabel: "Workspace",
    decisionNoteLabel: "Decision note",
    retryAction: "Refresh your session and try again.",
    loadError: "The approval queue is not available right now.",
    decisionError: "The decision could not be saved.",
    exportError: "Approval evidence could not be generated right now.",
    openApprovalExport: "Open/download file"
  }
} as const;

type ApprovalState =
  | { kind: "loading" }
  | { kind: "anonymous" }
  | {
      kind: "ready";
      session: AuthResponse;
      principal: PrincipalResponse["principal"];
      workspaces: WorkspaceSummary[];
      selectedWorkspaceId: string;
      expenses: ExpenseSummary[];
      approvalSla: ApprovalSlaSummary[];
      latestDecision: ExpenseDecisionSummary | null;
      latestApprovalExport: GeneratedReportSummary | null;
    }
  | { kind: "error"; message: string };

type SubmitState = { kind: "idle" } | { kind: "submitting"; expenseId: string; action: "approve" | "reject" } | { kind: "error"; message: string };
type ExportState = { kind: "idle" } | { kind: "submitting" } | { kind: "error"; message: string };

const pendingStatuses = new Set<ExpenseSummary["status"]>(["DRAFT", "EXTRACTED", "NEEDS_REVIEW"]);
const approvalPageSize = 6;

export function ApprovalsClient() {
  const { locale } = useLocale();
  const dateLocale = locale === "tr" ? "tr-TR" : "en-US";
  const text = copy[locale];
  const [state, setState] = useState<ApprovalState>({ kind: "loading" });
  const [submitState, setSubmitState] = useState<SubmitState>({ kind: "idle" });
  const [exportState, setExportState] = useState<ExportState>({ kind: "idle" });
  const [reason, setReason] = useState("");
  const [pendingPage, setPendingPage] = useState(0);
  const [decidedPage, setDecidedPage] = useState(0);

  async function load(
    preferredWorkspaceId?: string,
    latestDecision?: ExpenseDecisionSummary | null,
    latestApprovalExport?: GeneratedReportSummary | null
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
      const canRead = principal.principal.permissions.includes("expenses.read");
      const expenses =
        selectedWorkspaceId && canRead
          ? (
              await apiRequest<{ expenses: ExpenseSummary[] }>(
                `/expenses?workspaceId=${encodeURIComponent(selectedWorkspaceId)}&limit=100`,
                { headers: authHeaders(session.tokens.accessToken) }
              )
            ).expenses
          : [];
      const approvalSla =
        selectedWorkspaceId && principal.principal.permissions.includes("expenses.approve")
          ? (
              await apiRequest<{ items: ApprovalSlaSummary[] }>(`/approvals/sla?workspaceId=${encodeURIComponent(selectedWorkspaceId)}`, {
                headers: authHeaders(session.tokens.accessToken)
              })
            ).items
          : [];
      setState({
        kind: "ready",
        session,
        principal: principal.principal,
        workspaces,
        selectedWorkspaceId,
        expenses,
        approvalSla,
        latestDecision: latestDecision ?? null,
        latestApprovalExport: latestApprovalExport ?? null
      });
    } catch (caught) {
      setState({ kind: "error", message: formatApprovalError(caught, locale, "load") });
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const canRead = state.kind === "ready" && state.principal.permissions.includes("expenses.read");
  const canApprove = state.kind === "ready" && state.principal.permissions.includes("expenses.approve");
  const canExportReports = state.kind === "ready" && state.principal.permissions.includes("reports.export");

  const grouped = useMemo(() => {
    if (state.kind !== "ready") {
      return { pending: [] as ExpenseSummary[], decided: [] as ExpenseSummary[], slaByExpenseId: new Map<string, ApprovalSlaSummary>() };
    }
    return {
      pending: state.expenses.filter((expense) => pendingStatuses.has(expense.status)),
      decided: state.expenses.filter((expense) => expense.status === "APPROVED" || expense.status === "REJECTED"),
      slaByExpenseId: new Map(state.approvalSla.map((item) => [item.expense.id, item]))
    };
  }, [state]);

  const pendingPageCount = Math.max(1, Math.ceil(grouped.pending.length / approvalPageSize));
  const decidedPageCount = Math.max(1, Math.ceil(grouped.decided.length / approvalPageSize));
  const visiblePending = grouped.pending.slice(pendingPage * approvalPageSize, (pendingPage + 1) * approvalPageSize);
  const visibleDecided = grouped.decided.slice(decidedPage * approvalPageSize, (decidedPage + 1) * approvalPageSize);

  useEffect(() => {
    setPendingPage((page) => Math.min(page, pendingPageCount - 1));
    setDecidedPage((page) => Math.min(page, decidedPageCount - 1));
  }, [pendingPageCount, decidedPageCount]);

  async function decide(expenseId: string, action: "approve" | "reject") {
    if (state.kind !== "ready" || !canApprove) return;
    setSubmitState({ kind: "submitting", expenseId, action });
    try {
      const decision = await apiRequest<ExpenseDecisionSummary>(`/expenses/${encodeURIComponent(expenseId)}/${action}`, {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken),
        body: JSON.stringify({ reason: reason.trim() || null })
      });
      setReason("");
      setSubmitState({ kind: "idle" });
      await load(state.selectedWorkspaceId, decision, state.latestApprovalExport);
    } catch (caught) {
      setSubmitState({ kind: "error", message: formatApprovalError(caught, locale, "decision") });
    }
  }

  async function exportApprovalEvidence() {
    if (state.kind !== "ready" || !canExportReports) return;
    setExportState({ kind: "submitting" });
    try {
      const report = await apiRequest<GeneratedReportSummary>("/reports/exports", {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken),
        body: JSON.stringify({
          workspaceId: state.selectedWorkspaceId,
          type: "approval_evidence_csv",
          month: currentMonthKey()
        })
      });
      setExportState({ kind: "idle" });
      await load(state.selectedWorkspaceId, state.latestDecision, report);
    } catch (caught) {
      setExportState({ kind: "error", message: formatApprovalError(caught, locale, "export") });
    }
  }

  if (state.kind === "loading") return <Shell title={text.loading} detail={text.loadingDetail} text={text} />;

  if (state.kind === "anonymous") {
    return (
      <Shell title={text.title} detail={text.anonymousDetail} text={text}>
        <Link className="mt-6 inline-flex h-10 items-center bg-ink px-4 text-sm font-semibold text-paper" href="/login">
          {text.signIn}
        </Link>
      </Shell>
    );
  }

  if (state.kind === "error") {
    return (
      <Shell title={text.title} detail={state.message} text={text}>
        <SessionRecoveryActions locale={locale} />
      </Shell>
    );
  }

  return (
    <Shell title={text.title} detail={`${state.principal.displayName} - ${grouped.pending.length} ${text.pendingCount}`} text={text}>
      <div className="grid gap-8 xl:grid-cols-[360px_minmax(0,1fr)]">
        <section className="border-y border-black/10 py-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold">{text.decisionContext}</h2>
              <p className="mt-1 text-sm text-steel">{text.decisionContextDetail}</p>
            </div>
            <span className={canApprove ? "text-xs font-semibold uppercase tracking-normal text-signal" : "text-xs font-semibold uppercase tracking-normal text-black/35"}>
              {canApprove ? text.authorized : text.unauthorized}
            </span>
          </div>

          <div className="mt-6 space-y-4">
            <Field label={text.workspaceLabel}>
              <select
                className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal"
                value={state.selectedWorkspaceId}
                onChange={(event) => void load(event.target.value, state.latestDecision, state.latestApprovalExport)}
              >
                {state.workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={text.decisionNoteLabel}>
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={4}
                maxLength={1000}
                className="w-full resize-none border border-black/15 bg-white px-3 py-2 text-sm outline-none focus:border-signal"
              />
            </Field>
          </div>

          {submitState.kind === "error" ? <p className="mt-4 text-sm font-medium text-red-700">{submitState.message}</p> : null}

          {state.latestDecision ? (
            <div className="mt-6 border-t border-black/10 pt-5">
              <p className="text-xs font-semibold uppercase tracking-normal text-steel">Son karar</p>
              <p className="mt-2 text-sm font-semibold">{state.latestDecision.expense.title}</p>
              <p className="mt-1 text-sm text-steel">{formatApprovalState(state.latestDecision.approvalWorkflow.state, locale)}</p>
              <p className="mt-1 text-xs text-steel">{formatSlaStatus(state.latestDecision.approvalWorkflow.slaStatus, locale)}</p>
            </div>
          ) : null}

          <div className="mt-6 border-t border-black/10 pt-5">
            <div className="flex items-start justify-between gap-4">
              <div>
              <p className="text-xs font-semibold uppercase tracking-normal text-steel">{text.approvalExport}</p>
              <p className="mt-2 text-sm text-steel">{text.approvalExportDetail}</p>
            </div>
            <span className={canExportReports ? "text-xs font-semibold uppercase tracking-normal text-signal" : "text-xs font-semibold uppercase tracking-normal text-black/35"}>
              {canExportReports ? text.authorized : text.unauthorized}
            </span>
          </div>
          {exportState.kind === "error" ? <p className="mt-3 text-sm font-medium text-red-700">{exportState.message}</p> : null}
          <button
              type="button"
              className="mt-4 h-10 w-full border border-black/15 px-3 text-sm font-semibold hover:border-signal hover:text-signal disabled:cursor-not-allowed disabled:text-black/30"
              disabled={!canExportReports || !state.selectedWorkspaceId || exportState.kind === "submitting"}
              onClick={() => void exportApprovalEvidence()}
            >
              {exportState.kind === "submitting" ? text.generating : text.exportApproval}
            </button>
            {state.latestApprovalExport ? (
              <div className="mt-4">
                <p className="text-sm text-steel">{locale === "tr" ? "Onay kanıtı hazır." : "Approval evidence is ready."}</p>
                <a
                  className="mt-3 inline-flex h-9 items-center bg-signal px-3 text-xs font-semibold text-white"
                  href={state.latestApprovalExport.signedUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  {text.openApprovalExport}
                </a>
              </div>
            ) : null}
          </div>
        </section>

        <section className="border-y border-black/10 py-6">
          <div className="flex flex-col gap-4 border-b border-black/10 pb-5 md:flex-row md:items-end md:justify-between">
            <div>
              <h2 className="text-xl font-semibold">{text.pending}</h2>
              <p className="mt-1 text-sm text-steel">{text.pendingDetail}</p>
            </div>
            <span className="text-sm text-steel">{grouped.pending.length} {text.pendingCount}</span>
          </div>

          {!canRead ? (
            <div className="py-12 text-sm text-steel">{text.noAccess}</div>
          ) : grouped.pending.length === 0 ? (
            <div className="py-12 text-sm text-steel">{text.noPending}</div>
          ) : (
            <div className="divide-y divide-black/10">
                {visiblePending.map((expense) => (
                  <ExpenseRow
                    key={expense.id}
                    expense={expense}
                    sla={grouped.slaByExpenseId.get(expense.id) ?? null}
                    canApprove={canApprove}
                    submitState={submitState}
                    locale={locale}
                    text={text}
                    onApprove={() => void decide(expense.id, "approve")}
                    onReject={() => void decide(expense.id, "reject")}
                  />
              ))}
            </div>
          )}
          {grouped.pending.length > approvalPageSize ? (
            <PaginationControls page={pendingPage} pageCount={pendingPageCount} locale={locale} onChange={setPendingPage} />
          ) : null}

          <div className="mt-8 border-t border-black/10 pt-6">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold">{text.decided}</h2>
              <span className="text-sm text-steel">{grouped.decided.length} {text.decidedCount}</span>
            </div>
            <div className="mt-5 divide-y divide-black/10">
              {grouped.decided.length === 0 ? (
                <div className="py-8 text-sm text-steel">{text.noDecided}</div>
              ) : (
                visibleDecided.map((expense) => (
                  <ExpenseRow
                    key={expense.id}
                    expense={expense}
                    sla={grouped.slaByExpenseId.get(expense.id) ?? null}
                    canApprove={false}
                    submitState={submitState}
                    locale={locale}
                    text={text}
                  />
                ))
              )}
            </div>
            {grouped.decided.length > approvalPageSize ? (
              <PaginationControls page={decidedPage} pageCount={decidedPageCount} locale={locale} onChange={setDecidedPage} />
            ) : null}
          </div>
        </section>
      </div>
    </Shell>
  );
}

function ExpenseRow({
  expense,
  sla,
  canApprove,
  submitState,
  locale,
  text,
  onApprove,
  onReject
}: {
  expense: ExpenseSummary;
  sla: ApprovalSlaSummary | null;
  canApprove: boolean;
  submitState: SubmitState;
  locale: "tr" | "en";
  text: (typeof copy)[keyof typeof copy];
  onApprove?: () => void;
  onReject?: () => void;
}) {
  const isBusy = submitState.kind === "submitting" && submitState.expenseId === expense.id;
  return (
    <div className="grid gap-3 py-5 lg:grid-cols-[minmax(0,1fr)_140px_150px_170px]">
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold">{expense.title}</div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-steel">
          <span>{new Date(expense.occurredAt).toLocaleDateString(locale === "tr" ? "tr-TR" : "en-US")}</span>
          <span>{formatExpenseStatus(expense.status, locale)}</span>
          {expense.reimbursable ? <span>Geri ödenebilir</span> : null}
          {expense.businessExpense ? <span>İş gideri</span> : null}
          {sla ? <span>{formatSlaStatus(sla.slaStatus, locale)}</span> : null}
        </div>
      </div>
      <div className="text-sm font-semibold">{formatMoney(BigInt(expense.amountMinor), expense.currency)}</div>
      <div className="text-sm">
        {sla ? (
          <>
            <div className={isLateSla(sla.slaStatus) ? "font-semibold text-red-700" : "font-semibold text-ink"}>
              {formatSlaStatus(sla.slaStatus, locale)}
            </div>
            <div className="mt-1 text-xs text-steel">{sla.slaDueAt ? `${locale === "tr" ? "Son tarih" : "Due date"} ${new Date(sla.slaDueAt).toLocaleString(locale === "tr" ? "tr-TR" : "en-US")}` : locale === "tr" ? "SLA son tarihi yok" : "No SLA due date"}</div>
          </>
        ) : (
          <span className="text-steel">{locale === "tr" ? "SLA bilgisi yok" : "No SLA information"}</span>
        )}
      </div>
      {canApprove ? (
        <div className="flex gap-2">
          <button
            className="h-9 flex-1 bg-signal px-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-black/25"
            disabled={isBusy}
            onClick={onApprove}
          >
            {isBusy && submitState.action === "approve" ? "..." : text.approve}
          </button>
          <button
            className="h-9 flex-1 border border-black/15 px-3 text-sm font-semibold hover:border-red-700 hover:text-red-700 disabled:cursor-not-allowed disabled:text-black/25"
            disabled={isBusy}
            onClick={onReject}
          >
            {isBusy && submitState.action === "reject" ? "..." : text.reject}
          </button>
        </div>
      ) : (
        <div className={expense.status === "APPROVED" ? "text-sm font-semibold text-signal" : "text-sm font-semibold text-red-700"}>{formatExpenseStatus(expense.status, locale)}</div>
      )}
    </div>
  );
}

function PaginationControls({
  page,
  pageCount,
  locale,
  onChange
}: {
  page: number;
  pageCount: number;
  locale: "tr" | "en";
  onChange: (page: number) => void;
}) {
  return (
    <div className="mt-4 flex items-center justify-between border-t border-black/10 pt-4">
      <button type="button" className="h-9 border border-black/15 px-4 text-sm font-semibold disabled:opacity-40" disabled={page === 0} onClick={() => onChange(page - 1)}>
        {locale === "tr" ? "Önceki" : "Previous"}
      </button>
      <span className="text-xs text-steel">{page + 1} / {pageCount}</span>
      <button type="button" className="h-9 border border-black/15 px-4 text-sm font-semibold disabled:opacity-40" disabled={page + 1 >= pageCount} onClick={() => onChange(page + 1)}>
        {locale === "tr" ? "Sonraki" : "Next"}
      </button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm font-medium">
      <span className="mb-2 block">{label}</span>
      {children}
    </label>
  );
}

function Shell({ title, detail, children, text }: { title: string; detail: string; children?: React.ReactNode; text: (typeof copy)[keyof typeof copy] }) {
  void text;
  return <AppShell title={title} detail={detail}>{children}</AppShell>;
}

function formatMoney(amountMinor: bigint, currency: string): string {
  const sign = amountMinor < 0n ? "-" : "";
  const absolute = amountMinor < 0n ? -amountMinor : amountMinor;
  const major = absolute / 100n;
  const minor = absolute % 100n;
  return `${sign}${major.toString()},${minor.toString().padStart(2, "0")} ${currency}`;
}

function formatSlaStatus(status: string, locale: "tr" | "en"): string {
  const labels: Record<string, string> = {
    MET_ON_TIME: locale === "tr" ? "Zamanında tamamlandı" : "Met on time",
    ON_TIME: locale === "tr" ? "Zamanında" : "On time",
    ON_TRACK: locale === "tr" ? "Plan dahilinde" : "On track",
    DUE_SOON: locale === "tr" ? "Yakında dolacak" : "Due soon",
    BREACHED: locale === "tr" ? "SLA aşıldı" : "SLA breached",
    APPROVAL_LATE: locale === "tr" ? "Onay gecikti" : "Approval late",
    REIMBURSEMENT_LATE: locale === "tr" ? "Geri ödeme gecikti" : "Reimbursement late"
  };
  return labels[status] ?? status.replaceAll("_", " ");
}

function formatExpenseStatus(status: ExpenseSummary["status"], locale: "tr" | "en"): string {
  const labels: Record<ExpenseSummary["status"], string> = {
    DRAFT: locale === "tr" ? "Taslak" : "Draft",
    EXTRACTED: locale === "tr" ? "OCR’dan çıkarıldı" : "Extracted from OCR",
    NEEDS_REVIEW: locale === "tr" ? "İnceleme gerekiyor" : "Needs review",
    APPROVED: locale === "tr" ? "Onaylandı" : "Approved",
    REJECTED: locale === "tr" ? "Reddedildi" : "Rejected",
    REIMBURSED: locale === "tr" ? "Geri ödendi" : "Reimbursed",
    ARCHIVED: locale === "tr" ? "Arşivlendi" : "Archived"
  };
  return labels[status] ?? status.replaceAll("_", " ");
}

function formatApprovalState(status: string, locale: "tr" | "en"): string {
  const labels: Record<string, string> = {
    PENDING: locale === "tr" ? "Beklemede" : "Pending",
    APPROVED: locale === "tr" ? "Onaylandı" : "Approved",
    REJECTED: locale === "tr" ? "Reddedildi" : "Rejected",
    CANCELLED: locale === "tr" ? "İptal edildi" : "Cancelled"
  };
  return labels[status] ?? status.replaceAll("_", " ");
}

function isLateSla(status: string): boolean {
  return status === "BREACHED" || status.endsWith("_LATE");
}

function currentMonthKey(): string {
  return new Date().toISOString().slice(0, 7);
}

function formatApprovalError(
  caught: unknown,
  locale: "tr" | "en",
  context: "load" | "decision" | "export"
): string {
  const text = copy[locale];
  const fallback = context === "load" ? text.loadError : context === "decision" ? text.decisionError : text.exportError;
  const raw = caught instanceof Error ? caught.message : String(caught);
  const friendly = formatUserFacingError(raw, locale);
  return friendly && friendly !== raw ? `${fallback} ${friendly}` : `${fallback} ${text.retryAction}`;
}
