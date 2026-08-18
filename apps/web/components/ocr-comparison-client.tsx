"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  apiRequest,
  authHeaders,
  formatUserFacingError,
  type AdminDocumentReprocessResponse,
  type AdminJobsResponse,
  type AdminHealthResponse,
  type DocumentDownloadUrlResponse,
  type DocumentPageSummary,
  type AuthResponse,
  type DocumentSummary,
  type ExpenseSummary,
  type ModelVersionSummary,
  type OcrCapabilitiesResponse,
  type OcrEngineRunSummary,
  type OcrJobsResponse,
  type PersistedExtractionSummary,
  type PersistedOcrComparisonSummary,
  type PrincipalResponse,
  type DocumentOcrPipelineRunResponse,
  type WorkerJobSummary,
  type WorkspaceSummary
} from "../lib/api";
import { readSession } from "../lib/session";
import { useLocale } from "../lib/locale";
import { AppShell } from "./app-shell";
import { SessionRecoveryActions } from "./session-recovery-actions";

const copy = {
  tr: {
    loading: "OCR çalışma alanı",
    loadingDetail: "Belge ve OCR sonuçları yükleniyor.",
    anonymousDetail: "OCR sonuçlarını görmek için önce giriş yapın.",
    signIn: "Giriş yap",
    title: "OCR çalışma alanı",
    detail: "yüklü belgelerde OCR, çıkarım ve gider akışı",
    uploadHint: "Önce yüklediğiniz fiş veya faturayı seçin; gerçek OCR geçmişi ve sonuçları sağ tarafta görünür.",
    authorized: "Yetkili",
    unauthorized: "Yetkisiz",
    startOcrHint: "OCR başlatmak için önce bir fiş veya fatura yükleyin.",
    advancedCompare: "Gelişmiş / hata ayıklama elle OCR karşılaştırması",
    advancedDetail: "Bu bölüm demo ve test amaçlıdır. Ana kullanıcı akışı yüklenen belgeden gelen gerçek kalıcı OCR sonuçlarını kullanır.",
    compareError: "OCR karşılaştırması kaydedilemedi.",
    compare: "Elle karşılaştırmayı kaydet",
    comparing: "Karşılaştırılıyor...",
    originalFile: "Orijinal dosya",
    processedPage: "İşlenmiş sayfa",
    noOriginal: "Orijinal imzalı URL kullanılamıyor.",
    noPage: "Henüz işlenmiş sayfa çıktısı kaydedilmedi.",
    previewNote: "Önizleme imzalı çıktı URL'si üzerinden açılır.",
    selectedDocument: "Yüklenen belgeyi seçin, OCR işini başlatın, Worker sonucuyla oluşan ham metni kontrol edin, çıkarım çalıştırın ve gider kaydını oluşturun.",
    startOcr: "OCR başlat",
    noOcr: "Bu belge için henüz kaydedilmiş OCR sonucu yok. OCR başlatın veya Worker çalıştırın; servis yoksa durum açıkça hata olarak görünür.",
    fieldDecisions: "OCR alan kararları",
    rawOcrText: "Ham OCR metni",
    noSelectedText: "Seçili OCR metni yok.",
    noExtraction: "Henüz çıkarım sonucu yok. Ham OCR metni oluştuktan sonra \"Çıkarım oluştur\" adımı belge alanlarını kalıcı olarak kaydeder.",
    extractedFields: "Çıkarılan alanlar",
    extractedDetail: "OCR metninden çıkarılan alanlar gider oluşturma adımında kullanılır.",
    ocrHistory: "OCR geçmişi",
    ocrHistoryDetail: "Seçilen belge için kalıcı OCR işleri ve motor çalıştırmaları.",
    noJobs: "Bu belge için OCR işi yok.",
    dashboard: "Pano",
    expenses: "Giderler",
    compareSubtitle: "Karşılaştır",
    extraction: "Çıkarım",
    worker: "Worker",
    noDocument: "Yüklenmiş belge yok."
  },
  en: {
    loading: "OCR workspace",
    loadingDetail: "Loading documents and OCR results.",
    anonymousDetail: "Sign in first to see OCR results.",
    signIn: "Sign in",
    title: "OCR workspace",
    detail: "OCR, extraction and expense flow on uploaded documents",
    uploadHint: "Select the receipt or invoice you uploaded first; real OCR history and results appear on the right.",
    authorized: "Authorized",
    unauthorized: "Unauthorized",
    startOcrHint: "Upload a receipt or invoice before starting OCR.",
    advancedCompare: "Advanced manual OCR comparison",
    advancedDetail: "This section is for demo and test purposes. The main user flow uses real persisted OCR results from the uploaded document.",
    compareError: "OCR comparison could not be saved.",
    compare: "Save manual comparison",
    comparing: "Comparing...",
    originalFile: "Original file",
    processedPage: "Processed page",
    noOriginal: "Original signed URL unavailable.",
    noPage: "No processed page output has been saved yet.",
    previewNote: "Preview opens through the signed output URL.",
    selectedDocument: "Select the uploaded document, start OCR, inspect the raw text created by the Worker result, run extraction and create the expense record.",
    startOcr: "Start OCR",
    noOcr: "There is no saved OCR result for this document yet. Start OCR or run the Worker; if the service is unavailable the state is shown as an explicit error.",
    fieldDecisions: "OCR field decisions",
    rawOcrText: "Raw OCR text",
    noSelectedText: "No OCR text selected.",
    noExtraction: "No extraction result yet. After the raw OCR text is created, the \"Create extraction\" step persists the document fields.",
    extractedFields: "Extracted fields",
    extractedDetail: "Fields extracted from OCR text are used in the expense creation step.",
    ocrHistory: "OCR history",
    ocrHistoryDetail: "Persisted OCR jobs and engine runs for the selected document.",
    noJobs: "No OCR jobs for this document.",
    dashboard: "Dashboard",
    expenses: "Expenses",
    compareSubtitle: "Compare",
    extraction: "Extraction",
    worker: "Worker",
    noDocument: "No uploaded document."
  }
} as const;

type OcrState =
  | { kind: "loading" }
  | { kind: "anonymous" }
  | {
      kind: "ready";
      session: AuthResponse;
      principal: PrincipalResponse["principal"];
      workspaces: WorkspaceSummary[];
      selectedWorkspaceId: string;
      documents: DocumentSummary[];
      selectedDocumentId: string;
      documentPreview: DocumentPreviewState;
      jobs: OcrJobsResponse["jobs"];
      workerJobs: WorkerJobSummary[];
      latestExtraction: PersistedExtractionSummary | null;
      latestExpense: ExpenseSummary | null;
      latest: PersistedOcrComparisonSummary | null;
      ocrService: AdminHealthResponse["checks"][string] | null;
      activeCustomOcrModel: OcrCapabilitiesResponse["customOcr"]["activeModel"];
    }
  | { kind: "error"; message: string };

type SubmitState = "idle" | "submitting" | "error";
type FlowActionState =
  | { kind: "idle" }
  | { kind: "submitting"; target: "ocr" | "extraction" | "expense" | "worker" }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };
type OcrRunPayload = { engine: "TESSERACT" | "CUSTOM_CRNN"; text: string; confidence: number; latencyMs?: number };
type UserOcrEngine = "TESSERACT" | "CUSTOM_CRNN" | "ENSEMBLE";
type DocumentPreviewState = {
  originalUrl: string | null;
  pages: DocumentPageSummary[];
};

