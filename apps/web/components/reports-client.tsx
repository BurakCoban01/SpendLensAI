"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  apiRequest,
  authHeaders,
  formatUserFacingError,
  type AuthResponse,
  type ExportJobSummary,
  type GeneratedReportSummary,
  type PrincipalResponse,
  type ReportExportType,
  type WorkspaceSummary
} from "../lib/api";
import { readSession } from "../lib/session";
import { useLocale } from "../lib/locale";
import { AppShell } from "./app-shell";
import { SessionRecoveryActions } from "./session-recovery-actions";

const copy = {
  tr: {
    loading: "Raporlar",
    loadingDetail: "Dışa aktarma çalışma alanı yükleniyor.",
    anonymousDetail: "Dışa aktarma üretmek için önce giriş yapın.",
    signIn: "Giriş yap",
    title: "Raporlar",
    detail: "Kalıcı CSV ve PDF dışa aktarma işleri",
    createExport: "Dışa aktarım üret",
    createExportDetail: "Dışa aktarma dosyaları güvenli biçimde hazırlanır ve geçmişte izlenebilir.",
    authorized: "Yetkili",
    unauthorized: "Yetkisiz",
    workspace: "Çalışma alanı",
    month: "Ay",
    exportType: "Dışa aktarma türü",
    exportJobs: "Dışa aktarma işleri",
    latestExport: "Son dışa aktarma",
    refresh: "Yenile",
    create: "Üret",
    creating: "Üretiliyor...",
    noJobs: "Henüz dışa aktarma işi yok.",
    export: "Dışa aktar",
    expenses: "Giderler",
    budgets: "Bütçeler",
    exit: "Çıkış yap",
    dashboard: "Pano"
  },
  en: {
    loading: "Reports",
    loadingDetail: "Loading export workspace.",
    anonymousDetail: "Sign in first to generate exports.",
    signIn: "Sign in",
    title: "Reports",
    detail: "Persistent CSV and PDF export jobs",
    createExport: "Generate export",
    createExportDetail: "Export files are prepared securely and remain available in export history.",
    authorized: "Authorized",
    unauthorized: "Unauthorized",
    workspace: "Workspace",
    month: "Month",
    exportType: "Export type",
    exportJobs: "Export jobs",
    latestExport: "Latest export",
    refresh: "Refresh",
    create: "Generate",
    creating: "Generating...",
    noJobs: "No export jobs yet.",
    export: "Export",
    expenses: "Expenses",
    budgets: "Budgets",
    exit: "Sign out",
    dashboard: "Dashboard"
  }
} as const;

type ReportsState =
  | { kind: "loading" }
  | { kind: "anonymous" }
  | {
      kind: "ready";
      session: AuthResponse;
      principal: PrincipalResponse["principal"];
      workspaces: WorkspaceSummary[];
      selectedWorkspaceId: string;
      month: string;
      exportJobs: ExportJobSummary[];
      latestReport: GeneratedReportSummary | null;
    }
  | { kind: "error"; message: string };

type SubmitState = { kind: "idle" } | { kind: "submitting" } | { kind: "error"; message: string };

