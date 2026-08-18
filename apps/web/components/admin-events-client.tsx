"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  apiRequest,
  authHeaders,
  formatUserFacingError,
  type AdminEventDlqResponse,
  type AdminEventInboxResponse,
  type AdminEventsResponse,
  type AuthResponse,
  type EventDlqReplayResponse,
  type EventDrainResponse,
  type EventCatalogEntry,
  type PrincipalResponse
} from "../lib/api";
import { readSession } from "../lib/session";
import { AppShell } from "./app-shell";
import { useLocale } from "../lib/locale";
import { SessionRecoveryActions } from "./session-recovery-actions";

const copy = {
  tr: {
    loading: "Olaylar",
    loadingDetail: "Olay durumu yükleniyor.",
    anonymousDetail: "Olay tarayıcısını açmak için önce giriş yapın.",
    signIn: "Giriş yap",
    title: "Olaylar",
    detail: "kalıcı olay çıkış kuyruğu ve tüketici gelen kutusu",
    noAccess: "Bu hesap olay çıkış kuyruğu durumunu okuyamaz.",
    outbox: "Olay çıkış kuyruğu",
    outboxDetail: "Kafka teslimi beklerken veya bozulduğunda saklanan çalışma alanı kapsamlı olay kayıtları.",
    allTopics: "Tüm konu başlıkları",
    allStatuses: "Tüm durumlar",
    pending: "Bekleyen",
    published: "Yayınlandı",
    failed: "Hatalı",
    refresh: "Yenile",
    drain: "Çıkış kuyruğunu boşalt",
    draining: "Boşaltılıyor...",
    drainFailed: "Olay boşaltma başarısız oldu. API loglarını ve sağlık durumunu kontrol edin.",
    noEvents: "Bu filtreyle eşleşen olay yok.",
    catalogMissing: "Katalog kaydı bulunamadı.",
    requeueing: "Kuyruğa alınıyor...",
    requeue: "Yeniden kuyruğa al",
    dlq: "Hata kuyruğu (DLQ)",
    dlqDetail: "İnceleme ve kontrollü yeniden kuyruğa alma için DLQ teslim kanıtı olan hatalı outbox olayları.",
    reasonContains: "Hata metni içerir",
    replayPreview: "Yeniden oynatma önizlemesi",
    replay: "DLQ yeniden oynatma",
    replaying: "Yeniden oynatma çalışıyor...",
    replayFailed: "DLQ yeniden oynatma başarısız oldu. İlke filtrelerini ve API loglarını kontrol edin.",
    noDlq: "Bu filtreyle eşleşen DLQ destekli hata yok.",
    inbox: "Tüketici gelen kutusu",
    inboxDetail: "Çalışma alanı, tüketici ve olay kimliği kapsamındaki idempotency kayıtları.",
    allInbox: "Tüm gelen kutusu durumları",
    processed: "İşlendi",
    health: "Sağlık",
    queue: "Pano",
    exit: "Çıkış yap"
  },
  en: {
    loading: "Events",
    loadingDetail: "Loading event status.",
    anonymousDetail: "Sign in first to open the event browser.",
    signIn: "Sign in",
    title: "Events",
    detail: "persistent outbox and consumer inbox",
    noAccess: "This account cannot read outbox state.",
    outbox: "Event outbox",
    outboxDetail: "Workspace-scoped event records stored while Kafka delivery is pending or broken.",
    allTopics: "All topics",
    allStatuses: "All statuses",
    pending: "Pending",
    published: "Published",
    failed: "Failed",
    refresh: "Refresh",
    drain: "Drain outbox",
    draining: "Draining...",
    drainFailed: "Outbox drain failed. Check API logs and health status.",
    noEvents: "No events match this filter.",
    catalogMissing: "No catalog entry found.",
    requeueing: "Requeueing...",
    requeue: "Requeue",
    dlq: "Error queue (DLQ)",
    dlqDetail: "Failed outbox events with DLQ delivery evidence for review and controlled replay.",
    reasonContains: "Contains error text",
    replayPreview: "Replay preview",
    replay: "Replay DLQ",
    replaying: "Replay in progress...",
    replayFailed: "DLQ replay failed. Check policy filters and API logs.",
    noDlq: "No DLQ-backed failures match this filter.",
    inbox: "Consumer inbox",
    inboxDetail: "Idempotency records for workspace, consumer and event IDs.",
    allInbox: "All inbox statuses",
    processed: "Processed",
    health: "Health",
    queue: "Dashboard",
    exit: "Sign out"
  }
} as const;