export function OcrComparisonClient() {
  const { locale } = useLocale();
  const text = copy[locale];
  const localized = (path: string) => `${path}?lang=${encodeURIComponent(locale)}`;
  const [state, setState] = useState<OcrState>({ kind: "loading" });
  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const [flowAction, setFlowAction] = useState<FlowActionState>({ kind: "idle" });
  const [selectedOcrEngine, setSelectedOcrEngine] = useState<UserOcrEngine>("TESSERACT");

  async function load(preferredWorkspaceId?: string, preferredDocumentId?: string, latest?: PersistedOcrComparisonSummary | null) {
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
      const selectedWorkspaceId = preferredWorkspaceId && workspaces.some((workspace) => workspace.id === preferredWorkspaceId) ? preferredWorkspaceId : workspaces[0]?.id ?? "";
      let documents = selectedWorkspaceId
        ? (
            await apiRequest<{ documents: DocumentSummary[] }>(`/documents?workspaceId=${encodeURIComponent(selectedWorkspaceId)}&limit=50`, {
              headers: authHeaders(session.tokens.accessToken)
            })
          ).documents
        : [];
      if (preferredDocumentId && !documents.some((document) => document.id === preferredDocumentId)) {
        const preferred = await apiRequest<{ document: DocumentSummary }>(
          `/documents/${encodeURIComponent(preferredDocumentId)}`,
          { headers: authHeaders(session.tokens.accessToken) }
        ).catch(() => null);
        if (preferred?.document.workspaceId === selectedWorkspaceId) documents = [preferred.document, ...documents];
      }
      const selectedDocumentId = preferredDocumentId && documents.some((document) => document.id === preferredDocumentId) ? preferredDocumentId : documents[0]?.id ?? "";
      const canRead = principal.principal.permissions.includes("documents.read");
      const documentPreview =
        selectedDocumentId && canRead
          ? await loadDocumentPreview(session.tokens.accessToken, selectedDocumentId)
          : { originalUrl: null, pages: [] };
      const jobs =
        selectedDocumentId && canRead
          ? (
              await apiRequest<OcrJobsResponse>(`/documents/${selectedDocumentId}/ocr-runs`, {
                headers: authHeaders(session.tokens.accessToken)
              })
            ).jobs
          : [];
      const workerJobs =
        selectedDocumentId && principal.principal.permissions.includes("admin.jobs.read")
          ? (
              await apiRequest<AdminJobsResponse>("/admin/jobs?limit=200", {
                headers: authHeaders(session.tokens.accessToken)
              }).catch(() => ({ jobs: [] }))
            ).jobs.filter((job) => isDocumentWorkerJob(job, selectedDocumentId))
          : [];
      const latestExtraction =
        selectedDocumentId && canRead
          ? await apiRequest<PersistedExtractionSummary>(`/documents/${selectedDocumentId}/extraction`, {
              headers: authHeaders(session.tokens.accessToken)
            }).catch(() => null)
          : null;
      const previousExpense = state.kind === "ready" && state.selectedDocumentId === selectedDocumentId ? state.latestExpense : null;
      const latestExpense =
        selectedDocumentId && selectedWorkspaceId && principal.principal.permissions.includes("expenses.read")
          ? await apiRequest<{ expenses: ExpenseSummary[] }>(`/expenses?workspaceId=${encodeURIComponent(selectedWorkspaceId)}&limit=100`, {
              headers: authHeaders(session.tokens.accessToken)
            })
              .then((response) => response.expenses.filter((expense) => expense.documentId === selectedDocumentId && expense.status !== "ARCHIVED").sort(compareExpenseRecency)[0] ?? previousExpense)
              .catch(() => previousExpense)
          : previousExpense;
      const ocrService =
        principal.principal.permissions.includes("admin.health.read")
          ? await apiRequest<AdminHealthResponse>("/admin/health", {
              headers: authHeaders(session.tokens.accessToken)
            })
              .then((health) => health.checks.ocrService ?? null)
              .catch(() => null)
          : null;
      const activeCustomOcrModel =
        principal.principal.permissions.includes("ocr.run")
          ? await apiRequest<OcrCapabilitiesResponse>("/models/ocr-capabilities", {
              headers: authHeaders(session.tokens.accessToken)
            })
              .then((capabilities) => capabilities.customOcr.activeModel)
              .catch(() => null)
          : null;
      setState({
        kind: "ready",
        session,
        principal: principal.principal,
        workspaces,
        selectedWorkspaceId,
        documents,
        selectedDocumentId,
        documentPreview,
        jobs,
        workerJobs,
        latestExtraction,
        latestExpense,
        latest: latest ?? null,
        ocrService,
        activeCustomOcrModel
      });
    } catch (caught) {
      setState({ kind: "error", message: caught instanceof Error ? caught.message : "OCR_COMPARISON_LOAD_FAILED" });
    }
  }

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    const initialWorkspaceId = searchParams.get("workspaceId") ?? undefined;
    const initialDocumentId = searchParams.get("documentId") ?? searchParams.get("documentFileId") ?? undefined;
    void load(initialWorkspaceId, initialDocumentId);
  }, []);

  const selectedDocument = useMemo(() => {
    if (state.kind !== "ready") return null;
    return state.documents.find((document) => document.id === state.selectedDocumentId) ?? null;
  }, [state]);

  async function submitComparison(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.kind !== "ready" || !state.selectedDocumentId) return;
    const form = new FormData(event.currentTarget);
    const tesseractText = String(form.get("tesseractText") ?? "").trim();
    const customText = String(form.get("customText") ?? "").trim();
    const runs: OcrRunPayload[] = [];
    const tesseractLatencyMs = toOptionalInteger(form.get("tesseractLatencyMs"));
    const customLatencyMs = toOptionalInteger(form.get("customLatencyMs"));
    if (tesseractText) {
      runs.push({
        engine: "TESSERACT",
        text: tesseractText,
        confidence: clamp(Number(form.get("tesseractConfidence") ?? 0.8)),
        ...(tesseractLatencyMs !== undefined ? { latencyMs: tesseractLatencyMs } : {})
      });
    }
    if (customText) {
      runs.push({
        engine: "CUSTOM_CRNN",
        text: customText,
        confidence: clamp(Number(form.get("customConfidence") ?? 0.6)),
        ...(customLatencyMs !== undefined ? { latencyMs: customLatencyMs } : {})
      });
    }
    if (runs.length === 0) {
      setSubmitState("error");
      return;
    }
    setSubmitState("submitting");
    try {
      const groundTruthText = String(form.get("groundTruthText") ?? "").trim();
      const result = await apiRequest<PersistedOcrComparisonSummary>(`/documents/${state.selectedDocumentId}/ocr-runs/compare`, {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken),
        body: JSON.stringify({
          runs: runs.map((run) => ({
            engine: run.engine,
            text: run.text,
            confidence: run.confidence,
            ...(run.latencyMs !== undefined ? { latencyMs: run.latencyMs } : {})
          })),
          ...(groundTruthText ? { groundTruthText } : {})
        })
      });
      setSubmitState("idle");
      await load(state.selectedWorkspaceId, state.selectedDocumentId, result);
    } catch {
      setSubmitState("error");
    }
  }

  async function enqueueSelectedOcr() {
    if (state.kind !== "ready" || !state.selectedDocumentId) return;
    const latest = state.latest ?? latestFromJobs(state.jobs, selectedOcrEngine);
    const hasSelectedOcrText = latestMatchesEngine(latest, selectedOcrEngine) && Boolean(latest?.comparison.selectedText.trim());
    const hasSelectedExtraction = Boolean(
      state.latestExtraction && hasSelectedOcrText && extractionMatchesEngine(state.latestExtraction, selectedOcrEngine)
    );
    if (state.latestExpense && hasSelectedExtraction) {
      setFlowAction({
        kind: "success",
        message:
          locale === "tr"
            ? "Bu belge için OCR, çıkarım ve gider oluşturma tamamlandı. Ek OCR işi gerekmiyor."
            : "OCR, extraction and expense creation are complete for this document. No additional OCR job is needed."
      });
      return;
    }
    if (state.latestExtraction && hasSelectedExtraction) {
      setFlowAction({
        kind: "success",
        message:
          locale === "tr"
            ? "OCR ve çıkarım sonucu hazır. Gider oluştur adımıyla devam edin."
            : "OCR and extraction are ready. Continue with Create expense."
      });
      return;
    }
    if (hasSelectedOcrText) {
      setFlowAction({
        kind: "success",
        message:
          locale === "tr"
            ? `${formatEngineLabel(selectedOcrEngine, locale)} sonucu hazır. Çıkarım oluştur adımıyla devam edin.`
            : "Raw OCR text is ready. Continue with Create extraction."
      });
      return;
    }
    if (isOcrServiceUnavailable(state.ocrService)) {
      setFlowAction({ kind: "error", message: formatOcrServiceUnavailable(state.ocrService, locale) });
      return;
    }
    setFlowAction({ kind: "submitting", target: "ocr" });
    try {
      const stages =
        selectedOcrEngine === "TESSERACT"
          ? ["preprocess", "tesseract"]
          : selectedOcrEngine === "CUSTOM_CRNN"
            ? ["preprocess", "custom_crnn"]
            : ["preprocess", "tesseract", "custom_crnn"];
      const result = await apiRequest<AdminDocumentReprocessResponse>(`/admin/operations/documents/${state.selectedDocumentId}/reprocess`, {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken),
        body: JSON.stringify({
          stages,
          preprocessingProfile: selectedOcrEngine === "TESSERACT" ? "TESSERACT_OPTIMIZED" : "CUSTOM_MODEL_OPTIMIZED",
          language: "tur+eng"
        })
      });
      const retried = result.reprocess.enqueued.filter((item) => item.retried).length;
      const newlyQueued = result.reprocess.enqueued.filter((item) => !item.deduped && !item.retried).length;
      const alreadyExisting = result.reprocess.enqueued.length - newlyQueued - retried;
      setFlowAction({
        kind: "success",
        message:
          locale === "tr"
            ? `${newlyQueued} yeni OCR işi kuyruğa alındı${retried > 0 ? `; ${retried} başarısız iş yeniden kuyruğa alındı` : ""}${alreadyExisting > 0 ? `; ${alreadyExisting} iş zaten mevcuttu` : ""}. Seçili motor: ${formatEngineLabel(selectedOcrEngine, locale)}. Worker çalıştırıldığında ham OCR metni oluşacak.`
            : `${newlyQueued} new OCR job(s) queued${retried > 0 ? `; ${retried} failed job(s) requeued` : ""}${alreadyExisting > 0 ? `; ${alreadyExisting} already existed` : ""}. Selected engine: ${formatEngineLabel(selectedOcrEngine, locale)}. Running the Worker will create raw OCR text.`
      });
      await load(state.selectedWorkspaceId, state.selectedDocumentId);
    } catch (caught) {
      setFlowAction({ kind: "error", message: formatFlowError(caught, "OCR_JOB_ENQUEUE_FAILED", locale) });
    }
  }

  async function runNextWorker() {
    if (state.kind !== "ready" || !state.selectedDocumentId) return;
    try {
      const nextQueue = selectWorkerQueue(state, selectedOcrEngine);
      if ((nextQueue === "preprocessing" || nextQueue === "ocr") && isOcrServiceUnavailable(state.ocrService)) {
        setFlowAction({ kind: "error", message: formatOcrServiceUnavailable(state.ocrService, locale) });
        return;
      }
      setFlowAction({ kind: "submitting", target: "worker" });
      const response = await apiRequest<DocumentOcrPipelineRunResponse>("/admin/jobs/run-document-ocr-pipeline", {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken),
        body: JSON.stringify({
          documentFileId: state.selectedDocumentId,
          workerId: "ocr-page-user-worker",
          drainUntil: "extraction",
          maxSteps: 8,
          stopOnFailure: true
        })
      });
      const lastJob = response.jobsProcessed.at(-1);
      const detail = lastJob ? `${lastJob.jobType} ${formatJobStatus(lastJob.status, locale)}` : locale === "tr" ? "seçili belge için kuyrukta iş yok" : "no queued job for the selected document";
      const successDetail =
        locale === "tr"
          ? response.extractionAvailable
            ? "Ham OCR metni ve çıkarım sonucu oluştu."
            : response.rawOcrAvailable
              ? "Ham OCR metni oluştu."
              : "Seçili belgenin sıradaki OCR işi çalıştırıldı; durumu yenilendi."
          : response.extractionAvailable
            ? "Raw OCR text and extraction were created."
            : response.rawOcrAvailable
              ? "Raw OCR text was created."
              : "The selected document's next OCR job was processed and the status was refreshed.";
      setFlowAction({
        kind: lastJob?.status === "FAILED" ? "error" : "success",
        message:
          locale === "tr"
            ? `Worker sonucu: ${detail}. ${successDetail}${lastJob?.failureReason ? ` - ${formatWorkerFailure(lastJob.failureReason, locale)}` : ""}`
            : `Worker result: ${detail}. ${successDetail}${lastJob?.failureReason ? ` - ${formatWorkerFailure(lastJob.failureReason, locale)}` : ""}`
      });
      await load(state.selectedWorkspaceId, state.selectedDocumentId);
    } catch (caught) {
      setFlowAction({ kind: "error", message: formatFlowError(caught, "WORKER_RUN_FAILED", locale) });
    }
  }

  async function runExtractionFromLatest() {
    if (state.kind !== "ready" || !state.selectedDocumentId) return;
    const latest = state.latest ?? latestFromJobs(state.jobs, selectedOcrEngine);
    const hasSelectedOcrText = latestMatchesEngine(latest, selectedOcrEngine) && Boolean(latest?.comparison.selectedText.trim());
    const hasSelectedExtraction = Boolean(
      state.latestExtraction && hasSelectedOcrText && extractionMatchesEngine(state.latestExtraction, selectedOcrEngine)
    );
    if (hasSelectedExtraction) {
      setFlowAction({ kind: "success", message: locale === "tr" ? "Çıkarım sonucu zaten hazır." : "Extraction is already ready." });
      return;
    }
    if (!latest || !hasSelectedOcrText) {
      setFlowAction({ kind: "error", message: locale === "tr" ? "Çıkarım için önce başarılı bir OCR metni gerekir." : "Extraction needs a successful OCR text first." });
      return;
    }
    const text = preferredExtractionTextFromLatest(latest, selectedOcrEngine);
    const sourceEngine =
      selectedOcrEngine === "ENSEMBLE" ? (latest.comparison.selectedEngine === "NONE" ? null : latest.comparison.selectedEngine) : selectedOcrEngine;
    setFlowAction({ kind: "submitting", target: "extraction" });
    try {
      await apiRequest<PersistedExtractionSummary>(`/documents/${state.selectedDocumentId}/extraction`, {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken),
        body: JSON.stringify({ text, sourceEngine })
      });
      setFlowAction({ kind: "success", message: locale === "tr" ? "Çıkarım sonucu kaydedildi. Alanları aşağıda kontrol edebilirsiniz." : "Extraction result saved. You can review the fields below." });
      await load(state.selectedWorkspaceId, state.selectedDocumentId);
    } catch (caught) {
      setFlowAction({ kind: "error", message: formatFlowError(caught, "EXTRACTION_FAILED", locale) });
    }
  }

  async function createExpenseFromExtraction(forceNonExpenseDocument = false) {
    if (state.kind !== "ready" || !state.selectedDocumentId) return;
    if (state.latestExpense) {
      setFlowAction({ kind: "success", message: locale === "tr" ? "Gider kaydı zaten hazır." : "Expense record is already ready." });
      return;
    }
    setFlowAction({ kind: "submitting", target: "expense" });
    try {
      const result = await apiRequest<{ expense: ExpenseSummary }>(`/documents/${state.selectedDocumentId}/expense`, {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken),
        body: JSON.stringify({ forceNonExpenseDocument })
      });
      setFlowAction({ kind: "success", message: locale === "tr" ? "Gider taslağı oluşturuldu." : "Expense draft created." });
      setState((current) => (current.kind === "ready" ? { ...current, latestExpense: result.expense } : current));
    } catch (caught) {
      setFlowAction({ kind: "error", message: formatFlowError(caught, "EXPENSE_FROM_EXTRACTION_FAILED", locale) });
    }
  }

  if (state.kind === "loading") return <Shell title={text.loading} detail={text.loadingDetail} text={text} locale={locale} />;

  if (state.kind === "anonymous") {
    return (
      <Shell title={text.title} detail={text.anonymousDetail} text={text} locale={locale}>
        <Link className="mt-6 inline-flex h-10 items-center bg-ink px-4 text-sm font-semibold text-paper" href={localized("/login")}>
          {text.signIn}
        </Link>
      </Shell>
    );
  }

  if (state.kind === "error") {
    return (
      <Shell title={text.title} detail={formatFlowError(state.message, "OCR_WORKSPACE_LOAD_FAILED", locale)} text={text} locale={locale}>
        <SessionRecoveryActions locale={locale} />
      </Shell>
    );
  }

  const canRun = state.principal.permissions.includes("ocr.run");
  const canManageJobs = state.principal.permissions.includes("admin.jobs.manage");
  const canCreateExpense = state.principal.permissions.includes("expenses.create");
  const latest = state.latest ?? latestFromJobs(state.jobs, selectedOcrEngine);
  const latestMatchesSelectedEngine = latestMatchesEngine(latest, selectedOcrEngine);
  const hasSelectedOcrText = latestMatchesSelectedEngine && Boolean(latest?.comparison.selectedText.trim());
  const hasSelectedExtraction = Boolean(
    state.latestExtraction && hasSelectedOcrText && extractionMatchesEngine(state.latestExtraction, selectedOcrEngine)
  );
  const hasSelectedExpense = Boolean(state.latestExpense && hasSelectedExtraction);
  const selectedExtraction = hasSelectedExtraction ? state.latestExtraction : null;
  const selectedExpense = hasSelectedExpense ? state.latestExpense : null;
  const selectedOcrWarnings = selectedOcrRunWarnings(latest);
  const ocrRequiresReview =
    selectedOcrEngine === "CUSTOM_CRNN" &&
    latest !== null &&
    latestMatchesSelectedEngine &&
    (latest.comparison.averageConfidence < 0.5 ||
      selectedOcrWarnings.some((warning) =>
        [
          "CUSTOM_OCR_LOW_CONFIDENCE",
          "CUSTOM_OCR_LOW_REAL_DOCUMENT_CONFIDENCE",
          "CUSTOM_OCR_GARBAGE_TEXT",
          "CUSTOM_OCR_HIGH_CONFIDENCE_MISMATCH",
          "CUSTOM_OCR_SEGMENTATION_SUSPECT"
        ].includes(warning)
      ));
  const nextWorkerQueue = selectWorkerQueue(state, selectedOcrEngine);
  const pipeline = buildPipelineState(state, latest, selectedOcrEngine, locale);
  const workerBlockedByOcrService = (nextWorkerQueue === "preprocessing" || nextWorkerQueue === "ocr") && isOcrServiceUnavailable(state.ocrService);
  const documentType = hasSelectedExtraction ? (state.latestExtraction?.extracted.documentType ?? null) : null;
  const documentTypeConfidence = hasSelectedExtraction ? (state.latestExtraction?.extracted.documentTypeConfidence ?? 0) : 0;
  const nonExpenseDocument = Boolean(documentType && !isStandardExpenseDocumentType(documentType));
  const criticalExtractionIssues = selectedExtraction?.extracted.validationIssues.filter((issue) => issue.severity === "critical") ?? [];

  return (
    <Shell title={text.title} detail={`${state.principal.displayName} - ${text.detail}`} text={text} locale={locale}>
      <WorkflowActions
        canRun={canRun}
        canManageJobs={canManageJobs}
        canCreateExpense={canCreateExpense}
        hasDocument={Boolean(state.selectedDocumentId)}
        hasOcrText={hasSelectedOcrText}
        hasExtraction={hasSelectedExtraction}
        hasExpense={hasSelectedExpense}
        documentType={documentType}
        documentTypeConfidence={documentTypeConfidence}
        nonExpenseDocument={nonExpenseDocument}
        criticalExtractionIssues={criticalExtractionIssues}
        ocrQualityWarnings={selectedOcrWarnings}
        ocrRequiresReview={ocrRequiresReview}
        ocrService={state.ocrService}
        workerBlockedByOcrService={workerBlockedByOcrService}
        workerHasNext={Boolean(nextWorkerQueue)}
        nextWorkerLabel={pipeline.nextWorkerLabel}
        selectedEngine={selectedOcrEngine}
        activeCustomOcrModel={state.activeCustomOcrModel}
        action={flowAction}
        locale={locale}
        onEngineChange={(engine) => setSelectedOcrEngine(engine)}
        onRunOcr={() => void enqueueSelectedOcr()}
        onRunWorker={() => void runNextWorker()}
        onRunExtraction={() => void runExtractionFromLatest()}
        onCreateExpense={() => void createExpenseFromExtraction(false)}
        onForceCreateExpense={() => void createExpenseFromExtraction(true)}
        onRefreshStatus={() => void load(state.selectedWorkspaceId, state.selectedDocumentId)}
      />
      <div className="grid gap-8 xl:grid-cols-[420px_minmax(0,1fr)]">
        <section className="border-y border-black/10 py-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold">{locale === "tr" ? "Belge seçimi" : "Document selection"}</h2>
              <p className="mt-1 text-sm text-steel">{text.uploadHint}</p>
            </div>
            <span className={canRun ? "text-xs font-semibold uppercase tracking-[0.16em] text-signal" : "text-xs font-semibold uppercase tracking-[0.16em] text-black/35"}>
              {canRun ? text.authorized : text.unauthorized}
            </span>
          </div>

          <div className="mt-6 grid gap-4">
            <Field label={locale === "tr" ? "Çalışma alanı" : "Workspace"}>
              <select
                className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal"
                value={state.selectedWorkspaceId}
                onChange={(event) => void load(event.target.value)}
              >
                {state.workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={locale === "tr" ? "Belge" : "Document"}>
              <select
                className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal"
                value={state.selectedDocumentId}
                onChange={(event) => void load(state.selectedWorkspaceId, event.target.value)}
              >
                {state.documents.map((document) => (
                  <option key={document.id} value={document.id}>
                    {document.originalName}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {state.documents.length === 0 ? (
            <div className="mt-6 border-t border-black/10 pt-5 text-sm text-steel">
              {text.startOcrHint}
              <br />
              <Link className="mt-3 inline-flex font-semibold text-ink hover:text-signal" href={localized("/documents/upload")}>
                {locale === "tr" ? "Belge yükleme ekranını aç" : "Open document upload"}
              </Link>
            </div>
          ) : (
            <details className="mt-6 border-t border-black/10 pt-5">
              <summary className="cursor-pointer text-sm font-semibold text-steel hover:text-ink">{text.advancedCompare}</summary>
              <p className="mt-3 text-sm text-steel">
                {text.advancedDetail}
              </p>
              <form onSubmit={submitComparison} className="mt-5 space-y-5">
                <EngineTextArea label={locale === "tr" ? "Tesseract metni" : "Tesseract text"} name="tesseractText" defaultValue={sampleTesseractText(selectedDocument)} />
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={locale === "tr" ? "Tesseract güven skoru" : "Tesseract confidence"}>
                    <input name="tesseractConfidence" type="number" min={0} max={1} step={0.01} defaultValue={0.86} className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal" />
                  </Field>
                  <Field label={locale === "tr" ? "Tesseract süre ms" : "Tesseract latency ms"}>
                    <input name="tesseractLatencyMs" type="number" min={0} step={1} defaultValue={420} className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal" />
                  </Field>
                </div>
                <EngineTextArea label={locale === "tr" ? "Custom CRNN metni" : "Custom CRNN text"} name="customText" defaultValue={sampleCustomText(selectedDocument)} />
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={locale === "tr" ? "Custom güven skoru" : "Custom confidence"}>
                    <input name="customConfidence" type="number" min={0} max={1} step={0.01} defaultValue={0.61} className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal" />
                  </Field>
                  <Field label={locale === "tr" ? "Custom süre ms" : "Custom latency ms"}>
                    <input name="customLatencyMs" type="number" min={0} step={1} defaultValue={180} className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal" />
                  </Field>
                </div>
                <EngineTextArea label={locale === "tr" ? "Ground truth metni" : "Ground truth text"} name="groundTruthText" defaultValue="MAVI MARKET TARIH 12.05.2026 TOPLAM 72,05 TL" />
                {submitState === "error" ? <p className="text-sm font-medium text-red-700">{text.compareError}</p> : null}
                <button
                  className="h-11 w-full bg-ink text-sm font-semibold text-paper hover:bg-signal disabled:cursor-not-allowed disabled:bg-black/25"
                  disabled={!canRun || !state.selectedDocumentId || submitState === "submitting"}
                >
                  {submitState === "submitting" ? text.comparing : text.compare}
                </button>
              </form>
            </details>
          )}
        </section>

        <section className="space-y-8">
          <PipelinePanel pipeline={pipeline} locale={locale} />
          <DocumentPreview document={selectedDocument} preview={state.documentPreview} hasOcrText={hasSelectedOcrText} locale={locale} />
          <LatestComparison latest={latest} locale={locale} />
          <ExtractionPanel extraction={selectedExtraction} latestExpense={selectedExpense} locale={locale} />
          <History jobs={state.jobs} locale={locale} />
        </section>
      </div>
    </Shell>
  );
}

async function loadDocumentPreview(accessToken: string, documentId: string): Promise<DocumentPreviewState> {
  const [download, pages] = await Promise.all([
    apiRequest<DocumentDownloadUrlResponse>(`/documents/${documentId}/download-url?expiresInSeconds=300`, {
      method: "POST",
      headers: authHeaders(accessToken)
    }).catch(() => null),
    apiRequest<{ pages: DocumentPageSummary[] }>(`/documents/${documentId}/pages`, {
      headers: authHeaders(accessToken)
    }).catch(() => ({ pages: [] }))
  ]);
  return {
    originalUrl: download?.url ?? null,
    pages: pages.pages
  };
}

function DocumentPreview({
  document,
  preview,
  hasOcrText,
  locale
}: {
  document: DocumentSummary | null;
  preview: DocumentPreviewState;
  hasOcrText: boolean;
  locale: "tr" | "en";
}) {
  const firstPage = preview.pages[0] ?? null;
  return (
    <section className="border-y border-black/10 py-6">
      <div className="flex flex-col gap-4 border-b border-black/10 pb-5 md:flex-row md:items-end md:justify-between">
        <div>
          <h2 className="text-xl font-semibold">{locale === "tr" ? "Belge önizlemesi" : "Document preview"}</h2>
          <p className="mt-1 text-sm text-steel">
            {document ? `${document.originalName} - ${document.mimeType}` : locale === "tr" ? "Belge seçilmedi." : "No document selected."}
          </p>
        </div>
        <span className="text-sm text-steel">
          {preview.pages.length} {locale === "tr" ? "işlenmiş sayfa" : "processed pages"}
        </span>
      </div>
      {!document ? (
        <div className="py-10 text-sm text-steel">
          {locale === "tr"
            ? "Orijinal ve işlenmiş çıktıları görmek için bir belge seçin."
            : "Select a document to see the original and processed outputs."}
        </div>
      ) : (
        <div className="grid gap-6 py-6 lg:grid-cols-2">
          <PreviewPane
            locale={locale}
            title={locale === "tr" ? "Orijinal dosya" : "Original file"}
            url={preview.originalUrl}
            mimeType={document.mimeType}
            emptyText={locale === "tr" ? "Orijinal imzalı URL kullanılamıyor." : "Original signed URL unavailable."}
          />
          <PreviewPane
            locale={locale}
            title={firstPage ? (locale === "tr" ? `İşlenmiş sayfa ${firstPage.pageNumber}` : `Processed page ${firstPage.pageNumber}`) : locale === "tr" ? "İşlenmiş sayfa" : "Processed page"}
            url={firstPage?.processedImageUrl ?? null}
            mimeType="image/png"
            emptyText={
              hasOcrText
                ? locale === "tr"
                  ? "İşlenmiş sayfa önizlemesi kaydedilmedi; ancak ham OCR metni seçili belgenin özgün dosyası üzerinden oluşturuldu."
                  : "No processed page preview was saved; raw OCR text was created from the selected document's original file."
                : locale === "tr"
                  ? "Henüz işlenmiş sayfa çıktısı kaydedilmedi."
                  : "No processed page output has been saved yet."
            }
            meta={
              firstPage
                ? [
                    firstPage.preprocessingProfile ? `${locale === "tr" ? "Profil" : "Profile"} ${firstPage.preprocessingProfile}` : null,
                    firstPage.qualityScore ? `${locale === "tr" ? "Kalite" : "Quality"} ${firstPage.qualityScore}` : null,
                    firstPage.width && firstPage.height ? `${firstPage.width}x${firstPage.height}` : null
                  ]
                    .filter(Boolean)
                    .join(" - ")
                : null
            }
          />
        </div>
      )}
    </section>
  );
}

function PreviewPane({
  title,
  url,
  mimeType,
  emptyText,
  meta,
  locale
}: {
  title: string;
  url: string | null;
  mimeType: string;
  emptyText: string;
  meta?: string | null;
  locale: "tr" | "en";
}) {
  const canRenderImage = Boolean(url) && mimeType.startsWith("image/") && !url?.startsWith("memory://");
  return (
    <div>
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-sm font-semibold uppercase tracking-[0.16em] text-steel">{title}</h3>
        {url ? (
          <a className="text-sm font-semibold text-ink hover:text-signal" href={url} target="_blank" rel="noreferrer">
            {locale === "tr" ? "Aç" : "Open"}
          </a>
        ) : null}
      </div>
      {meta ? <p className="mt-2 text-xs text-steel">{meta}</p> : null}
      <div className="mt-4 flex min-h-64 items-center justify-center border border-black/10 bg-white">
        {canRenderImage ? (
          <img src={url ?? ""} alt={title} className="max-h-[360px] w-full object-contain" />
        ) : url ? (
          <div className="px-5 text-center text-sm text-steel">
            {locale === "tr" ? "Önizleme imzalı çıktı URL'si üzerinden açılır." : "Preview opens through the signed output URL."}
          </div>
        ) : (
          <div className="px-5 text-center text-sm text-steel">{emptyText}</div>
        )}
      </div>
    </div>
  );
}

function WorkflowActions({
  canRun,
  canManageJobs,
  canCreateExpense,
  hasDocument,
  hasOcrText,
  hasExtraction,
  hasExpense,
  documentType,
  documentTypeConfidence,
  nonExpenseDocument,
  criticalExtractionIssues,
  ocrQualityWarnings,
  ocrRequiresReview,
  ocrService,
  workerBlockedByOcrService,
  workerHasNext,
  nextWorkerLabel,
  selectedEngine,
  activeCustomOcrModel,
  action,
  locale,
  onEngineChange,
  onRunOcr,
  onRunWorker,
  onRunExtraction,
  onCreateExpense,
  onForceCreateExpense,
  onRefreshStatus
}: {
  canRun: boolean;
  canManageJobs: boolean;
  canCreateExpense: boolean;
  hasDocument: boolean;
  hasOcrText: boolean;
  hasExtraction: boolean;
  hasExpense: boolean;
  documentType: PersistedExtractionSummary["extracted"]["documentType"] | null;
  documentTypeConfidence: number;
  nonExpenseDocument: boolean;
  criticalExtractionIssues: PersistedExtractionSummary["extracted"]["validationIssues"];
  ocrQualityWarnings: string[];
  ocrRequiresReview: boolean;
  ocrService: AdminHealthResponse["checks"][string] | null;
  workerBlockedByOcrService: boolean;
  workerHasNext: boolean;
  nextWorkerLabel: string;
  selectedEngine: UserOcrEngine;
  activeCustomOcrModel: OcrCapabilitiesResponse["customOcr"]["activeModel"];
  action: FlowActionState;
  locale: "tr" | "en";
  onEngineChange: (engine: UserOcrEngine) => void;
  onRunOcr: () => void;
  onRunWorker: () => void;
  onRunExtraction: () => void;
  onCreateExpense: () => void;
  onForceCreateExpense: () => void;
  onRefreshStatus: () => void;
}) {
  const busy = action.kind === "submitting";
  const ocrBlockedByOcrService = isOcrServiceUnavailable(ocrService);
  const customModelRequired = selectedEngine === "CUSTOM_CRNN" || selectedEngine === "ENSEMBLE";
  const customModelMissing = customModelRequired && !activeCustomOcrModel;
  const expenseBlockedByCriticalIssues = criticalExtractionIssues.length > 0;
  const engineLabel = formatEngineLabel(selectedEngine, locale);
  const workerHelp =
    !hasDocument
      ? locale === "tr"
        ? "Worker için önce belge seçin."
        : "Select a document before running Worker."
      : workerHasNext
        ? locale === "tr"
          ? `Worker düğmesi seçili belgeye ait ön işleme, ${engineLabel} ve çıkarım işlerini sırayla çalıştırır. Sıradaki aşama: ${nextWorkerLabel}.`
          : `Run Worker processes preprocessing, ${engineLabel}, and extraction jobs for the selected document in order. Next stage: ${nextWorkerLabel}.`
        : hasExpense
          ? locale === "tr"
            ? "Bu belge için Worker aşaması tamamlandı; OCR, çıkarım ve gider kaydı hazır."
            : "Worker processing is complete for this document; OCR, extraction and expense are ready."
          : hasOcrText
            ? locale === "tr"
              ? "Ham OCR metni hazır. Çıkarım oluştur adımıyla devam edin."
              : "Raw OCR text is ready. Continue with Create extraction."
            : locale === "tr"
              ? "Aktif Worker işi yok. OCR başlat adımıyla kuyruğu hazırlayın."
              : "There is no active Worker job. Use Start OCR to prepare the queue.";
  return (
    <section className="mb-8 border-y border-black/10 bg-white px-4 py-5 md:px-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <h2 className="text-lg font-semibold">{locale === "tr" ? "Sıradaki adım" : "Next step"}</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-steel">
            {locale === "tr"
              ? "Yüklenen belgeyi seçin, OCR işini başlatın, Worker sonucuyla oluşan ham metni kontrol edin, çıkarım çalıştırın ve gider kaydını oluşturun. Servis hazır değilse hata mesajı hangi yerel sürecin başlatılması gerektiğini açıkça gösterir."
              : "Select the uploaded document, start OCR, inspect the raw text created by the Worker result, run extraction and create the expense record. If a service is unavailable, the error explains which local process should be started."}
          </p>
        </div>
        <div className="grid gap-3 xl:min-w-[640px]">
          <div className="grid gap-2 lg:grid-cols-[minmax(13rem,16rem)_minmax(0,1fr)] lg:items-start">
            <label className="grid gap-1 text-sm font-semibold">
              <span>{locale === "tr" ? "OCR motoru" : "OCR engine"}</span>
              <select
                className="h-10 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal"
                value={selectedEngine}
                onChange={(event) => onEngineChange(event.target.value as UserOcrEngine)}
              >
                <option value="TESSERACT">Tesseract</option>
                <option value="CUSTOM_CRNN">Custom OCR</option>
                <option value="ENSEMBLE">Ensemble</option>
              </select>
            </label>
            <div className="min-w-0 break-words pt-0.5 text-xs leading-5 text-steel">
              {selectedEngine === "CUSTOM_CRNN" || selectedEngine === "ENSEMBLE" ? (
                activeCustomOcrModel ? (
                  <span className="font-semibold text-signal">
                    {locale === "tr" ? "Aktif Custom OCR modeli" : "Active Custom OCR model"}: {activeCustomOcrModel.name}
                    {formatModelMetricSummary(activeCustomOcrModel, locale)}
                  </span>
                ) : (
                  <span className="font-semibold text-amber-700">
                    {locale === "tr"
                      ? "Aktif Custom OCR modeli yok. Yerelde modeli doğrulayıp aktif yapmak için `pnpm custom-ocr:bootstrap` çalıştırın; ayrıntılar için Model sayfasını açın."
                      : "No active Custom OCR model is registered. Run `pnpm custom-ocr:bootstrap` locally, then open the Models page for details."}{" "}
                    <Link className="underline decoration-amber-700/50 underline-offset-2" href={`/models?lang=${encodeURIComponent(locale)}`}>
                      {locale === "tr" ? "Model kayıtları" : "Model registry"}
                    </Link>
                  </span>
                )
              ) : (
                <span>{locale === "tr" ? "Tesseract ayrı baseline olarak çalışır." : "Tesseract runs as the separate baseline."}</span>
              )}
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <ActionButton
            disabled={!canRun || !hasDocument || ocrBlockedByOcrService || customModelMissing || busy}
            onClick={onRunOcr}
            {...(customModelMissing
              ? {
                  disabledReason:
                    locale === "tr"
                      ? "Custom OCR için önce `pnpm custom-ocr:bootstrap` ile aktif model kaydı oluşturulmalı."
                      : "Custom OCR needs an active model first. Run `pnpm custom-ocr:bootstrap`."
                }
              : {})}
          >
            {locale === "tr" ? "OCR başlat" : "Start OCR"}
          </ActionButton>
          <ActionButton disabled={!canManageJobs || !hasDocument || !workerHasNext || workerBlockedByOcrService || busy} onClick={onRunWorker}>
            {workerHasNext
              ? locale === "tr"
                ? `Worker çalıştır: ${nextWorkerLabel}`
                : `Run Worker: ${nextWorkerLabel}`
              : locale === "tr"
                ? "Worker tamamlandı"
                : "Worker complete"}
          </ActionButton>
          <ActionButton
            disabled={!canRun || !hasOcrText || hasExtraction || ocrRequiresReview || busy}
            onClick={onRunExtraction}
            disabledReason={
              hasExtraction
                ? locale === "tr"
                  ? "Çıkarım sonucu zaten hazır."
                  : "Extraction is already ready."
                : ocrRequiresReview
                  ? locale === "tr"
                    ? `Custom OCR sonucu otomatik çıkarım için güvenli değil; önce inceleme gerekiyor (${ocrQualityWarnings.join(", ") || "LOW_CONFIDENCE"}).`
                    : `Custom OCR is not safe for automatic extraction; review is required first (${ocrQualityWarnings.join(", ") || "LOW_CONFIDENCE"}).`
                : locale === "tr"
                  ? "Önce başarılı OCR metni gerekiyor."
                  : "A successful OCR text is required first."
            }
          >
            {hasExtraction ? (locale === "tr" ? "Çıkarım hazır" : "Extraction ready") : locale === "tr" ? "Çıkarım oluştur" : "Create extraction"}
          </ActionButton>
          <ActionButton
            disabled={!canCreateExpense || !hasExtraction || hasExpense || nonExpenseDocument || expenseBlockedByCriticalIssues || busy}
            onClick={onCreateExpense}
            disabledReason={
              hasExpense
                ? locale === "tr"
                  ? "Gider kaydı zaten hazır."
                  : "Expense record is already ready."
                : expenseBlockedByCriticalIssues
                  ? locale === "tr"
                    ? `Gider oluşturulamaz; önce inceleme gerekiyor: ${criticalExtractionIssues.map((issue) => issue.code).join(", ")}.`
                    : `Expense creation is blocked until review: ${criticalExtractionIssues.map((issue) => issue.code).join(", ")}.`
                : nonExpenseDocument
                  ? locale === "tr"
                    ? "Belge standart fiş/fatura değil. Onaylı gider taslağı eylemini kullanın."
                    : "This is not a standard receipt/invoice. Use the confirmed expense draft action."
                : locale === "tr"
                  ? "Önce çıkarım sonucu gerekiyor."
                  : "An extraction result is required first."
            }
          >
            {hasExpense ? (locale === "tr" ? "Gider hazır" : "Expense ready") : locale === "tr" ? "Gider oluştur" : "Create expense"}
          </ActionButton>
          </div>
        </div>
      </div>
      {nonExpenseDocument && hasExtraction && !hasExpense ? (
        <div className="mt-4 border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          <p className="font-semibold">
            {locale === "tr"
              ? `Belge tipi: ${formatDocumentType(documentType, locale)} (${formatConfidenceLabel(documentTypeConfidence, locale)})`
              : `Document type: ${formatDocumentType(documentType, locale)} (${formatConfidenceLabel(documentTypeConfidence, locale)})`}
          </p>
          <p className="mt-1">
            {locale === "tr"
              ? "Bu belge standart fiş/fatura gibi görünmüyor. Destekleyici belge olarak saklayın veya gerçekten gider kaydı açılacaksa onaylı taslak eylemini kullanın."
              : "This document does not look like a standard receipt/invoice. Keep it as supporting evidence or use the confirmed draft action only when an expense record is intended."}
          </p>
          {canCreateExpense ? (
            <button
              type="button"
              className="mt-3 border border-amber-700 px-3 py-2 text-xs font-semibold text-amber-950 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={busy}
              onClick={onForceCreateExpense}
            >
              {locale === "tr" ? "Onayla ve gider taslağı oluştur" : "Confirm and create expense draft"}
            </button>
          ) : null}
        </div>
      ) : null}
      <p className="mt-4 text-sm text-steel">
        {workerHelp}
      </p>
      {!hasOcrText ? <p className="mt-2 text-sm text-steel">{locale === "tr" ? "Çıkarım oluştur: Önce başarılı OCR metni gerekiyor." : "Create extraction: a successful OCR text is required first."}</p> : null}
      {ocrRequiresReview ? (
        <p className="mt-2 text-sm font-medium text-amber-700">
          {locale === "tr"
            ? `Çıkarım oluştur: Custom OCR kalite kapısı inceleme gerektiriyor (${ocrQualityWarnings.join(", ") || "LOW_CONFIDENCE"}).`
            : `Create extraction: the Custom OCR quality gate requires review (${ocrQualityWarnings.join(", ") || "LOW_CONFIDENCE"}).`}
        </p>
      ) : null}
      {!hasExtraction ? <p className="mt-1 text-sm text-steel">{locale === "tr" ? "Gider oluştur: Önce çıkarım sonucu gerekiyor." : "Create expense: an extraction result is required first."}</p> : null}
      {expenseBlockedByCriticalIssues ? (
        <p className="mt-2 text-sm font-medium text-red-700">
          {locale === "tr"
            ? `Gider oluştur: Bu çıkarım otomatik gider için güvenli değil. İnceleme/düzeltme gerekiyor (${criticalExtractionIssues.map((issue) => issue.code).join(", ")}).`
            : `Create expense: this extraction is not safe for automatic expense creation. Review or correction is required (${criticalExtractionIssues.map((issue) => issue.code).join(", ")}).`}
        </p>
      ) : null}
      {action.kind === "submitting" ? <p className="mt-4 text-sm font-medium text-steel">{locale === "tr" ? "İşlem sürüyor" : "Processing"}: {action.target}</p> : null}
      {ocrBlockedByOcrService ? (
        <div className="mt-4 flex flex-col gap-3 text-sm font-medium text-red-700 sm:flex-row sm:items-center">
          <span>{formatOcrServiceUnavailable(ocrService, locale)}</span>
          <button type="button" className="w-fit border border-red-700 px-3 py-1 text-xs font-semibold text-red-700 hover:bg-red-50" onClick={onRefreshStatus}>
            {locale === "tr" ? "Durumu yenile" : "Refresh status"}
          </button>
        </div>
      ) : null}
      {action.kind === "success" ? <p className="mt-4 text-sm font-medium text-signal">{action.message}</p> : null}
      {action.kind === "error" ? <p className="mt-4 text-sm font-medium text-red-700">{action.message}</p> : null}
    </section>
  );
}

function ActionButton({
  disabled,
  disabledReason,
  onClick,
  children
}: {
  disabled: boolean;
  disabledReason?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="h-10 border border-black/15 px-3 text-sm font-semibold hover:border-signal hover:text-signal disabled:cursor-not-allowed disabled:border-black/10 disabled:text-black/35"
      disabled={disabled}
      onClick={onClick}
      title={disabled && disabledReason ? disabledReason : undefined}
    >
      {children}
    </button>
  );
}

type PipelineStatus = "not_started" | "queued" | "running" | "succeeded" | "failed" | "available" | "unavailable" | "blocked";
type PipelineStage = {
  id: "preprocess" | "ocr" | "extraction" | "expense";
  label: string;
  status: PipelineStatus;
  detail: string;
};
type PipelineState = {
  stages: PipelineStage[];
  workerJobs: WorkerJobSummary[];
  staleWorkerJobs: WorkerJobSummary[];
  guidance: string;
  nextWorkerLabel: string;
};

function PipelinePanel({ pipeline, locale }: { pipeline: PipelineState; locale: "tr" | "en" }) {
  return (
    <section className="border-y border-black/10 py-6">
      <div className="flex flex-col gap-3 border-b border-black/10 pb-5 md:flex-row md:items-end md:justify-between">
        <div>
          <h2 className="text-xl font-semibold">{locale === "tr" ? "OCR işlem hattı" : "OCR pipeline"}</h2>
          <p className="mt-1 text-sm leading-6 text-steel">{pipeline.guidance}</p>
        </div>
        <span className="text-sm text-steel">
          {pipeline.workerJobs.length} {locale === "tr" ? "worker işi" : "worker jobs"}
        </span>
      </div>
      <div className="grid gap-4 py-5 md:grid-cols-4">
        {pipeline.stages.map((stage) => (
          <div key={stage.id} className="border-t border-black/10 pt-3">
            <div className="text-sm font-semibold">{stage.label}</div>
            <div className={pipelineStatusClass(stage.status)}>{formatPipelineStatus(stage.status, locale)}</div>
            <p className="mt-2 text-xs leading-5 text-steel">{stage.detail}</p>
          </div>
        ))}
      </div>
      {pipeline.workerJobs.length > 0 ? (
        <div className="border-t border-black/10 pt-4">
          <h3 className="text-sm font-semibold uppercase tracking-[0.16em] text-steel">{locale === "tr" ? "Belgeye bağlı Worker işleri" : "Document worker jobs"}</h3>
          <div className="mt-3 divide-y divide-black/10">
            {pipeline.workerJobs.slice(0, 8).map((job) => (
              <div key={job.id} className="grid gap-2 py-3 text-sm md:grid-cols-[120px_1fr_110px_80px]">
                <span className="font-semibold">{job.queue}</span>
                <span className="font-mono text-xs text-steel">{job.jobType}</span>
                <span className={job.status === "FAILED" ? "font-semibold text-red-700" : "font-semibold text-signal"}>{formatJobStatus(job.status, locale)}</span>
                <span className="text-steel">{job.progress}%</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {pipeline.staleWorkerJobs.length > 0 ? (
        <details className="border-t border-black/10 pt-4">
          <summary className="cursor-pointer text-sm font-semibold text-steel hover:text-ink">
            {locale === "tr" ? "Geçmiş / tekrar eden işler" : "Historical / repeated jobs"} ({pipeline.staleWorkerJobs.length})
          </summary>
          <p className="mt-2 text-sm text-steel">
            {locale === "tr"
              ? "Eski/tekrarlı kuyruk kayıtları işlem hattını engellemiyor."
              : "Old or repeated queue records do not block the pipeline."}
          </p>
          <div className="mt-3 divide-y divide-black/10">
            {pipeline.staleWorkerJobs.slice(0, 8).map((job) => (
              <div key={job.id} className="grid gap-2 py-3 text-sm md:grid-cols-[120px_1fr_110px_80px]">
                <span className="font-semibold">{job.queue}</span>
                <span className="font-mono text-xs text-steel">{job.jobType}</span>
                <span className="font-semibold text-steel">{formatJobStatus(job.status, locale)}</span>
                <span className="text-steel">{job.progress}%</span>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}

function LatestComparison({ latest, locale }: { latest: PersistedOcrComparisonSummary | null; locale: "tr" | "en" }) {
  if (!latest) {
    return (
      <section className="border-y border-black/10 py-10 text-sm text-steel">
        {locale === "tr"
          ? "Bu belge için henüz kaydedilmiş OCR sonucu yok. OCR başlatın veya Worker çalıştırın; servis yoksa durum açıkça hata olarak görünür."
          : "There is no saved OCR result for this document yet. Start OCR or run the Worker; if the service is unavailable the state is shown as an explicit error."}
      </section>
    );
  }
  const warnings = selectedOcrRunWarnings(latest);
  return (
    <section className="border-y border-black/10 py-6">
      <div className="grid gap-4 border-b border-black/10 pb-5 md:grid-cols-4">
        <Metric label={locale === "tr" ? "Seçilen motor" : "Selected engine"} value={latest.comparison.selectedEngine} />
        <Metric label={locale === "tr" ? "Güven" : "Confidence"} value={formatPercent(latest.comparison.averageConfidence)} />
        <Metric label={locale === "tr" ? "Benzerlik" : "Similarity"} value={formatNullablePercent(latest.comparison.pairwiseTextSimilarity, locale)} />
        <Metric label="CER" value={formatNullablePercent(latest.comparison.characterErrorRate, locale)} />
      </div>
      <div className="grid gap-6 py-6 lg:grid-cols-[1fr_260px]">
        <div>
          <h2 className="text-xl font-semibold">{locale === "tr" ? "OCR alan kararları" : "OCR field decisions"}</h2>
          <div className="mt-4 divide-y divide-black/10">
            {latest.comparison.fieldDecisions.map((decision) => (
              <div key={decision.field} className="grid gap-3 py-3 md:grid-cols-[150px_1fr_130px]">
                <div className="text-sm font-semibold">{decision.field}</div>
                <div className="min-w-0 break-all text-sm text-steel">{formatDecisionValue(decision.field, decision.value, locale)}</div>
                <div className={decision.status === "conflict" ? "text-sm font-semibold uppercase tracking-[0.16em] text-red-700" : "text-sm font-semibold uppercase tracking-[0.16em] text-signal"}>
                  {decision.status}
                </div>
              </div>
            ))}
          </div>
        </div>
        <aside className="border-l border-black/10 pl-5">
          <h3 className="text-sm font-semibold uppercase tracking-[0.16em] text-steel">{locale === "tr" ? "Ham OCR metni" : "Raw OCR text"}</h3>
          {warnings.length > 0 ? (
            <div className="mt-4 border border-amber-300 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-950">
              <p className="font-semibold">{locale === "tr" ? "OCR kalite uyarıları" : "OCR quality warnings"}</p>
              <p className="mt-1 break-words">{warnings.join(", ")}</p>
            </div>
          ) : null}
          <p className="mt-4 whitespace-pre-wrap text-sm leading-6 text-ink">
            {latest.comparison.selectedText || (locale === "tr" ? "Seçili OCR metni yok." : "No OCR text selected.")}
          </p>
          {latest.comparison.conflictFields.length > 0 ? (
            <p className="mt-5 text-sm font-semibold text-red-700">
              {locale === "tr" ? "Çakışan alanlar" : "Conflict fields"}: {latest.comparison.conflictFields.join(", ")}
            </p>
          ) : null}
        </aside>
      </div>
    </section>
  );
}

function ExtractionPanel({
  extraction,
  latestExpense,
  locale
}: {
  extraction: PersistedExtractionSummary | null;
  latestExpense: ExpenseSummary | null;
  locale: "tr" | "en";
}) {
  if (!extraction) {
    return (
      <section className="border-y border-black/10 py-10 text-sm text-steel">
        {locale === "tr"
          ? "Henüz çıkarım sonucu yok. Ham OCR metni oluştuktan sonra \"Çıkarım oluştur\" adımı belge alanlarını kalıcı olarak kaydeder."
          : 'No extraction result yet. After the raw OCR text is created, the "Create extraction" step persists the document fields.'}
      </section>
    );
  }
  const extracted = extraction.extracted;
  return (
    <section className="border-y border-black/10 py-6">
      <div className="flex flex-col gap-3 border-b border-black/10 pb-5 md:flex-row md:items-end md:justify-between">
        <div>
          <h2 className="text-xl font-semibold">{locale === "tr" ? "Çıkarım sonucu" : "Extraction result"}</h2>
          <p className="mt-1 text-sm text-steel">
            {locale === "tr" ? "OCR metninden çıkarılan alanlar gider oluşturma adımında kullanılır." : "Fields extracted from OCR text are used in the expense creation step."}
          </p>
        </div>
        <span className="text-sm text-steel">
          {extraction.job.status} - {locale === "tr" ? "güven" : "confidence"} {formatConfidenceLabel(extracted.confidence, locale)}
        </span>
      </div>
      <div className="grid gap-4 py-5 md:grid-cols-3">
        <Metric label={locale === "tr" ? "Belge tipi" : "Document type"} value={formatDocumentType(extracted.documentType, locale)} />
        <Metric label={locale === "tr" ? "Satıcı" : "Merchant"} value={extracted.merchantName ?? (locale === "tr" ? "Eksik" : "Missing")} />
        <Metric label={locale === "tr" ? "Tarih" : "Date"} value={extracted.date ?? (locale === "tr" ? "Eksik" : "Missing")} />
        <Metric label={locale === "tr" ? "Toplam" : "Total"} value={extracted.total ? formatMinor(extracted.total.amountMinor, extracted.total.currency) : locale === "tr" ? "Eksik" : "Missing"} />
        <Metric label={locale === "tr" ? "KDV" : "VAT"} value={extracted.taxTotal ? formatMinor(extracted.taxTotal.amountMinor, extracted.taxTotal.currency) : locale === "tr" ? "Eksik" : "Missing"} />
        <Metric label={locale === "tr" ? "Ödeme" : "Payment"} value={extracted.paymentMethod ?? (locale === "tr" ? "Eksik" : "Missing")} />
        <Metric label={locale === "tr" ? "Kalem" : "Line items"} value={`${extracted.lineItems.length}`} />
      </div>
      {!isStandardExpenseDocumentType(extracted.documentType) ? (
        <p className="border-t border-black/10 py-4 text-sm text-amber-900">
          {locale === "tr"
            ? "Bu belge standart fiş/fatura olarak sınıflandırılmadı. Çıkarım sonucu destekleyici belge incelemesi içindir; gider taslağı oluşturmak için ayrıca onay gerekir."
            : "This document was not classified as a standard receipt/invoice. The extraction is for supporting-document review; creating an expense draft requires confirmation."}
        </p>
      ) : null}
      {extracted.normalizedText ? (
        <div className="border-t border-black/10 py-4">
          <h3 className="text-sm font-semibold">{locale === "tr" ? "Normalleştirilmiş OCR metni" : "Normalized OCR text"}</h3>
          <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-ink">{extracted.normalizedText}</p>
          {extracted.normalizationCorrections.length > 0 ? (
            <p className="mt-3 text-xs text-steel">
              {locale === "tr" ? "Düzeltmeler" : "Corrections"}: {extracted.normalizationCorrections.join(", ")}
            </p>
          ) : null}
        </div>
      ) : null}
      {extracted.fieldEvidence.length > 0 ? (
        <div className="border-t border-black/10 py-4">
          <h3 className="text-sm font-semibold">{locale === "tr" ? "Alan kaynağı ve güven skoru" : "Field source and confidence"}</h3>
          <div className="mt-3 divide-y divide-black/10 text-sm">
            {extracted.fieldEvidence.map((field) => (
              <div key={`${field.fieldName}-${field.source}`} className="grid gap-2 py-2 md:grid-cols-[150px_130px_110px_1fr]">
                <span className="font-semibold">{formatEvidenceFieldName(field.fieldName, locale)}</span>
                <span className="text-steel">{formatEvidenceSource(field.source, locale)}</span>
                <span className="text-steel">{formatPercent(field.confidence)}</span>
                <span className="min-w-0 break-words text-steel">{field.normalizedEvidence ?? field.rawEvidence ?? "-"}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {extracted.validationIssues.length > 0 ? (
        <div className="border-t border-black/10 pt-4">
          <h3 className="text-sm font-semibold">{locale === "tr" ? "Doğrulama uyarıları" : "Validation warnings"}</h3>
          <ul className="mt-2 space-y-1 text-sm text-red-700">
            {extracted.validationIssues.map((issue) => (
              <li key={`${issue.code}-${issue.message}`}>{issue.code}: {issue.message}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="border-t border-black/10 pt-4 text-sm font-medium text-signal">{locale === "tr" ? "Doğrulama uyarısı yok." : "No validation warnings."}</p>
      )}
      {latestExpense ? (
        <p className="mt-4 text-sm font-medium text-signal">
          {locale === "tr" ? "Gider oluşturuldu" : "Expense created"}: {latestExpense.title} - {formatMinor(latestExpense.amountMinor, latestExpense.currency)}
        </p>
      ) : null}
    </section>
  );
}

function History({ jobs, locale }: { jobs: OcrJobsResponse["jobs"]; locale: "tr" | "en" }) {
  return (
    <section className="border-y border-black/10 py-6">
      <div className="flex items-end justify-between border-b border-black/10 pb-5">
        <div>
          <h2 className="text-xl font-semibold">{locale === "tr" ? "OCR geçmişi" : "OCR history"}</h2>
          <p className="mt-1 text-sm text-steel">
            {locale === "tr" ? "Seçilen belge için kalıcı OCR işleri ve motor çalıştırmaları." : "Persistent OCR jobs and engine runs for the selected document."}
          </p>
        </div>
        <span className="text-sm text-steel">
          {jobs.length} {locale === "tr" ? "iş" : "jobs"}
        </span>
      </div>
      {jobs.length === 0 ? (
        <div className="py-10 text-sm text-steel">
          {locale === "tr"
            ? "Bu belge için kalıcı OCR sonucu yok. Ön işleme ve Worker durumu yukarıdaki işlem hattında görünür."
            : "No persisted OCR result exists for this document. Preprocessing and Worker state are shown in the pipeline above."}
        </div>
      ) : (
        <div className="divide-y divide-black/10">
          {jobs.map((entry) => (
            <div key={entry.job.id} className="py-5">
              <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <div className="font-mono text-sm font-semibold">{entry.job.id}</div>
                <div className="text-xs text-steel">{new Date(entry.job.createdAt).toLocaleString()}</div>
              </div>
              <div className="mt-4 grid gap-3 md:grid-cols-3">
                {entry.runs.map((run) => (
                  <RunPill key={run.id} run={run} locale={locale} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function RunPill({ run, locale }: { run: OcrEngineRunSummary; locale: "tr" | "en" }) {
  return (
    <div className="border-t border-black/10 pt-3">
      <div className="text-sm font-semibold">{run.engine}</div>
      <div className="mt-1 text-xs uppercase tracking-[0.16em] text-steel">{run.status}</div>
      <div className="mt-2 text-xs text-steel">
        {locale === "tr" ? "Güven" : "Confidence"} {run.confidence ?? (locale === "tr" ? "yok" : "n/a")}
        {run.latencyMs !== null ? ` - ${run.latencyMs} ms` : ""}
      </div>
      {run.failureReason ? <div className="mt-2 text-xs font-medium text-red-700">{run.failureReason}</div> : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-[0.16em] text-steel">{label}</div>
      <div className="mt-2 text-lg font-semibold">{value}</div>
    </div>
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

function EngineTextArea({ label, name, defaultValue }: { label: string; name: string; defaultValue: string }) {
  return (
    <label className="block text-sm font-medium">
      <span className="mb-2 block">{label}</span>
      <textarea name={name} defaultValue={defaultValue} className="min-h-28 w-full border border-black/15 bg-white p-3 font-mono text-xs outline-none focus:border-signal" />
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
  return <AppShell title={title} detail={detail}>{children}</AppShell>;
}

function latestFromJobs(jobs: OcrJobsResponse["jobs"], selectedEngine: UserOcrEngine = "ENSEMBLE"): PersistedOcrComparisonSummary | null {
  const latest =
    selectedEngine === "ENSEMBLE"
      ? jobs[0]
      : jobs.find((job) => job.runs.some((run) => run.engine === selectedEngine && run.status === "SUCCEEDED"));
  const ensemble = latest?.runs.find((run) => run.engine === "ENSEMBLE");
  const comparison = ensemble?.normalizedJson;
  if (!latest || !isComparison(comparison)) return null;
  return { job: latest.job, runs: latest.runs, comparison };
}

function latestMatchesEngine(latest: PersistedOcrComparisonSummary | null, selectedEngine: UserOcrEngine): boolean {
  if (!latest) return false;
  const successfulEngines = new Set(latest.runs.filter((run) => run.status === "SUCCEEDED").map((run) => run.engine));
  if (selectedEngine === "ENSEMBLE") return successfulEngines.has("TESSERACT") && successfulEngines.has("CUSTOM_CRNN");
  const otherEngine = selectedEngine === "TESSERACT" ? "CUSTOM_CRNN" : "TESSERACT";
  if (!successfulEngines.has(selectedEngine)) return false;
  if (!successfulEngines.has(otherEngine)) return true;
  return latest.comparison.selectedEngine === selectedEngine;
}

function preferredExtractionTextFromLatest(latest: PersistedOcrComparisonSummary, selectedEngine: UserOcrEngine): string {
  const fallback = latest.comparison.selectedText.trim();
  const engine = selectedEngine === "ENSEMBLE" ? (latest.comparison.selectedEngine !== "NONE" ? latest.comparison.selectedEngine : null) : selectedEngine;
  if (!engine) return fallback;
  const run = latest.runs.find((candidate) => candidate.engine === engine && candidate.status === "SUCCEEDED");
  const payload = isRecord(run?.normalizedJson) ? run.normalizedJson : null;
  const metadata = isRecord(payload?.metadata) ? payload.metadata : null;
  const normalizedText = typeof metadata?.normalizedText === "string" ? metadata.normalizedText.trim() : "";
  return normalizedText || fallback;
}

function latestOcrWorkerJob(workerJobs: WorkerJobSummary[], selectedEngine: UserOcrEngine): WorkerJobSummary | null {
  const jobTypes =
    selectedEngine === "TESSERACT"
      ? ["ocr.tesseract"]
      : selectedEngine === "CUSTOM_CRNN"
        ? ["ocr.custom_crnn"]
        : ["ocr.tesseract", "ocr.custom_crnn"];
  return (
    workerJobs
      .filter((job) => jobTypes.includes(job.jobType))
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())[0] ?? null
  );
}

function selectWorkerQueue(state: Extract<OcrState, { kind: "ready" }>, selectedEngine: UserOcrEngine): "preprocessing" | "ocr" | "extraction" | undefined {
  const latest = state.latest ?? latestFromJobs(state.jobs, selectedEngine);
  const hasProcessedPages = state.documentPreview.pages.length > 0;
  const hasOcrText = latestMatchesEngine(latest, selectedEngine) && Boolean(latest?.comparison.selectedText.trim());
  const hasExtraction = Boolean(state.latestExtraction && hasOcrText && extractionMatchesEngine(state.latestExtraction, selectedEngine));
  const extractionJob = latestWorkerJob(state.workerJobs, "extraction.from_text");
  if (hasOcrText) {
    return !hasExtraction && extractionJob && ["QUEUED", "RUNNING"].includes(extractionJob.status) ? "extraction" : undefined;
  }
  if (!hasProcessedPages) return "preprocessing";
  return "ocr";
}

function buildPipelineState(
  state: Extract<OcrState, { kind: "ready" }>,
  latest: PersistedOcrComparisonSummary | null,
  selectedEngine: UserOcrEngine,
  locale: "tr" | "en"
): PipelineState {
  const preprocessJob = latestWorkerJob(state.workerJobs, "document.preprocess");
  const ocrJob = latestOcrWorkerJob(state.workerJobs, selectedEngine);
  const extractionJob = latestWorkerJob(state.workerJobs, "extraction.from_text");
  const hasProcessedPages = state.documentPreview.pages.length > 0;
  const hasOcrText = latestMatchesEngine(latest, selectedEngine) && Boolean(latest?.comparison.selectedText.trim());
  const hasExtraction = Boolean(state.latestExtraction && hasOcrText && extractionMatchesEngine(state.latestExtraction, selectedEngine));
  const hasExpense = Boolean(state.latestExpense && hasExtraction);
  const extractionStageJob =
    hasExtraction || extractionJob?.status === "QUEUED" || extractionJob?.status === "RUNNING" ? extractionJob : null;
  const preprocessSupersededByOcr = hasOcrText && !hasProcessedPages;
  const expenseNeedsConfirmation = Boolean(state.latestExtraction && !isStandardExpenseDocumentType(state.latestExtraction.extracted.documentType));
  const nextQueue = selectWorkerQueue(state, selectedEngine);
  const engineLabel = formatEngineLabel(selectedEngine, locale);
  const nextWorkerLabel = formatQueueLabel(nextQueue, selectedEngine, locale);
  const displayWorkerJobs = summarizePipelineWorkerJobs(state.workerJobs, {
    hasProcessedPages,
    hasOcrText,
    hasExtraction,
    hasExpense
  });

  let guidance: string;
  if (hasProcessedPages && !hasOcrText && !ocrJob) {
    guidance = "Ön işleme tamamlandı ancak OCR işi bulunamadı. OCR başlat adımını tekrar çalıştırın veya job zincirini kontrol edin.";
  } else if (hasProcessedPages && !hasOcrText && ocrJob && ["QUEUED", "RUNNING"].includes(ocrJob.status)) {
    guidance = `${engineLabel} kuyruğa alındı. Worker çalıştırıldığında ham OCR metni oluşacak.`;
  } else if (hasProcessedPages && !hasOcrText) {
    guidance = `Ön işleme tamamlandı. Şimdi ${engineLabel} çalıştırılmalı.`;
  } else if (preprocessSupersededByOcr && !hasExtraction) {
    guidance = "Ham OCR metni özgün dosya/fallback yolundan oluşturuldu; işlenmiş sayfa önizlemesi kaydedilmemiş. Çıkarım oluştur adımıyla devam edin.";
  } else if (hasOcrText && !hasExtraction) {
    guidance = "Ham OCR metni hazır. Çıkarım oluştur adımı belge alanlarını kaydeder.";
  } else if (hasExtraction && !hasExpense) {
    guidance = "Çıkarım sonucu hazır. Gider oluştur adımı belgeyi gider kaydına bağlar.";
  } else if (hasExpense) {
    guidance = "OCR, çıkarım ve gider oluşturma akışı bu belge için tamamlandı.";
  } else if (preprocessJob && ["QUEUED", "RUNNING"].includes(preprocessJob.status)) {
    guidance = "Ön işleme kuyruğa alındı. Worker çalıştırıldığında işlenmiş sayfa üretilecek.";
  } else {
    guidance = `OCR başlat adımı önce belgeyi ön işlemeye, ardından ${engineLabel} kuyruğuna alır.`;
  }

  return {
    workerJobs: displayWorkerJobs.active,
    staleWorkerJobs: displayWorkerJobs.stale,
    nextWorkerLabel,
    guidance,
    stages: [
      {
        id: "preprocess",
        label: "Ön işleme",
        status: hasProcessedPages ? "succeeded" : preprocessSupersededByOcr ? "unavailable" : statusFromJob(preprocessJob, "not_started"),
        detail: hasProcessedPages
          ? `${state.documentPreview.pages.length} işlenmiş sayfa hazır.`
          : preprocessSupersededByOcr
            ? "Ham OCR metni özgün dosya/fallback yolundan üretildi; işlenmiş sayfa önizlemesi yok."
            : "OCR-ready sayfa görüntüleri üretilir."
      },
      {
        id: "ocr",
        label: engineLabel,
        status: hasOcrText ? "succeeded" : statusFromJob(ocrJob, hasProcessedPages ? "blocked" : "not_started"),
        detail: hasOcrText ? "Ham OCR metni kaydedildi." : hasProcessedPages ? "Worker bu aşamayı çalıştırınca ham metin oluşur." : "Önce ön işleme gerekir."
      },
      {
        id: "extraction",
        label: "Çıkarım",
        status: hasExtraction ? "succeeded" : statusFromJob(extractionStageJob, hasOcrText ? "available" : "blocked"),
        detail: hasExtraction ? "Belge alanları kalıcı olarak kaydedildi." : hasOcrText ? "Çıkarım oluştur adımı belge alanlarını kaydeder." : "Önce başarılı OCR metni gerekiyor."
      },
      {
        id: "expense",
        label: "Gider",
        status: hasExpense ? "succeeded" : hasExtraction ? "available" : "blocked",
        detail: hasExpense
          ? "Gider kaydı belgeye bağlı."
          : expenseNeedsConfirmation
            ? "Belge standart fiş/fatura değil; gider taslağı için kullanıcı onayı gerekir."
            : hasExtraction
              ? "Gider kaydı oluşturulabilir."
              : "Önce çıkarım sonucu gerekiyor."
      }
    ]
  };
}

function summarizePipelineWorkerJobs(
  workerJobs: WorkerJobSummary[],
  state: { hasProcessedPages: boolean; hasOcrText: boolean; hasExtraction: boolean; hasExpense: boolean }
): { active: WorkerJobSummary[]; stale: WorkerJobSummary[] } {
  const stageDone: Record<string, boolean> = {
    "document.preprocess": state.hasProcessedPages || state.hasOcrText,
    "ocr.tesseract": state.hasOcrText,
    "ocr.custom_crnn": state.hasOcrText,
    "extraction.from_text": state.hasExtraction || state.hasExpense
  };
  const grouped = new Map<string, WorkerJobSummary[]>();
  for (const job of workerJobs) {
    const list = grouped.get(job.jobType) ?? [];
    list.push(job);
    grouped.set(job.jobType, list);
  }

  const summarized: WorkerJobSummary[] = [];
  const stale: WorkerJobSummary[] = [];
  for (const [jobType, jobs] of grouped.entries()) {
    const sorted = [...jobs].sort(compareWorkerJobRecency);
    if (stageDone[jobType]) {
      const succeeded = sorted.find((job) => job.status === "SUCCEEDED");
      if (succeeded) {
        summarized.push(succeeded);
        stale.push(...sorted.filter((job) => job.id !== succeeded.id && (job.status === "QUEUED" || job.status === "RUNNING" || job.status === "FAILED")));
        continue;
      }
      stale.push(...sorted.filter((job) => job.status === "QUEUED" || job.status === "RUNNING" || job.status === "FAILED"));
      continue;
    }
    const active = sorted.find((job) => job.status === "RUNNING" || job.status === "QUEUED");
    const fallback = sorted[0];
    const selected = active ?? fallback;
    if (selected) summarized.push(selected);
  }

  return {
    active: summarized.sort(compareWorkerJobRecency),
    stale: stale.sort(compareWorkerJobRecency)
  };
}

function extractionMatchesEngine(extraction: PersistedExtractionSummary, selectedEngine: UserOcrEngine): boolean {
  if (selectedEngine === "ENSEMBLE") return true;
  return extraction.fields.some((field) => field.sourceEngine === selectedEngine);
}

function compareExpenseRecency(left: ExpenseSummary, right: ExpenseSummary): number {
  return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
}

function compareWorkerJobRecency(left: WorkerJobSummary, right: WorkerJobSummary): number {
  return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
}

function latestWorkerJob(workerJobs: WorkerJobSummary[], jobType: string, statuses?: WorkerJobSummary["status"][]): WorkerJobSummary | null {
  return (
    workerJobs
      .filter((job) => job.jobType === jobType)
      .filter((job) => !statuses || statuses.includes(job.status))
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())[0] ?? null
  );
}

function isDocumentWorkerJob(job: WorkerJobSummary, documentId: string): boolean {
  return recordDocumentId(job.payload) === documentId || recordDocumentId(job.result) === documentId;
}

function recordDocumentId(record: Record<string, unknown> | null): string | null {
  const value = record?.documentFileId ?? record?.documentId;
  return typeof value === "string" ? value : null;
}

function statusFromJob(job: WorkerJobSummary | null, fallback: PipelineStatus): PipelineStatus {
  if (!job) return fallback;
  if (job.status === "QUEUED") return "queued";
  if (job.status === "RUNNING") return "running";
  if (job.status === "SUCCEEDED") return "succeeded";
  if (job.status === "FAILED") return "failed";
  return fallback;
}

function formatQueueLabel(queue: "preprocessing" | "ocr" | "extraction" | undefined, selectedEngine: UserOcrEngine, locale: "tr" | "en"): string {
  if (queue === "preprocessing") return locale === "tr" ? "ön işleme" : "preprocessing";
  if (queue === "ocr") return formatEngineLabel(selectedEngine, locale);
  if (queue === "extraction") return locale === "tr" ? "çıkarım" : "extraction";
  return locale === "tr" ? "genel" : "general";
}

function formatEngineLabel(engine: UserOcrEngine, locale: "tr" | "en"): string {
  if (engine === "CUSTOM_CRNN") return "Custom OCR";
  if (engine === "ENSEMBLE") return locale === "tr" ? "Ensemble karşılaştırması" : "Ensemble comparison";
  return "Tesseract OCR";
}

function formatPipelineStatus(status: PipelineStatus, locale: "tr" | "en"): string {
  const labels: Record<PipelineStatus, { tr: string; en: string }> = {
    not_started: { tr: "Başlamadı", en: "Not started" },
    queued: { tr: "Kuyrukta", en: "Queued" },
    running: { tr: "Çalışıyor", en: "Running" },
    succeeded: { tr: "Tamamlandı", en: "Succeeded" },
    failed: { tr: "Başarısız", en: "Failed" },
    available: { tr: "Hazır", en: "Available" },
    unavailable: { tr: "Kullanılamaz", en: "Unavailable" },
    blocked: { tr: "Bekliyor", en: "Waiting" }
  };
  return labels[status][locale];
}

function pipelineStatusClass(status: PipelineStatus): string {
  if (status === "failed") return "mt-2 text-xs font-semibold uppercase tracking-[0.16em] text-red-700";
  if (status === "succeeded" || status === "available") return "mt-2 text-xs font-semibold uppercase tracking-[0.16em] text-signal";
  return "mt-2 text-xs font-semibold uppercase tracking-[0.16em] text-steel";
}

function isComparison(value: unknown): value is PersistedOcrComparisonSummary["comparison"] {
  return typeof value === "object" && value !== null && "selectedEngine" in value && "fieldDecisions" in value;
}

function selectedOcrRunWarnings(latest: PersistedOcrComparisonSummary | null): string[] {
  if (!latest || latest.comparison.selectedEngine === "NONE") return [];
  const selectedRun = latest.runs
    .filter((run) => run.engine === latest.comparison.selectedEngine)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())[0];
  const collected: string[] = [];
  if (selectedRun && isRecord(selectedRun.normalizedJson)) {
    const warnings = selectedRun.normalizedJson.warnings;
    if (Array.isArray(warnings)) {
      collected.push(...warnings.filter((warning): warning is string => typeof warning === "string" && warning.length > 0));
    }
  }
  if (latest.comparison.selectedEngine === "CUSTOM_CRNN" && latest.comparison.averageConfidence < 0.5) {
    collected.push("CUSTOM_OCR_LOW_CONFIDENCE");
  }
  return [...new Set(collected)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function toOptionalInteger(value: FormDataEntryValue | null): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : undefined;
}

function formatPercent(value: number): string {
  return `${Math.round(clamp(value) * 1000) / 10}%`;
}

function formatNullablePercent(value: number | null, locale: "tr" | "en"): string {
  return value === null ? (locale === "tr" ? "yok" : "n/a") : formatPercent(value);
}

function formatModelMetricSummary(model: Pick<ModelVersionSummary, "metrics">, locale: "tr" | "en"): string {
  const metrics = model.metrics;
  if (!metrics) return "";
  const realFixtureMetrics = readNestedMetricObject(metrics, ["engines", "CUSTOM_CRNN"]);
  const realCer = realFixtureMetrics ? readMetricNumberAny(realFixtureMetrics, ["averageCer", "cer"]) : null;
  const realWer = realFixtureMetrics ? readMetricNumberAny(realFixtureMetrics, ["averageWer", "wer"]) : null;
  const realTurkishF1 = realFixtureMetrics
    ? readMetricNumberAny(realFixtureMetrics, ["turkishSpecialCharacterF1", "turkishSpecialCharacterAccuracy"])
    : null;
  const cer = realCer ?? readMetricNumber(metrics, ["bestValidationCer", "finalCer"], ["finalValidation", "averageCer"]);
  const wer = realWer ?? readMetricNumber(metrics, ["finalWer"], ["finalValidation", "averageWer"]);
  const turkishMetric =
    realTurkishF1 ??
    readMetricNumber(metrics, ["turkishSpecialCharacterAccuracy"], ["finalValidation", "turkishSpecialCharacterAccuracy"]);
  const hasRealFixtureMetrics = realCer !== null || realWer !== null || realTurkishF1 !== null;
  const scopeLabel = hasRealFixtureMetrics
    ? locale === "tr"
      ? "Gerçek fixture"
      : "Real fixture"
    : locale === "tr"
      ? "Doğrulama"
      : "Validation";
  const parts = [
    scopeLabel,
    cer === null ? null : locale === "tr" ? `CER ${formatPercent(cer)} hata` : `CER ${formatPercent(cer)} error`,
    wer === null ? null : locale === "tr" ? `WER ${formatPercent(wer)} hata` : `WER ${formatPercent(wer)} error`,
    turkishMetric === null
      ? null
      : locale === "tr"
        ? `Türkçe karakter ${hasRealFixtureMetrics ? "F1 " : ""}${formatPercent(turkishMetric)}`
        : `Turkish chars ${hasRealFixtureMetrics ? "F1 " : ""}${formatPercent(turkishMetric)}`
  ].filter(Boolean);
  return parts.length > 0 ? ` (${parts.join(" · ")})` : "";
}

function readNestedMetricObject(metrics: Record<string, unknown>, path: string[]): Record<string, unknown> | null {
  let value: unknown = metrics;
  for (const part of path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    value = (value as Record<string, unknown>)[part];
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readMetricNumberAny(metrics: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = metrics[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function readMetricNumber(metrics: Record<string, unknown>, flatKeys: string[], nestedPath: [string, string]): number | null {
  for (const key of flatKeys) {
    const value = metrics[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  const nested = metrics[nestedPath[0]];
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const value = (nested as Record<string, unknown>)[nestedPath[1]];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function isStandardExpenseDocumentType(documentType: PersistedExtractionSummary["extracted"]["documentType"]): boolean {
  return documentType === "retail_receipt" || documentType === "invoice" || documentType === "e_archive_invoice";
}

function formatDocumentType(documentType: PersistedExtractionSummary["extracted"]["documentType"] | null, locale: "tr" | "en"): string {
  const labels: Record<PersistedExtractionSummary["extracted"]["documentType"], { tr: string; en: string }> = {
    retail_receipt: { tr: "Fiş / market belgesi", en: "Retail receipt" },
    invoice: { tr: "Fatura", en: "Invoice" },
    e_archive_invoice: { tr: "E-arşiv fatura", en: "E-archive invoice" },
    bank_transfer_receipt: { tr: "Banka işlem dekontu", en: "Bank transfer receipt" },
    payment_proof: { tr: "Ödeme kanıtı", en: "Payment proof" },
    card_slip: { tr: "Kart slipi", en: "Card slip" },
    unknown_document: { tr: "Bilinmeyen belge", en: "Unknown document" }
  };
  return documentType ? labels[documentType][locale] : locale === "tr" ? "Henüz sınıflandırılmadı" : "Not classified yet";
}

function formatConfidenceLabel(value: number, locale: "tr" | "en"): string {
  return value > 0 ? formatPercent(value) : locale === "tr" ? "güven hesaplanmadı" : "confidence not computed";
}

function formatEvidenceFieldName(fieldName: string, locale: "tr" | "en"): string {
  const labels: Record<string, { tr: string; en: string }> = {
    merchantName: { tr: "Satıcı", en: "Merchant" },
    receiptNo: { tr: "Fiş/fatura no", en: "Receipt/invoice no" },
    date: { tr: "Tarih", en: "Date" },
    total: { tr: "Toplam", en: "Total" },
    taxTotal: { tr: "KDV", en: "VAT" },
    paymentMethod: { tr: "Ödeme yöntemi", en: "Payment method" },
    lineItems: { tr: "Kalemler", en: "Line items" }
  };
  return labels[fieldName]?.[locale] ?? fieldName;
}

function formatEvidenceSource(source: string, locale: "tr" | "en"): string {
  const labels: Record<string, { tr: string; en: string }> = {
    normalized_ocr_text: { tr: "Normalleştirilmiş OCR", en: "Normalized OCR" },
    heuristic: { tr: "Kural tabanlı çıkarım", en: "Heuristic" },
    review: { tr: "Kullanıcı düzeltmesi", en: "User review" }
  };
  return labels[source]?.[locale] ?? source;
}

function formatDecisionValue(field: string, value: string | null, locale: "tr" | "en"): string {
  if (!value) return locale === "tr" ? "Eksik" : "Missing";
  if (["subtotal", "discount", "taxTotal", "total"].includes(field)) {
    const money = /^(-?\d+)\s+([A-Z]{3})$/.exec(value.trim());
    if (money?.[1] && money[2]) return formatMinor(money[1], money[2]);
  }
  return value;
}

function formatMinor(amountMinor: string, currency: string): string {
  const value = BigInt(amountMinor);
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const major = absolute / 100n;
  const minor = (absolute % 100n).toString().padStart(2, "0");
  return `${sign}${major.toString()},${minor} ${currency}`;
}

function sampleTesseractText(document: DocumentSummary | null): string {
  const merchant = document?.kind === "INVOICE" ? "ANKARA KIRTASIYE" : "MAVI MARKET";
  return `${merchant}\nTARIH 12.05.2026\nTOPLAM 72,05 TL`;
}

function sampleCustomText(document: DocumentSummary | null): string {
  const merchant = document?.kind === "INVOICE" ? "ANKARA KIRTASIYE" : "MAVI MARKET";
  return `${merchant}\nTARIH 12.05.2026\nTOPLAM 79,05 TL`;
}

function formatFlowError(caught: unknown, fallback: string, locale: "tr" | "en"): string {
  const message = caught instanceof Error ? caught.message : fallback;
  if (message === "NON_EXPENSE_DOCUMENT_REQUIRES_CONFIRMATION") {
    return locale === "tr"
      ? "Belge standart fiş/fatura değil. Destekleyici belge olarak inceleyin veya onaylı gider taslağı eylemini kullanın."
      : "This is not a standard receipt/invoice. Review it as supporting evidence or use the confirmed expense draft action.";
  }
  const explanations: Record<string, string> =
    locale === "tr"
      ? {
          OCR_JOB_ENQUEUE_FAILED: "OCR işi kuyruklanamadı. Worker ve ilgili servislerin çalıştığını kontrol edin.",
          WORKER_RUN_FAILED: "Worker çalıştırılamadı. Yerel worker sürecini başlatıp tekrar deneyin.",
          EXTRACTION_FAILED: "Çıkarım üretilemedi. Önce OCR metninin oluştuğunu doğrulayın.",
          EXPENSE_FROM_EXTRACTION_FAILED: "Çıkarım sonucundan gider oluşturulamadı. Alanları ve izinleri kontrol edin.",
          UNSUPPORTED_DOCUMENT_TYPE_FOR_EXPENSE: "Belge tipi gider için yeterince güvenilir değil. Önce inceleme/düzeltme akışında belge tipini ve alanları doğrulayın.",
          DUPLICATE_EXPENSE_FOR_DOCUMENT: "Bu belgeye bağlı bir gider zaten var. Gider listesinden mevcut kaydı açın.",
          OCR_WORKSPACE_LOAD_FAILED: "OCR çalışma alanı yüklenemedi. Oturumu yenileyip tekrar deneyin."
        }
      : {
          OCR_JOB_ENQUEUE_FAILED: "OCR job could not be queued. Check that the Worker and related services are running.",
          WORKER_RUN_FAILED: "Worker could not run. Start the local worker process and try again.",
          EXTRACTION_FAILED: "Extraction could not be generated. First confirm that OCR text exists.",
          EXPENSE_FROM_EXTRACTION_FAILED: "Expense could not be created from the extraction result. Check the fields and permissions.",
          UNSUPPORTED_DOCUMENT_TYPE_FOR_EXPENSE: "This document type is not reliable enough for an expense. Review or correct the document type and fields first.",
          DUPLICATE_EXPENSE_FOR_DOCUMENT: "An expense already exists for this document. Open the existing record from the expenses list.",
          OCR_WORKSPACE_LOAD_FAILED: "The OCR workspace could not be loaded. Refresh your session and try again."
        };
  const explanation = explanations[message] ?? explanations[fallback];
  if (explanation) return explanation;
  const friendly = formatUserFacingError(message, locale);
  return friendly !== message
    ? friendly
    : locale === "tr"
      ? "OCR işlemi tamamlanamadı. Belge durumunu yenileyip tekrar deneyin."
      : "The OCR action could not be completed. Refresh the document status and try again.";
}

function formatWorkerFailure(reason: string, locale: "tr" | "en"): string {
  if (/OCR_SERVICE_UNAVAILABLE|OCR_PREPROCESSING_FAILED|OCR_TESSERACT_FAILED|OCR_CUSTOM_CRNN_FAILED|fetch failed|ECONNREFUSED|ENOTFOUND/i.test(reason)) {
    return formatOcrServiceUnavailable(null, locale);
  }
  if (/MinIO|S3|object storage|NoSuchKey|getObject/i.test(reason)) {
    return locale === "tr"
      ? "Belge nesne depolamadan okunamadı. Yerel MinIO/S3 servisini ve API ayarlarını kontrol edip Worker adımını yeniden çalıştırın."
      : "The document could not be read from object storage. Check the local MinIO/S3 service and API settings, then rerun the Worker step.";
  }
  const explanations: Record<string, string> =
    locale === "tr"
      ? {
          PREPROCESSING_WORKER_NOT_CONFIGURED: "Ön işleme Worker servisi hazır değil. OCR servislerini çalıştırın.",
          OCR_TESSERACT_WORKER_NOT_CONFIGURED: "Tesseract Worker hazır değil. OCR servisi ve Worker sürecini başlatın.",
          OCR_CUSTOM_CRNN_WORKER_NOT_CONFIGURED: "Custom OCR Worker hazır değil. OCR servisi ve Worker sürecini başlatın.",
          CUSTOM_OCR_ACTIVE_MODEL_NOT_FOUND:
            "Custom OCR modeli hazır değil. Yerelde `pnpm custom-ocr:bootstrap` komutunu çalıştırıp aktif modeli kaydedin.",
          CUSTOM_OCR_MODEL_ARTIFACT_UNAVAILABLE:
            "Custom OCR model dosyası bulunamadı. `pnpm custom-ocr:bootstrap` ile artifact yolunu doğrulayıp modeli yeniden aktif edin."
        }
      : {
          PREPROCESSING_WORKER_NOT_CONFIGURED: "Preprocessing Worker is not ready. Start the OCR services.",
          OCR_TESSERACT_WORKER_NOT_CONFIGURED: "Tesseract Worker is not ready. Start the OCR service and Worker process.",
          OCR_CUSTOM_CRNN_WORKER_NOT_CONFIGURED: "Custom OCR Worker is not ready. Start the OCR service and Worker process.",
          CUSTOM_OCR_ACTIVE_MODEL_NOT_FOUND: "Custom OCR model is not ready. Run `pnpm custom-ocr:bootstrap` to register an active model.",
          CUSTOM_OCR_MODEL_ARTIFACT_UNAVAILABLE:
            "The Custom OCR model artifact is unavailable. Run `pnpm custom-ocr:bootstrap` to validate the artifact path."
        };
  return explanations[reason] ?? reason;
}

function isOcrServiceUnavailable(check: AdminHealthResponse["checks"][string] | null): boolean {
  return check?.status === "degraded";
}

function formatOcrServiceUnavailable(check: AdminHealthResponse["checks"][string] | null, locale: "tr" | "en"): string {
  const detail = check?.detail ? ` (${check.detail})` : "";
  return locale === "tr"
    ? `OCR servisi hazır değil. OCR kullanmak için pnpm dev:ocr komutuyla yerel OCR servisini başlatın, ardından pnpm dev sürecini yenileyin.${detail}`
    : `The OCR service is not ready. Start the local OCR service with pnpm dev:ocr, then restart pnpm dev.${detail}`;
}

function formatJobStatus(status: string, locale: "tr" | "en"): string {
  const labels: Record<string, string> =
    locale === "tr"
      ? {
          QUEUED: "Kuyrukta",
          RUNNING: "Çalışıyor",
          SUCCEEDED: "Tamamlandı",
          FAILED: "Başarısız",
          CANCELED: "İptal edildi"
        }
      : {
          QUEUED: "Queued",
          RUNNING: "Running",
          SUCCEEDED: "Succeeded",
          FAILED: "Failed",
          CANCELED: "Canceled"
        };
  return labels[status] ?? status;
}