function reportTypes(locale: "tr" | "en"): Array<{ value: ReportExportType; label: string; detail: string }> {
  return locale === "tr"
    ? [
        { value: "expense_ledger_csv", label: "Gider defteri", detail: "Çalışma alanı giderlerinin satır bazlı dışa aktarımı" },
        { value: "category_breakdown_csv", label: "Kategori dağılımı", detail: "Kategori ID’ye göre gruplanmış toplamlar" },
        { value: "merchant_spend_csv", label: "Satıcı harcaması", detail: "Satıcıya göre gruplanmış toplamlar" },
        { value: "monthly_expense_report_pdf", label: "Aylık PDF", detail: "Toplamları ve satıcı harcamalarını içeren kalıcı özet PDF" },
        { value: "approval_evidence_csv", label: "Onay kanıtı", detail: "Muhasebe/denetim incelemesi için onay SLA, politika ve geri ödeme kanıtı" },
        { value: "reimbursement_batch_csv", label: "Geri ödeme paketi", detail: "Finans ödeme incelemesi için onaylı ve ödenmiş talep satırları" },
        { value: "reimbursement_claim_report_pdf", label: "Geri ödeme PDF", detail: "Finans incelemesi için onaylı ve ödenmiş talep özeti PDF" },
        { value: "ocr_quality_report_csv", label: "OCR kalitesi", detail: "Motor güveni, gecikme, hata ve ensemble çakışmaları" },
        { value: "model_evaluation_report_csv", label: "Model değerlendirmesi", detail: "Model kayıt sisteminden eğitim ve değerlendirme metrikleri" },
  { value: "audit_pack_csv", label: "Denetim paketi", detail: "İnceleme için gider defteri satırları ve ilişkili denetim olayları" },
        { value: "dataset_export_jsonl", label: "Veri kümesi JSONL", detail: "Belge görsel referansları, anotasyonlar, düzeltmeler ve etkin öğrenme metadatası" }
      ]
    : [
        { value: "expense_ledger_csv", label: "Expense ledger", detail: "Row-level export of workspace expenses" },
        { value: "category_breakdown_csv", label: "Category breakdown", detail: "Totals grouped by category ID" },
        { value: "merchant_spend_csv", label: "Merchant spend", detail: "Totals grouped by merchant" },
        { value: "monthly_expense_report_pdf", label: "Monthly PDF", detail: "Persistent summary PDF with totals and merchant spend" },
        { value: "approval_evidence_csv", label: "Approval evidence", detail: "Approval SLA, policy and reimbursement evidence for accounting/audit review" },
        { value: "reimbursement_batch_csv", label: "Reimbursement batch", detail: "Approved and paid claim rows for finance review" },
        { value: "reimbursement_claim_report_pdf", label: "Reimbursement PDF", detail: "Summary PDF of approved and paid claims for finance review" },
        { value: "ocr_quality_report_csv", label: "OCR quality", detail: "Engine confidence, latency, error and ensemble conflicts" },
        { value: "model_evaluation_report_csv", label: "Model evaluation", detail: "Training and evaluation metrics from the model registry" },
        { value: "audit_pack_csv", label: "Audit pack", detail: "Expense ledger rows and related audit events for review" },
        { value: "dataset_export_jsonl", label: "Dataset JSONL", detail: "Document image references, annotations, corrections and active-learning metadata" }
      ];
}