type EventState =
  | { kind: "loading" }
  | { kind: "anonymous" }
  | {
      kind: "ready";
      session: AuthResponse;
      principal: PrincipalResponse["principal"];
      catalog: Record<string, EventCatalogEntry>;
      events: AdminEventsResponse;
      inbox: AdminEventInboxResponse;
      dlq: AdminEventDlqResponse;
    }
  | { kind: "error"; message: string };

type EventFilterState = "all" | "pending" | "published" | "failed";
type InboxFilterStatus = "all" | "processed" | "failed";
type DrainState = "idle" | "running" | "error";
type DlqReplayState = "idle" | "running" | "error";

const turkishEventDescriptions: Record<string, string> = {
  "document.uploaded": "Belge kabul edildi ve güvenli biçimde saklandı.",
  "ocr.job.created": "Belge için bir OCR işi oluşturuldu.",
  "ocr.preprocessing.completed": "Belge ön işleme adımı tamamlandı.",
  "ocr.tesseract.completed": "Tesseract OCR çalışması tamamlandı.",
  "ocr.custom_model.completed": "Custom OCR çalışması tamamlandı.",
  "ocr.ensemble.completed": "OCR motorlarının birleşik değerlendirmesi tamamlandı.",
  "extraction.completed": "Belgedeki yapılandırılmış alanların çıkarımı tamamlandı.",
  "extraction.needs_review": "Düşük güvenli alanlar insan incelemesine yönlendirildi.",
  "expense.created": "Belgeden veya kullanıcı girişinden yeni bir gider oluşturuldu.",
  "expense.updated": "Gider bilgileri güncellendi.",
  "expense.approved": "Yetkili onaylayıcı gideri onayladı.",
  "expense.rejected": "Yetkili onaylayıcı gideri reddetti.",
  "model.training.started": "Custom OCR model eğitimi başlatıldı.",
  "model.training.completed": "Custom OCR model eğitimi tamamlandı.",
  "model.evaluation.completed": "Model kalite değerlendirmesi tamamlandı.",
  "annotation.created": "OCR düzeltmesinden yeni bir açıklama kaydı oluşturuldu.",
  "audit.event.created": "Denetlenebilir bir sistem veya kullanıcı işlemi kaydedildi.",
  "report.generated": "Rapor veya dışa aktarma dosyası oluşturulup saklandı.",
  "webhook.delivery.requested": "Yapılandırılmış webhook hedefine teslim isteği oluşturuldu."
};

