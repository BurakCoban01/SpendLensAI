"use client";

import { AlertTriangle, ArrowRight, CheckSquare, FileScan, ReceiptText, Upload, WalletCards } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { AppShell } from "./app-shell";
import { SessionRecoveryActions } from "./session-recovery-actions";
import {
  apiRequest,
  authHeaders,
  formatUserFacingError,
  type ApprovalSlaSummary,
  type AuthResponse,
  type DocumentSummary,
  type ExpenseSummary,
  type MonthlySpendAnalytics,
  type PrincipalResponse,
  type ReviewTaskWithDocument,
  type WorkspaceSummary
} from "../lib/api";
import { clearSession, readSession } from "../lib/session";
import { useLocale } from "../lib/locale";

const copy = {
  tr: {
    loading: "Genel bakış yükleniyor",
    loadingDetail: "Çalışma alanınızın güncel gider ve belge durumu hazırlanıyor.",
    anonymousTitle: "Aktif oturum yok",
    anonymousDetail: "Çalışma alanınızı görüntülemek için giriş yapın.",
    signIn: "Giriş yap",
    errorTitle: "Genel bakış yüklenemedi",
    title: "Genel bakış",
    monthlySpend: "Bu ayki harcama",
    reviewQueue: "İnceleme bekleyen",
    pendingApprovals: "Bekleyen onay",
    budgetUsage: "En yüksek bütçe kullanımı",
    expenses: "gider",
    documents: "belge",
    noBudget: "Bütçe yok",
    quickActions: "Hızlı işlemler",
    uploadDocument: "Belge yükle",
    openReview: "İnceleme kuyruğu",
    createExpense: "Gider oluştur",
    recentExpenses: "Son giderler",
    recentDocuments: "Son belgeler",
    viewAll: "Tümünü görüntüle",
    noExpenses: "Henüz gider kaydı yok.",
    noDocuments: "Henüz belge yüklenmemiş.",
    exceptions: "İşlem gerektirenler",
    exceptionsDetail: "OCR veya doğrulama adımında dikkatinizi bekleyen kayıtlar.",
    noExceptions: "İnceleme bekleyen kayıt yok.",
    reviewNow: "Şimdi incele",
    workspace: "Çalışma alanı",
    status: {
      DRAFT: "Taslak",
      EXTRACTED: "Çıkarıldı",
      NEEDS_REVIEW: "İnceleme gerekli",
      APPROVED: "Onaylandı",
      REJECTED: "Reddedildi",
      REIMBURSED: "Ödendi",
      ARCHIVED: "Arşivlendi"
    }
  },
  en: {
    loading: "Loading overview",
    loadingDetail: "Preparing the latest expense and document status for your workspace.",
    anonymousTitle: "No active session",
    anonymousDetail: "Sign in to view your workspace.",
    signIn: "Sign in",
    errorTitle: "Overview could not be loaded",
    title: "Overview",
    monthlySpend: "Spend this month",
    reviewQueue: "Waiting for review",
    pendingApprovals: "Pending approvals",
    budgetUsage: "Highest budget usage",
    expenses: "expenses",
    documents: "documents",
    noBudget: "No budget",
    quickActions: "Quick actions",
    uploadDocument: "Upload document",
    openReview: "Review queue",
    createExpense: "Create expense",
    recentExpenses: "Recent expenses",
    recentDocuments: "Recent documents",
    viewAll: "View all",
    noExpenses: "No expense records yet.",
    noDocuments: "No documents uploaded yet.",
    exceptions: "Needs attention",
    exceptionsDetail: "Records waiting for action in OCR or validation.",
    noExceptions: "Nothing is waiting for review.",
    reviewNow: "Review now",
    workspace: "Workspace",
    status: {
      DRAFT: "Draft",
      EXTRACTED: "Extracted",
      NEEDS_REVIEW: "Needs review",
      APPROVED: "Approved",
      REJECTED: "Rejected",
      REIMBURSED: "Reimbursed",
      ARCHIVED: "Archived"
    }
  }
} as const;

type DashboardState =
  | { kind: "loading" }
  | { kind: "anonymous" }
  | {
      kind: "ready";
      session: AuthResponse;
      principal: PrincipalResponse["principal"];
      workspace: WorkspaceSummary | null;
      expenses: ExpenseSummary[];
      documents: DocumentSummary[];
      approvals: ApprovalSlaSummary[];
      reviewTasks: ReviewTaskWithDocument[];
      analytics: MonthlySpendAnalytics | null;
    }
  | { kind: "error"; message: string };

