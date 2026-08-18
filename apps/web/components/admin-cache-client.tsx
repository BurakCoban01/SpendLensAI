"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { apiRequest, authHeaders, formatUserFacingError, type AdminCacheResponse, type AuthResponse, type PrincipalResponse } from "../lib/api";
import { readSession } from "../lib/session";
import { AppShell } from "./app-shell";
import { useLocale } from "../lib/locale";
import { SessionRecoveryActions } from "./session-recovery-actions";

const copy = {
  tr: {
    loading: "Önbellek",
    loadingDetail: "Sıcak durum önbelleği yükleniyor.",
    anonymousDetail: "Önbellek işlemlerini açmak için önce giriş yapın.",
    signIn: "Giriş yap",
    title: "Önbellek",
    detail: "Redis sıcak durum önbelleği",
    noAccess: "Bu hesap önbellek durumunu okuyamaz.",
    hotState: "Sıcak durum",
    hotStateDetail: "İlerleme, kilit ve kısa süreli koordinasyon için kullanılan Redis destekli önbellek anahtarları.",
    refresh: "Yenile",
    infrastructure: "Altyapı",
    connection: "Bağlantı",
    connected: "Bağlı",
    disconnected: "Bağlı değil",
    keys: "Anahtarlar",
    noKeys: "Bu önek ile eşleşen anahtar yok.",
    ttlNone: "TTL yok",
    lockControl: "Kilit kontrolü",
    active: "Aktif",
    noAccessShort: "Yetki yok",
    lockKey: "Kilit anahtarı",
    ttlMs: "TTL ms",
    lockFailed: "Kilit isteği başarısız oldu.",
    checking: "Kontrol ediliyor...",
    acquireLock: "Kilit al",
    noDistributedLocks: "Bu hesap dağıtık kilit yönetemez.",
    exit: "Çıkış yap",
    workerJobs: "Worker işleri",
    dashboard: "Pano"
  },
  en: {
    loading: "Cache",
    loadingDetail: "Loading warm-state cache.",
    anonymousDetail: "Sign in first to open cache operations.",
    signIn: "Sign in",
    title: "Cache",
    detail: "Redis warm state",
    noAccess: "This account cannot read cache state.",
    hotState: "Warm state",
    hotStateDetail: "Redis-backed cache keys used for progress, locks and short-lived coordination.",
    refresh: "Refresh",
    infrastructure: "Infrastructure",
    connection: "Connection",
    connected: "Connected",
    disconnected: "Disconnected",
    keys: "Keys",
    noKeys: "No keys match this prefix.",
    ttlNone: "No TTL",
    lockControl: "Lock control",
    active: "Active",
    noAccessShort: "No access",
    lockKey: "Lock key",
    ttlMs: "TTL ms",
    lockFailed: "Lock request failed.",
    checking: "Checking...",
    acquireLock: "Acquire lock",
    noDistributedLocks: "This account cannot manage distributed locks.",
    exit: "Sign out",
    workerJobs: "Worker jobs",
    dashboard: "Dashboard"
  }
} as const;

type CacheState =
  | { kind: "loading" }
  | { kind: "anonymous" }
  | { kind: "ready"; session: AuthResponse; principal: PrincipalResponse["principal"]; cache: AdminCacheResponse }
  | { kind: "error"; message: string };

type SubmitState = "idle" | "submitting" | "error";

