"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  apiRequest,
  authHeaders,
  formatUserFacingError,
  type AdminAuditExportResponse,
  type AdminAuditResponse,
  type AdminAuditRetentionResponse,
  type AuthResponse,
  type PrincipalResponse
} from "../lib/api";
import { readSession } from "../lib/session";
import { AppShell } from "./app-shell";
import { useLocale } from "../lib/locale";
import { SessionRecoveryActions } from "./session-recovery-actions";

const copy = {
  tr: {
    loading: "Denetim kayıtları",
    loadingDetail: "Çalışma alanı aktivitesi yükleniyor.",
    anonymousDetail: "Operasyon geçmişini açmak için önce giriş yapın.",
    signIn: "Giriş yap",
    deniedDetail: "hesabında admin.audit.read yetkisi yok.",
    title: "Denetim kayıtları",
    detail: "Güvenlik incelemesi ve operasyon izlenebilirliği için çalışma alanı kapsamlı değişmez aktivite.",
    actionPlaceholder: "Aksiyon",
    resourcePlaceholder: "Kaynak türü",
    actorPlaceholder: "Aktör kullanıcı ID",
    refresh: "Yenile",
    exportJsonl: "JSONL dışa aktar",
    downloadRows: "satır indir",
    generated: "üretildi.",
    dryRun: "Saklama önizle",
    apply: "Uygula",
    totalEvents: "Toplam olay",
    actions: "Aksiyonlar",
    resources: "Kaynaklar",
    noData: "Henüz veri yok.",
    noLogs: "Geçerli filtrelerle eşleşen denetim kaydı yok.",
    noCorrelationId: "no-correlation-id",
    system: "sistem",
    cutoff: "Kesim tarihi",
    matched: "eşleşen",
    deleted: "silinen",
    exit: "Çıkış yap",
    dashboard: "Pano"
  },
  en: {
    loading: "Audit logs",
    loadingDetail: "Loading workspace activity.",
    anonymousDetail: "Sign in first to open operational history.",
    signIn: "Sign in",
    deniedDetail: "does not have admin.audit.read permission.",
    title: "Audit logs",
    detail: "Workspace-scoped immutable activity for security review and operational traceability.",
    actionPlaceholder: "Action",
    resourcePlaceholder: "Resource type",
    actorPlaceholder: "Actor user ID",
    refresh: "Refresh",
    exportJsonl: "Export JSONL",
    downloadRows: "download rows",
    generated: "generated.",
    dryRun: "Retention preview",
    apply: "Apply",
    totalEvents: "Total events",
    actions: "Actions",
    resources: "Resources",
    noData: "No data yet.",
    noLogs: "No audit logs match the current filters.",
    noCorrelationId: "no-correlation-id",
    system: "system",
    cutoff: "Cutoff",
    matched: "matched",
    deleted: "deleted",
    exit: "Sign out",
    dashboard: "Dashboard"
  }
} as const;

type AuditState =
  | { kind: "loading" }
  | { kind: "anonymous" }
  | { kind: "denied"; principal: PrincipalResponse["principal"] }
  | { kind: "ready"; session: AuthResponse; principal: PrincipalResponse["principal"]; audit: AdminAuditResponse }
  | { kind: "error"; message: string };

