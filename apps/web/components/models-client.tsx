"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  apiRequest,
  authHeaders,
  formatUserFacingError,
  type AuthResponse,
  type ModelBenchmarkResultSummary,
  type ModelEvaluationRunSummary,
  type ModelRollbackResultSummary,
  type ModelStatus,
  type ModelTrainResultSummary,
  type ModelTrainingRunSummary,
  type ModelVersionSummary,
  type ModelsOverviewResponse,
  type PrincipalResponse
} from "../lib/api";
import { readSession } from "../lib/session";
import { useLocale } from "../lib/locale";
import { AppShell } from "./app-shell";
import { SessionRecoveryActions } from "./session-recovery-actions";

const copy = {
  tr: {
    loading: "Modeller",
    loadingDetail: "Model kayıt defteri yükleniyor.",
    anonymousDetail: "Model kayıt defteri ekranını açmak için önce giriş yapın.",
    signIn: "Giriş yap",
    title: "Modeller",
    detail: "yerel eğitim ve değerlendirme kayıt defteri",
    noAccess: "Bu hesap model eğitim çalışmalarını okuyamaz veya başlatamaz.",
    quickTrain: "Hızlı eğitim",
    quickTrainDetail: "Yerel sentetik kategori profilini çalıştırır ve aday bir artefakt kaydeder.",
    local: "Yerel",
    categorySeed: "Kategori başlangıç değeri",
    samplesPerCategory: "Kategori başına örnek",
    categoryTrainFailed: "Kategori eğitimi başarısız oldu. API loglarını ve Python bağımlılıklarını kontrol edin.",
    train: "Eğitiliyor...",
    startCategoryTrain: "Kategori eğitimini başlat",
    fullCategoryProfile: "Tam kategori profili",
    fullCategoryDetail: "Daha büyük yerel kategori profilini çalıştırır ve aday bir artefakt kaydeder.",
    customOcr: "Custom OCR",
    customOcrDetail: "Hızlı CRNN/CTC doğrulama profilini çalıştırır; doğrulanmış aktif model normal OCR akışında otomatik kullanılır.",
    ocrSeed: "OCR başlangıç değeri",
    sampleCount: "Örnek sayısı",
    epochCount: "Epoch sayısı",
    customTrainFailed: "Custom OCR eğitimi başarısız oldu. API loglarını ve Python bağımlılıklarını kontrol edin.",
    startCustomTrain: "Custom OCR eğitimini başlat",
    fullCustomProfile: "Tam Custom OCR profili",
    fullCustomDetail: "Daha büyük CRNN/CTC local_full profilini çalıştırır ve kalite değerlendirmesine hazır bir aday model kaydeder.",
    customFullTrainFailed: "Tam Custom OCR eğitimi başarısız oldu. API loglarını ve Python bağımlılıklarını kontrol edin.",
    latestMetrics: "Son metrikler",
    noMetrics: "Henüz model metriği kaydedilmedi.",
    trainingRuns: "Eğitim çalışmaları",
    noTrainingRuns: "Henüz kategori eğitim çalışması başlatılmadı.",
    evaluationRuns: "Değerlendirme çalışmaları",
    noEvaluationRuns: "Henüz model değerlendirme çalışması kaydedilmedi.",
    modelRegistry: "Model kayıt defteri",
    noModelVersion: "Henüz model sürümü kaydedilmedi.",
    noBenchmark: "Henüz kıyaslama yok",
    modelMetrics: "Model metrikleri",
    compareHint: "Kıyaslama çalıştırmadan önce bir Custom OCR modeli eğitin.",
    exit: "Çıkış yap",
    dashboard: "Pano"
  },
  en: {
    loading: "Models",
    loadingDetail: "Loading model ledger.",
    anonymousDetail: "Sign in first to open the model ledger.",
    signIn: "Sign in",
    title: "Models",
    detail: "local training and evaluation ledger",
    noAccess: "This account cannot read or start model training runs.",
    quickTrain: "Quick training",
    quickTrainDetail: "Runs a local synthetic category profile and stores a candidate artifact.",
    local: "Local",
    categorySeed: "Category seed",
    samplesPerCategory: "Samples per category",
    categoryTrainFailed: "Category training failed. Check API logs and Python dependencies.",
    train: "Training...",
    startCategoryTrain: "Start category training",
    fullCategoryProfile: "Full category profile",
    fullCategoryDetail: "Runs a larger local category profile and stores a candidate artifact.",
    customOcr: "Custom OCR",
    customOcrDetail: "Runs a quick CRNN/CTC validation profile; normal local use is prepared with `pnpm custom-ocr:bootstrap`.",
    ocrSeed: "OCR seed",
    sampleCount: "Sample count",
    epochCount: "Epoch count",
    customTrainFailed: "Custom OCR training failed. Check API logs and Python dependencies.",
    startCustomTrain: "Start Custom OCR training",
    fullCustomProfile: "Full Custom OCR profile",
    fullCustomDetail: "Runs the larger CRNN/CTC local_full profile and stores a candidate model. Use `pnpm custom-ocr:bootstrap` to activate an existing checkpoint locally.",
    customFullTrainFailed: "Full Custom OCR training failed. Check API logs and Python dependencies.",
    latestMetrics: "Latest metrics",
    noMetrics: "No model metrics saved yet.",
    trainingRuns: "Training runs",
    noTrainingRuns: "No category training run started yet.",
    evaluationRuns: "Evaluation runs",
    noEvaluationRuns: "No model evaluation run recorded yet.",
    modelRegistry: "Model ledger",
    noModelVersion: "No model version saved yet.",
    noBenchmark: "No benchmark yet",
    modelMetrics: "Model metrics",
    compareHint: "Train a Custom OCR model before running a benchmark.",
    exit: "Sign out",
    dashboard: "Dashboard"
  }
} as const;

type ModelsState =
  | { kind: "loading" }
  | { kind: "anonymous" }
  | { kind: "ready"; session: AuthResponse; principal: PrincipalResponse["principal"]; overview: ModelsOverviewResponse }
  | { kind: "error"; message: string };

type SubmitState = "idle" | "submitting" | "error";