export function DashboardClient() {
  const { locale } = useLocale();
  const text = copy[locale];
  const localized = (path: string) => `${path}?lang=${locale}`;
  const [state, setState] = useState<DashboardState>({ kind: "loading" });

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    const session = readSession();
    if (!session) {
      setState({ kind: "anonymous" });
      return;
    }

    try {
      const headers = authHeaders(session.tokens.accessToken);
      const [principalResult, workspaceResult] = await Promise.all([
        apiRequest<PrincipalResponse>("/auth/me", { headers }),
        apiRequest<{ workspaces: WorkspaceSummary[] }>("/workspaces", { headers })
      ]);
      const principal = principalResult.principal;
      const workspace = workspaceResult.workspaces[0] ?? null;
      if (!workspace) {
        setState({ kind: "ready", session, principal, workspace: null, expenses: [], documents: [], approvals: [], reviewTasks: [], analytics: null });
        return;
      }

      const workspaceQuery = `workspaceId=${encodeURIComponent(workspace.id)}`;
      const month = currentMonthKey();
      const [expenses, documents, approvals, reviewTasks, analytics] = await Promise.all([
        principal.permissions.includes("expenses.read")
          ? apiRequest<{ expenses: ExpenseSummary[] }>(`/expenses?${workspaceQuery}&limit=100`, { headers }).then((result) => result.expenses)
          : Promise.resolve([]),
        principal.permissions.includes("documents.read")
          ? apiRequest<{ documents: DocumentSummary[] }>(`/documents?${workspaceQuery}&limit=6`, { headers }).then((result) => result.documents)
          : Promise.resolve([]),
        principal.permissions.includes("expenses.approve")
          ? apiRequest<{ items: ApprovalSlaSummary[] }>(`/approvals/sla?${workspaceQuery}`, { headers }).then((result) => result.items)
          : Promise.resolve([]),
        principal.permissions.includes("ocr.review")
          ? apiRequest<{ reviewTasks: ReviewTaskWithDocument[] }>(`/review/tasks?${workspaceQuery}`, { headers }).then((result) => result.reviewTasks)
          : Promise.resolve([]),
        principal.permissions.includes("expenses.read")
          ? apiRequest<{ analytics: MonthlySpendAnalytics }>(`/analytics/monthly-spend?${workspaceQuery}&month=${month}`, { headers }).then((result) => result.analytics)
          : Promise.resolve(null)
      ]);

      setState({ kind: "ready", session, principal, workspace, expenses, documents, approvals, reviewTasks, analytics });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "SESSION_FAILED";
      if (/INVALID_TOKEN|INVALID_REFRESH_TOKEN|SESSION_REVOKED/i.test(message)) clearSession();
      setState({ kind: "error", message });
    }
  }

  if (state.kind === "loading") return <AppShell title={text.loading} detail={text.loadingDetail}><DashboardSkeleton /></AppShell>;
  if (state.kind === "anonymous") {
    return <AppShell title={text.anonymousTitle} detail={text.anonymousDetail}><SessionRecoveryActions locale={locale} /></AppShell>;
  }
  if (state.kind === "error") {
    return <AppShell title={text.errorTitle} detail={formatUserFacingError(state.message, locale)}><SessionRecoveryActions locale={locale} /></AppShell>;
  }

  const pendingApprovals = state.approvals.filter((item) => item.expense.status === "NEEDS_REVIEW" || item.expense.status === "EXTRACTED");
  const pendingReviews = state.reviewTasks.filter((entry) => entry.task.status === "QUEUED" || entry.task.status === "RUNNING");
  const reviewExpenses = state.expenses.filter((expense) => expense.status === "NEEDS_REVIEW");
  const pendingReviewCount = pendingReviews.length + reviewExpenses.length;
  const highestBudget = state.analytics?.budgetUsage.reduce((highest, item) => Math.max(highest, item.utilizationPercent), 0) ?? null;
  const recentExpenses = [...state.expenses].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)).slice(0, 5);
  const recentDocuments = [...state.documents].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 5);

  return (
    <AppShell
      title={text.title}
      eyebrow={state.workspace ? `${text.workspace}: ${state.workspace.name}` : state.session.tenant.name}
      detail={`${state.principal.displayName}, ${locale === "tr" ? "çalışma alanınızdaki güncel durum burada." : "here is the latest activity in your workspace."}`}
      actions={<Link className="product-button-primary" href={localized("/documents/upload")}><Upload size={17} aria-hidden="true" />{text.uploadDocument}</Link>}
    >
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label={locale === "tr" ? "Temel göstergeler" : "Key metrics"}>
        <MetricCard icon={<ReceiptText size={19} />} label={text.monthlySpend} value={formatMoney(state.analytics?.totalMinor ?? "0", state.analytics?.currency ?? "TRY", locale)} detail={`${state.analytics?.expenseCount ?? 0} ${text.expenses}`} />
        <MetricCard icon={<CheckSquare size={19} />} label={text.reviewQueue} value={String(pendingReviewCount)} detail={`${state.documents.length} ${text.documents}`} tone={pendingReviewCount > 0 ? "warning" : "success"} href={localized("/review")} />
        <MetricCard icon={<FileScan size={19} />} label={text.pendingApprovals} value={String(pendingApprovals.length)} detail={formatSlaStatus(pendingApprovals[0]?.slaStatus, locale)} tone={pendingApprovals.length > 0 ? "warning" : "success"} href={localized("/approvals")} />
        <MetricCard
          icon={<WalletCards size={19} />}
          label={text.budgetUsage}
          value={highestBudget === null ? text.noBudget : `%${Math.round(highestBudget)}`}
          detail={highestBudget !== null && highestBudget >= 100
            ? (locale === "tr" ? "Bütçe aşıldı" : "Budget exceeded")
            : highestBudget !== null && highestBudget >= 90
              ? (locale === "tr" ? "Sınıra yaklaşıyor" : "Near limit")
              : (locale === "tr" ? "Aylık kullanım" : "Monthly usage")}
          tone={highestBudget !== null && highestBudget >= 100 ? "danger" : highestBudget !== null && highestBudget >= 90 ? "warning" : "neutral"}
          href={localized("/budgets")}
        />
      </section>

      <section className="product-card mt-5 p-4 sm:p-5">
        <h2 className="text-base font-semibold">{text.quickActions}</h2>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link className="product-button-primary" href={localized("/documents/upload")}><Upload size={17} aria-hidden="true" />{text.uploadDocument}</Link>
          <Link className="product-button-secondary" href={localized("/review")}><CheckSquare size={17} aria-hidden="true" />{text.openReview}</Link>
          <Link className="product-button-secondary" href={localized("/expenses")}><ReceiptText size={17} aria-hidden="true" />{text.createExpense}</Link>
        </div>
      </section>

      <div className="mt-5 grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
        <section className="product-card min-w-0 p-4 sm:p-5">
          <SectionHeading title={text.recentExpenses} linkText={text.viewAll} href={localized("/expenses")} />
          {recentExpenses.length > 0 ? (
            <div className="mt-3 divide-y divide-[var(--border)]">
              {recentExpenses.map((expense) => (
                <Link key={expense.id} href={`${localized("/expenses")}&expenseId=${encodeURIComponent(expense.id)}`} className="grid min-h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 py-3 hover:text-[var(--primary)]">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">{expense.title}</div>
                    <div className="mt-1 truncate text-xs text-[var(--text-secondary)]">{expense.merchantName ?? formatDate(expense.occurredAt, locale)}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-semibold">{formatMoney(expense.amountMinor, expense.currency, locale)}</div>
                    <div className={`mt-1 text-xs ${statusTone(expense.status)}`}>{text.status[expense.status]}</div>
                  </div>
                </Link>
              ))}
            </div>
          ) : <EmptyLine text={text.noExpenses} />}
        </section>

        <section className="product-card min-w-0 p-4 sm:p-5">
          <SectionHeading title={text.recentDocuments} linkText={text.viewAll} href={localized("/documents/upload")} />
          {recentDocuments.length > 0 ? (
            <div className="mt-3 divide-y divide-[var(--border)]">
              {recentDocuments.map((document) => (
                <Link key={document.id} href={`${localized("/documents/ocr")}&documentId=${encodeURIComponent(document.id)}`} className="flex min-h-16 items-center justify-between gap-3 py-3 hover:text-[var(--primary)]">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">{document.originalName}</div>
                    <div className="mt-1 text-xs text-[var(--text-secondary)]">{formatDate(document.createdAt, locale)} · {formatFileSize(document.sizeBytes, locale)}</div>
                  </div>
                  <ArrowRight className="shrink-0" size={17} aria-hidden="true" />
                </Link>
              ))}
            </div>
          ) : <EmptyLine text={text.noDocuments} />}
        </section>
      </div>

      <section className="product-card mt-5 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold"><AlertTriangle size={18} className="text-[var(--warning)]" aria-hidden="true" />{text.exceptions}</h2>
            <p className="mt-1 text-sm text-[var(--text-secondary)]">{text.exceptionsDetail}</p>
          </div>
          {pendingReviewCount > 0 ? <Link className="product-button-secondary" href={localized("/review")}>{text.reviewNow}<ArrowRight size={16} aria-hidden="true" /></Link> : null}
        </div>
        {pendingReviewCount > 0 ? (
          <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {pendingReviews.slice(0, 6).map(({ task, document }) => (
              <Link key={task.id} href={`${localized("/review")}&documentId=${encodeURIComponent(document.id)}`} className="rounded-md border border-[var(--border)] bg-[var(--surface-muted)] p-3 hover:border-[var(--primary)]">
                <div className="truncate text-sm font-semibold">{document.originalName}</div>
                <div className="mt-1 text-xs text-[var(--text-secondary)]">{task.reasonCodes.join(", ") || (locale === "tr" ? "Doğrulama gerekli" : "Validation required")}</div>
              </Link>
            ))}
            {reviewExpenses.slice(0, Math.max(0, 6 - pendingReviews.length)).map((expense) => (
              <Link key={expense.id} href={`${localized("/expenses")}&expenseId=${encodeURIComponent(expense.id)}`} className="rounded-md border border-[var(--border)] bg-[var(--surface-muted)] p-3 hover:border-[var(--primary)]">
                <div className="truncate text-sm font-semibold">{expense.title}</div>
                <div className="mt-1 text-xs text-[var(--text-secondary)]">{locale === "tr" ? "Gider doğrulaması bekliyor" : "Expense validation is pending"}</div>
              </Link>
            ))}
          </div>
        ) : <EmptyLine text={text.noExceptions} />}
      </section>
    </AppShell>
  );
}

