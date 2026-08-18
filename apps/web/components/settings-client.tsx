"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import {
  apiRequest,
  authHeaders,
  formatUserFacingError,
  type AiProviderStatus,
  type ApiKeySummary,
  type AuthResponse,
  type AuthSessionSummary,
  type PrincipalResponse,
  type WebhookEndpointSummary,
  type WorkspaceSummary
} from "../lib/api";
import { clearSession, readSession } from "../lib/session";
import { AppShell } from "./app-shell";
import { useLocale } from "../lib/locale";
import { SessionRecoveryActions } from "./session-recovery-actions";

const copy = {
  tr: {
    loading: "Ayarlar",
    loadingDetail: "Çalışma alanı ve oturum ayarları yükleniyor.",
    anonymousDetail: "Aktif oturum bulunamadı.",
    signIn: "Giriş yap",
    errorTitle: "Ayarlar hatası",
    account: "Hesap",
    email: "E-posta",
    tenant: "Çalışma alanı",
    roles: "Roller",
    permissions: "Yetkiler",
    workspaces: "Çalışma alanları",
    sessions: "Oturum envanteri",
    security: "Güvenlik",
    active: "Aktif",
    revoked: "İptal",
    expired: "Süresi doldu",
    logoutAll: "Tüm oturumlardan çık",
    logoutError: "Çıkış işlemi başarısız oldu.",
    apiKeys: "API anahtarları",
    noApiKeys: "Bu hesap için yönetilebilir API anahtarı yok.",
    apiKeyName: "Anahtar adı",
    apiKeyScopes: "Erişim kapsamları",
    documentsRead: "Belgeleri görüntüle",
    documentsUpload: "Belge yükle",
    createApiKey: "API anahtarı oluştur",
    creatingApiKey: "Oluşturuluyor...",
    rawApiKey: "Tek seferlik API anahtarı",
    rawApiKeyDetail: "Bu değer tekrar gösterilmez. Yalnız yetkili yerel otomasyon istemcisinde saklayın.",
    revokeApiKey: "İptal et",
    revokedApiKey: "İptal edildi",
    apiKeyError: "API anahtarı işlemi başarısız oldu.",
    intelligence: "AI ve otomasyon",
    aiProvider: "AI sağlayıcı",
    aiDisabled: "Harici LLM kapalı; deterministik OCR ve çıkarım ana akış olarak çalışır.",
    aiEnabled: "Yapılandırıldı ve etkin.",
    aiConfiguredOff: "Sağlayıcı yapılandırılmış değil veya özellik kapalı.",
    provider: "Sağlayıcı",
    model: "Model",
    rawInputStorage: "Ham girdi saklama",
    webhooks: "Webhook otomasyonu",
    noWebhooks: "Bu çalışma alanında webhook endpoint'i yok.",
    webhookUrl: "Webhook URL",
    webhookEvents: "Olaylar",
    webhookEventsHint: "Virgülle ayırın; örn. expense.created, report.generated",
    createWebhook: "Webhook oluştur",
    creatingWebhook: "Oluşturuluyor...",
    webhookSecret: "Tek seferlik webhook sırrı",
    webhookSecretDetail: "Bu değer tekrar gösterilmez. n8n veya yerel alıcıda HMAC SHA-256 doğrulaması için saklayın.",
    webhookError: "Webhook işlemi başarısız oldu.",
    disableWebhook: "Devre dışı bırak",
    webhookDisabled: "Devre dışı",
    enabled: "Etkin",
    disabled: "Kapalı",
    navDashboard: "Pano",
    navDocuments: "Belgeler",
    navExpenses: "Giderler",
    navSettings: "Ayarlar",
    created: "Oluşturuldu",
    ends: "Bitiş",
    unknownClient: "Bilinmeyen istemci"
  },
  en: {
    loading: "Settings",
    loadingDetail: "Loading workspace and session settings.",
    anonymousDetail: "No active session found.",
    signIn: "Sign in",
    errorTitle: "Settings error",
    account: "Account",
    email: "Email",
    tenant: "Workspace",
    roles: "Roles",
    permissions: "Permissions",
    workspaces: "Workspaces",
    sessions: "Session inventory",
    security: "Security",
    active: "Active",
    revoked: "Revoked",
    expired: "Expired",
    logoutAll: "Sign out all sessions",
    logoutError: "Logout failed.",
    apiKeys: "API keys",
    noApiKeys: "There are no manageable API keys for this account.",
    apiKeyName: "Key name",
    apiKeyScopes: "Access scopes",
    documentsRead: "Read documents",
    documentsUpload: "Upload documents",
    createApiKey: "Create API key",
    creatingApiKey: "Creating...",
    rawApiKey: "One-time API key",
    rawApiKeyDetail: "This value is not shown again. Store it only in an authorized local automation client.",
    revokeApiKey: "Revoke",
    revokedApiKey: "Revoked",
    apiKeyError: "API key operation failed.",
    intelligence: "AI and automation",
    aiProvider: "AI provider",
    aiDisabled: "External LLM is off; deterministic OCR and extraction remain the primary path.",
    aiEnabled: "Configured and enabled.",
    aiConfiguredOff: "Provider is not configured or the feature is disabled.",
    provider: "Provider",
    model: "Model",
    rawInputStorage: "Raw input storage",
    webhooks: "Webhook automation",
    noWebhooks: "This workspace has no webhook endpoints.",
    webhookUrl: "Webhook URL",
    webhookEvents: "Events",
    webhookEventsHint: "Separate with commas, e.g. expense.created, report.generated",
    createWebhook: "Create webhook",
    creatingWebhook: "Creating...",
    webhookSecret: "One-time webhook secret",
    webhookSecretDetail: "This value is not shown again. Store it in n8n or a local receiver for HMAC SHA-256 verification.",
    webhookError: "Webhook operation failed.",
    disableWebhook: "Disable",
    webhookDisabled: "Disabled",
    enabled: "Enabled",
    disabled: "Disabled",
    navDashboard: "Dashboard",
    navDocuments: "Documents",
    navExpenses: "Expenses",
    navSettings: "Settings",
    created: "Created",
    ends: "Ends",
    unknownClient: "Unknown client"
  }
} as const;