export function ModelsClient() {
  const { locale } = useLocale();
  const text = copy[locale];
  const [state, setState] = useState<ModelsState>({ kind: "loading" });
  const [categorySubmitState, setCategorySubmitState] = useState<SubmitState>("idle");
  const [customOcrSubmitState, setCustomOcrSubmitState] = useState<SubmitState>("idle");
  const [categoryFullSubmitState, setCategoryFullSubmitState] = useState<SubmitState>("idle");
  const [customOcrFullSubmitState, setCustomOcrFullSubmitState] = useState<SubmitState>("idle");
  const [customOcrFullError, setCustomOcrFullError] = useState<string | null>(null);
  const [promotingId, setPromotingId] = useState<string | null>(null);
  const [rollingBackId, setRollingBackId] = useState<string | null>(null);
  const [benchmarkingId, setBenchmarkingId] = useState<string | null>(null);
  const [benchmarkError, setBenchmarkError] = useState<string | null>(null);

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
      const canTrain = principal.principal.permissions.includes("models.train");
      const overview = canTrain
        ? await apiRequest<ModelsOverviewResponse>("/models", {
            headers: authHeaders(session.tokens.accessToken)
          })
        : { models: [], trainingRuns: [], evaluationRuns: [] };
      setState({ kind: "ready", session, principal: principal.principal, overview });
    } catch (caught) {
      setState({ kind: "error", message: caught instanceof Error ? caught.message : "MODELS_LOAD_FAILED" });
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const latestCategoryMetrics = useMemo(() => {
    if (state.kind !== "ready") return null;
    return state.overview.models.find((model) => model.engine === "CATEGORY_ML" && model.metrics)?.metrics ?? null;
  }, [state]);

  const latestCustomOcrMetrics = useMemo(() => {
    if (state.kind !== "ready") return null;
    return (
      state.overview.models.find((model) => model.engine === "CUSTOM_CRNN" && model.status === "ACTIVE" && model.metrics)?.metrics ??
      state.overview.models.find((model) => model.engine === "CUSTOM_CRNN" && model.metrics)?.metrics ??
      null
    );
  }, [state]);

  async function startSmokeTraining(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.kind !== "ready") return;
    const form = new FormData(event.currentTarget);
    setCategorySubmitState("submitting");
    try {
      const result = await apiRequest<ModelTrainResultSummary>("/models/category/smoke-train", {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken),
        body: JSON.stringify({
          seed: Number(form.get("seed") ?? 42),
          samplesPerCategory: Number(form.get("samplesPerCategory") ?? 12)
        })
      });
      setState({
        ...state,
        overview: {
          models: [result.modelVersion, ...state.overview.models],
          trainingRuns: [result.trainingRun, ...state.overview.trainingRuns],
          evaluationRuns: [result.evaluationRun, ...state.overview.evaluationRuns]
        }
      });
      setCategorySubmitState("idle");
    } catch {
      setCategorySubmitState("error");
    }
  }

  async function startCustomOcrSmokeTraining(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.kind !== "ready") return;
    const form = new FormData(event.currentTarget);
    setCustomOcrSubmitState("submitting");
    try {
      const result = await apiRequest<ModelTrainResultSummary>("/models/custom-ocr/smoke-train", {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken),
        body: JSON.stringify({
          seed: Number(form.get("seed") ?? 42),
          samples: Number(form.get("samples") ?? 16),
          epochs: Number(form.get("epochs") ?? 1)
        })
      });
      setState({
        ...state,
        overview: {
          models: [result.modelVersion, ...state.overview.models],
          trainingRuns: [result.trainingRun, ...state.overview.trainingRuns],
          evaluationRuns: [result.evaluationRun, ...state.overview.evaluationRuns]
        }
      });
      setCustomOcrSubmitState("idle");
    } catch {
      setCustomOcrSubmitState("error");
    }
  }

  async function startCategoryFullTraining(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.kind !== "ready") return;
    const form = new FormData(event.currentTarget);
    setCategoryFullSubmitState("submitting");
    try {
      const result = await apiRequest<ModelTrainResultSummary>("/models/category/full-train", {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken),
        body: JSON.stringify({
          seed: Number(form.get("seed") ?? 42),
          samplesPerCategory: Number(form.get("samplesPerCategory") ?? 128)
        })
      });
      setState({
        ...state,
        overview: {
          models: [result.modelVersion, ...state.overview.models],
          trainingRuns: [result.trainingRun, ...state.overview.trainingRuns],
          evaluationRuns: [result.evaluationRun, ...state.overview.evaluationRuns]
        }
      });
      setCategoryFullSubmitState("idle");
    } catch {
      setCategoryFullSubmitState("error");
    }
  }

  async function startCustomOcrFullTraining(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.kind !== "ready") return;
    const form = new FormData(event.currentTarget);
    setCustomOcrFullSubmitState("submitting");
    setCustomOcrFullError(null);
    try {
      const result = await apiRequest<ModelTrainResultSummary>("/models/custom-ocr/full-train", {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken),
        body: JSON.stringify({
          seed: Number(form.get("seed") ?? 42),
          samples: Number(form.get("samples") ?? 2048),
          epochs: Number(form.get("epochs") ?? 8)
        })
      });
      setState({
        ...state,
        overview: {
          models: [result.modelVersion, ...state.overview.models],
          trainingRuns: [result.trainingRun, ...state.overview.trainingRuns],
          evaluationRuns: [result.evaluationRun, ...state.overview.evaluationRuns]
        }
      });
      setCustomOcrFullSubmitState("idle");
    } catch (caught) {
      setCustomOcrFullError(formatUserFacingError(errorMessage(caught), locale));
      setCustomOcrFullSubmitState("error");
    }
  }

  async function promote(modelId: string) {
    if (state.kind !== "ready") return;
    setPromotingId(modelId);
    try {
      const promoted = await apiRequest<ModelVersionSummary>(`/models/${modelId}/promote`, {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken)
      });
      setState({
        ...state,
        overview: {
          ...state.overview,
          models: state.overview.models.map((model) => {
            if (model.id === promoted.id) return promoted;
            if (model.engine === promoted.engine && model.status === "ACTIVE") return { ...model, status: "ARCHIVED" };
            return model;
          })
        }
      });
    } finally {
      setPromotingId(null);
    }
  }

  async function rollback(modelId: string) {
    if (state.kind !== "ready") return;
    setRollingBackId(modelId);
    try {
      const result = await apiRequest<ModelRollbackResultSummary>(`/models/${modelId}/rollback`, {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken)
      });
      const rolledBack = result.modelVersion;
      setState({
        ...state,
        overview: {
          ...state.overview,
          models: state.overview.models.map((model) => {
            if (model.id === rolledBack.id) return rolledBack;
            if (model.engine === rolledBack.engine && model.status === "ACTIVE") return { ...model, status: "ARCHIVED" };
            return model;
          })
        }
      });
    } finally {
      setRollingBackId(null);
    }
  }

  async function runOcrBenchmark(modelId: string) {
    if (state.kind !== "ready") return;
    setBenchmarkingId(modelId);
    setBenchmarkError(null);
    try {
      const result = await apiRequest<ModelBenchmarkResultSummary>(`/models/${modelId}/ocr-benchmark`, {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken),
        body: JSON.stringify({
          seed: 42,
          samples: 3,
          split: "all",
          skipTesseract: false
        })
      });
      setState({
        ...state,
        overview: {
          ...state.overview,
          models: state.overview.models.map((model) => (model.id === result.modelVersion.id ? result.modelVersion : model)),
          evaluationRuns: [result.evaluationRun, ...state.overview.evaluationRuns]
        }
      });
    } catch (caught) {
      setBenchmarkError(formatUserFacingError(errorMessage(caught), locale));
    } finally {
      setBenchmarkingId(null);
    }
  }

  if (state.kind === "loading") return <Shell title={text.loading} detail={text.loadingDetail} text={text} locale={locale} />;

  if (state.kind === "anonymous") {
    return (
      <Shell title={text.title} detail={text.anonymousDetail} text={text} locale={locale}>
        <Link className="mt-6 inline-flex h-10 items-center bg-ink px-4 text-sm font-semibold text-paper" href="/login">
          {text.signIn}
        </Link>
      </Shell>
    );
  }

  if (state.kind === "error") {
    return (
      <Shell title={text.title} detail={formatUserFacingError(state.message, locale)} text={text} locale={locale}>
        <SessionRecoveryActions locale={locale} />
      </Shell>
    );
  }

  const canTrain = state.principal.permissions.includes("models.train");
  const canPromote = state.principal.permissions.includes("models.promote");

  return (
    <Shell title={text.title} detail={`${state.principal.displayName} - ${text.detail}`} text={text} locale={locale}>
      {!canTrain ? (
        <section className="border-y border-black/10 py-10 text-sm text-steel">{text.noAccess}</section>
      ) : (
        <div className="grid gap-8 xl:grid-cols-[380px_minmax(0,1fr)]">
          <section className="border-y border-black/10 py-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold">{text.quickTrain}</h2>
                <p className="mt-1 text-sm text-steel">{text.quickTrainDetail}</p>
              </div>
              <span className="text-xs font-semibold uppercase tracking-[0.16em] text-signal">{text.local}</span>
            </div>

            <details className="mt-6 border-y border-black/10 py-4">
              <summary className="cursor-pointer text-sm font-semibold text-ink">
                {locale === "tr" ? "Eğitim araçlarını aç" : "Open training tools"}
              </summary>

            <form onSubmit={startSmokeTraining} className="mt-6 space-y-4">
              <Field label={text.categorySeed}>
                <input
                  name="seed"
                  type="number"
                  min={0}
                  max={1000000}
                  defaultValue={42}
                  className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal"
                />
              </Field>
              <Field label={text.samplesPerCategory}>
                <input
                  name="samplesPerCategory"
                  type="number"
                  min={4}
                  max={64}
                  defaultValue={12}
                  className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal"
                />
              </Field>
              {categorySubmitState === "error" ? <p className="text-sm font-medium text-red-700">{text.categoryTrainFailed}</p> : null}
              <button
                className="h-11 w-full bg-ink text-sm font-semibold text-paper hover:bg-signal disabled:cursor-not-allowed disabled:bg-black/25"
                disabled={categorySubmitState === "submitting"}
              >
                {categorySubmitState === "submitting" ? text.train : text.startCategoryTrain}
              </button>
            </form>

            <form onSubmit={startCategoryFullTraining} className="mt-8 space-y-4 border-t border-black/10 pt-6">
              <div>
                <h3 className="text-sm font-semibold uppercase tracking-[0.16em] text-steel">{text.fullCategoryProfile}</h3>
                <p className="mt-2 text-sm leading-6 text-steel">{text.fullCategoryDetail}</p>
              </div>
              <Field label={text.categorySeed}>
                <input
                  name="seed"
                  type="number"
                  min={0}
                  max={1000000}
                  defaultValue={42}
                  className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal"
                />
              </Field>
              <Field label={text.samplesPerCategory}>
                <input
                  name="samplesPerCategory"
                  type="number"
                  min={65}
                  max={2048}
                  defaultValue={128}
                  className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal"
                />
              </Field>
              {categoryFullSubmitState === "error" ? <p className="text-sm font-medium text-red-700">{text.categoryTrainFailed}</p> : null}
              <button
                className="h-11 w-full border border-black/15 px-4 text-sm font-semibold text-ink hover:border-signal hover:text-signal disabled:cursor-not-allowed disabled:border-black/10 disabled:text-black/35"
                disabled={categoryFullSubmitState === "submitting"}
              >
                {categoryFullSubmitState === "submitting" ? text.train : text.startCategoryTrain}
              </button>
            </form>

            <form onSubmit={startCustomOcrSmokeTraining} className="mt-8 space-y-4 border-t border-black/10 pt-6">
              <div>
                <h3 className="text-sm font-semibold uppercase tracking-[0.16em] text-steel">{text.customOcr}</h3>
                <p className="mt-2 text-sm leading-6 text-steel">{text.customOcrDetail}</p>
              </div>
              <Field label={text.ocrSeed}>
                <input
                  name="seed"
                  type="number"
                  min={0}
                  max={1000000}
                  defaultValue={42}
                  className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal"
                />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={text.sampleCount}>
                  <input
                    name="samples"
                    type="number"
                    min={8}
                    max={64}
                    defaultValue={16}
                    className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal"
                  />
                </Field>
                <Field label={text.epochCount}>
                  <input
                    name="epochs"
                    type="number"
                    min={1}
                    max={3}
                    defaultValue={1}
                    className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal"
                  />
                </Field>
              </div>
              {customOcrSubmitState === "error" ? <p className="text-sm font-medium text-red-700">{text.customTrainFailed}</p> : null}
              <button
                className="h-11 w-full border border-black/15 px-4 text-sm font-semibold text-ink hover:border-signal hover:text-signal disabled:cursor-not-allowed disabled:border-black/10 disabled:text-black/35"
                disabled={customOcrSubmitState === "submitting"}
              >
                {customOcrSubmitState === "submitting" ? text.train : text.startCustomTrain}
              </button>
            </form>

            <form onSubmit={startCustomOcrFullTraining} className="mt-8 space-y-4 border-t border-black/10 pt-6">
              <div>
                <h3 className="text-sm font-semibold uppercase tracking-[0.16em] text-steel">{text.fullCustomProfile}</h3>
                <p className="mt-2 text-sm leading-6 text-steel">{text.fullCustomDetail}</p>
              </div>
              <Field label={text.ocrSeed}>
                <input
                  name="seed"
                  type="number"
                  min={0}
                  max={1000000}
                  defaultValue={42}
                  className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal"
                />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={text.sampleCount}>
                  <input
                    name="samples"
                    type="number"
                    min={65}
                    max={50000}
                    defaultValue={2048}
                    className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal"
                  />
                </Field>
                <Field label={text.epochCount}>
                  <input
                    name="epochs"
                    type="number"
                    min={2}
                    max={20}
                    defaultValue={8}
                    className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal"
                  />
                </Field>
              </div>
              {customOcrFullSubmitState === "error" ? (
                <p className="text-sm font-medium text-red-700">
                  {text.customFullTrainFailed}
                  {customOcrFullError ? ` ${customOcrFullError}` : ""}
                </p>
              ) : null}
              <button
                className="h-11 w-full border border-black/15 px-4 text-sm font-semibold text-ink hover:border-signal hover:text-signal disabled:cursor-not-allowed disabled:border-black/10 disabled:text-black/35"
                disabled={customOcrFullSubmitState === "submitting"}
              >
                {customOcrFullSubmitState === "submitting" ? text.train : text.startCustomTrain}
              </button>
            </form>

            </details>

            <div className="mt-8 border-t border-black/10 pt-6">
              <h3 className="text-sm font-semibold uppercase tracking-[0.16em] text-steel">{text.latestMetrics}</h3>
              {latestCategoryMetrics || latestCustomOcrMetrics ? (
                <div className="mt-4 grid gap-4">
                  {latestCategoryMetrics ? (
                    <>
                      <MetricBar label={locale === "tr" ? "Kategori doğruluğu" : "Category accuracy"} value={metricNumber(latestCategoryMetrics, "accuracy")} locale={locale} />
                      <MetricBar label={locale === "tr" ? "Kategori macro F1" : "Category macro F1"} value={metricNumber(latestCategoryMetrics, "macro_f1")} locale={locale} />
                    </>
                  ) : null}
                  {latestCustomOcrMetrics ? (
                    <>
                      <MetricValue label={locale === "tr" ? "Custom OCR CER hata" : "Custom OCR CER error"} value={customOcrMetricNumber(latestCustomOcrMetrics, ["averageCer", "cer", "finalCer", "bestValidationCer"])} locale={locale} percent />
                      <MetricValue label={locale === "tr" ? "Custom OCR WER hata" : "Custom OCR WER error"} value={customOcrMetricNumber(latestCustomOcrMetrics, ["averageWer", "wer", "finalWer"])} locale={locale} percent />
                      <MetricValue label={locale === "tr" ? "Türkçe karakter F1/doğruluk" : "Turkish character F1/accuracy"} value={customOcrMetricNumber(latestCustomOcrMetrics, ["turkishSpecialCharacterF1", "turkishSpecialCharacterAccuracy"])} locale={locale} percent />
                      <MetricValue label={locale === "tr" ? "Gerçek belge metin parçası yakalama" : "Real document snippet recall"} value={customOcrMetricNumber(latestCustomOcrMetrics, ["averageSnippetRecall", "snippetRecall"])} locale={locale} percent />
                    </>
                  ) : null}
                  <p className="text-sm leading-6 text-steel">
                    {customOcrMetricNote(latestCustomOcrMetrics, latestCategoryMetrics, locale)}
                  </p>
                </div>
              ) : (
                <p className="mt-4 text-sm leading-6 text-steel">{text.noMetrics}</p>
              )}
            </div>
          </section>

          <section className="min-w-0 space-y-8">
            <OcrBenchmarkDashboard
              models={state.overview.models}
              evaluationRuns={state.overview.evaluationRuns}
              benchmarkingId={benchmarkingId}
              benchmarkError={benchmarkError}
              locale={locale}
              onRunBenchmark={runOcrBenchmark}
            />
            <details className="border-y border-black/10 py-4">
              <summary className="cursor-pointer text-sm font-semibold text-ink">
                {locale === "tr" ? "Gelişmiş model kayıtlarını aç" : "Open advanced model records"}
              </summary>
              <div className="mt-6 space-y-8">
                <ModelComparison models={state.overview.models} evaluationRuns={state.overview.evaluationRuns} locale={locale} />
                <Registry
                  models={state.overview.models}
                  canPromote={canPromote}
                  promotingId={promotingId}
                  rollingBackId={rollingBackId}
                  onPromote={promote}
                  onRollback={rollback}
                  text={text}
                  locale={locale}
                />
                <Runs title={text.trainingRuns} runs={state.overview.trainingRuns} emptyText={text.noTrainingRuns} locale={locale} />
                <Runs title={text.evaluationRuns} runs={state.overview.evaluationRuns} emptyText={text.noEvaluationRuns} locale={locale} />
              </div>
            </details>
          </section>
        </div>
      )}
    </Shell>
  );
}