function MetricCard({ icon, label, value, detail, tone = "neutral", href }: { icon: ReactNode; label: string; value: string; detail: string; tone?: "neutral" | "success" | "warning" | "danger"; href?: string }) {
  const content = <><div className="flex items-center justify-between gap-3"><span className="text-sm text-[var(--text-secondary)]">{label}</span><span className="text-[var(--primary)]" aria-hidden="true">{icon}</span></div><div className="mt-4 text-2xl font-semibold">{value}</div><div className={`mt-1 text-xs ${toneClass(tone)}`}>{detail}</div></>;
  return href ? <Link href={href} className="product-card block min-h-32 p-4 transition hover:border-[var(--primary)]">{content}</Link> : <div className="product-card min-h-32 p-4">{content}</div>;
}

function SectionHeading({ title, linkText, href }: { title: string; linkText: string; href: string }) {
  return <div className="flex items-center justify-between gap-3"><h2 className="text-base font-semibold">{title}</h2><Link href={href} className="text-xs font-semibold text-[var(--primary)] hover:underline">{linkText}</Link></div>;
}

function EmptyLine({ text }: { text: string }) {
  return <div className="mt-4 rounded-md border border-dashed border-[var(--border)] bg-[var(--surface-muted)] px-4 py-7 text-center text-sm text-[var(--text-secondary)]">{text}</div>;
}