export function AdminEventsClient() {
  const { locale } = useLocale();
  const text = copy[locale];
  const [state, setState] = useState<EventState>({ kind: "loading" });
  const [topic, setTopic] = useState("");
  const [eventState, setEventState] = useState<EventFilterState>("all");
  const [inboxConsumer, setInboxConsumer] = useState("");
  const [inboxStatus, setInboxStatus] = useState<InboxFilterStatus>("all");
  const [drainState, setDrainState] = useState<DrainState>("idle");
  const [drainResult, setDrainResult] = useState<EventDrainResponse | null>(null);
  const [dlqReplayState, setDlqReplayState] = useState<DlqReplayState>("idle");
  const [dlqReplayResult, setDlqReplayResult] = useState<EventDlqReplayResponse | null>(null);
  const [dlqReasonContains, setDlqReasonContains] = useState("");
  const [requeueEventId, setRequeueEventId] = useState<string | null>(null);

  async function load(nextTopic = topic, nextState = eventState, nextInboxConsumer = inboxConsumer, nextInboxStatus = inboxStatus) {
    const session = readSession();
    if (!session) {
      setState({ kind: "anonymous" });
      return;
    }
    try {
      const principal = await apiRequest<PrincipalResponse>("/auth/me", {
        headers: authHeaders(session.tokens.accessToken)
      });
      if (!principal.principal.permissions.includes("admin.events.read")) {
        setState({
          kind: "ready",
          session,
          principal: principal.principal,
          catalog: {},
          events: { backlog: { pending: 0, published: 0, failed: 0 }, events: [] },
          inbox: { events: [] },
          dlq: { events: [] }
        });
        return;
      }
      const query = new URLSearchParams();
      query.set("limit", "10");
      if (nextTopic) query.set("topic", nextTopic);
      if (nextState !== "all") query.set("state", nextState);
      const inboxQuery = new URLSearchParams();
      inboxQuery.set("limit", "10");
      if (nextTopic) inboxQuery.set("topic", nextTopic);
      if (nextInboxConsumer) inboxQuery.set("consumerName", nextInboxConsumer);
      if (nextInboxStatus !== "all") inboxQuery.set("status", nextInboxStatus);
      const [catalog, events, inbox, dlq] = await Promise.all([
        apiRequest<{ topics: Record<string, EventCatalogEntry> }>("/admin/events/catalog", {
          headers: authHeaders(session.tokens.accessToken)
        }),
        apiRequest<AdminEventsResponse>(`/admin/events?${query.toString()}`, {
          headers: authHeaders(session.tokens.accessToken)
        }),
        apiRequest<AdminEventInboxResponse>(`/admin/events/inbox?${inboxQuery.toString()}`, {
          headers: authHeaders(session.tokens.accessToken)
        }),
        apiRequest<AdminEventDlqResponse>(`/admin/events/dlq?${query.toString()}`, {
          headers: authHeaders(session.tokens.accessToken)
        })
      ]);
      setState({ kind: "ready", session, principal: principal.principal, catalog: catalog.topics, events, inbox, dlq });
    } catch (caught) {
      setState({ kind: "error", message: caught instanceof Error ? caught.message : "EVENTS_LOAD_FAILED" });
    }
  }

  async function drainEvents() {
    if (state.kind !== "ready") return;
    setDrainState("running");
    setDrainResult(null);
    try {
      const result = await apiRequest<EventDrainResponse>("/admin/events/drain", {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken),
        body: JSON.stringify({ limit: 25, includeFailed: eventState === "failed" })
      });
      setDrainResult(result);
      setDrainState("idle");
      await load(topic, eventState, inboxConsumer, inboxStatus);
    } catch {
      setDrainState("error");
    }
  }

  async function requeueEvent(eventId: string) {
    if (state.kind !== "ready") return;
    setRequeueEventId(eventId);
    try {
      await apiRequest(`/admin/events/${eventId}/requeue`, {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken)
      });
      await load(topic, eventState, inboxConsumer, inboxStatus);
    } finally {
      setRequeueEventId(null);
    }
  }

  async function replayDlq(dryRun: boolean) {
    if (state.kind !== "ready") return;
    setDlqReplayState("running");
    setDlqReplayResult(null);
    try {
      const result = await apiRequest<EventDlqReplayResponse>("/admin/events/dlq/replay", {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken),
        body: JSON.stringify({
          ...(topic ? { topic } : {}),
          ...(dlqReasonContains.trim() ? { reasonContains: dlqReasonContains.trim() } : {}),
          limit: 25,
          dryRun
        })
      });
      setDlqReplayResult(result);
      setDlqReplayState("idle");
      if (!dryRun) await load(topic, eventState, inboxConsumer, inboxStatus);
    } catch {
      setDlqReplayState("error");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const topics = useMemo(() => (state.kind === "ready" ? Object.keys(state.catalog).sort() : []), [state]);

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

  const canReadEvents = state.principal.permissions.includes("admin.events.read");
  const canPublishEvents = state.principal.permissions.includes("admin.events.publish");

  return (
    <Shell title={text.title} detail={`${state.principal.displayName} - ${text.detail}`} text={text}>
      {!canReadEvents ? (
        <section className="border-y border-black/10 py-10 text-sm text-steel">{text.noAccess}</section>
      ) : (
        <section className="border-y border-black/10 py-6">
          <div className="flex flex-wrap items-end gap-4 border-b border-black/10 pb-5">
            <div className="min-w-[240px] flex-1">
              <h2 className="text-xl font-semibold">{text.outbox}</h2>
              <p className="mt-1 text-sm text-steel">{text.outboxDetail}</p>
            </div>
            <select
              className="h-10 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal sm:w-[220px]"
              value={topic}
              onChange={(event) => {
                setTopic(event.target.value);
                void load(event.target.value, eventState, inboxConsumer, inboxStatus);
              }}
            >
              <option value="">{text.allTopics}</option>
              {topics.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
            <select
              className="h-10 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal sm:w-[170px]"
              value={eventState}
              onChange={(event) => {
                const nextState = event.target.value as EventFilterState;
                setEventState(nextState);
                void load(topic, nextState, inboxConsumer, inboxStatus);
              }}
            >
              <option value="all">{text.allStatuses}</option>
              <option value="pending">{text.pending}</option>
              <option value="published">{text.published}</option>
              <option value="failed">{text.failed}</option>
            </select>
            <button className="h-10 border border-black/15 px-4 text-sm font-semibold hover:border-signal hover:text-signal" onClick={() => void load()}>
              {text.refresh}
            </button>
            {canPublishEvents ? (
              <button
                className="h-10 bg-ink px-4 text-sm font-semibold text-paper disabled:cursor-not-allowed disabled:bg-black/30"
                disabled={drainState === "running"}
                onClick={() => void drainEvents()}
              >
                {drainState === "running" ? text.draining : text.drain}
              </button>
            ) : null}
          </div>

          {drainState === "error" ? <p className="border-b border-black/10 py-3 text-sm text-red-700">{text.drainFailed}</p> : null}
          {drainResult ? (
            <p className="border-b border-black/10 py-3 text-sm text-steel">
              {drainResult.attempted} olay denendi, {drainResult.published} yayınlandı, {drainResult.failed} hata aldı, {drainResult.dlqPublished} DLQ kaydı yayınlandı.
            </p>
          ) : null}

          <div className="grid gap-4 border-b border-black/10 py-5 md:grid-cols-3">
            <Metric label="Bekleyen" value={String(state.events.backlog.pending)} tone="pending" />
            <Metric label="Yayınlanan" value={String(state.events.backlog.published)} tone="published" />
            <Metric label="Hatalı" value={String(state.events.backlog.failed)} tone="failed" />
          </div>

          <div className="divide-y divide-black/10">
            {state.events.events.length === 0 ? (
              <div className="py-10 text-sm text-steel">{text.noEvents}</div>
            ) : (
              state.events.events.map((event) => {
                const catalogEntry = state.catalog[event.topic];
                return (
                  <div key={event.id} className="grid min-w-0 gap-3 py-5 lg:grid-cols-[220px_minmax(0,1fr)_150px]">
                    <div className="min-w-0">
                      <div className="break-all font-mono text-sm font-semibold">{event.topic}</div>
                      <div className="mt-1 text-xs text-steel">{new Date(event.createdAt).toLocaleString()}</div>
                    </div>
                    <div className="min-w-0">
                      <div className="break-all text-sm font-medium">{event.aggregateId}</div>
                      <div className="mt-1 text-sm text-steel">{eventDescription(event.topic, catalogEntry, locale, text.catalogMissing)}</div>
                      {event.failureReason ? <div className="mt-2 break-all text-sm text-red-700">{event.failureReason}</div> : null}
                      <div className="mt-2 break-all font-mono text-xs text-black/45">{event.correlationId}</div>
                    </div>
                    <div className="flex flex-col gap-3">
                      <div className={statusClass(statusOf(event))}>{eventStatusLabel(statusOf(event), text)}</div>
                      {canPublishEvents && statusOf(event) === "failed" ? (
                        <button
                          className="h-9 border border-black/15 px-3 text-xs font-semibold hover:border-signal hover:text-signal disabled:cursor-not-allowed disabled:text-black/35"
                          disabled={requeueEventId === event.id}
                          onClick={() => void requeueEvent(event.id)}
                        >
                          {requeueEventId === event.id ? text.requeueing : text.requeue}
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className="border-t border-black/10 pt-6">
            <div className="border-b border-black/10 pb-6">
                  <div className="grid gap-4 md:grid-cols-[1fr_240px_auto_auto] md:items-end">
                <div>
                <h2 className="text-xl font-semibold">{text.dlq}</h2>
                  <p className="mt-1 text-sm text-steel">{text.dlqDetail}</p>
                </div>
                <input
                  className="h-10 border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal"
                  placeholder={text.reasonContains}
                  value={dlqReasonContains}
                  onChange={(event) => setDlqReasonContains(event.target.value)}
                />
                {canPublishEvents ? (
                  <button
                    className="h-10 border border-black/15 px-4 text-sm font-semibold hover:border-signal hover:text-signal disabled:cursor-not-allowed disabled:text-black/35"
                    disabled={dlqReplayState === "running"}
                    onClick={() => void replayDlq(true)}
                  >
                    {text.replayPreview}
                  </button>
                ) : null}
                {canPublishEvents ? (
                  <button
                    className="h-10 bg-ink px-4 text-sm font-semibold text-paper disabled:cursor-not-allowed disabled:bg-black/30"
                    disabled={dlqReplayState === "running"}
                    onClick={() => void replayDlq(false)}
                  >
                    {dlqReplayState === "running" ? text.replaying : text.replay}
                  </button>
                ) : null}
              </div>
              {dlqReplayState === "error" ? <p className="mt-4 text-sm text-red-700">{text.replayFailed}</p> : null}
              {dlqReplayResult ? (
                <p className="mt-4 text-sm text-steel">
                  {dlqReplayResult.scanned} DLQ adayı tarandı; {dlqReplayResult.dryRun ? "önizlenen" : "replay edilen"} {dlqReplayResult.events.length},
                  yeniden kuyruğa alınan {dlqReplayResult.replayed}, atlanan {dlqReplayResult.skipped}.
                </p>
              ) : null}
              <div className="mt-4 divide-y divide-black/10">
                {state.dlq.events.length === 0 ? (
                  <div className="py-8 text-sm text-steel">{text.noDlq}</div>
                ) : (
                  state.dlq.events.map((event) => (
                    <div key={event.id} className="grid min-w-0 gap-3 py-5 lg:grid-cols-[220px_minmax(0,1fr)_150px]">
                      <div>
                        <div className="font-mono text-sm font-semibold">{event.topic}</div>
                        <div className="mt-1 text-xs text-steel">{new Date(event.createdAt).toLocaleString()}</div>
                      </div>
                      <div>
                        <div className="text-sm font-medium">{event.aggregateId}</div>
                        <div className="mt-2 break-all text-sm text-red-700">{event.failureReason}</div>
                        <div className="mt-2 break-all font-mono text-xs text-black/45">{event.correlationId}</div>
                      </div>
                      <div className="flex flex-col gap-3">
                        <div className={statusClass("failed")}>dlq</div>
                        {canPublishEvents ? (
                          <button
                            className="h-9 border border-black/15 px-3 text-xs font-semibold hover:border-signal hover:text-signal disabled:cursor-not-allowed disabled:text-black/35"
                            disabled={requeueEventId === event.id}
                            onClick={() => void requeueEvent(event.id)}
                          >
                            {requeueEventId === event.id ? "Kuyruğa alınıyor..." : "Yeniden kuyruğa al"}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

          <div className="pt-6">
            <div className="flex flex-wrap items-end gap-4 border-b border-black/10 pb-5">
              <div className="min-w-[240px] flex-1">
                  <h2 className="text-xl font-semibold">{text.inbox}</h2>
                <p className="mt-1 text-sm text-steel">{text.inboxDetail}</p>
              </div>
              <input
                className="h-10 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal sm:w-[220px]"
                placeholder="Tüketici adı"
                value={inboxConsumer}
                onChange={(event) => setInboxConsumer(event.target.value)}
              />
              <select
                className="h-10 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal sm:w-[170px]"
                value={inboxStatus}
                onChange={(event) => {
                  const nextStatus = event.target.value as InboxFilterStatus;
                  setInboxStatus(nextStatus);
                  void load(topic, eventState, inboxConsumer, nextStatus);
                }}
              >
                <option value="all">{text.allInbox}</option>
                <option value="processed">{text.processed}</option>
                <option value="failed">{text.failed}</option>
              </select>
              <button className="h-10 border border-black/15 px-4 text-sm font-semibold hover:border-signal hover:text-signal" onClick={() => void load()}>
                Uygula
              </button>
            </div>

            <div className="divide-y divide-black/10">
              {state.inbox.events.length === 0 ? (
                <div className="py-10 text-sm text-steel">Bu filtreyle eşleşen inbox kaydı yok.</div>
              ) : (
                state.inbox.events.map((event) => (
                  <div key={event.id} className="grid min-w-0 gap-3 py-5 lg:grid-cols-[220px_minmax(0,1fr)_150px]">
                    <div className="min-w-0">
                      <div className="break-all font-mono text-sm font-semibold">{event.consumerName}</div>
                      <div className="mt-1 text-xs text-steel">{new Date(event.receivedAt).toLocaleString()}</div>
                    </div>
                    <div className="min-w-0">
                      <div className="break-all font-mono text-sm font-medium">{event.topic}</div>
                      <div className="mt-1 break-all text-sm text-steel">{event.aggregateId}</div>
                      <div className="mt-2 break-all font-mono text-xs text-black/45">{event.eventId}</div>
                    </div>
                    <div className={statusClass(event.status)}>{eventStatusLabel(event.status, text)}</div>
                  </div>
                ))
              )}
            </div>
          </div>
          </div>
        </section>
      )}
    </Shell>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone: "pending" | "published" | "failed" }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-normal text-steel">{label}</div>
      <div className={`${statusClass(tone)} mt-2 inline-flex`}>{value}</div>
    </div>
  );
}

function Shell({ title, detail, children, text }: { title: string; detail: string; children?: React.ReactNode; text: (typeof copy)[keyof typeof copy] }) {
  void text;
  return <AppShell title={title} detail={detail}>{children}</AppShell>;
}

function statusOf(event: { publishedAt: string | null; failureReason: string | null }) {
  if (event.failureReason) return "failed";
  if (event.publishedAt) return "published";
  return "pending";
}

function statusClass(status: string): string {
  if (status === "published" || status === "processed") return "text-sm font-semibold uppercase tracking-normal text-signal";
  if (status === "failed") return "text-sm font-semibold uppercase tracking-normal text-red-700";
  return "text-sm font-semibold uppercase tracking-normal text-black/55";
}

function eventStatusLabel(status: string, text: (typeof copy)[keyof typeof copy]): string {
  if (status === "pending") return text.pending;
  if (status === "published") return text.published;
  if (status === "failed") return text.failed;
  if (status === "processed") return text.processed;
  return status;
}

function eventDescription(topic: string, catalogEntry: EventCatalogEntry | undefined, locale: "tr" | "en", fallback: string): string {
  if (locale === "tr") return turkishEventDescriptions[topic] ?? fallback;
  return catalogEntry?.description ?? fallback;
}