export function AdminCacheClient() {
  const { locale } = useLocale();
  const text = copy[locale];
  const [state, setState] = useState<CacheState>({ kind: "loading" });
  const [prefix, setPrefix] = useState("worker-job:");
  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const [lockResult, setLockResult] = useState("");

  async function load(nextPrefix = prefix) {
    const session = readSession();
    if (!session) {
      setState({ kind: "anonymous" });
      return;
    }
    try {
      const principal = await apiRequest<PrincipalResponse>("/auth/me", {
        headers: authHeaders(session.tokens.accessToken)
      });
      if (!principal.principal.permissions.includes("admin.cache.read")) {
        setState({
          kind: "ready",
          session,
          principal: principal.principal,
          cache: { health: { backend: "memory", connected: false, detail: "NO_ACCESS" }, keys: [] }
        });
        return;
      }
      const query = new URLSearchParams({ prefix: nextPrefix });
      const cache = await apiRequest<AdminCacheResponse>(`/admin/cache?${query.toString()}`, {
        headers: authHeaders(session.tokens.accessToken)
      });
      setState({ kind: "ready", session, principal: principal.principal, cache });
    } catch (caught) {
      setState({ kind: "error", message: caught instanceof Error ? caught.message : "CACHE_LOAD_FAILED" });
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function acquireLock(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.kind !== "ready") return;
    const form = new FormData(event.currentTarget);
    setSubmitState("submitting");
    try {
      const result = await apiRequest<{ acquired: boolean; key: string }>("/admin/cache/locks/acquire", {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken),
        body: JSON.stringify({
          key: form.get("key"),
          ttlMs: Number(form.get("ttlMs") ?? 30000)
        })
      });
      setLockResult(`${result.key}: ${result.acquired ? "alındı" : "meşgul"}`);
      setSubmitState("idle");
      await load();
    } catch {
      setSubmitState("error");
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

  const canRead = state.principal.permissions.includes("admin.cache.read");
  const canManage = state.principal.permissions.includes("admin.cache.manage");

  return (
    <Shell title={text.title} detail={`${state.principal.displayName} - ${text.detail}`} text={text}>
      {!canRead ? (
        <section className="border-y border-black/10 py-10 text-sm text-steel">{text.noAccess}</section>
      ) : (
        <section className="grid gap-8 lg:grid-cols-[1fr_340px]">
          <div className="border-y border-black/10 py-6">
            <div className="grid gap-4 border-b border-black/10 pb-5 md:grid-cols-[1fr_220px_auto] md:items-end">
              <div>
              <h2 className="text-xl font-semibold">{text.hotState}</h2>
                <p className="mt-1 text-sm text-steel">{text.hotStateDetail}</p>
              </div>
              <input
                value={prefix}
                onChange={(event) => setPrefix(event.target.value)}
                className="h-10 border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal"
              />
              <button className="h-10 border border-black/15 px-4 text-sm font-semibold hover:border-signal hover:text-signal" onClick={() => void load()}>
                {text.refresh}
              </button>
            </div>

            <div className="grid gap-4 border-b border-black/10 py-5 md:grid-cols-3">
              <Metric label={text.infrastructure} value={state.cache.health.backend} />
              <Metric label={text.connection} value={state.cache.health.connected ? text.connected : text.disconnected} tone={state.cache.health.connected ? "ok" : "bad"} />
              <Metric label={text.keys} value={String(state.cache.keys.length)} />
            </div>

            <div className="divide-y divide-black/10">
              {state.cache.keys.length === 0 ? (
                <div className="py-10 text-sm text-steel">{text.noKeys}</div>
              ) : (
                state.cache.keys.map((item) => (
                  <div key={item.key} className="grid gap-3 py-4 md:grid-cols-[1fr_140px]">
                    <div className="break-all font-mono text-sm">{item.key}</div>
                    <div className="text-sm text-steel">{item.ttlSeconds === null ? text.ttlNone : `${item.ttlSeconds}s`}</div>
                  </div>
                ))
              )}
            </div>
          </div>

          <aside className="border-l border-black/10 pl-6">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">{text.lockControl}</h2>
              <span className={canManage ? "text-xs uppercase tracking-normal text-signal" : "text-xs uppercase tracking-normal text-black/35"}>
                {canManage ? text.active : text.noAccessShort}
              </span>
            </div>
            {canManage ? (
              <form className="mt-5 space-y-3" onSubmit={acquireLock}>
                <input name="key" required defaultValue="ocr:demo" placeholder={text.lockKey} className="h-10 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal" />
                <input name="ttlMs" type="number" defaultValue={30000} placeholder={text.ttlMs} className="h-10 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal" />
                {lockResult ? <p className="text-sm text-steel">{lockResult}</p> : null}
                {submitState === "error" ? <p className="text-sm text-red-700">{text.lockFailed}</p> : null}
                <button className="h-10 w-full bg-ink text-sm font-semibold text-paper hover:bg-signal" disabled={submitState === "submitting"}>
                  {submitState === "submitting" ? text.checking : text.acquireLock}
                </button>
              </form>
            ) : (
              <p className="mt-4 text-sm leading-6 text-steel">{text.noDistributedLocks}</p>
            )}
          </aside>
        </section>
      )}
    </Shell>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "ok" | "bad" }) {
  const valueClass = tone === "ok" ? "text-signal" : tone === "bad" ? "text-red-700" : "text-ink";
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-normal text-steel">{label}</div>
      <div className={`mt-2 text-2xl font-semibold ${valueClass}`}>{value}</div>
    </div>
  );
}

function Shell({ title, detail, children, text }: { title: string; detail: string; children?: React.ReactNode; text: (typeof copy)[keyof typeof copy] }) {
  void text;
  return <AppShell title={title} detail={detail}>{children}</AppShell>;
}
