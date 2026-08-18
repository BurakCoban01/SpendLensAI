"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  apiRequest,
  authHeaders,
  type AuthResponse,
  type BudgetUsageSummary,
  type FinanceInsightAnalytics,
  type MonthlySpendAnalytics,
  type PrincipalResponse,
  type WorkspaceSummary
} from "../lib/api";
import { readSession } from "../lib/session";
import { useLocale } from "../lib/locale";
import { AppShell } from "./app-shell";
import { SessionRecoveryActions } from "./session-recovery-actions";

const copy = {
  tr: {
    loading: "Bütçeler",
    loadingDetail: "Finans çalışma alanı yükleniyor.",
    anonymousDetail: "Bütçe kullanımını görmek için önce giriş yapın.",
    signIn: "Giriş yap",
    title: "Bütçeler",
    detail: "Bütçe planlama ve aylık harcama",
    plan: "Plan",
    planDetail: "Bütçeler kuruş gibi küçük para birimleriyle tam sayı olarak saklanır.",
    authorized: "Yetkili",
    unauthorized: "Yetkisiz",
    expenses: "Giderler",
    workspace: "Çalışma alanı",
    month: "Ay",
    budgetName: "Bütçe adı",
    amount: "Tutar",
    currency: "Para birimi",
    alertPercent: "Uyarı yüzdesi",
    createBudget: "Bütçe oluştur",
    creating: "Oluşturuluyor...",
    created: "Bütçe oluşturuldu.",
    monthlySpend: "Aylık harcama",
    monthlySpendDetail: "Toplamlar bu çalışma alanında kayıtlı giderlerden hesaplanır.",
    noAccess: "Bu hesap bütçe analizlerini görüntüleme yetkisine sahip değil.",
    noBudget: "Bu çalışma alanı için bütçe oluşturulmamış.",
    exceeded: "Bütçe aşıldı",
    alert: "Uyarı",
    inPlan: "Plan dahilinde",
    remaining: "Kalan",
    trend: "Ay trendi",
    noPreviousMonth: "Önceki ay karşılaştırması yok",
    comparedToPrevious: "Önceki aya göre",
    cashflow: "Nakit akışı",
    localLedger: "Yalnızca giderlerden oluşan yerel defter",
    budgetAlerts: "Bütçe uyarıları",
    anomalySignals: "anomali sinyali",
    projectedMonthEnd: "Ay sonu tahmini",
    observedDays: "aktif gün gözlemlendi",
    dailyPace: "Günlük tempo",
    daysInMonth: "Ay içinde",
    projectedBudgetUsage: "Tahmini bütçe kullanımı",
    noBudgetRisk: "Tahmini bütçe riski yok",
    weeklyTrend: "Haftalık trend",
    categoryBreakdown: "Kategori dağılımı",
    merchantBreakdown: "Satıcı dağılımı",
    paymentMethods: "Ödeme yöntemleri",
    recommendations: "Öneriler",
    signals: "Sinyaller",
    exit: "Çıkış yap",
    dashboard: "Pano"
  },
  en: {
    loading: "Budgets",
    loadingDetail: "Loading financial workspace.",
    anonymousDetail: "Sign in first to see budget usage.",
    signIn: "Sign in",
    title: "Budgets",
    detail: "Budget planning and monthly spend",
    plan: "Plan",
    planDetail: "Budgets are stored as integers in minor units.",
    authorized: "Authorized",
    unauthorized: "Unauthorized",
    expenses: "Expenses",
    workspace: "Workspace",
    month: "Month",
    budgetName: "Budget name",
    amount: "Amount",
    currency: "Currency",
    alertPercent: "Alert percent",
    createBudget: "Create budget",
    creating: "Creating...",
    created: "Budget created.",
    monthlySpend: "Monthly spend",
    monthlySpendDetail: "Totals are calculated from expenses recorded in this workspace.",
    noAccess: "This account cannot view budget analytics.",
    noBudget: "No budget has been created for this workspace.",
    exceeded: "Budget exceeded",
    alert: "Alert",
    inPlan: "In plan",
    remaining: "Remaining",
    trend: "Month trend",
    noPreviousMonth: "No previous month comparison",
    comparedToPrevious: "Compared with previous month",
    cashflow: "Cash flow",
    localLedger: "Local ledger made only of expenses",
    budgetAlerts: "Budget alerts",
    anomalySignals: "anomaly signals",
    projectedMonthEnd: "Projected month-end",
    observedDays: "active days observed",
    dailyPace: "Daily pace",
    daysInMonth: "Days in the month",
    projectedBudgetUsage: "Projected budget usage",
    noBudgetRisk: "No projected budget risk",
    weeklyTrend: "Weekly trend",
    categoryBreakdown: "Category breakdown",
    merchantBreakdown: "Merchant breakdown",
    paymentMethods: "Payment methods",
    recommendations: "Recommendations",
    signals: "Signals",
    exit: "Sign out",
    dashboard: "Dashboard"
  }
} as const;

