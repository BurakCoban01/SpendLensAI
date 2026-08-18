"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  apiRequest,
  authHeaders,
  formatUserFacingError,
  type AdminDocumentReprocessResponse,
  type AdminHealthResponse,
  type AuthResponse,
  type PrincipalResponse
} from "../lib/api";
import { readSession } from "../lib/session";
import { AppShell } from "./app-shell";
import { useLocale } from "../lib/locale";
import { SessionRecoveryActions } from "./session-recovery-actions";

const copy = {
  tr: {
    loading: "Operasyon",
    loadingDetail: "Bağımlılık sağlığı yükleniyor.",
    anonymousDetail: "Operasyon konsolunu açmak için önce giriş yapın.",
    signIn: "Giriş yap",
    title: "Operasyon",
    detail: "bağımlılık durumu",
    noAccess: "Bu hesap admin sağlık durumunu okuyamaz.",
    noSnapshot: "Sağlık anlık görüntüsü dönmedi.",
    refresh: "Yenile",
    systemHealth: "Sistem sağlığı",
    systemHealthDetail: "Yerel servisler ve Worker hazır durumu için yalnızca admin erişimli bağımlılık özeti.",
    generalStatus: "Genel durum",
    checkTime: "Kontrol zamanı",
    components: "Bileşenler",
    ready: "Hazır",
    operationsSnapshot: "Operasyon anlık görünümü",
    workspaces: "Çalışma alanları",
    documents: "Belgeler",
    activeExpenses: "Aktif giderler",
    archivedExpenses: "Arşiv giderler",
    storageBackend: "Depolama altyapısı",
    documentSize: "Belge boyutu",
    storedObject: "Saklanan nesne",
    requestLimit: "İstek sınırı",
    storageErrors: "Depolama hataları",
    totalSpend: "Toplam harcama",
    storageQuota: "Depolama kotası",
    quotaUsage: "Kota kullanımı",
    softLimit: "Yumuşak sınır",
    remaining: "Kalan",
    featureFlags: "Özellik bayrakları",
    runbooks: "Çalıştırma rehberleri",
    reprocessTitle: "Belgeyi yeniden işle",
    reprocessDetail: "Var olan çalışma alanı belgesi için seçili Worker aşamalarını kuyruğa alır.",
    active: "Yetkili",
    noPermission: "Yetki yok",
    documentId: "Belge dosya kimliği",
    checkpoint: "İsteğe bağlı Custom OCR kontrol noktası",
    preprocess: "Ön işleme",
    enqueue: "Yeniden işlemeyi kuyruğa al",
    enqueuing: "Kuyruğa alınıyor...",
    success: "iş kuyruğa alındı",
    exit: "Çıkış yap",
    reports: "Raporlar",
    dashboard: "Pano"
  },
  en: {
    loading: "Operations",
    loadingDetail: "Loading dependency health.",
    anonymousDetail: "Sign in first to open the operations console.",
    signIn: "Sign in",
    title: "Operations",
    detail: "dependency status",
    noAccess: "This account cannot read admin health.",
    noSnapshot: "No health snapshot returned.",
    refresh: "Refresh",
    systemHealth: "System health",
    systemHealthDetail: "Admin-only dependency summary for local services and worker readiness.",
    generalStatus: "Overall status",
    checkTime: "Check time",
    components: "Components",
    ready: "Ready",
    operationsSnapshot: "Operations snapshot",
    workspaces: "Workspaces",
    documents: "Documents",
    activeExpenses: "Active expenses",
    archivedExpenses: "Archived expenses",
    storageBackend: "Storage backend",
    documentSize: "Document size",
    storedObject: "Stored object",
    requestLimit: "Request limit",
    storageErrors: "Storage errors",
    totalSpend: "Total spend",
    storageQuota: "Storage quota",
    quotaUsage: "Quota usage",
    softLimit: "Soft limit",
    remaining: "Remaining",
    featureFlags: "Feature flags",
    runbooks: "Runbooks",
    reprocessTitle: "Reprocess document",
    reprocessDetail: "Queues the selected worker stages for an existing workspace document.",
    active: "Active",
    noPermission: "No permission",
    documentId: "Document file ID",
    checkpoint: "Optional Custom OCR checkpoint",
    preprocess: "Preprocess",
    enqueue: "Queue reprocess",
    enqueuing: "Queueing...",
    success: "job queued",
    exit: "Sign out",
    reports: "Reports",
    dashboard: "Dashboard"
  }
} as const;