function DashboardSkeleton() {
  return <div className="grid animate-pulse gap-3 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }, (_, index) => <div key={index} className="product-card h-32 bg-[var(--surface-muted)]" />)}</div>;
}

function toneClass(tone: "neutral" | "success" | "warning" | "danger"): string {
  if (tone === "success") return "text-[var(--success)]";
  if (tone === "warning") return "text-[var(--warning)]";
  if (tone === "danger") return "text-[var(--danger)]";
  return "text-[var(--text-secondary)]";
}

function statusTone(status: ExpenseSummary["status"]): string {
  if (status === "APPROVED" || status === "REIMBURSED") return "text-[var(--success)]";
  if (status === "REJECTED") return "text-[var(--danger)]";
  if (status === "NEEDS_REVIEW") return "text-[var(--warning)]";
  return "text-[var(--text-secondary)]";
}

function formatSlaStatus(status: string | undefined, locale: "tr" | "en"): string {
  if (!status) return "-";
  const labels: Record<string, { tr: string; en: string }> = {
    ON_TRACK: { tr: "Süresinde", en: "On track" },
    DUE_SOON: { tr: "Süre yaklaşıyor", en: "Due soon" },
    OVERDUE: { tr: "Süresi geçti", en: "Overdue" }
  };
  return labels[status]?.[locale] ?? status;
}

function formatMoney(minor: string, currency: string, locale: "tr" | "en"): string {
  const amount = Number(minor) / 100;
  return new Intl.NumberFormat(locale === "tr" ? "tr-TR" : "en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(Number.isFinite(amount) ? amount : 0);
}

function formatDate(value: string, locale: "tr" | "en"): string {
  return new Intl.DateTimeFormat(locale === "tr" ? "tr-TR" : "en-US", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(value));
}

function formatFileSize(value: string, locale: "tr" | "en"): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return "-";
  return `${new Intl.NumberFormat(locale === "tr" ? "tr-TR" : "en-US", { maximumFractionDigits: 1 }).format(bytes / 1024)} KB`;
}

function currentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}
