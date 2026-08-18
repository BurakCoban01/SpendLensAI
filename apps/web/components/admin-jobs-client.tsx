"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  apiRequest,
  authHeaders,
  formatUserFacingError,
  type AdminJobsResponse,
  type AuthResponse,
  type PrincipalResponse,
  type WorkerHeartbeatSummary,
  type WorkerJobStatus,
  type WorkerRunNextResponse,
  type WorkerRuntimeMutationResponse,
  type WorkerRuntimeResponse
} from "../lib/api";
import { readSession } from "../lib/session";
import { AppShell } from "./app-shell";
import { useLocale } from "../lib/locale";
import { SessionRecoveryActions } from "./session-recovery-actions";

const copy = {
  tr: {
    loading: "Worker işleri",
    loadingDetail: "Worker iş durumu yükleniyor.",
    anonymousDetail: "İş izleme ekranını açmak için önce giriş yapın.",
    signIn: "Giriş yap",
    title: "Worker işleri",
    detail: "worker kayıt defteri",
    noAccess: "Bu hesap Worker işlerini okuyamaz.",
    jobs: "Worker işleri",
    jobsDetail: "Yerel arka plan işleri için kalıcı durum, yeniden deneme ve ilerleme kayıtları.",
    allQueues: "Tüm kuyruklar",
    allStatuses: "Tüm durumlar",
    refresh: "Yenile",
    runNext: "Sıradakini çalıştır",
    running: "Çalışıyor...",
    noQueued: "Geçerli kuyruk filtresiyle eşleşen bekleyen iş yok.",
    failedJobs: "Bu filtreyle eşleşen iş yok.",
    workTime: "Çalışma zamanı",
    active: "aktif",
    workerRuntime: "Bu çalışma alanı için heartbeat görünürlüğü olan yerel otomatik kuyruk boşaltma.",
    startAutoWorker: "Otomatik Worker başlat",
    updating: "Güncelleniyor...",
    runtimeFailed: "Worker runtime işlemi başarısız oldu.",
    noHeartbeat: "Kaydedilmiş Worker heartbeat yok.",
    queueJob: "Kuyruğa al",
    queueActive: "Aktif",
    noPermission: "Yetki yok",
    queuePrefix: "Kuyruk, örn. ocr",
    jobType: "İş türü, örn. ocr.tesseract",
    dedupeKey: "Dedupe anahtarı",
    eventTopic: "Olay konusu",
    aggregateId: "Aggregate kimliği",
    payloadError: "İş kuyruğa alınamadı.",
    enqueue: "İşi kuyruğa al",
    enqueueing: "Kuyruğa alınıyor...",
    unable: "Bu hesap Worker işi kuyruklayamaz veya tekrar deneyemez.",
    exit: "Çıkış yap",
    events: "Olaylar",
    dashboard: "Pano"
  },
  en: {
    loading: "Worker jobs",
    loadingDetail: "Loading worker job status.",
    anonymousDetail: "Sign in first to open the job monitor.",
    signIn: "Sign in",
    title: "Worker jobs",
    detail: "worker ledger",
    noAccess: "This account cannot read worker jobs.",
    jobs: "Worker jobs",
    jobsDetail: "Persistent status, retry and progress records for local background jobs.",
    allQueues: "All queues",
    allStatuses: "All statuses",
    refresh: "Refresh",
    runNext: "Run next",
    running: "Running...",
    noQueued: "No pending jobs match the current queue filter.",
    failedJobs: "No jobs match this filter.",
    workTime: "Runtime",
    active: "active",
    workerRuntime: "Local auto-drain with heartbeat visibility for this workspace.",
    startAutoWorker: "Start auto worker",
    updating: "Updating...",
    runtimeFailed: "Worker runtime operation failed.",
    noHeartbeat: "No saved worker heartbeat.",
    queueJob: "Queue job",
    queueActive: "Active",
    noPermission: "No permission",
    queuePrefix: "Queue, e.g. ocr",
    jobType: "Job type, e.g. ocr.tesseract",
    dedupeKey: "Dedupe key",
    eventTopic: "Event topic",
    aggregateId: "Aggregate ID",
    payloadError: "Job could not be queued.",
    enqueue: "Queue job",
    enqueueing: "Queueing...",
    unable: "This account cannot queue or retry worker jobs.",
    exit: "Sign out",
    events: "Events",
    dashboard: "Dashboard"
  }
} as const;