type BudgetState =
  | { kind: "loading" }
  | { kind: "anonymous" }
  | {
      kind: "ready";
      session: AuthResponse;
      principal: PrincipalResponse["principal"];
      workspaces: WorkspaceSummary[];
      selectedWorkspaceId: string;
      month: string;
      budgets: BudgetUsageSummary[];
      analytics: MonthlySpendAnalytics | null;
      insights: FinanceInsightAnalytics | null;
    }
  | { kind: "error"; message: string };

type SubmitState = { kind: "idle" } | { kind: "submitting" } | { kind: "success" } | { kind: "error"; message: string };

const currencies = ["TRY", "USD", "EUR", "GBP"] as const;

export function BudgetsClient() {
  const { locale } = useLocale();
  const text = copy[locale];
  const [state, setState] = useState<BudgetState>({ kind: "loading" });
  const [submitState, setSubmitState] = useState<SubmitState>({ kind: "idle" });

  async function load(preferredWorkspaceId?: string, preferredMonth?: string) {
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
      const canRead = principal.principal.permissions.includes("expenses.read");
      const [budgets, analytics, insights] =
        selectedWorkspaceId && canRead
          ? await Promise.all([
              apiRequest<{ budgets: BudgetUsageSummary[] }>(
                `/budgets?workspaceId=${encodeURIComponent(selectedWorkspaceId)}&month=${encodeURIComponent(month)}`,
                { headers: authHeaders(session.tokens.accessToken) }
              ),
              apiRequest<{ analytics: MonthlySpendAnalytics }>(
                `/analytics/monthly-spend?workspaceId=${encodeURIComponent(selectedWorkspaceId)}&month=${encodeURIComponent(month)}`,
                { headers: authHeaders(session.tokens.accessToken) }
              ),
              apiRequest<{ analytics: FinanceInsightAnalytics }>(
                `/analytics/finance-insights?workspaceId=${encodeURIComponent(selectedWorkspaceId)}&month=${encodeURIComponent(month)}`,
                { headers: authHeaders(session.tokens.accessToken) }
              )
            ])
          : [{ budgets: [] }, { analytics: null }, { analytics: null }];
      setState({
        kind: "ready",
        session,
        principal: principal.principal,
        workspaces,
        selectedWorkspaceId,
        month,
        budgets: budgets.budgets,
        analytics: analytics.analytics,
        insights: insights.analytics
      });
    } catch (caught) {
      setState({ kind: "error", message: caught instanceof Error ? caught.message : "BUDGETS_LOAD_FAILED" });
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const canRead = state.kind === "ready" && state.principal.permissions.includes("expenses.read");
  const canManage = state.kind === "ready" && state.principal.permissions.includes("budgets.manage");

  const totals = useMemo(() => {
    if (state.kind !== "ready" || !state.analytics) return null;
    return [
      [locale === "tr" ? "Toplam harcama" : "Total spend", state.analytics.totalMinor],
      [locale === "tr" ? "İş gideri" : "Business expense", state.analytics.businessMinor],
      [locale === "tr" ? "Geri ödenebilir" : "Reimbursable", state.analytics.reimbursableMinor]
    ] as const;
  }, [state]);

  async function createBudget(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.kind !== "ready" || !canManage) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const amountMinor = parseDecimalMinor(String(form.get("amount") ?? ""));
    const alertPercent = Number(form.get("alertPercent") ?? 80);
    if (!amountMinor || !Number.isInteger(alertPercent) || alertPercent < 1 || alertPercent > 100) {
      setSubmitState({ kind: "error", message: locale === "tr" ? "Geçerli bir tutar ve uyarı yüzdesi girin." : "Enter a valid amount and alert percent." });
      return;
    }
    setSubmitState({ kind: "submitting" });
    try {
      await apiRequest<{ budget: unknown; usage: BudgetUsageSummary }>("/budgets", {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken),
        body: JSON.stringify({
          workspaceId: state.selectedWorkspaceId,
          name: form.get("name"),
          currency: form.get("currency"),
          amountMinor,
          alertPercent,
          month: state.month
        })
      });
      formElement.reset();
      setSubmitState({ kind: "success" });
      await load(state.selectedWorkspaceId, state.month);
    } catch (caught) {
      setSubmitState({ kind: "error", message: caught instanceof Error ? caught.message : "BUDGET_CREATE_FAILED" });
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
    <Shell title={text.title} detail={`${state.principal.displayName} - ${state.month}`} text={text}>
      <div className="grid gap-8 xl:grid-cols-[380px_minmax(0,1fr)]">
        <section className="border-y border-black/10 py-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold">{text.plan}</h2>
              <p className="mt-1 text-sm text-steel">{text.planDetail}</p>
            </div>
            <span className={canManage ? "text-xs font-semibold uppercase tracking-normal text-signal" : "text-xs font-semibold uppercase tracking-normal text-black/35"}>
              {canManage ? text.authorized : text.unauthorized}
            </span>
          </div>

          <div className="mt-6 grid gap-4">
            <Field label={text.workspace}>
              <select
                className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal"
                value={state.selectedWorkspaceId}
                onChange={(event) => void load(event.target.value, state.month)}
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
                onChange={(event) => void load(state.selectedWorkspaceId, event.target.value)}
              />
            </Field>
          </div>

          <form onSubmit={createBudget} className="mt-6 space-y-4 border-t border-black/10 pt-6">
            <Field label={text.budgetName}>
              <input name="name" required maxLength={160} className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal" />
            </Field>
            <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
              <Field label={text.amount}>
                <input name="amount" required inputMode="decimal" placeholder="6000,00" className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal" />
              </Field>
              <Field label={text.currency}>
                <select name="currency" defaultValue="TRY" className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal">
                  {currencies.map((currency) => (
                    <option key={currency} value={currency}>
                      {currency}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label={text.alertPercent}>
              <input name="alertPercent" type="number" min={1} max={100} defaultValue={80} className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal" />
            </Field>
            {submitState.kind === "error" ? <p className="text-sm font-medium text-red-700">{submitState.message}</p> : null}
            {submitState.kind === "success" ? <p className="text-sm font-medium text-signal">{text.created}</p> : null}
            <button
              className="h-11 w-full bg-ink text-sm font-semibold text-paper hover:bg-signal disabled:cursor-not-allowed disabled:bg-black/25"
              disabled={!canManage || !state.selectedWorkspaceId || submitState.kind === "submitting"}
            >
              {submitState.kind === "submitting" ? text.creating : text.createBudget}
            </button>
          </form>
        </section>

        <section className="border-y border-black/10 py-6">
          <div className="flex flex-col gap-4 border-b border-black/10 pb-5 md:flex-row md:items-end md:justify-between">
            <div>
              <h2 className="text-xl font-semibold">{text.monthlySpend}</h2>
              <p className="mt-1 text-sm text-steel">{text.monthlySpendDetail}</p>
            </div>
            <span className="text-sm text-steel">{state.analytics?.expenseCount ?? 0} gider</span>
          </div>

          {!canRead ? (
            <div className="py-12 text-sm text-steel">{text.noAccess}</div>
          ) : (
            <>
              <div className="grid gap-4 border-b border-black/10 py-5 md:grid-cols-3">
                {totals?.map(([label, amount]) => (
                  <div key={label}>
                    <div className="text-xs font-semibold uppercase tracking-normal text-steel">{label}</div>
                    <div className="mt-2 text-2xl font-semibold">{formatMoney(BigInt(amount), state.analytics?.currency ?? "TRY")}</div>
                  </div>
                ))}
              </div>

              <div className="divide-y divide-black/10">
                {state.budgets.length === 0 ? (
                  <div className="py-12 text-sm text-steel">{text.noBudget}</div>
                ) : (
                  state.budgets.map((usage) => (
                    <div key={usage.budget.id} className="grid gap-4 py-5 lg:grid-cols-[minmax(0,1fr)_180px_120px]">
                      <div className="min-w-0">
                        <div className="flex items-center justify-between gap-3">
                          <h3 className="truncate text-sm font-semibold">{usage.budget.name}</h3>
                          <span className={usage.utilizationPercent > 100 ? "text-xs font-semibold uppercase tracking-normal text-red-700" : usage.alertTriggered ? "text-xs font-semibold uppercase tracking-normal text-amber-700" : "text-xs font-semibold uppercase tracking-normal text-signal"}>
                            {usage.utilizationPercent > 100 ? text.exceeded : usage.alertTriggered ? text.alert : text.inPlan}
                          </span>
                        </div>
                        <div className="mt-3 h-2 w-full bg-black/10">
                          <div className={usage.utilizationPercent > 100 ? "h-2 bg-red-700" : usage.alertTriggered ? "h-2 bg-amber-600" : "h-2 bg-signal"} style={{ width: `${Math.min(100, Math.max(0, usage.utilizationPercent))}%` }} />
                        </div>
                        <div className="mt-2 text-xs text-steel">
                          {formatMoney(BigInt(usage.budget.amountMinor), usage.budget.currency)} bütçenin {formatMoney(BigInt(usage.period.spentMinor), usage.budget.currency)} tutarı kullanıldı
                        </div>
                      </div>
                      <div className="text-sm font-semibold">{usage.utilizationPercent.toFixed(2)}%</div>
                      <div className="text-sm text-steel">
                        {text.remaining}
                        <br />
                        {formatMoney(BigInt(usage.remainingMinor), usage.budget.currency)}
                      </div>
                    </div>
                  ))
                )}
              </div>

              {state.insights ? (
                <div className="border-t border-black/10 pt-6">
                  <div className="grid gap-4 md:grid-cols-3">
                    <InsightMetric
                        label={text.trend}
                      value={formatMoney(BigInt(state.insights.trend.deltaMinor), state.insights.currency)}
                      detail={
                        state.insights.trend.deltaPercent === null
                          ? text.noPreviousMonth
                          : `${text.comparedToPrevious} ${formatPercent(state.insights.trend.deltaPercent)}`
                      }
                    />
                    <InsightMetric label={text.cashflow} value={formatMoney(BigInt(state.insights.cashflow.netMinor), state.insights.currency)} detail={text.localLedger} />
                    <InsightMetric
                      label={text.budgetAlerts}
                      value={String(state.insights.budgetAlerts.filter((alert) => alert.severity !== "ok").length)}
                      detail={`${state.insights.anomalySummary.length} ${text.anomalySignals}`}
                    />
                  </div>

                  <div className="mt-6 border-t border-black/10 pt-5">
                    <div className="grid gap-4 md:grid-cols-3">
                      <InsightMetric
                        label={text.projectedMonthEnd}
                        value={formatMoney(BigInt(state.insights.forecast.projectedMonthEndMinor), state.insights.currency)}
                        detail={`${state.insights.forecast.observedDayCount} ${text.observedDays}`}
                      />
                      <InsightMetric
                        label={text.dailyPace}
                        value={formatMoney(BigInt(state.insights.forecast.dailyAverageMinor), state.insights.currency)}
                        detail={`${text.daysInMonth} ${state.insights.forecast.monthDayCount}`}
                      />
                      <InsightMetric
                        label={text.projectedBudgetUsage}
                        value={
                          state.insights.forecast.projectedBudgetUtilizationPercent === null
                            ? (locale === "tr" ? "Bütçe yok" : "No budget")
                            : formatPercent(state.insights.forecast.projectedBudgetUtilizationPercent)
                        }
                        detail={state.insights.forecast.largestBudgetRisk?.name ?? text.noBudgetRisk}
                      />
                    </div>
                  </div>

                  <div className="mt-6 grid gap-6 xl:grid-cols-2">
                    <InsightList
                      title={text.weeklyTrend}
                      rows={state.insights.weeklySpend.map((week) => ({
                        key: week.weekStart,
                        label: formatWeekRange(week.weekStart, week.weekEnd),
                        value: formatMoney(BigInt(week.totalMinor), state.insights?.currency ?? "TRY"),
                        detail: `${week.expenseCount} gider`
                      }))}
                    />
                    <InsightList
                      title={text.categoryBreakdown}
                      rows={state.insights.categoryBreakdown.slice(0, 5).map((category) => ({
                        key: category.categoryId,
                        label:
                          state.analytics?.budgetUsage.find((usage) => usage.budget.categoryId === category.categoryId)?.budget.name ??
                          "Kategorisiz",
                        value: formatMoney(BigInt(category.totalMinor), state.insights?.currency ?? "TRY"),
                        detail: `${formatPercent(category.sharePercent)} pay`
                      }))}
                    />
                    <InsightList
                      title={text.merchantBreakdown}
                      rows={state.insights.merchantBreakdown.slice(0, 5).map((merchant) => ({
                        key: merchant.merchant,
                        label: merchant.merchant,
                        value: formatMoney(BigInt(merchant.totalMinor), state.insights?.currency ?? "TRY"),
                        detail: `${merchant.expenseCount} gider`
                      }))}
                    />
                    <InsightList
                      title={text.paymentMethods}
                      rows={state.insights.paymentMethodBreakdown.slice(0, 5).map((paymentMethod) => ({
                        key: paymentMethod.paymentMethod,
                        label: paymentMethod.paymentMethod,
                        value: formatMoney(BigInt(paymentMethod.totalMinor), state.insights?.currency ?? "TRY"),
                        detail: `${paymentMethod.expenseCount} gider`
                      }))}
                    />
                  </div>

                  {state.insights.recommendations.length > 0 ? (
                    <div className="mt-6 border-t border-black/10 pt-5">
                      <h3 className="text-sm font-semibold">{text.recommendations}</h3>
                      <div className="mt-3 divide-y divide-black/10">
                        {state.insights.recommendations.map((recommendation) => (
                          <div key={recommendation.code} className="grid gap-2 py-3 text-sm md:grid-cols-[minmax(0,1fr)_120px]">
                            <div className="min-w-0">
                              <div className="truncate font-semibold">{formatRecommendationCode(recommendation.code)}</div>
                              <div className="text-xs text-steel">{formatRecommendationMessage(recommendation.code, recommendation.message)}</div>
                            </div>
                            <span className={severityClass(recommendation.severity)}>{formatSeverity(recommendation.severity)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {state.insights.anomalySummary.length > 0 ? (
                    <div className="mt-6 border-t border-black/10 pt-5">
                      <h3 className="text-sm font-semibold">{text.signals}</h3>
                      <div className="mt-3 divide-y divide-black/10">
                        {state.insights.anomalySummary.map((anomaly) => (
                          <div key={anomaly.code} className="flex items-center justify-between gap-4 py-3 text-sm">
                            <div className="min-w-0">
                              <div className="truncate font-semibold">{formatAnomalyCode(anomaly.code)}</div>
                              <div className="text-xs text-steel">{anomaly.count} eşleşme</div>
                            </div>
                            <span className={severityClass(anomaly.severity)}>{formatSeverity(anomaly.severity)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
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

function InsightMetric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="border-t border-black/10 pt-4">
      <div className="text-xs font-semibold uppercase tracking-normal text-steel">{label}</div>
      <div className="mt-2 text-xl font-semibold">{value}</div>
      <div className="mt-1 text-xs text-steel">{detail}</div>
    </div>
  );
}

function InsightList({ title, rows }: { title: string; rows: Array<{ key: string; label: string; value: string; detail: string }> }) {
  return (
    <div>
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="mt-3 divide-y divide-black/10">
        {rows.length === 0 ? (
          <div className="py-4 text-sm text-steel">Bu ay için veri yok.</div>
        ) : (
          rows.map((row) => (
            <div key={row.key} className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 py-3 text-sm">
              <div className="min-w-0">
                <div className="truncate font-medium">{row.label}</div>
                <div className="text-xs text-steel">{row.detail}</div>
              </div>
              <div className="font-semibold">{row.value}</div>
            </div>
          ))
        )}
      </div>
    </div>
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

function parseDecimalMinor(value: string): string | null {
  const normalized = value.trim().replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const [whole, fraction = ""] = normalized.split(".");
  return `${whole}${fraction.padEnd(2, "0")}`.replace(/^0+(?=\d)/, "") || "0";
}

function formatMoney(amountMinor: bigint, currency: string): string {
  const sign = amountMinor < 0n ? "-" : "";
  const absolute = amountMinor < 0n ? -amountMinor : amountMinor;
  const major = absolute / 100n;
  const minor = absolute % 100n;
  return `${sign}${major.toString()},${minor.toString().padStart(2, "0")} ${currency}`;
}

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
}

function formatWeekRange(startsAt: string, endsAt: string): string {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  end.setUTCDate(end.getUTCDate() - 1);
  return `${start.getUTCDate().toString().padStart(2, "0")}.${(start.getUTCMonth() + 1).toString().padStart(2, "0")} - ${end.getUTCDate().toString().padStart(2, "0")}.${(end.getUTCMonth() + 1).toString().padStart(2, "0")}`;
}

function severityClass(severity: FinanceInsightAnalytics["anomalySummary"][number]["severity"]): string {
  if (severity === "critical") return "text-xs font-semibold uppercase tracking-normal text-red-700";
  if (severity === "warning") return "text-xs font-semibold uppercase tracking-normal text-amber-700";
  return "text-xs font-semibold uppercase tracking-normal text-steel";
}

function formatSeverity(severity: FinanceInsightAnalytics["anomalySummary"][number]["severity"]): string {
  if (severity === "critical") return "Kritik";
  if (severity === "warning") return "Uyarı";
  return "Normal";
}

function formatRecommendationCode(code: FinanceInsightAnalytics["recommendations"][number]["code"]): string {
  const labels: Record<FinanceInsightAnalytics["recommendations"][number]["code"], string> = {
    PROJECTED_OVER_BUDGET: "Bütçe aşımı tahmini",
    HIGH_RUN_RATE: "Yüksek harcama temposu",
    REIMBURSABLE_FOLLOW_UP: "Geri ödeme takibi",
    NO_BUDGET: "Bütçe yok"
  };
  return labels[code] ?? code.replaceAll("_", " ");
}

function formatRecommendationMessage(code: FinanceInsightAnalytics["recommendations"][number]["code"], fallback: string): string {
  const labels: Record<FinanceInsightAnalytics["recommendations"][number]["code"], string> = {
    PROJECTED_OVER_BUDGET: "Ay sonu harcama tahmini en az bir tanımlı bütçenin üzerinde.",
    HIGH_RUN_RATE: "Gözlemlenen günlük harcama temposu önceki aya göre yüksek seyrediyor.",
    REIMBURSABLE_FOLLOW_UP: "Ay sonu raporlamasından önce geri ödenebilir giderleri kontrol edin.",
    NO_BUDGET: "Bu çalışma alanı için bütçe tanımlayın."
  };
  return labels[code] ?? fallback;
}

function formatAnomalyCode(code: string): string {
  const labels: Record<string, string> = {
    WEEKEND_BUSINESS_EXPENSE: "Hafta sonu iş gideri",
    REIMBURSABLE_CONCENTRATION: "Geri ödenebilir gider yoğunluğu",
    HIGH_VALUE_EXPENSE: "Yüksek tutarlı gider",
    DUPLICATE_RECEIPT: "Tekrarlı fiş"
  };
  return labels[code] ?? code.replaceAll("_", " ");
}