type HealthState =
  | { kind: "loading" }
  | { kind: "anonymous" }
  | { kind: "ready"; session: AuthResponse; principal: PrincipalResponse["principal"]; health: AdminHealthResponse | null }
  | { kind: "error"; message: string };

type ReprocessState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; result: AdminDocumentReprocessResponse["reprocess"] }
  | { kind: "error"; message: string };

const dependencyOrder = ["api", "postgres", "redis", "kafka", "minio", "tesseract", "workers"];

export function AdminHealthClient() {
  const { locale } = useLocale();
  const text = copy[locale];
  const [state, setState] = useState<HealthState>({ kind: "loading" });
  const [reprocessState, setReprocessState] = useState<ReprocessState>({ kind: "idle" });

  async function load() {
    const session = readSession();
    if (!session) {
      setState({ kind: "anonymous" });
      return;
    }
    try {
      const principal = await apiRequest<PrincipalResponse>("/auth/me", {
        headers: authHeaders(session.tokens.accessToken)
      });
      const canReadHealth = principal.principal.permissions.includes("admin.health.read");
      const health = canReadHealth
        ? await apiRequest<AdminHealthResponse>("/admin/health", {
            headers: authHeaders(session.tokens.accessToken)
          })
        : null;
      setState({ kind: "ready", session, principal: principal.principal, health });
    } catch (caught) {
      setState({ kind: "error", message: caught instanceof Error ? caught.message : "HEALTH_LOAD_FAILED" });
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const rows = useMemo(() => {
    if (state.kind !== "ready" || !state.health) return [];
    const seen = new Set<string>();
    const ordered = dependencyOrder.flatMap((key) => {
      const check = state.health?.checks[key];
      if (!check) return [];
      seen.add(key);
      return [{ key, ...check }];
    });
    const remaining = Object.entries(state.health.checks)
      .filter(([key]) => !seen.has(key))
      .map(([key, check]) => ({ key, ...check }));
    return [...ordered, ...remaining];
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

  if (state.kind === "error") {
    return (
      <Shell title={text.title} detail={formatUserFacingError(state.message, locale)} text={text}>
        <SessionRecoveryActions locale={locale} />
      </Shell>
    );
  }

  const canReadHealth = state.principal.permissions.includes("admin.health.read");
  const canManageJobs = state.principal.permissions.includes("admin.jobs.manage");
  const operations = state.health?.operations ?? null;
  const allowUnregisteredCustomOcrCheckpoint =
    operations?.featureFlags.some((flag) => flag.key === "customOcrUnregisteredCheckpoint" && flag.enabled) ?? false;

  async function reprocessDocument(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.kind !== "ready" || !canReadHealth || !canManageJobs) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const documentFileId = String(form.get("documentFileId") ?? "").trim();
    const stages = form.getAll("stages").map(String);
    if (!documentFileId || stages.length === 0) {
      setReprocessState({ kind: "error", message: "Belge ID girin ve en az bir aşama seçin." });
      return;
    }
    setReprocessState({ kind: "submitting" });
    try {
      const result = await apiRequest<AdminDocumentReprocessResponse>(
        `/admin/operations/documents/${encodeURIComponent(documentFileId)}/reprocess`,
        {
          method: "POST",
          headers: authHeaders(state.session.tokens.accessToken),
          body: JSON.stringify({
            stages,
            preprocessingProfile: form.get("preprocessingProfile"),
            language: form.get("language"),
            ...(allowUnregisteredCustomOcrCheckpoint
              ? { checkpoint: String(form.get("checkpoint") ?? "").trim() || null }
              : {})
          })
        }
      );
      setReprocessState({ kind: "success", result: result.reprocess });
      formElement.reset();
      await load();
    } catch (caught) {
      setReprocessState({ kind: "error", message: caught instanceof Error ? caught.message : "REPROCESS_FAILED" });
    }
  }

  return (
    <Shell title={text.title} detail={`${state.principal.displayName} - ${text.detail}`} text={text}>
      <section className="border-y border-black/10 py-6">
        <div className="flex flex-col gap-4 border-b border-black/10 pb-5 md:flex-row md:items-end md:justify-between">
          <div>
            <h2 className="text-xl font-semibold">{text.systemHealth}</h2>
            <p className="mt-1 text-sm text-steel">{text.systemHealthDetail}</p>
          </div>
          <div className="flex items-center gap-3">
            {state.health ? <span className={statusClass(state.health.status)}>{state.health.status}</span> : null}
            <button className="h-10 border border-black/15 px-4 text-sm font-semibold hover:border-signal hover:text-signal" onClick={() => void load()}>
              {text.refresh}
            </button>
          </div>
        </div>

        {!canReadHealth ? (
          <div className="py-12 text-sm text-steel">{text.noAccess}</div>
        ) : !state.health ? (
          <div className="py-12 text-sm text-steel">{text.noSnapshot}</div>
        ) : (
          <>
            <div className="grid gap-4 border-b border-black/10 py-5 md:grid-cols-3">
              <Metric label={text.generalStatus} value={state.health.status} tone={state.health.status} />
              <Metric label={text.checkTime} value={new Date(state.health.checkedAt).toLocaleString(locale === "tr" ? "tr-TR" : "en-US")} />
              <Metric label={text.components} value={String(rows.length)} />
            </div>
            <div className="divide-y divide-black/10">
              {rows.map((row) => (
                <div key={row.key} className="grid gap-3 py-5 md:grid-cols-[180px_120px_1fr]">
                  <div className="text-sm font-semibold">{healthComponentLabel(row.key, locale)}</div>
                  <div className={statusClass(row.status)}>{row.status}</div>
                  <div className="text-sm text-steel">{formatHealthDetail(row.key, row.detail, locale, text.ready)}</div>
                </div>
              ))}
            </div>
            {operations ? (
              <div className="border-t border-black/10 py-6">
                <h2 className="text-xl font-semibold">{text.operationsSnapshot}</h2>
                <div className="mt-5 grid gap-4 md:grid-cols-4">
                  <Metric label={text.workspaces} value={String(operations.tenantUsage.workspaceCount)} />
                  <Metric label={text.documents} value={String(operations.tenantUsage.documentCount)} />
                  <Metric label={text.activeExpenses} value={String(operations.tenantUsage.activeExpenseCount)} />
                  <Metric label={text.archivedExpenses} value={String(operations.tenantUsage.archivedExpenseCount)} />
                </div>
                <div className="mt-5 grid gap-4 md:grid-cols-3">
                  <Metric label={text.storageBackend} value={operations.storageUsage.backend} tone={operations.storageUsage.connected ? "ok" : "degraded"} />
                  <Metric label={text.documentSize} value={formatBytes(operations.storageUsage.documentBytes)} />
                  <Metric label={text.storedObject} value={operations.storageUsage.storedObjectCount === null ? (locale === "tr" ? "yok" : "n/a") : String(operations.storageUsage.storedObjectCount)} />
                </div>
                <div className="mt-5 grid gap-4 md:grid-cols-3">
                  <Metric label={text.requestLimit} value={`${operations.rateLimit.max} / ${operations.rateLimit.timeWindow}`} />
                  <Metric label={text.storageErrors} value={String(operations.storageUsage.operationErrorCount)} tone={operations.storageUsage.operationErrorCount > 0 ? "degraded" : "ok"} />
                  <Metric label={text.totalSpend} value={formatCurrencyTotals(operations.tenantUsage.totalExpenseMinorByCurrency)} />
                </div>
                <div className="mt-5 border-t border-black/10 pt-5">
                  <div className="grid gap-4 md:grid-cols-4">
                    <Metric label={text.storageQuota} value={operations.storageUsage.quota.status} tone={quotaTone(operations.storageUsage.quota.status)} />
                    <Metric label={text.quotaUsage} value={`${operations.storageUsage.quota.utilizationPercent.toFixed(2)}%`} />
                    <Metric label={text.softLimit} value={formatBytes(operations.storageUsage.quota.softLimitBytes)} />
                    <Metric label={text.remaining} value={formatBytes(operations.storageUsage.quota.remainingBytes)} />
                  </div>
                  <div className="mt-4 h-2 w-full bg-black/10">
                    <div className={operations.storageUsage.quota.status === "exceeded" ? "h-2 bg-red-700" : operations.storageUsage.quota.status === "warning" ? "h-2 bg-amber-600" : "h-2 bg-signal"} style={{ width: `${Math.min(100, Math.max(0, operations.storageUsage.quota.utilizationPercent))}%` }} />
                  </div>
                </div>
                <details className="mt-6 border border-black/10 bg-paper p-4">
                  <summary className="cursor-pointer text-sm font-semibold">
                    {locale === "tr" ? "Gelişmiş operasyon araçlarını aç" : "Open advanced operations tools"}
                  </summary>
                <div className="mt-5 grid gap-6 md:grid-cols-2">
                  <div>
                    <h3 className="text-sm font-semibold uppercase tracking-normal text-steel">{text.featureFlags}</h3>
                    <div className="mt-3 divide-y divide-black/10">
                      {operations.featureFlags.map((flag) => (
                        <div key={flag.key} className="grid gap-2 py-3 md:grid-cols-[160px_100px_1fr]">
                          <div className="text-sm font-semibold">{flag.key}</div>
                          <div className={statusClass(flag.enabled ? "ok" : "unknown")}>{flag.enabled ? "açık" : "kapalı"}</div>
                          <div className="text-sm text-steel">{formatFeatureDetail(flag.key, flag.detail, locale)}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold uppercase tracking-normal text-steel">{text.runbooks}</h3>
                    <div className="mt-3 divide-y divide-black/10">
                      {operations.runbooks.map((runbook) => (
                        <div key={runbook.path} className="py-3">
                          <div className="text-sm font-semibold">{runbook.label}</div>
                          <div className="mt-1 font-mono text-xs text-steel">{runbook.path}</div>
                          <div className="mt-1 text-sm text-steel">{formatRunbookDetail(runbook.path, runbook.detail, locale)}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                <form onSubmit={reprocessDocument} className="mt-6 border-t border-black/10 pt-5">
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div>
                      <h3 className="text-sm font-semibold uppercase tracking-normal text-steel">{text.reprocessTitle}</h3>
                      <p className="mt-2 text-sm text-steel">{text.reprocessDetail}</p>
                    </div>
                    <span className={canManageJobs ? "text-xs font-semibold uppercase tracking-normal text-signal" : "text-xs font-semibold uppercase tracking-normal text-black/35"}>
                      {canManageJobs ? text.active : text.noPermission}
                    </span>
                  </div>
                  <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_180px_140px]">
                    <input name="documentFileId" required placeholder={text.documentId} className="h-11 border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal" />
                    <input name="preprocessingProfile" defaultValue="TESSERACT_OPTIMIZED" className="h-11 border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal" />
                    <input name="language" defaultValue="tur+eng" className="h-11 border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal" />
                  </div>
                  {allowUnregisteredCustomOcrCheckpoint ? (
                    <input name="checkpoint" placeholder={text.checkpoint} className="mt-3 h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal" />
                  ) : null}
                  <div className="mt-4 flex flex-wrap gap-4 text-sm">
                    <label className="inline-flex items-center gap-2">
                      <input name="stages" type="checkbox" value="preprocess" defaultChecked />
                      {text.preprocess}
                    </label>
                    <label className="inline-flex items-center gap-2">
                      <input name="stages" type="checkbox" value="tesseract" defaultChecked />
                      Tesseract
                    </label>
                    <label className="inline-flex items-center gap-2">
                      <input name="stages" type="checkbox" value="custom_crnn" />
                      Custom OCR
                    </label>
                  </div>
                  {reprocessState.kind === "error" ? <p className="mt-3 text-sm font-medium text-red-700">{reprocessState.message}</p> : null}
                  {reprocessState.kind === "success" ? (
                    <p className="mt-3 text-sm font-medium text-signal">
                      {reprocessState.result.enqueued.length} {locale === "tr" ? "iş" : "job"} kuyruğa alındı: {reprocessState.result.enqueued.map((item) => `${item.stage}:${item.job.id}`).join(", ")}
                    </p>
                  ) : null}
                  <button
                    className="mt-4 h-11 bg-ink px-4 text-sm font-semibold text-paper hover:bg-signal disabled:cursor-not-allowed disabled:bg-black/25"
                    disabled={!canManageJobs || reprocessState.kind === "submitting"}
                  >
                    {reprocessState.kind === "submitting" ? text.enqueuing : text.enqueue}
                  </button>
                </form>
                </details>
              </div>
            ) : null}
          </>
        )}
      </section>
    </Shell>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-normal text-steel">{label}</div>
      <div className={tone ? `${statusClass(tone)} mt-2 inline-flex` : "mt-2 text-2xl font-semibold"}>{value}</div>
    </div>
  );
}

function Shell({ title, detail, children, text }: { title: string; detail: string; children?: React.ReactNode; text: (typeof copy)[keyof typeof copy] }) {
  void text;
  return <AppShell title={title} detail={detail}>{children}</AppShell>;
}

function statusClass(status: string): string {
  if (status === "ok") return "text-sm font-semibold uppercase tracking-normal text-signal";
  if (status === "warning") return "text-sm font-semibold uppercase tracking-normal text-amber-700";
  if (status === "degraded") return "text-sm font-semibold uppercase tracking-normal text-red-700";
  return "text-sm font-semibold uppercase tracking-normal text-black/40";
}

function formatBytes(value: string): string {
  const bytes = Number.parseInt(value, 10);
  if (!Number.isFinite(bytes) || bytes === 0) return "0 B";
  const sign = bytes < 0 ? "-" : "";
  const units = ["B", "KB", "MB", "GB"];
  let amount = Math.abs(bytes);
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  return `${sign}${amount.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatCurrencyTotals(totals: Record<string, string>): string {
  const entries = Object.entries(totals);
  if (entries.length === 0) return "0";
  return entries
    .map(([currency, minor]) => `${currency} ${(Number.parseInt(minor, 10) / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`)
    .join(", ");
}

function quotaTone(status: NonNullable<AdminHealthResponse["operations"]>["storageUsage"]["quota"]["status"]): string {
  if (status === "exceeded") return "degraded";
  if (status === "warning") return "warning";
  return "ok";
}

function healthComponentLabel(key: string, locale: "tr" | "en"): string {
  if (locale === "en") return key;
  return {
    api: "API",
    postgres: "PostgreSQL",
    redis: "Redis",
    kafka: "Kafka",
    minio: "MinIO",
    tesseract: "Tesseract",
    workers: "Worker'lar",
    ocrService: "OCR servisi"
  }[key] ?? key;
}

function formatHealthDetail(key: string, detail: string | undefined, locale: "tr" | "en", ready: string): string {
  if (!detail) return ready;
  if (locale === "en") return detail;
  if (key === "tesseract" && /Ready with tur\+eng languages/i.test(detail)) return "Türkçe ve İngilizce dil paketleriyle hazır";
  if (key === "workers" && /active local worker runtime heartbeat/i.test(detail)) {
    const count = detail.match(/^\d+/)?.[0] ?? "1";
    return `${count} etkin yerel worker sinyali alınıyor`;
  }
  if (key === "ocrService" && /reachable and ready/i.test(detail)) return "OCR servisine erişiliyor ve servis hazır";
  return detail;
}

function formatFeatureDetail(key: string, fallback: string, locale: "tr" | "en"): string {
  if (locale === "en") return fallback;
  return {
    memoryAdapters: "Yerel smoke ve tarayıcı testlerinde bellek içi depoları kullanır.",
    customOcrUnregisteredCheckpoint: "Yalnızca kontrollü yerel tanılama için kayıt dışı Custom OCR checkpoint kullanımına izin verir.",
    kafkaProducer: "Kalıcı olay çıkış kuyruğunu Kafka uyumlu broker'a gönderir.",
    kafkaLagMetrics: "Kafka tüketici gecikmesini gözlemlenebilirlik metriklerine ekler.",
    redisRateLimit: "Genel API istek sınırlarını Redis üzerinden koordine eder.",
    minioStorage: "Belge ve rapor dosyalarını S3 uyumlu MinIO depolamasında saklar."
  }[key] ?? fallback;
}

function formatRunbookDetail(path: string, fallback: string, locale: "tr" | "en"): string {
  if (locale === "en") return fallback;
  if (path.includes("dependency-degraded")) return "Yerel PostgreSQL, Redis, Kafka, MinIO, OCR veya worker bağımlılıklarını kurtarma adımları.";
  if (path.includes("COMPLETION_AUDIT")) return "Ürün hazırlığı kontrollerini ve doğrulama kanıtlarını izler.";
  if (path.includes("KAFKA_EVENTS")) return "Olay kataloğu, outbox/inbox, hata kuyruğu ve gecikme metrikleri için başvuru.";
  return fallback;
}