export function AdminAuditClient() {
  const { locale } = useLocale();
  const text = copy[locale];
  const [state, setState] = useState<AuditState>({ kind: "loading" });
  const [action, setAction] = useState("");
  const [resourceType, setResourceType] = useState("");
  const [actorUserId, setActorUserId] = useState("");
  const [exportResult, setExportResult] = useState<AdminAuditExportResponse | null>(null);
  const [retentionDays, setRetentionDays] = useState(365);
  const [retentionResult, setRetentionResult] = useState<AdminAuditRetentionResponse | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);

  async function load(sessionOverride?: AuthResponse) {
    const session = sessionOverride ?? readSession();
    if (!session) {
      setState({ kind: "anonymous" });
      return;
    }
    try {
      const principal = await apiRequest<PrincipalResponse>("/auth/me", {
        headers: authHeaders(session.tokens.accessToken)
      });
      if (!principal.principal.permissions.includes("admin.audit.read")) {
        setState({ kind: "denied", principal: principal.principal });
        return;
      }
      const params = new URLSearchParams();
      params.set("limit", "20");
      if (action.trim()) params.set("action", action.trim());
      if (resourceType.trim()) params.set("resourceType", resourceType.trim());
      if (actorUserId.trim()) params.set("actorUserId", actorUserId.trim());
      const suffix = params.toString() ? `?${params.toString()}` : "";
      const audit = await apiRequest<AdminAuditResponse>(`/admin/audit${suffix}`, {
        headers: authHeaders(session.tokens.accessToken)
      });
      setState({ kind: "ready", session, principal: principal.principal, audit });
    } catch (caught) {
      setState({ kind: "error", message: caught instanceof Error ? caught.message : "AUDIT_LOAD_FAILED" });
    }
  }

  function currentFilters(limit = 1000) {
    return {
      ...(action.trim() ? { action: action.trim() } : {}),
      ...(resourceType.trim() ? { resourceType: resourceType.trim() } : {}),
      ...(actorUserId.trim() ? { actorUserId: actorUserId.trim() } : {}),
      limit
    };
  }

  async function exportAudit() {
    if (state.kind !== "ready") return;
    setOperationError(null);
    try {
      const result = await apiRequest<AdminAuditExportResponse>("/admin/audit/export", {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken),
        body: JSON.stringify(currentFilters(1000))
      });
      setExportResult(result);
    } catch (caught) {
      setOperationError(caught instanceof Error ? caught.message : "AUDIT_EXPORT_FAILED");
    }
  }

  async function runRetention(dryRun: boolean) {
    if (state.kind !== "ready") return;
    setOperationError(null);
    try {
      const result = await apiRequest<AdminAuditRetentionResponse>("/admin/audit/retention", {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken),
        body: JSON.stringify({ retentionDays, dryRun, confirm: !dryRun })
      });
      setRetentionResult(result);
      if (!dryRun) await load(state.session);
    } catch (caught) {
      setOperationError(caught instanceof Error ? caught.message : "AUDIT_RETENTION_FAILED");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const actionOptions = useMemo(() => {
    if (state.kind !== "ready") return [];
    return state.audit.summary.actions.map((row) => row.action);
  }, [state]);

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

  if (state.kind === "denied") {
    return <Shell title={text.title} detail={`${state.principal.displayName} ${text.deniedDetail}`} text={text} />;
  }

  if (state.kind === "error") {
    return (
      <Shell title={text.title} detail={formatUserFacingError(state.message, locale)} text={text}>
        <SessionRecoveryActions locale={locale} />
      </Shell>
    );
  }

  const canManageAudit = state.principal.permissions.includes("admin.audit.manage");

  return (
    <Shell title={text.title} detail={text.detail} text={text}>
      <form
        className="grid gap-3 border-y border-black/10 py-4 md:grid-cols-[1fr_1fr_1fr_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          void load(state.session);
        }}
      >
        <input
          list="audit-actions"
          value={action}
          onChange={(event) => setAction(event.target.value)}
          placeholder={text.actionPlaceholder}
          className="h-10 border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal"
        />
        <datalist id="audit-actions">
          {actionOptions.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
        <input
          value={resourceType}
          onChange={(event) => setResourceType(event.target.value)}
          placeholder={text.resourcePlaceholder}
          className="h-10 border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal"
        />
        <input
          value={actorUserId}
          onChange={(event) => setActorUserId(event.target.value)}
          placeholder={text.actorPlaceholder}
          className="h-10 border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal"
        />
        <button className="h-10 bg-ink px-4 text-sm font-semibold text-paper hover:bg-signal">{text.refresh}</button>
      </form>

      <section className="grid gap-4 border-b border-black/10 py-5 lg:grid-cols-[1fr_360px]">
        <div>
          <div className="flex flex-wrap gap-3">
            <button className="h-10 border border-black/15 px-4 text-sm font-semibold hover:border-signal hover:text-signal" onClick={() => void exportAudit()}>
              {text.exportJsonl}
            </button>
            {exportResult ? (
              <a
                className="inline-flex h-10 items-center border border-black/15 px-4 text-sm font-semibold hover:border-signal hover:text-signal"
                download={exportResult.filename}
                href={`data:application/x-ndjson;charset=utf-8,${encodeURIComponent(exportResult.content)}`}
              >
              {exportResult.count} {text.downloadRows}
              </a>
            ) : null}
          </div>
          {exportResult ? (
            <p className="mt-3 text-sm text-steel">
              {exportResult.filename}, {new Date(exportResult.generatedAt).toLocaleString(locale === "tr" ? "tr-TR" : "en-US")} tarihinde {exportResult.count} satırla {text.generated}
            </p>
          ) : null}
          {operationError ? <p className="mt-3 text-sm text-red-700">{operationError}</p> : null}
        </div>

        <div>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
            <input
              className="h-10 border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal"
              min={1}
              max={3650}
              type="number"
              value={retentionDays}
              onChange={(event) => setRetentionDays(Number(event.target.value))}
            />
            <button
              className="h-10 border border-black/15 px-4 text-sm font-semibold hover:border-signal hover:text-signal disabled:cursor-not-allowed disabled:text-black/35"
              disabled={!canManageAudit}
              onClick={() => void runRetention(true)}
            >
              {text.dryRun}
            </button>
            <button
              className="h-10 bg-ink px-4 text-sm font-semibold text-paper disabled:cursor-not-allowed disabled:bg-black/30"
              disabled={!canManageAudit || !retentionResult?.dryRun}
              onClick={() => void runRetention(false)}
            >
              {text.apply}
            </button>
          </div>
          {retentionResult ? (
            <p className="mt-3 text-sm text-steel">
              {text.cutoff} {new Date(retentionResult.cutoff).toLocaleDateString(locale === "tr" ? "tr-TR" : "en-US")}: {text.matched} {retentionResult.matched}, {text.deleted} {retentionResult.deleted}.
            </p>
          ) : null}
        </div>
      </section>

      <section className="mt-6 grid gap-6 lg:grid-cols-[280px_1fr]">
        <aside className="space-y-6">
          <div>
            <p className="text-xs uppercase tracking-normal text-steel">{text.totalEvents}</p>
            <p className="mt-2 text-4xl font-semibold">{state.audit.summary.total}</p>
          </div>
          <SummaryList title={text.actions} rows={state.audit.summary.actions.map((row) => [row.action, row.count])} noData={text.noData} />
          <SummaryList title={text.resources} rows={state.audit.summary.resources.map((row) => [row.resourceType, row.count])} noData={text.noData} />
        </aside>

        <div className="min-w-0 border-t border-black/10">
          {state.audit.logs.length === 0 ? (
            <p className="py-8 text-sm text-steel">{text.noLogs}</p>
          ) : (
            state.audit.logs.map((log) => (
              <article key={log.id} className="grid gap-3 border-b border-black/10 py-4 lg:grid-cols-[210px_1fr_190px]">
                <div>
                  <p className="text-sm font-semibold">{log.action}</p>
                  <p className="mt-1 text-xs text-steel">{new Date(log.createdAt).toLocaleString("tr-TR")}</p>
                </div>
                <div className="min-w-0">
                  <p className="break-all text-sm">
                    {log.resourceType}
                    {log.resourceId ? <span className="text-steel"> / {log.resourceId}</span> : null}
                  </p>
                  <p className="mt-1 truncate font-mono text-xs text-steel">{log.correlationId ?? text.noCorrelationId}</p>
                  {log.metadata ? (
                    <details className="mt-2 text-xs text-steel">
                      <summary className="cursor-pointer font-semibold">{locale === "tr" ? "Ayrıntılar" : "Details"}</summary>
                      <pre className="mt-2 whitespace-pre-wrap break-all font-mono">{JSON.stringify(log.metadata, null, 2)}</pre>
                    </details>
                  ) : null}
                </div>
                <div className="break-all font-mono text-xs text-steel">{log.actorUserId ?? text.system}</div>
              </article>
            ))
          )}
        </div>
      </section>
    </Shell>
  );
}

function SummaryList({ title, rows, noData }: { title: string; rows: Array<[string, number]>; noData: string }) {
  return (
    <div>
      <h2 className="text-sm font-semibold">{title}</h2>
      <div className="mt-3 space-y-2">
        {rows.length === 0 ? <p className="text-sm text-steel">{noData}</p> : null}
        {rows.map(([label, count]) => (
          <div key={label} className="flex items-center justify-between gap-4 border-t border-black/10 pt-2 text-sm">
            <span className="truncate text-steel">{label}</span>
            <span className="font-semibold">{count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Shell({ title, detail, children, text }: { title: string; detail: string; children?: React.ReactNode; text: (typeof copy)[keyof typeof copy] }) {
  void text;
  return <AppShell title={title} detail={detail}>{children}</AppShell>;
}