type SettingsCopy = (typeof copy)[keyof typeof copy];

type SettingsState =
  | { kind: "loading" }
  | { kind: "anonymous" }
  | {
      kind: "ready";
      session: AuthResponse;
      principal: PrincipalResponse["principal"];
      sessions: AuthSessionSummary[];
      sessionSummary: { active: number; revoked: number; expired: number };
      sessionPageCount: number;
      workspaces: WorkspaceSummary[];
      apiKeys: ApiKeySummary[];
      aiStatus: AiProviderStatus | null;
      webhooks: WebhookEndpointSummary[];
    }
  | { kind: "error"; message: string };

export function SettingsClient() {
  const { locale } = useLocale();
  const text = copy[locale];
  const [state, setState] = useState<SettingsState>({ kind: "loading" });
  const [sessionPage, setSessionPage] = useState(0);
  const [actionState, setActionState] = useState<"idle" | "submitting" | "done" | "error">("idle");
  const [apiKeyState, setApiKeyState] = useState<
    | { kind: "idle" }
    | { kind: "submitting" }
    | { kind: "created"; rawKey: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [revokingApiKeyId, setRevokingApiKeyId] = useState<string | null>(null);
  const [webhookState, setWebhookState] = useState<
    | { kind: "idle" }
    | { kind: "submitting" }
    | { kind: "created"; secret: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [disablingWebhookId, setDisablingWebhookId] = useState<string | null>(null);

  async function load() {
    const session = readSession();
    if (!session) {
      setState({ kind: "anonymous" });
      return;
    }
    try {
      const headers = authHeaders(session.tokens.accessToken);
      const principal = await apiRequest<PrincipalResponse>("/auth/me", { headers });
      const permissions = principal.principal.permissions;
      const [sessions, workspaces, apiKeys, aiStatus, webhooks] = await Promise.all([
        apiRequest<{
          sessions: AuthSessionSummary[];
          pagination: { page: number; limit: number; total: number; pageCount: number };
          summary: { active: number; revoked: number; expired: number };
        }>("/auth/sessions?limit=8&page=1", { headers }),
        apiRequest<{ workspaces: WorkspaceSummary[] }>("/workspaces", { headers }),
        permissions.includes("api_keys.manage")
          ? apiRequest<{ apiKeys: ApiKeySummary[] }>("/api-keys", { headers })
          : Promise.resolve({ apiKeys: [] }),
        permissions.includes("ai.use") ? apiRequest<AiProviderStatus>("/ai/providers/status", { headers }) : Promise.resolve(null),
        permissions.includes("webhooks.manage")
          ? apiRequest<{ endpoints: WebhookEndpointSummary[] }>("/webhooks?includeDisabled=true", { headers })
          : Promise.resolve({ endpoints: [] })
      ]);
      setState({
        kind: "ready",
        session,
        principal: principal.principal,
        sessions: sessions.sessions,
        sessionSummary: sessions.summary,
        sessionPageCount: sessions.pagination.pageCount,
        workspaces: workspaces.workspaces,
        apiKeys: apiKeys.apiKeys,
        aiStatus,
        webhooks: webhooks.endpoints
      });
    } catch (caught) {
      setState({ kind: "error", message: caught instanceof Error ? caught.message : "SETTINGS_LOAD_FAILED" });
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const sessionStats = state.kind === "ready" ? state.sessionSummary : { active: 0, revoked: 0, expired: 0 };
  const visibleSessions = state.kind === "ready" ? state.sessions : [];
  const sessionPageCount = state.kind === "ready" ? state.sessionPageCount : 1;

  async function showSessionPage(pageIndex: number) {
    if (state.kind !== "ready" || pageIndex < 0 || pageIndex >= state.sessionPageCount) return;
    const response = await apiRequest<{
      sessions: AuthSessionSummary[];
      pagination: { page: number; limit: number; total: number; pageCount: number };
      summary: { active: number; revoked: number; expired: number };
    }>(`/auth/sessions?limit=8&page=${pageIndex + 1}`, {
      headers: authHeaders(state.session.tokens.accessToken)
    });
    setSessionPage(pageIndex);
    setState((current) =>
      current.kind === "ready"
        ? { ...current, sessions: response.sessions, sessionSummary: response.summary, sessionPageCount: response.pagination.pageCount }
        : current
    );
  }

  async function logoutAll() {
    if (state.kind !== "ready") return;
    setActionState("submitting");
    try {
      await apiRequest<void>("/auth/logout-all", {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken)
      });
      clearSession();
      setActionState("done");
      setState({ kind: "anonymous" });
    } catch {
      setActionState("error");
    }
  }

  async function createWebhook(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.kind !== "ready") return;
    setWebhookState({ kind: "submitting" });
    try {
      const formData = new FormData(event.currentTarget);
      const url = String(formData.get("webhookUrl") ?? "").trim();
      const eventTypes = String(formData.get("webhookEvents") ?? "")
        .split(",")
        .map((eventType) => eventType.trim())
        .filter(Boolean);
      const created = await apiRequest<{ endpoint: WebhookEndpointSummary; secret: string }>("/webhooks", {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken),
        body: JSON.stringify({ url, eventTypes })
      });
      setWebhookState({ kind: "created", secret: created.secret });
      await load();
    } catch (caught) {
      setWebhookState({ kind: "error", message: caught instanceof Error ? caught.message : "WEBHOOK_FAILED" });
    }
  }

  async function disableWebhook(endpointId: string) {
    if (state.kind !== "ready" || !state.principal.permissions.includes("webhooks.manage")) return;
    setDisablingWebhookId(endpointId);
    try {
      await apiRequest<{ endpoint: WebhookEndpointSummary }>(`/webhooks/${encodeURIComponent(endpointId)}`, {
        method: "DELETE",
        headers: authHeaders(state.session.tokens.accessToken)
      });
      await load();
    } catch (caught) {
      setWebhookState({ kind: "error", message: caught instanceof Error ? caught.message : "WEBHOOK_FAILED" });
    } finally {
      setDisablingWebhookId(null);
    }
  }

  async function createApiKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.kind !== "ready" || !state.principal.permissions.includes("api_keys.manage")) return;
    const form = event.currentTarget;
    setApiKeyState({ kind: "submitting" });
    try {
      const formData = new FormData(form);
      const name = String(formData.get("apiKeyName") ?? "").trim();
      const scopes = formData.getAll("apiKeyScopes").map(String);
      const created = await apiRequest<{ apiKey: ApiKeySummary; rawKey: string }>("/api-keys", {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken),
        body: JSON.stringify({ name, scopes })
      });
      setApiKeyState({ kind: "created", rawKey: created.rawKey });
      form.reset();
      await load();
    } catch (caught) {
      setApiKeyState({ kind: "error", message: caught instanceof Error ? caught.message : "API_KEY_FAILED" });
    }
  }

  async function revokeApiKey(apiKeyId: string) {
    if (state.kind !== "ready" || !state.principal.permissions.includes("api_keys.manage")) return;
    setRevokingApiKeyId(apiKeyId);
    try {
      await apiRequest<void>(`/api-keys/${encodeURIComponent(apiKeyId)}`, {
        method: "DELETE",
        headers: authHeaders(state.session.tokens.accessToken)
      });
      await load();
    } catch (caught) {
      setApiKeyState({ kind: "error", message: caught instanceof Error ? caught.message : "API_KEY_FAILED" });
    } finally {
      setRevokingApiKeyId(null);
    }
  }

  if (state.kind === "loading") return <Shell title={text.loading} detail={text.loadingDetail} text={text} />;
  if (state.kind === "anonymous") {
    return (
      <Shell title={text.loading} detail={text.anonymousDetail} text={text}>
        <Link className="mt-6 inline-flex h-10 items-center bg-ink px-4 text-sm font-semibold text-paper" href="/login">
          {text.signIn}
        </Link>
      </Shell>
    );
  }
  if (state.kind === "error") {
    return (
      <Shell title={text.errorTitle} detail={formatUserFacingError(state.message, locale)} text={text}>
        <SessionRecoveryActions locale={locale} />
      </Shell>
    );
  }

  return (
    <Shell title={text.loading} detail={`${state.session.tenant.name} - ${state.principal.displayName}`} text={text}>
      <section className="grid gap-8 lg:grid-cols-[1fr_360px]">
        <div className="space-y-8">
          <section>
            <h2 className="text-lg font-semibold">{text.account}</h2>
            <div className="mt-4 grid border-y border-black/10">
              <InfoRow label={text.email} value={state.principal.email} />
              <InfoRow label={text.tenant} value={`${state.session.tenant.name} / ${state.session.tenant.slug}`} />
              <InfoRow label={text.roles} value={state.principal.roles.map((role) => formatRole(role, locale)).join(", ")} />
              <InfoRow label={text.permissions} value={`${state.principal.permissions.length} izin`} />
            </div>
          </section>

          <section>
            <h2 className="text-lg font-semibold">{text.workspaces}</h2>
            <div className="mt-4 grid border-y border-black/10">
              {state.workspaces.map((workspace) => (
                <InfoRow key={workspace.id} label={workspace.name} value={formatWorkspaceKind(workspace.kind, locale)} />
              ))}
            </div>
          </section>

          <section>
            <h2 className="text-lg font-semibold">{text.sessions}</h2>
            <div className="mt-4 grid gap-3">
              {visibleSessions.map((session) => (
                <div key={session.id} className="border border-black/10 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="font-mono text-xs text-steel">{session.id}</span>
                    <StatusLabel session={session} />
                  </div>
                  <div className="mt-3 grid gap-2 text-sm text-steel md:grid-cols-3">
                    <span>{text.created} {formatDate(session.createdAt)}</span>
                    <span>{text.ends} {formatDate(session.expiresAt)}</span>
                    <span>{session.userAgent ?? text.unknownClient}</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 flex items-center justify-between border-t border-black/10 pt-3">
              <button
                type="button"
                className="h-9 border border-black/15 px-4 text-sm font-semibold disabled:opacity-40"
                disabled={sessionPage === 0}
                onClick={() => void showSessionPage(sessionPage - 1)}
              >
                {locale === "tr" ? "Önceki" : "Previous"}
              </button>
              <span className="text-xs text-steel">
                {locale === "tr" ? `Sayfa ${sessionPage + 1} / ${sessionPageCount}` : `Page ${sessionPage + 1} / ${sessionPageCount}`}
              </span>
              <button
                type="button"
                className="h-9 border border-black/15 px-4 text-sm font-semibold disabled:opacity-40"
                disabled={sessionPage + 1 >= sessionPageCount}
                onClick={() => void showSessionPage(sessionPage + 1)}
              >
                {locale === "tr" ? "Sonraki" : "Next"}
              </button>
            </div>
          </section>
        </div>

        <aside className="border-l border-black/10 pl-6">
          <h2 className="text-lg font-semibold">{text.security}</h2>
          <div className="mt-4 grid grid-cols-3 border-y border-black/10 py-4 text-center">
            <Metric label={text.active} value={sessionStats.active} />
            <Metric label={text.revoked} value={sessionStats.revoked} />
            <Metric label={text.expired} value={sessionStats.expired} />
          </div>
          <button
            type="button"
            onClick={() => void logoutAll()}
            disabled={actionState === "submitting"}
            className="mt-5 h-10 w-full bg-ink px-4 text-sm font-semibold text-paper disabled:opacity-60"
          >
            {text.logoutAll}
          </button>
          {actionState === "error" ? <p className="mt-3 text-sm text-danger">{text.logoutError}</p> : null}

          <h2 className="mt-8 text-lg font-semibold">{text.apiKeys}</h2>
          {state.principal.permissions.includes("api_keys.manage") ? (
            <form onSubmit={(event) => void createApiKey(event)} className="mt-4 space-y-3 border border-black/10 p-3">
              <label className="block text-sm font-medium">
                {text.apiKeyName}
                <input name="apiKeyName" required minLength={2} maxLength={120} className="mt-1 h-10 w-full border border-black/10 bg-paper px-3 text-sm text-ink" />
              </label>
              <fieldset>
                <legend className="text-sm font-medium">{text.apiKeyScopes}</legend>
                <label className="mt-2 flex min-h-10 items-center gap-2 text-sm">
                  <input name="apiKeyScopes" type="checkbox" value="documents.read" defaultChecked />
                  {text.documentsRead}
                </label>
                <label className="flex min-h-10 items-center gap-2 text-sm">
                  <input name="apiKeyScopes" type="checkbox" value="documents.upload" />
                  {text.documentsUpload}
                </label>
              </fieldset>
              <button type="submit" disabled={apiKeyState.kind === "submitting"} className="h-10 w-full bg-ink px-4 text-sm font-semibold text-paper disabled:opacity-60">
                {apiKeyState.kind === "submitting" ? text.creatingApiKey : text.createApiKey}
              </button>
            </form>
          ) : null}
          {apiKeyState.kind === "created" ? (
            <div className="mt-4 border border-signal/40 p-3 text-sm">
              <div className="font-semibold">{text.rawApiKey}</div>
              <code className="mt-2 block break-all text-xs text-steel">{apiKeyState.rawKey}</code>
              <p className="mt-2 text-xs text-steel">{text.rawApiKeyDetail}</p>
            </div>
          ) : null}
          {apiKeyState.kind === "error" ? <p className="mt-3 text-sm text-danger">{formatUserFacingError(apiKeyState.message, locale) || text.apiKeyError}</p> : null}
          <div className="mt-4 space-y-3">
            {state.apiKeys.length === 0 ? (
              <p className="text-sm text-steel">{text.noApiKeys}</p>
            ) : (
              state.apiKeys.map((key) => (
                <div key={key.id} className="border border-black/10 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="font-medium">{key.name}</div>
                    {key.revokedAt ? (
                      <span className="text-xs font-semibold text-steel">{text.revokedApiKey}</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void revokeApiKey(key.id)}
                        disabled={revokingApiKeyId === key.id}
                        className="text-xs font-semibold text-danger disabled:opacity-50"
                      >
                        {text.revokeApiKey}
                      </button>
                    )}
                  </div>
                  <div className="mt-1 text-xs text-steel">{key.keyPrefix} - {key.scopes.join(", ")}</div>
                </div>
              ))
            )}
          </div>

          <section className="mt-8 border-t border-black/10 pt-6">
            <h2 className="text-lg font-semibold">{text.intelligence}</h2>
            {state.aiStatus ? (
              <div className="mt-4 space-y-3 text-sm text-steel">
                <InfoRow label={text.aiProvider} value={state.aiStatus.enabled ? text.aiEnabled : state.aiStatus.provider === "disabled" ? text.aiDisabled : text.aiConfiguredOff} />
                <InfoRow label={text.provider} value={state.aiStatus.provider} />
                <InfoRow label={text.model} value={state.aiStatus.model ?? "-"} />
                <InfoRow label={text.rawInputStorage} value={state.aiStatus.rawInputStorage ? text.enabled : text.disabled} />
                {state.aiStatus.capabilityWarnings.map((warning) => (
                  <p key={warning} className="border border-black/10 p-3">{formatCapabilityWarning(warning, locale)}</p>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-sm text-steel">{text.aiDisabled}</p>
            )}
          </section>

          <section className="mt-8 border-t border-black/10 pt-6">
            <h2 className="text-lg font-semibold">{text.webhooks}</h2>
            <form onSubmit={(event) => void createWebhook(event)} className="mt-4 space-y-3">
              <label className="block text-sm font-medium">
                {text.webhookUrl}
                <input name="webhookUrl" type="url" required placeholder="https://example.test/spendlens" className="mt-1 h-10 w-full border border-black/10 bg-paper px-3 text-sm text-ink" />
              </label>
              <label className="block text-sm font-medium">
                {text.webhookEvents}
                <input name="webhookEvents" required defaultValue="expense.created" className="mt-1 h-10 w-full border border-black/10 bg-paper px-3 text-sm text-ink" />
                <span className="mt-1 block text-xs text-steel">{text.webhookEventsHint}</span>
              </label>
              <button type="submit" disabled={webhookState.kind === "submitting"} className="h-10 w-full bg-ink px-4 text-sm font-semibold text-paper disabled:opacity-60">
                {webhookState.kind === "submitting" ? text.creatingWebhook : text.createWebhook}
              </button>
            </form>
            {webhookState.kind === "created" ? (
              <div className="mt-4 border border-signal/40 p-3 text-sm">
                <div className="font-semibold">{text.webhookSecret}</div>
                <code className="mt-2 block break-all text-xs text-steel">{webhookState.secret}</code>
                <p className="mt-2 text-xs text-steel">{text.webhookSecretDetail}</p>
              </div>
            ) : null}
            {webhookState.kind === "error" ? <p className="mt-3 text-sm text-danger">{formatUserFacingError(webhookState.message, locale) || text.webhookError}</p> : null}
            <div className="mt-4 space-y-3">
              {state.webhooks.length === 0 ? (
                <p className="text-sm text-steel">{text.noWebhooks}</p>
              ) : (
                state.webhooks.map((endpoint) => (
                  <div key={endpoint.id} className="border border-black/10 p-3 text-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div className="break-all font-medium">{endpoint.url}</div>
                      {endpoint.enabled ? (
                        <button
                          type="button"
                          onClick={() => void disableWebhook(endpoint.id)}
                          disabled={disablingWebhookId === endpoint.id}
                          className="shrink-0 text-xs font-semibold text-danger disabled:opacity-50"
                        >
                          {text.disableWebhook}
                        </button>
                      ) : (
                        <span className="shrink-0 text-xs font-semibold text-steel">{text.webhookDisabled}</span>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-steel">{endpoint.eventTypes.join(", ")} - {endpoint.enabled ? text.enabled : text.disabled}</div>
                  </div>
                ))
              )}
            </div>
          </section>
        </aside>
      </section>
    </Shell>
  );
}

function Shell({
  title,
  detail,
  children,
  text
}: {
  title: string;
  detail: string;
  children?: React.ReactNode;
  text: SettingsCopy;
}) {
  void text;
  return <AppShell title={title} detail={detail}>{children}</AppShell>;
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-2 border-b border-black/10 py-3 last:border-b-0 md:grid-cols-[180px_1fr]">
      <div className="text-sm font-medium">{label}</div>
      <div className="break-words text-sm text-steel">{value}</div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-2xl font-semibold">{value}</div>
      <div className="text-xs uppercase text-steel">{label}</div>
    </div>
  );
}

function StatusLabel({ session }: { session: AuthSessionSummary }) {
  const expired = new Date(session.expiresAt).getTime() < Date.now();
  const label = session.revokedAt ? "İptal" : expired ? "Süresi doldu" : "Aktif";
  const className = label === "Aktif" ? "text-signal" : label === "İptal" ? "text-danger" : "text-steel";
  return <span className={`text-xs font-semibold uppercase ${className}`}>{label}</span>;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("tr-TR", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function formatRole(role: string, locale: "tr" | "en"): string {
  const labels: Record<string, { tr: string; en: string }> = {
    OWNER: { tr: "Sahip", en: "Owner" },
    ADMIN: { tr: "Yönetici", en: "Administrator" },
    FINANCE_MANAGER: { tr: "Finans yöneticisi", en: "Finance manager" },
    REVIEWER: { tr: "İnceleme uzmanı", en: "Reviewer" },
    EMPLOYEE: { tr: "Çalışan", en: "Employee" }
  };
  return labels[role]?.[locale] ?? role;
}

function formatWorkspaceKind(kind: string, locale: "tr" | "en"): string {
  const labels: Record<string, { tr: string; en: string }> = {
    BUSINESS: { tr: "İşletme", en: "Business" },
    PERSONAL: { tr: "Kişisel", en: "Personal" }
  };
  return labels[kind]?.[locale] ?? kind;
}

function formatCapabilityWarning(warning: string, locale: "tr" | "en"): string {
  if (locale === "en") return warning;
  if (/thinking mode requested as high/i.test(warning)) {
    return "Yüksek düşünme modu istendi; seçili sağlayıcı bu ayarı desteklemiyorsa varsayılan davranışını kullanabilir.";
  }
  if (/may ignore unsupported controls/i.test(warning)) {
    return "Sağlayıcı desteklemediği gelişmiş denetimleri yok sayabilir.";
  }
  return "Yapılandırılan AI sağlayıcısının bazı gelişmiş özellikleri desteklememe olasılığı var.";
}