function OcrBenchmarkDashboard({
  models,
  evaluationRuns,
  benchmarkingId,
  benchmarkError,
  locale,
  onRunBenchmark
}: {
  models: ModelVersionSummary[];
  evaluationRuns: ModelEvaluationRunSummary[];
  benchmarkingId: string | null;
  benchmarkError: string | null;
  locale: "tr" | "en";
  onRunBenchmark: (modelId: string) => Promise<void>;
}) {
  const customModels = models.filter((model) => model.engine === "CUSTOM_CRNN");
  const rows = customModels.map((model) => {
    const latestBenchmark = evaluationRuns
      .filter((run) => run.modelVersionId === model.id && isOcrBenchmarkMetrics(run.metrics))
      .sort((left, right) => new Date(right.completedAt ?? right.createdAt).getTime() - new Date(left.completedAt ?? left.createdAt).getTime())[0];
    const metrics = latestBenchmark?.metrics ?? null;
      return {
      model,
      latestBenchmark,
      samples: benchmarkDatasetSamples(metrics),
      datasetMode: benchmarkDatasetMode(metrics),
      tesseract: benchmarkEngineMetrics(metrics, "TESSERACT"),
      custom: benchmarkEngineMetrics(metrics, "CUSTOM_CRNN")
    };
  });

  return (
    <section className="min-w-0 border-y border-black/10 py-6">
      <div className="flex flex-col gap-4 border-b border-black/10 pb-5 md:flex-row md:items-end md:justify-between">
        <div>
          <h2 className="text-xl font-semibold">{locale === "tr" ? "OCR karşılaştırma panosu" : "OCR benchmark dashboard"}</h2>
          <p className="mt-1 text-sm text-steel">
            {locale === "tr"
              ? "Custom OCR için gerçek belge karşılaştırması ve ayrı Tesseract referans durumu. CER/WER hata oranıdır."
              : "Real fixture benchmark status for Custom OCR and separate Tesseract baseline. CER/WER are error rates."}
          </p>
        </div>
        <span className="text-sm text-steel">
          {rows.length} {locale === "tr" ? "Custom OCR sürümü" : "Custom OCR versions"}
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="py-10 text-sm text-steel">
          {locale === "tr" ? "Karşılaştırmayı çalıştırmadan önce bir Custom OCR modeli eğitin." : "Train a Custom OCR model before running a benchmark."}
        </div>
      ) : (
        <div className="max-w-full overflow-x-auto">
          {benchmarkError ? <p className="mb-4 text-sm font-medium text-red-700">{benchmarkError}</p> : null}
          <table className="w-full min-w-[1240px] border-collapse text-left text-sm">
            <thead className="border-b border-black/10 text-xs uppercase tracking-[0.14em] text-steel">
              <tr>
                <th className="py-3 pr-4 font-semibold">{locale === "tr" ? "Model" : "Model"}</th>
                <th className="py-3 pr-4 font-semibold">{locale === "tr" ? "Veri kümesi" : "Dataset"}</th>
                <th className="py-3 pr-4 font-semibold">{locale === "tr" ? "Örnek sayısı" : "Sample count"}</th>
                <th className="py-3 pr-4 font-semibold">Tesseract</th>
                <th className="py-3 pr-4 font-semibold">{locale === "tr" ? "Kalite kapısı" : "Quality gate"}</th>
                <th className="py-3 pr-4 font-semibold">{locale === "tr" ? "Custom CER hata" : "Custom CER error"}</th>
                <th className="py-3 pr-4 font-semibold">{locale === "tr" ? "Custom WER hata" : "Custom WER error"}</th>
                <th className="py-3 pr-4 font-semibold">{locale === "tr" ? "Metin parçası yakalama" : "Snippet recall"}</th>
                <th className="py-3 pr-4 font-semibold">{locale === "tr" ? "Sözcük F1" : "Token F1"}</th>
                <th className="py-3 pr-4 font-semibold">{locale === "tr" ? "Uyarılar" : "Warnings"}</th>
                <th className="py-3 pr-4 font-semibold">{locale === "tr" ? "Alan F1/doğruluk" : "Field F1/accuracy"}</th>
                <th className="py-3 pr-4 font-semibold">{locale === "tr" ? "Hata" : "Error"}</th>
                <th className="py-3 pr-4 font-semibold">{locale === "tr" ? "Gecikme" : "Latency"}</th>
                <th className="py-3 font-semibold">{locale === "tr" ? "İşlem" : "Action"}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/10">
              {rows.map((row) => (
                <tr key={row.model.id} data-testid={`ocr-benchmark-row-${row.model.name}`}>
                  <td className="py-4 pr-4 align-top">
                    <div className="font-semibold">{row.model.name}</div>
                      <div className="mt-1 text-xs text-steel">
                        {row.latestBenchmark?.completedAt
                          ? new Date(row.latestBenchmark.completedAt).toLocaleString()
                          : locale === "tr"
                            ? "Henüz karşılaştırma yok"
                            : "No benchmark yet"}
                    </div>
                  </td>
                  <td className="py-4 pr-4 align-top font-mono text-sm text-steel">{row.datasetMode ?? (locale === "tr" ? "yok" : "n/a")}</td>
                  <td className="py-4 pr-4 align-top font-mono text-sm text-steel">{row.samples ?? (locale === "tr" ? "yok" : "n/a")}</td>
                  <td className="py-4 pr-4 align-top text-steel">{row.tesseract.status ?? (locale === "tr" ? "yok" : "n/a")}</td>
                  <td className="py-4 pr-4 align-top text-sm">
                    <span className={row.custom.qualityGateStatus === "passed" ? "font-semibold text-green-700" : row.custom.qualityGateStatus === "failed" ? "font-semibold text-red-700" : "text-steel"}>
                      {formatQualityGate(row.custom.qualityGateStatus, row.custom.qualityGateReasons, locale)}
                    </span>
                  </td>
                  <MetricCell value={row.custom.averageCer} percent locale={locale} />
                  <MetricCell value={row.custom.averageWer} percent locale={locale} />
                  <MetricCell value={row.custom.averageSnippetRecall} percent locale={locale} />
                  <MetricCell value={row.custom.tokenF1} percent locale={locale} />
                  <td className="py-4 pr-4 align-top text-xs text-steel">{formatWarningCounts(row.custom.warningCounts, locale)}</td>
                  <MetricCell value={row.custom.fieldF1} percent locale={locale} />
                  <MetricCell value={row.custom.failureRate} percent locale={locale} />
                  <td className="py-4 pr-4 align-top font-mono text-sm text-steel">
                    {row.custom.averageLatencyMs === null ? (locale === "tr" ? "yok" : "n/a") : `${Math.round(row.custom.averageLatencyMs)} ms`}
                  </td>
                  <td className="py-4 align-top">
                    <button
                      className="text-sm font-semibold text-ink hover:text-signal"
                      onClick={() => void onRunBenchmark(row.model.id)}
                      disabled={benchmarkingId === row.model.id}
                      aria-label={`${row.model.name} için karşılaştırmayı çalıştır`}
                    >
                      {benchmarkingId === row.model.id ? "Çalıştırılıyor..." : "Karşılaştırmayı çalıştır"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ModelComparison({ models, evaluationRuns, locale }: { models: ModelVersionSummary[]; evaluationRuns: ModelEvaluationRunSummary[]; locale: "tr" | "en" }) {
  const rows = models
    .map((model) => {
      const latestEvaluation = evaluationRuns
        .filter((run) => run.modelVersionId === model.id)
        .sort((left, right) => new Date(right.completedAt ?? right.createdAt).getTime() - new Date(left.completedAt ?? left.createdAt).getTime())[0];
      const metrics = latestEvaluation?.metrics ?? model.metrics ?? {};
      return {
        model,
        latestEvaluation,
        metrics,
        modelMetrics: model.metrics ?? {}
      };
    })
    .sort((left, right) => {
      const engineOrder = left.model.engine.localeCompare(right.model.engine);
      if (engineOrder !== 0) return engineOrder;
      return statusRank(left.model.status) - statusRank(right.model.status);
    });

  return (
    <section className="border-y border-black/10 py-6">
      <div className="flex flex-col gap-4 border-b border-black/10 pb-5 md:flex-row md:items-end md:justify-between">
        <div>
          <h2 className="text-xl font-semibold">{locale === "tr" ? "Sürüm karşılaştırması" : "Version comparison"}</h2>
          <p className="mt-1 text-sm text-steel">
            {locale === "tr" ? "Motor bazında en son kalıcı model ve değerlendirme metrikleri." : "Latest persistent model and evaluation metrics by engine."}
          </p>
        </div>
        <span className="text-sm text-steel">
          {rows.length} {locale === "tr" ? "sürüm" : "versions"}
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="py-10 text-sm text-steel">{locale === "tr" ? "Karşılaştırılacak model sürümü yok." : "No model versions available for comparison."}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-left text-sm">
            <thead className="border-b border-black/10 text-xs uppercase tracking-[0.14em] text-steel">
              <tr>
                <th className="py-3 pr-4 font-semibold">{locale === "tr" ? "Model" : "Model"}</th>
                <th className="py-3 pr-4 font-semibold">{locale === "tr" ? "Motor" : "Engine"}</th>
                <th className="py-3 pr-4 font-semibold">{locale === "tr" ? "Durum" : "Status"}</th>
                <th className="py-3 pr-4 font-semibold">{locale === "tr" ? "Doğruluk" : "Accuracy"}</th>
                <th className="py-3 pr-4 font-semibold">Macro F1</th>
                <th className="py-3 pr-4 font-semibold">{locale === "tr" ? "CER hata" : "CER error"}</th>
                <th className="py-3 pr-4 font-semibold">{locale === "tr" ? "WER hata" : "WER error"}</th>
                <th className="py-3 pr-4 font-semibold">{locale === "tr" ? "Kayıp" : "Loss"}</th>
                <th className="py-3 font-semibold">{locale === "tr" ? "Değerlendirme" : "Evaluation"}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/10">
              {rows.map((row) => (
                <tr key={row.model.id}>
                  <td className="py-4 pr-4 align-top">
                    <div className="font-semibold">{row.model.name}</div>
                    <div className="mt-1 font-mono text-xs text-steel">{row.model.id.slice(0, 8)}</div>
                  </td>
                  <td className="py-4 pr-4 align-top text-steel">{row.model.engine}</td>
                  <td className="py-4 pr-4 align-top">
                    <span className={modelStatusClass(row.model.status)}>{formatModelStatus(row.model.status, locale)}</span>
                  </td>
                  <MetricCell value={metricNumber(row.metrics, "accuracy")} percent locale={locale} />
                  <MetricCell value={metricNumber(row.metrics, "macro_f1")} percent locale={locale} />
                  <MetricCell value={modelComparisonMetric(row.metrics, row.modelMetrics, row.model.engine, "cer")} percent locale={locale} />
                  <MetricCell value={modelComparisonMetric(row.metrics, row.modelMetrics, row.model.engine, "wer")} percent locale={locale} />
                  <MetricCell value={metricNumber(row.metrics, "loss")} locale={locale} />
                    <td className="py-4 align-top text-xs text-steel">
                     {row.latestEvaluation?.completedAt ? new Date(row.latestEvaluation.completedAt).toLocaleString() : locale === "tr" ? "Model metrikleri" : "Model metrics"}
                    </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Registry({
  models,
  canPromote,
  promotingId,
  rollingBackId,
  onPromote,
  onRollback,
  text,
  locale
}: {
  models: ModelVersionSummary[];
  canPromote: boolean;
  promotingId: string | null;
  rollingBackId: string | null;
  onPromote: (modelId: string) => Promise<void>;
  onRollback: (modelId: string) => Promise<void>;
  text: (typeof copy)[keyof typeof copy];
  locale: "tr" | "en";
}) {
  return (
    <section className="border-y border-black/10 py-6">
      <div className="flex flex-col gap-4 border-b border-black/10 pb-5 md:flex-row md:items-end md:justify-between">
        <div>
          <h2 className="text-xl font-semibold">{text.modelRegistry}</h2>
          <p className="mt-1 text-sm text-steel">{locale === "tr" ? "Aday, aktif ve arşivlenmiş yerel artefaktlar kayıt defterinde tutulur." : "Candidate, active and archived local artifacts are kept in the ledger."}</p>
        </div>
        <span className="text-sm text-steel">{models.length} {locale === "tr" ? "sürüm" : "versions"}</span>
      </div>
      {models.length === 0 ? (
        <div className="py-10 text-sm text-steel">{text.noModelVersion}</div>
      ) : (
        <div className="divide-y divide-black/10">
          {models.map((model) => (
            <div key={model.id} className="grid gap-4 py-5 lg:grid-cols-[220px_1fr_130px]">
              <div>
                <div className="text-sm font-semibold">{model.name}</div>
                <div className="mt-1 text-xs text-steel">{new Date(model.createdAt).toLocaleString()}</div>
              </div>
              <div className="min-w-0">
                <div className="text-sm text-steel">{model.engine}</div>
                <div className="mt-2 break-all font-mono text-xs text-steel">{model.artifactKey ?? "Artefakt anahtarı yok"}</div>
                <ConfusionMatrix metrics={model.metrics} />
              </div>
              <div className="flex flex-col items-start gap-3">
                <span className={modelStatusClass(model.status)}>{formatModelStatus(model.status, locale)}</span>
                {canPromote && model.status === "CANDIDATE" ? (
                  <button
                    className="text-sm font-semibold text-ink hover:text-signal"
                    onClick={() => void onPromote(model.id)}
                    disabled={promotingId === model.id}
                    aria-label={`${model.name} sürümünü yükselt`}
                  >
                    {promotingId === model.id ? (locale === "tr" ? "Yükseltiliyor..." : "Promoting...") : (locale === "tr" ? "Yükselt" : "Promote")}
                  </button>
                ) : null}
                {canPromote && model.status === "ARCHIVED" ? (
                  <button
                    className="text-sm font-semibold text-ink hover:text-signal"
                    onClick={() => void onRollback(model.id)}
                    disabled={rollingBackId === model.id}
                    aria-label={`${model.name} sürümünü geri al`}
                  >
                    {rollingBackId === model.id ? (locale === "tr" ? "Geri alınıyor..." : "Rolling back...") : (locale === "tr" ? "Geri al" : "Rollback")}
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Runs({
  title,
  runs,
  emptyText,
  locale
}: {
  title: string;
  runs: Array<ModelTrainingRunSummary | ModelEvaluationRunSummary>;
  emptyText: string;
  locale: "tr" | "en";
}) {
  return (
    <section className="border-y border-black/10 py-6">
      <div className="flex items-end justify-between border-b border-black/10 pb-5">
        <div>
          <h2 className="text-xl font-semibold">{title}</h2>
          <p className="mt-1 text-sm text-steel">{locale === "tr" ? "Kalıcı durum, metrik artefaktı ve tamamlanma geçmişi." : "Persistent status, metric artifacts and completion history."}</p>
        </div>
        <span className="text-sm text-steel">{runs.length} {locale === "tr" ? "çalışma" : "runs"}</span>
      </div>
      {runs.length === 0 ? (
        <div className="py-10 text-sm text-steel">{emptyText}</div>
      ) : (
        <div className="divide-y divide-black/10">
          {runs.map((run) => (
            <div key={run.id} className="grid gap-4 py-5 lg:grid-cols-[180px_1fr_120px]">
              <div>
                <div className="font-mono text-sm font-semibold">{"profile" in run ? formatRunProfile(run.profile, locale) : locale === "tr" ? "Değerlendirme" : "Evaluation"}</div>
                <div className="mt-1 text-xs text-steel">
                  {"seed" in run ? `${locale === "tr" ? "Başlangıç tohumu" : "Seed"} ${run.seed}` : run.modelVersionId ?? (locale === "tr" ? "Model sürümü yok" : "No model version")}
                </div>
              </div>
              <div className="min-w-0">
                <div className="break-all font-mono text-xs text-steel">
                  {"logsKey" in run
                    ? run.logsKey ?? (locale === "tr" ? "Rapor anahtarı yok" : "No report key")
                    : run.reportKey ?? (locale === "tr" ? "Rapor anahtarı yok" : "No report key")}
                </div>
                <div className="mt-2 text-xs text-steel">
                  {run.completedAt ? `${locale === "tr" ? "Tamamlandı" : "Completed"} ${new Date(run.completedAt).toLocaleString()}` : locale === "tr" ? "Tamamlanmadı" : "Not completed"}
                  {run.failureReason ? ` - ${run.failureReason}` : ""}
                </div>
              </div>
              <span className={jobStatusClass(run.status)}>{formatRunStatus(run.status, locale)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function formatRunProfile(profile: string, locale: "tr" | "en") {
  if (profile === "evaluation") return locale === "tr" ? "Değerlendirme" : "Evaluation";
  if (profile === "training") return locale === "tr" ? "Eğitim" : "Training";
  return profile;
}

function MetricCell({ value, percent = false, locale }: { value: number | null; percent?: boolean; locale: "tr" | "en" }) {
  return (
    <td className="py-4 pr-4 align-top font-mono text-sm text-steel">
      {value === null ? (locale === "tr" ? "yok" : "n/a") : percent ? `${Math.round(value * 1000) / 10}%` : value.toFixed(4)}
    </td>
  );
}

function ConfusionMatrix({ metrics }: { metrics: Record<string, unknown> | null }) {
  const matrix = Array.isArray(metrics?.confusion_matrix) ? metrics.confusion_matrix : null;
  if (!matrix) return null;
  return (
    <div className="mt-4 inline-grid gap-1">
      {matrix.map((row, rowIndex) => (
        <div key={rowIndex} className="flex gap-1">
          {Array.isArray(row)
            ? row.map((cell, cellIndex) => (
                <span key={`${rowIndex}-${cellIndex}`} className="flex h-8 w-8 items-center justify-center bg-black/5 font-mono text-xs text-ink">
                  {String(cell)}
                </span>
              ))
            : null}
        </div>
      ))}
    </div>
  );
}

function MetricBar({ label, value, locale }: { label: string; value: number | null; locale: "tr" | "en" }) {
  const normalized = value === null ? 0 : Math.max(0, Math.min(1, value));
  return (
    <div>
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className="font-mono text-steel">{value === null ? (locale === "tr" ? "yok" : "n/a") : `${Math.round(normalized * 1000) / 10}%`}</span>
      </div>
      <div className="mt-2 h-2 bg-black/10">
        <div className="h-2 bg-signal" style={{ width: `${normalized * 100}%` }} />
      </div>
    </div>
  );
}

function MetricValue({ label, value, locale, percent = false }: { label: string; value: unknown; locale: "tr" | "en"; percent?: boolean }) {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : null;
  return (
    <div className="flex items-center justify-between border-t border-black/10 pt-3 text-sm">
      <span className="font-medium">{label}</span>
      <span className="font-mono text-steel">{numeric === null ? (locale === "tr" ? "yok" : "n/a") : percent ? `${Math.round(numeric * 1000) / 10}%` : numeric.toFixed(4)}</span>
    </div>
  );
}

function formatModelStatus(status: ModelVersionSummary["status"], locale: "tr" | "en"): string {
  const labels: Record<ModelVersionSummary["status"], string> =
    locale === "tr"
      ? { CANDIDATE: "Aday", ACTIVE: "Aktif", ARCHIVED: "Arşivlenmiş", FAILED: "Başarısız" }
      : { CANDIDATE: "Candidate", ACTIVE: "Active", ARCHIVED: "Archived", FAILED: "Failed" };
  return labels[status] ?? status;
}

function formatRunStatus(status: ModelTrainingRunSummary["status"] | ModelEvaluationRunSummary["status"], locale: "tr" | "en"): string {
  const labels: Record<string, string> =
    locale === "tr"
      ? { QUEUED: "Kuyrukta", RUNNING: "Çalışıyor", SUCCEEDED: "Tamamlandı", FAILED: "Başarısız", CANCELED: "İptal edildi" }
      : { QUEUED: "Queued", RUNNING: "Running", SUCCEEDED: "Succeeded", FAILED: "Failed", CANCELED: "Canceled" };
  return labels[status] ?? status;
}

function isOcrBenchmarkMetrics(metrics: Record<string, unknown> | null): boolean {
  return Boolean(metrics && typeof metrics.engines === "object" && metrics.engines !== null);
}

function benchmarkDatasetSamples(metrics: Record<string, unknown> | null): number | null {
  const dataset = metrics?.dataset;
  if (!dataset || typeof dataset !== "object") return null;
  const samples = (dataset as Record<string, unknown>).samples;
  return typeof samples === "number" && Number.isFinite(samples) ? samples : null;
}

function benchmarkDatasetMode(metrics: Record<string, unknown> | null): string | null {
  const dataset = metrics?.dataset;
  if (!dataset || typeof dataset !== "object") return null;
  const record = dataset as Record<string, unknown>;
  return typeof record.mode === "string" ? record.mode : typeof record.dataDir === "string" ? record.dataDir : null;
}

function benchmarkEngineMetrics(metrics: Record<string, unknown> | null, engine: "TESSERACT" | "CUSTOM_CRNN") {
  const empty = {
    status: null as string | null,
    averageCer: null as number | null,
    averageWer: null as number | null,
    averageSnippetRecall: null as number | null,
    tokenF1: null as number | null,
    fieldF1: null as number | null,
    failureRate: null as number | null,
    averageLatencyMs: null as number | null,
    qualityGateStatus: null as string | null,
    qualityGateReasons: [] as string[],
    warningCounts: null as Record<string, number> | null
  };
  const engines = metrics?.engines;
  if (!engines || typeof engines !== "object") return empty;
  const engineMetrics = (engines as Record<string, unknown>)[engine];
  if (!engineMetrics || typeof engineMetrics !== "object") return empty;
  const record = engineMetrics as Record<string, unknown>;
  return {
    status: typeof record.status === "string" ? record.status : null,
    averageCer: finiteMetric(record.averageCer),
    averageWer: finiteMetric(record.averageWer),
    averageSnippetRecall: finiteMetric(record.averageSnippetRecall),
    tokenF1: finiteMetric(record.tokenF1),
    fieldF1: finiteMetric(record.fieldF1) ?? fieldAccuracyAverage(record.fieldAccuracy),
    failureRate: finiteMetric(record.failureRate),
    averageLatencyMs: finiteMetric(record.averageLatencyMs),
    qualityGateStatus: typeof record.qualityGateStatus === "string" ? record.qualityGateStatus : null,
    qualityGateReasons: Array.isArray(record.qualityGateReasons) ? record.qualityGateReasons.map(String) : [],
    warningCounts: warningCounts(record.warningCounts)
  };
}

function warningCounts(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([key, count]) => [key, finiteMetric(count)] as const)
    .filter((entry): entry is readonly [string, number] => entry[1] !== null && entry[1] > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function formatWarningCounts(value: Record<string, number> | null, locale: "tr" | "en"): string {
  if (!value) return locale === "tr" ? "yok" : "none";
  return Object.entries(value)
    .map(([code, count]) => `${code}: ${count}`)
    .join(", ");
}

function formatQualityGate(status: string | null, reasons: string[], locale: "tr" | "en"): string {
  if (!status) return locale === "tr" ? "yok" : "n/a";
  const label = status === "passed" ? (locale === "tr" ? "Geçti" : "Passed") : status === "failed" ? (locale === "tr" ? "Kaldı" : "Failed") : status;
  return reasons.length ? `${label}: ${reasons.join(", ")}` : label;
}

function fieldAccuracyAverage(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const accuracies = Object.values(value as Record<string, unknown>)
    .map((entry) => (entry && typeof entry === "object" ? finiteMetric((entry as Record<string, unknown>).accuracy) : null))
    .filter((entry): entry is number => entry !== null);
  if (accuracies.length === 0) return null;
  return accuracies.reduce((sum, entry) => sum + entry, 0) / accuracies.length;
}

function finiteMetric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm font-medium">
      <span className="mb-2 block">{label}</span>
      {children}
    </label>
  );
}

function Shell({
  title,
  detail,
  children,
  text,
  locale
}: {
  title: string;
  detail: string;
  children?: React.ReactNode;
  text: (typeof copy)[keyof typeof copy];
  locale: "tr" | "en";
}) {
  void text;
  void locale;
  return <AppShell title={title} detail={detail}>{children}</AppShell>;
}

function metricNumber(metrics: Record<string, unknown>, key: string): number | null {
  const value = metrics[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function metricNumberAny(metrics: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = metricNumber(metrics, key);
    if (value !== null) return value;
  }
  return null;
}

function customOcrMetricNumber(metrics: Record<string, unknown>, keys: string[]): number | null {
  const engines = metrics.engines;
  if (engines && typeof engines === "object" && !Array.isArray(engines)) {
    const custom = (engines as Record<string, unknown>).CUSTOM_CRNN;
    if (custom && typeof custom === "object" && !Array.isArray(custom)) {
      const benchmarkValue = metricNumberAny(custom as Record<string, unknown>, keys);
      if (benchmarkValue !== null) return benchmarkValue;
    }
  }
  return metricNumberAny(metrics, keys);
}

function customOcrMetricNote(customMetrics: Record<string, unknown> | null, categoryMetrics: Record<string, unknown> | null, locale: "tr" | "en"): string {
  if (customMetrics) {
    const dataset = String(customMetrics.datasetMode ?? customMetrics.dataset_mode ?? customMetrics.profile ?? "unknown");
    const realStatus = String(customMetrics.realFixtureBenchmarkStatus ?? customMetrics.real_fixture_benchmark_status ?? "not_run");
    const blockedReason = customMetrics.promotionBlockedReason;
    const base =
      locale === "tr"
        ? `Veri kümesi: ${dataset}. Gerçek belge doğrulaması: ${formatQualityGate(realStatus, [], locale)}. CER/WER hata oranıdır; sentetik metrikler üretime hazır anlamına gelmez.`
        : `Dataset: ${dataset}. Real fixture validation: ${realStatus}. CER/WER are error rates; synthetic metrics do not mean production-ready.`;
    return typeof blockedReason === "string" && blockedReason
      ? `${base} ${locale === "tr" ? "Promosyon blokajı" : "Promotion blocked"}: ${blockedReason}`
      : base;
  }
  if (categoryMetrics?.accuracy_note) return String(categoryMetrics.accuracy_note);
  return locale === "tr" ? "Son kaydedilen çalışmadan gelen metrikler; veri türünü model satırından kontrol edin." : "Metrics from the most recently saved run; check the model row for dataset type.";
}

function metricNumberPath(metrics: Record<string, unknown>, path: string[]): number | null {
  let value: unknown = metrics;
  for (const part of path) {
    if (!value || typeof value !== "object") return null;
    value = (value as Record<string, unknown>)[part];
  }
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function benchmarkMetric(metrics: Record<string, unknown>, engine: string, key: "cer" | "wer"): number | null {
  const engines = metrics.engines;
  if (!engines || typeof engines !== "object") return null;
  const engineMetrics = (engines as Record<string, unknown>)[engine];
  if (!engineMetrics || typeof engineMetrics !== "object") return null;
  return metricNumberAny(engineMetrics as Record<string, unknown>, key === "cer" ? ["averageCer", "cer"] : ["averageWer", "wer"]);
}

function modelComparisonMetric(
  evaluationMetrics: Record<string, unknown>,
  modelMetrics: Record<string, unknown>,
  engine: string,
  key: "cer" | "wer"
): number | null {
  const directKeys = key === "cer" ? ["cer", "finalCer", "bestValidationCer"] : ["wer", "finalWer"];
  return (
    benchmarkMetric(evaluationMetrics, engine, key) ??
    metricNumberAny(evaluationMetrics, directKeys) ??
    metricNumberPath(evaluationMetrics, key === "cer" ? ["finalValidation", "averageCer"] : ["finalValidation", "averageWer"]) ??
    benchmarkMetric(modelMetrics, engine, key) ??
    metricNumberAny(modelMetrics, directKeys) ??
    metricNumberPath(modelMetrics, key === "cer" ? ["finalValidation", "averageCer"] : ["finalValidation", "averageWer"])
  );
}

function statusRank(status: ModelStatus): number {
  if (status === "ACTIVE") return 0;
  if (status === "CANDIDATE") return 1;
  if (status === "ARCHIVED") return 2;
  return 3;
}

function modelStatusClass(status: ModelStatus): string {
  if (status === "ACTIVE") return "text-sm font-semibold uppercase tracking-[0.16em] text-signal";
  if (status === "FAILED") return "text-sm font-semibold uppercase tracking-[0.16em] text-red-700";
  if (status === "CANDIDATE") return "text-sm font-semibold uppercase tracking-[0.16em] text-blue-700";
  return "text-sm font-semibold uppercase tracking-[0.16em] text-black/55";
}

function jobStatusClass(status: ModelTrainingRunSummary["status"]): string {
  if (status === "SUCCEEDED") return "text-sm font-semibold uppercase tracking-[0.16em] text-signal";
  if (status === "FAILED") return "text-sm font-semibold uppercase tracking-[0.16em] text-red-700";
  if (status === "RUNNING") return "text-sm font-semibold uppercase tracking-[0.16em] text-blue-700";
  return "text-sm font-semibold uppercase tracking-[0.16em] text-black/55";
}