export function ReportsClient() {
  const { locale } = useLocale();
  const dateLocale = locale === "tr" ? "tr-TR" : "en-US";
  const text = copy[locale];
  const [state, setState] = useState<ReportsState>({ kind: "loading" });
  const [submitState, setSubmitState] = useState<SubmitState>({ kind: "idle" });

  async function load(preferredWorkspaceId?: string, preferredMonth?: string, latestReport?: GeneratedReportSummary | null) {
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
      const month = preferredMonth ?? currentMonthKey();
      const canExport = principal.principal.permissions.includes("reports.export");
      const exportJobs =
        selectedWorkspaceId && canExport
          ? (
              await apiRequest<{ exportJobs: ExportJobSummary[] }>(
                `/reports/exports?workspaceId=${encodeURIComponent(selectedWorkspaceId)}`,
                { headers: authHeaders(session.tokens.accessToken) }
              )
            ).exportJobs
          : [];
      setState({
        kind: "ready",
        session,
        principal: principal.principal,
        workspaces,
        selectedWorkspaceId,
        month,
        exportJobs,
        latestReport: latestReport ?? null
      });
    } catch (caught) {
      setState({ kind: "error", message: formatReportError(caught, locale, "load") });
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const canExport = state.kind === "ready" && state.principal.permissions.includes("reports.export");

  async function createExport(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.kind !== "ready" || !canExport) return;
    const form = new FormData(event.currentTarget);
    setSubmitState({ kind: "submitting" });
    try {
      const latestReport = await apiRequest<GeneratedReportSummary>("/reports/exports", {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken),
        body: JSON.stringify({
          workspaceId: state.selectedWorkspaceId,
          type: form.get("type"),
          month: state.month
        })
      });
      setSubmitState({ kind: "idle" });
      await load(state.selectedWorkspaceId, state.month, latestReport);
    } catch (caught) {
      setSubmitState({ kind: "error", message: formatReportError(caught, locale, "export") });
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
    <Shell title={text.title} detail={`${state.principal.displayName} - ${text.detail}`} text={text}>
      <div className="grid gap-8 xl:grid-cols-[390px_minmax(0,1fr)]">
        <section className="border-y border-black/10 py-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold">{text.createExport}</h2>
              <p className="mt-1 text-sm text-steel">{text.createExportDetail}</p>
            </div>
            <span className={canExport ? "text-xs font-semibold uppercase tracking-normal text-signal" : "text-xs font-semibold uppercase tracking-normal text-black/35"}>
              {canExport ? text.authorized : text.unauthorized}
            </span>
          </div>

          <form onSubmit={createExport} className="mt-6 space-y-4">
            <Field label={text.workspace}>
              <select
                className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal"
                value={state.selectedWorkspaceId}
                onChange={(event) => void load(event.target.value, state.month, state.latestReport)}
              >
                {state.workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={text.month}>
              <input
                type="month"
                value={state.month}
                className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal"
                onChange={(event) => void load(state.selectedWorkspaceId, event.target.value, state.latestReport)}
              />
            </Field>
            <Field label={text.exportType}>
              <select name="type" className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal">
                {reportTypes(locale).map((type) => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </select>
            </Field>
            {submitState.kind === "error" ? <p className="text-sm font-medium text-red-700">{submitState.message}</p> : null}
            <button
              className="h-11 w-full bg-ink text-sm font-semibold text-paper hover:bg-signal disabled:cursor-not-allowed disabled:bg-black/25"
              disabled={!canExport || !state.selectedWorkspaceId || submitState.kind === "submitting"}
            >
              {submitState.kind === "submitting" ? text.creating : text.create}
            </button>
          </form>

          {state.latestReport ? (
            <div className="mt-6 border-t border-black/10 pt-5">
              <p className="text-xs font-semibold uppercase tracking-normal text-steel">{text.latestExport}</p>
              <p className="mt-2 text-sm font-medium">{state.latestReport.contentType}</p>
              <p className="mt-2 text-sm text-steel">{locale === "tr" ? "Dosya güvenli biçimde oluşturuldu." : "The file was generated securely."}</p>
              <a className="mt-4 inline-flex h-10 items-center bg-signal px-4 text-sm font-semibold text-white" href={state.latestReport.signedUrl}>
                {text.export}
              </a>
            </div>
          ) : null}
        </section>

        <section className="border-y border-black/10 py-6">
          <div className="flex flex-col gap-4 border-b border-black/10 pb-5 md:flex-row md:items-end md:justify-between">
            <div>
              <h2 className="text-xl font-semibold">{text.exportJobs}</h2>
              <p className="mt-1 text-sm text-steel">{locale === "tr" ? "Bu çalışma alanı için üretilen dışa aktarmaları burada izleyebilirsiniz." : "Review the exports generated for this workspace here."}</p>
            </div>
            <span className="text-sm text-steel">{state.exportJobs.length} {locale === "tr" ? "iş" : "jobs"}</span>
          </div>

          {!canExport ? (
            <div className="py-12 text-sm text-steel">{locale === "tr" ? "Bu hesap rapor dışa aktarma yetkisine sahip değil." : "This account cannot export reports."}</div>
          ) : state.exportJobs.length === 0 ? (
            <div className="py-12 text-sm text-steel">{locale === "tr" ? "Bu çalışma alanı için henüz dışa aktarım üretilmemiş." : "No exports have been generated for this workspace yet."}</div>
          ) : (
            <div className="divide-y divide-black/10">
              {state.exportJobs.map((job) => (
                <div key={job.id} className="grid gap-3 py-5 lg:grid-cols-[220px_1fr_110px]">
                  <div>
                    <div className="text-sm font-semibold">{labelForReport(job.type, locale)}</div>
                    <div className="mt-1 text-xs text-steel">{new Date(job.createdAt).toLocaleString(dateLocale)}</div>
                  </div>
                  <div className="min-w-0 text-sm text-steel">
                    {job.objectKey ? (locale === "tr" ? "Dosya hazır" : "File ready") : locale === "tr" ? "Dosya yok" : "No file"}
                  </div>
                  <div className={job.status === "SUCCEEDED" ? "text-sm font-semibold text-signal" : "text-sm font-semibold text-red-700"}>
                    {formatExportStatus(job.status)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </Shell>
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

function currentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, "0")}`;
}

function labelForReport(type: ReportExportType, locale: "tr" | "en"): string {
  return reportTypes(locale).find((item) => item.value === type)?.label ?? type;
}

function formatExportStatus(status: string): string {
  const labels: Record<string, string> = {
    PENDING: "Beklemede",
    RUNNING: "Çalışıyor",
    SUCCEEDED: "Tamamlandı",
    FAILED: "Başarısız"
  };
  return labels[status] ?? status.replaceAll("_", " ");
}

function formatReportError(caught: unknown, locale: "tr" | "en", context: "load" | "export"): string {
  const raw = caught instanceof Error ? caught.message : String(caught);
  const friendly = formatUserFacingError(raw, locale);
  if (friendly !== raw) return friendly;
  if (context === "export") {
    return locale === "tr" ? "Dışa aktarım oluşturulamadı. Filtreleri kontrol edip tekrar deneyin." : "The export could not be generated. Check the filters and try again.";
  }
  return locale === "tr" ? "Raporlar şu anda yüklenemedi. Sayfayı yenileyip tekrar deneyin." : "Reports could not be loaded right now. Refresh the page and try again.";
}