type JobsState =
  | { kind: "loading" }
  | { kind: "anonymous" }
  | {
      kind: "ready";
      session: AuthResponse;
      principal: PrincipalResponse["principal"];
      jobs: AdminJobsResponse;
      runtime: WorkerRuntimeResponse;
    }
  | { kind: "error"; message: string };

type FilterStatus = "all" | WorkerJobStatus;
type SubmitState = "idle" | "submitting" | "error";
type WorkerState = "idle" | "running" | "empty" | "error";
type RuntimeActionState = "idle" | "running" | "error";

const statuses: WorkerJobStatus[] = ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELED"];

export function AdminJobsClient() {
  const { locale } = useLocale();
  const text = copy[locale];
  const [state, setState] = useState<JobsState>({ kind: "loading" });
  const [queue, setQueue] = useState("");
  const [status, setStatus] = useState<FilterStatus>("all");
  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const [workerState, setWorkerState] = useState<WorkerState>("idle");
  const [runtimeState, setRuntimeState] = useState<RuntimeActionState>("idle");

  async function load(nextQueue = queue, nextStatus = status) {
    const session = readSession();
    if (!session) {
      setState({ kind: "anonymous" });
      return;
    }
    try {
      const principal = await apiRequest<PrincipalResponse>("/auth/me", {
        headers: authHeaders(session.tokens.accessToken)
      });
      if (!principal.principal.permissions.includes("admin.jobs.read")) {
        setState({
          kind: "ready",
          session,
          principal: principal.principal,
          jobs: { backlog: emptyBacklog(), jobs: [] },
          runtime: { active: 0, workers: [] }
        });
        return;
      }
      const query = new URLSearchParams();
      query.set("limit", "15");
      if (nextQueue) query.set("queue", nextQueue);
      if (nextStatus !== "all") query.set("status", nextStatus);
      const jobs = await apiRequest<AdminJobsResponse>(`/admin/jobs?${query.toString()}`, {
        headers: authHeaders(session.tokens.accessToken)
      });
      const runtime = await apiRequest<WorkerRuntimeResponse>("/admin/jobs/workers", {
        headers: authHeaders(session.tokens.accessToken)
      });
      setState({ kind: "ready", session, principal: principal.principal, jobs, runtime });
    } catch (caught) {
      setState({ kind: "error", message: caught instanceof Error ? caught.message : "JOBS_LOAD_FAILED" });
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const queues = useMemo(() => {
    if (state.kind !== "ready") return [];
    return [...new Set(state.jobs.jobs.map((job) => job.queue))].sort();
  }, [state]);

  async function enqueue(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.kind !== "ready") return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setSubmitState("submitting");
    try {
      const payloadText = String(form.get("payload") ?? "{}");
      await apiRequest("/admin/jobs", {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken),
        body: JSON.stringify({
          queue: form.get("queue"),
          jobType: form.get("jobType"),
          dedupeKey: String(form.get("dedupeKey") ?? "").trim() || null,
          eventTopic: String(form.get("eventTopic") ?? "").trim() || null,
          aggregateId: String(form.get("aggregateId") ?? "").trim() || null,
          payload: JSON.parse(payloadText) as Record<string, unknown>
        })
      });
      setSubmitState("idle");
      formElement.reset();
      await load();
    } catch {
      setSubmitState("error");
    }
  }

  async function retry(jobId: string) {
    if (state.kind !== "ready") return;
    await apiRequest(`/admin/jobs/${jobId}/retry`, {
      method: "POST",
      headers: authHeaders(state.session.tokens.accessToken)
    });
    await load();
  }

  async function runNext() {
    if (state.kind !== "ready") return;
    setWorkerState("running");
    try {
      const response = await apiRequest<WorkerRunNextResponse>("/admin/jobs/run-next", {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken),
        body: JSON.stringify({
          queue: queue || undefined,
          workerId: "browser-admin-worker"
        })
      });
      setWorkerState(response.processed ? "idle" : "empty");
      await load();
    } catch {
      setWorkerState("error");
    }
  }

  async function startRuntime() {
    if (state.kind !== "ready") return;
    setRuntimeState("running");
    try {
      await apiRequest<WorkerRuntimeMutationResponse>("/admin/jobs/workers/start", {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken),
        body: JSON.stringify({
          queue: queue || undefined,
          workerId: queue ? `browser-${queue}-worker` : "browser-auto-worker",
          intervalMs: 1000,
          maxJobsPerTick: 5
        })
      });
      setRuntimeState("idle");
      await load();
    } catch {
      setRuntimeState("error");
    }
  }

  async function stopRuntime(workerId: string) {
    if (state.kind !== "ready") return;
    setRuntimeState("running");
    try {
      await apiRequest<WorkerRuntimeMutationResponse>(`/admin/jobs/workers/${workerId}/stop`, {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken)
      });
      setRuntimeState("idle");
      await load();
    } catch {
      setRuntimeState("error");
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
      <Shell title={text.title} detail={formatUserFacingError(state.message, locale)} text={text}>
        <SessionRecoveryActions locale={locale} />
      </Shell>
    );
  }

  const canRead = state.principal.permissions.includes("admin.jobs.read");
  const canManage = state.principal.permissions.includes("admin.jobs.manage");

  return (
    <Shell title={text.title} detail={`${state.principal.displayName} - ${text.detail}`} text={text}>
      {!canRead ? (
        <section className="border-y border-black/10 py-10 text-sm text-steel">{text.noAccess}</section>
      ) : (
        <section className="grid min-w-0 gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0 border-y border-black/10 py-6">
            <div className="flex flex-wrap items-end gap-4 border-b border-black/10 pb-5">
              <div className="min-w-[220px] flex-1">
                <h2 className="text-xl font-semibold">{text.jobs}</h2>
                <p className="mt-1 text-sm text-steel">{text.jobsDetail}</p>
              </div>
              <select
                className="h-10 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal sm:w-[180px]"
                value={queue}
                onChange={(event) => {
                  setQueue(event.target.value);
                  void load(event.target.value, status);
                }}
              >
                <option value="">{text.allQueues}</option>
                {queues.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
              <select
                className="h-10 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal sm:w-[170px]"
                value={status}
                onChange={(event) => {
                  const next = event.target.value as FilterStatus;
                  setStatus(next);
                  void load(queue, next);
                }}
              >
                <option value="all">{text.allStatuses}</option>
                {statuses.map((item) => (
                  <option key={item} value={item}>
                    {jobStatusLabel(item, locale)}
                  </option>
                ))}
              </select>
              <button className="h-10 border border-black/15 px-4 text-sm font-semibold hover:border-signal hover:text-signal" onClick={() => void load()}>
                {text.refresh}
              </button>
              {canManage ? (
                <button
                  className="h-10 bg-ink px-4 text-sm font-semibold text-paper hover:bg-signal disabled:bg-black/30"
                  disabled={workerState === "running"}
                  onClick={() => void runNext()}
                >
                  {workerState === "running" ? text.running : text.runNext}
                </button>
              ) : null}
            </div>
            {workerState === "empty" ? <p className="mt-3 text-sm text-steel">{text.noQueued}</p> : null}
            {workerState === "error" ? <p className="mt-3 text-sm text-red-700">{text.runtimeFailed}</p> : null}

            <div className="grid gap-4 border-b border-black/10 py-5 md:grid-cols-5">
              {statuses.map((item) => (
                <Metric key={item} label={jobStatusLabel(item, locale)} value={String(state.jobs.backlog[item] ?? 0)} tone={item} />
              ))}
            </div>

            <div className="divide-y divide-black/10">
              {state.jobs.jobs.length === 0 ? (
                <div className="py-10 text-sm text-steel">{text.failedJobs}</div>
              ) : (
                state.jobs.jobs.map((job) => (
                  <div key={job.id} className="grid min-w-0 gap-3 py-5 lg:grid-cols-[190px_minmax(0,1fr)_150px]">
                    <div className="min-w-0">
                      <div className="break-all font-mono text-sm font-semibold">{job.queue}</div>
                      <div className="mt-1 text-xs text-steel">{new Date(job.createdAt).toLocaleString()}</div>
                    </div>
                    <div className="min-w-0">
                      <div className="break-all text-sm font-medium">{job.jobType}</div>
                      <div className="mt-2 h-2 bg-black/10">
                        <div className="h-2 bg-signal" style={{ width: `${job.progress}%` }} />
                      </div>
                      <div className="mt-2 text-xs text-steel">
                        Deneme {job.attempts}/{job.maxAttempts}
                        {job.failureReason ? <span className="break-all"> - {job.failureReason}</span> : null}
                      </div>
                    </div>
                    <div className="flex flex-col items-start gap-3">
                      <span className={statusClass(job.status)}>{jobStatusLabel(job.status, locale)}</span>
                      {canManage && job.status === "FAILED" ? (
                        <button className="text-sm font-semibold text-ink hover:text-signal" onClick={() => void retry(job.id)}>
                          Tekrar dene
                        </button>
                      ) : null}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <aside className="border-l border-black/10 pl-6">
            <div className="border-b border-black/10 pb-6">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold">{text.workTime}</h2>
                <span className="text-xs uppercase tracking-normal text-steel">{state.runtime.active} {text.active}</span>
              </div>
              <p className="mt-2 text-sm leading-6 text-steel">{text.workerRuntime}</p>
              {canManage ? (
                <button
                  className="mt-4 h-10 w-full bg-ink text-sm font-semibold text-paper hover:bg-signal disabled:bg-black/30"
                  disabled={runtimeState === "running"}
                  onClick={() => void startRuntime()}
                >
                  {runtimeState === "running" ? text.updating : text.startAutoWorker}
                </button>
              ) : null}
              {runtimeState === "error" ? <p className="mt-3 text-sm text-red-700">{text.runtimeFailed}</p> : null}
              <div className="mt-5 space-y-4">
                {state.runtime.workers.length === 0 ? <p className="text-sm text-steel">{text.noHeartbeat}</p> : null}
                {state.runtime.workers.map((worker) => (
                  <RuntimeWorker key={worker.workerId} worker={worker} canManage={canManage} onStop={stopRuntime} locale={locale} />
                ))}
              </div>
            </div>

            <div className="mt-6 flex items-center justify-between">
              <h2 className="text-lg font-semibold">{text.queueJob}</h2>
              <span className={canManage ? "text-xs uppercase tracking-normal text-signal" : "text-xs uppercase tracking-normal text-black/35"}>
                {canManage ? text.queueActive : text.noPermission}
              </span>
            </div>
            {canManage ? (
              <form className="mt-5 space-y-3" onSubmit={enqueue}>
                <input name="queue" required placeholder={text.queuePrefix} className="h-10 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal" />
                <input name="jobType" required placeholder={text.jobType} className="h-10 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal" />
                <input name="dedupeKey" placeholder={text.dedupeKey} className="h-10 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal" />
                <input name="eventTopic" placeholder={text.eventTopic} className="h-10 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal" />
                <input name="aggregateId" placeholder={text.aggregateId} className="h-10 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal" />
                <textarea name="payload" defaultValue={'{"documentFileId":"demo"}'} className="min-h-28 w-full border border-black/15 bg-white p-3 font-mono text-xs outline-none focus:border-signal" />
                {submitState === "error" ? <p className="text-sm text-red-700">{text.payloadError}</p> : null}
                <button className="h-10 w-full bg-ink text-sm font-semibold text-paper hover:bg-signal" disabled={submitState === "submitting"}>
                  {submitState === "submitting" ? text.enqueueing : text.enqueue}
                </button>
              </form>
            ) : (
              <p className="mt-4 text-sm leading-6 text-steel">{text.unable}</p>
            )}
          </aside>
        </section>
      )}
    </Shell>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone: WorkerJobStatus }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-normal text-steel">{label}</div>
      <div className={`${statusClass(tone)} mt-2 inline-flex`}>{value}</div>
    </div>
  );
}

function RuntimeWorker({
  worker,
  canManage,
  onStop,
  locale
}: {
  worker: WorkerHeartbeatSummary;
  canManage: boolean;
  onStop: (workerId: string) => Promise<void>;
  locale: "tr" | "en";
}) {
  return (
    <div className="border border-black/10 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-mono text-xs font-semibold">{worker.workerId}</div>
          <div className="mt-1 text-xs text-steel">{worker.queue ?? "tüm kuyruklar"}</div>
        </div>
        <span className={runtimeStatusClass(worker.status)}>{runtimeStatusLabel(worker.status, locale)}</span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 text-xs text-steel">
        <div>İşlenen {worker.processedJobs}</div>
        <div>{locale === "tr" ? "Boş yoklama" : "Empty polls"} {worker.emptyPolls}</div>
        <div className="col-span-2">{locale === "tr" ? "Son sinyal" : "Heartbeat"} {new Date(worker.lastHeartbeatAt).toLocaleString(locale === "tr" ? "tr-TR" : "en-US")}</div>
      </div>
      {worker.lastError ? <p className="mt-2 text-xs text-red-700">{worker.lastError}</p> : null}
      {canManage && worker.status !== "STOPPED" ? (
        <button className="mt-3 text-sm font-semibold text-ink hover:text-signal" onClick={() => void onStop(worker.workerId)}>
          {locale === "tr" ? "Worker'ı durdur" : "Stop worker"}
        </button>
      ) : null}
    </div>
  );
}

function Shell({ title, detail, children, text }: { title: string; detail: string; children?: React.ReactNode; text: (typeof copy)[keyof typeof copy] }) {
  void text;
  return <AppShell title={title} detail={detail}>{children}</AppShell>;
}

function statusClass(status: WorkerJobStatus): string {
  if (status === "SUCCEEDED") return "text-sm font-semibold uppercase tracking-normal text-signal";
  if (status === "FAILED") return "text-sm font-semibold uppercase tracking-normal text-red-700";
  if (status === "RUNNING") return "text-sm font-semibold uppercase tracking-normal text-blue-700";
  return "text-sm font-semibold uppercase tracking-normal text-black/55";
}

function jobStatusLabel(status: WorkerJobStatus, locale: "tr" | "en"): string {
  if (locale === "en") return status;
  return {
    QUEUED: "BEKLİYOR",
    RUNNING: "ÇALIŞIYOR",
    SUCCEEDED: "BAŞARILI",
    FAILED: "HATALI",
    CANCELED: "İPTAL"
  }[status];
}

function runtimeStatusClass(status: WorkerHeartbeatSummary["status"]): string {
  if (status === "ERROR") return "text-xs font-semibold uppercase tracking-normal text-red-700";
  if (status === "RUNNING") return "text-xs font-semibold uppercase tracking-normal text-blue-700";
  if (status === "IDLE") return "text-xs font-semibold uppercase tracking-normal text-signal";
  return "text-xs font-semibold uppercase tracking-normal text-black/45";
}

function runtimeStatusLabel(status: WorkerHeartbeatSummary["status"], locale: "tr" | "en"): string {
  if (locale === "en") return status;
  return { RUNNING: "ÇALIŞIYOR", IDLE: "BOŞTA", STOPPED: "DURDU", ERROR: "HATALI" }[status];
}

function emptyBacklog(): Record<WorkerJobStatus, number> {
  return { QUEUED: 0, RUNNING: 0, SUCCEEDED: 0, FAILED: 0, CANCELED: 0 };
}
