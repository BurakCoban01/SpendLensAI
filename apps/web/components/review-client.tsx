"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  apiRequest,
  authHeaders,
  formatUserFacingError,
  type ActiveLearningSuggestionSummary,
  type AnnotationSummary,
  type AuthResponse,
  type CorrectionSummary,
  type CorrectionResultSummary,
  type DocumentDownloadUrlSummary,
  type DocumentSummary,
  type ExportJobSummary,
  type GeneratedReportSummary,
  type ModelTrainResultSummary,
  type OcrEngineRunSummary,
  type OcrJobsResponse,
  type PersistedExtractionSummary,
  type PrincipalResponse,
  type ReviewEscalationsRunResponse,
  type ReviewRebalanceSuggestionsResponse,
  type ReviewAssigneeSummary,
  type ReviewTaskSummary,
  type ReviewTaskWithDocument,
  type ReviewWorkloadResponse,
  type WorkspaceSummary
} from "../lib/api";
import { readSession } from "../lib/session";
import { useLocale } from "../lib/locale";
import { AppShell } from "./app-shell";
import { SessionRecoveryActions } from "./session-recovery-actions";

const copy = {
  tr: {
    loading: "İnceleme",
    loadingDetail: "İnceleme çalışma alanı yükleniyor.",
    anonymousDetail: "OCR çıktısını incelemek için önce giriş yapın.",
    signIn: "Giriş yap",
    title: "İnceleme",
    detail: "düzeltme ve etiketleme kuyruğu",
    authorized: "Yetkili",
    unauthorized: "Yetkisiz",
    reviewReasons: "İnceleme gerekçeleri",
    createTask: "İnceleme görevi oluştur",
    creating: "Oluşturuluyor...",
    exportReady: "Yetkili",
    noDocument: "İncelemek için bir belge seçin.",
    noOcr: "Bu belge için henüz kaydedilmiş OCR sonucu yok. OCR başlatın veya Worker çalıştırın; servis yoksa durum açıkça hata olarak görünür.",
    fieldChecks: "Alan incelemesi",
    validationIssues: "Doğrulama sorunları",
    noValidation: "Doğrulama sorunu yok.",
    reviewTasks: "İnceleme görevleri",
    activeLearning: "Etkin öğrenme",
    escalation: "Eskalasyon",
    exit: "Çıkış yap",
    documents: "Belgeler",
    dashboard: "Pano"
  },
  en: {
    loading: "Review",
    loadingDetail: "Loading the review workspace.",
    anonymousDetail: "Sign in first to review OCR output.",
    signIn: "Sign in",
    title: "Review",
    detail: "correction and labeling queue",
    authorized: "Authorized",
    unauthorized: "Unauthorized",
    reviewReasons: "Review reasons",
    createTask: "Create review task",
    creating: "Creating...",
    exportReady: "Authorized",
    noDocument: "Select a document to review.",
    noOcr: "There is no saved OCR result for this document yet. Start OCR or run the Worker; if the service is unavailable the state is shown as an explicit error.",
    fieldChecks: "Field review",
    validationIssues: "Validation issues",
    noValidation: "No validation issues.",
    reviewTasks: "Review tasks",
    activeLearning: "Active learning",
    escalation: "Escalation",
    exit: "Sign out",
    documents: "Documents",
    dashboard: "Dashboard"
  }
} as const;

type ReviewState =
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
      selectedDocumentUrl: DocumentDownloadUrlSummary | null;
      ocrJobs: OcrJobsResponse["jobs"];
      corrections: CorrectionSummary[];
      annotations: AnnotationSummary[];
      latestExtraction: PersistedExtractionSummary | null;
      reviewTasks: ReviewTaskWithDocument[];
      reviewers: ReviewAssigneeSummary[];
      workload: ReviewWorkloadResponse | null;
      rebalanceSuggestions: ReviewRebalanceSuggestionsResponse["suggestions"];
      latestEscalationRun: ReviewEscalationsRunResponse | null;
      trainingExportJobs: ExportJobSummary[];
      latestTrainingExport: GeneratedReportSummary | null;
      latestDatasetTraining: ModelTrainResultSummary | null;
      suggestions: ActiveLearningSuggestionSummary[];
      latestCorrection: CorrectionResultSummary | null;
    }
  | { kind: "error"; message: string };

type SubmitState = { kind: "idle" } | { kind: "submitting"; target: string } | { kind: "error"; message: string };

type BboxDraft = {
  label: string;
  engine: string;
  text: string;
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
};

export function ReviewClient() {
  const { locale } = useLocale();
  const text = copy[locale];
  const dateLocale = locale === "tr" ? "tr-TR" : "en-US";
  const [state, setState] = useState<ReviewState>({ kind: "loading" });
  const [submitState, setSubmitState] = useState<SubmitState>({ kind: "idle" });
  const [bboxDraft, setBboxDraft] = useState<BboxDraft>(() => createBboxDraft(null));
  const [selectedTokenIds, setSelectedTokenIds] = useState<string[]>([]);

  async function load(
    preferredWorkspaceId?: string,
    preferredDocumentId?: string,
    latestCorrection?: CorrectionResultSummary | null,
    latestTrainingExport?: GeneratedReportSummary | null,
    latestDatasetTraining?: ModelTrainResultSummary | null,
    latestEscalationRun?: ReviewEscalationsRunResponse | null
  ) {
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
      const canReview = principal.principal.permissions.includes("ocr.review");
      const canAnnotate = principal.principal.permissions.includes("annotations.manage");
      const canExport = principal.principal.permissions.includes("reports.export");
      let documents =
        selectedWorkspaceId && canReview
          ? (
              await apiRequest<{ documents: DocumentSummary[] }>(
                `/documents?workspaceId=${encodeURIComponent(selectedWorkspaceId)}&limit=50`,
                { headers: authHeaders(session.tokens.accessToken) }
              )
            ).documents
          : [];
      if (preferredDocumentId && canReview && !documents.some((document) => document.id === preferredDocumentId)) {
        const preferred = await apiRequest<{ document: DocumentSummary }>(
          `/documents/${encodeURIComponent(preferredDocumentId)}`,
          { headers: authHeaders(session.tokens.accessToken) }
        ).catch(() => null);
        if (preferred?.document.workspaceId === selectedWorkspaceId) documents = [preferred.document, ...documents];
      }
      const selectedDocumentId = preferredDocumentId && documents.some((document) => document.id === preferredDocumentId)
        ? preferredDocumentId
        : documents[0]?.id ?? "";
      const [tasks, reviewers, workload, rebalanceSuggestions, suggestions] =
        selectedWorkspaceId && canReview
          ? await Promise.all([
              apiRequest<{ reviewTasks: ReviewTaskWithDocument[] }>(
                `/review/tasks?workspaceId=${encodeURIComponent(selectedWorkspaceId)}&limit=100`,
                { headers: authHeaders(session.tokens.accessToken) }
              ),
              apiRequest<{ reviewers: ReviewAssigneeSummary[] }>("/review/reviewers", {
                headers: authHeaders(session.tokens.accessToken)
              }),
              apiRequest<ReviewWorkloadResponse>(`/review/workload?workspaceId=${encodeURIComponent(selectedWorkspaceId)}`, {
                headers: authHeaders(session.tokens.accessToken)
              }).catch(() => null),
              apiRequest<ReviewRebalanceSuggestionsResponse>(
                `/review/rebalance-suggestions?workspaceId=${encodeURIComponent(selectedWorkspaceId)}`,
                { headers: authHeaders(session.tokens.accessToken) }
              ).catch(() => ({ suggestions: [] })),
              canAnnotate
                ? apiRequest<{ suggestions: ActiveLearningSuggestionSummary[] }>(
                    `/active-learning/suggestions?workspaceId=${encodeURIComponent(selectedWorkspaceId)}&limit=50`,
                    { headers: authHeaders(session.tokens.accessToken) }
                  )
                : Promise.resolve({ suggestions: [] })
            ])
          : [{ reviewTasks: [] }, { reviewers: [] }, null, { suggestions: [] }, { suggestions: [] }];
      const [selectedDocumentUrl, ocrJobs, corrections, annotations, latestExtraction] =
        selectedDocumentId && canReview
          ? await Promise.all([
              apiRequest<DocumentDownloadUrlSummary>(
                `/documents/${encodeURIComponent(selectedDocumentId)}/download-url?expiresInSeconds=300`,
                { method: "POST", headers: authHeaders(session.tokens.accessToken) }
              ).catch(() => null),
              apiRequest<OcrJobsResponse>(
                `/documents/${encodeURIComponent(selectedDocumentId)}/ocr-runs`,
                { headers: authHeaders(session.tokens.accessToken) }
              ).catch(() => ({ jobs: [] })),
              apiRequest<{ corrections: CorrectionSummary[] }>(
                `/documents/${encodeURIComponent(selectedDocumentId)}/corrections`,
                { headers: authHeaders(session.tokens.accessToken) }
              ).catch(() => ({ corrections: [] })),
              canAnnotate
                ? apiRequest<{ annotations: AnnotationSummary[] }>(
                    `/documents/${encodeURIComponent(selectedDocumentId)}/annotations`,
                    { headers: authHeaders(session.tokens.accessToken) }
                  ).catch(() => ({ annotations: [] }))
                : Promise.resolve({ annotations: [] }),
              apiRequest<PersistedExtractionSummary>(
                `/documents/${encodeURIComponent(selectedDocumentId)}/extraction`,
                { headers: authHeaders(session.tokens.accessToken) }
              ).catch(() => null)
            ])
          : [null, { jobs: [] }, { corrections: [] }, { annotations: [] }, null];
      const trainingExportJobs =
        selectedWorkspaceId && canExport
          ? (
              await apiRequest<{ exportJobs: ExportJobSummary[] }>(
                `/reports/exports?workspaceId=${encodeURIComponent(selectedWorkspaceId)}`,
                { headers: authHeaders(session.tokens.accessToken) }
              ).catch(() => ({ exportJobs: [] }))
            ).exportJobs.filter((job) => job.type === "dataset_export_jsonl")
          : [];

      setState({
        kind: "ready",
        session,
        principal: principal.principal,
        workspaces,
        selectedWorkspaceId,
        documents,
        selectedDocumentId,
        selectedDocumentUrl,
        ocrJobs: ocrJobs.jobs,
        corrections: corrections.corrections,
        annotations: annotations.annotations,
        latestExtraction,
        reviewTasks: tasks.reviewTasks,
        reviewers: reviewers.reviewers,
        workload,
        rebalanceSuggestions: rebalanceSuggestions.suggestions,
        latestEscalationRun: latestEscalationRun ?? null,
        trainingExportJobs,
        latestTrainingExport: latestTrainingExport ?? null,
        latestDatasetTraining: latestDatasetTraining ?? null,
        suggestions: suggestions.suggestions,
        latestCorrection: latestCorrection ?? null
      });
    } catch (caught) {
      setState({ kind: "error", message: formatReviewError(caught, locale) });
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const canReview = state.kind === "ready" && state.principal.permissions.includes("ocr.review");
  const canAnnotate = state.kind === "ready" && state.principal.permissions.includes("annotations.manage");
  const canRunExtraction = state.kind === "ready" && state.principal.permissions.includes("ocr.run");
  const canManageReviewAssignments = state.kind === "ready" && state.principal.permissions.includes("users.manage");
  const canExportReports = state.kind === "ready" && state.principal.permissions.includes("reports.export");
  const canTrainModels = state.kind === "ready" && state.principal.permissions.includes("models.train");

  const selectedDocument = useMemo(() => {
    if (state.kind !== "ready") return null;
    return state.documents.find((document) => document.id === state.selectedDocumentId) ?? null;
  }, [state]);

  const bboxSeed = useMemo(() => {
    if (state.kind !== "ready") return null;
    return firstOcrOverlayToken(state.ocrJobs);
  }, [state]);

  const selectableOcrTokens = useMemo(() => {
    if (state.kind !== "ready") return [];
    return ocrSelectableTokens(state.ocrJobs);
  }, [state]);

  const selectedOcrTokens = useMemo(
    () => selectableOcrTokens.filter((token) => selectedTokenIds.includes(token.id)),
    [selectableOcrTokens, selectedTokenIds]
  );

  const bboxPages = useMemo(() => {
    const pages = [...new Set(selectableOcrTokens.filter((token) => token.engine === bboxDraft.engine).map((token) => token.pageNumber))].sort(
      (left, right) => left - right
    );
    return pages.length > 0 ? pages : [bboxDraft.pageNumber];
  }, [bboxDraft.engine, bboxDraft.pageNumber, selectableOcrTokens]);

  useEffect(() => {
    setBboxDraft(createBboxDraft(bboxSeed));
  }, [bboxSeed]);

  const selectedDocumentIdForTokenReset = state.kind === "ready" ? state.selectedDocumentId : "";

  useEffect(() => {
    setSelectedTokenIds([]);
  }, [selectedDocumentIdForTokenReset]);

  function applySelectedOcrTokens(nextIds: string[]) {
    const selected = selectableOcrTokens.filter((token) => nextIds.includes(token.id));
    setSelectedTokenIds(nextIds);
    if (selected.length === 0) return;
    const first = selected[0]!;
    const primaryPageTokens = selected.filter((token) => token.engine === first.engine && token.pageNumber === first.pageNumber);
    const bbox = unionTokenBbox(primaryPageTokens);
    const confidence = averageConfidence(selected);
    setBboxDraft((current) => ({
      ...current,
      label: selected.length > 1 ? "ocr_multi_token_span" : "ocr_bbox_token",
      engine: first.engine,
      text: selected.map((token) => token.text).join(" "),
      pageNumber: first.pageNumber,
      x: bbox[0],
      y: bbox[1],
      width: bbox[2],
      height: bbox[3],
      confidence
    }));
  }

  function toggleOcrToken(tokenId: string) {
    const token = selectableOcrTokens.find((candidate) => candidate.id === tokenId);
    if (!token) return;
    const alreadySelected = selectedTokenIds.includes(tokenId);
    const sameEngineSelection = selectableOcrTokens
      .filter((candidate) => selectedTokenIds.includes(candidate.id) && candidate.engine === token.engine)
      .map((candidate) => candidate.id);
    const nextIds = alreadySelected
      ? sameEngineSelection.filter((id) => id !== tokenId)
      : [...sameEngineSelection, tokenId];
    applySelectedOcrTokens(nextIds);
  }

  async function createTask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.kind !== "ready" || !canReview || !state.selectedDocumentId) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const reasonCodes = String(form.get("reasonCodes") ?? "")
      .split(",")
      .map((reason) => reason.trim())
      .filter(Boolean);
    if (reasonCodes.length === 0) {
      setSubmitState({ kind: "error", message: "En az bir gerekçe kodu girin." });
      return;
    }
    setSubmitState({ kind: "submitting", target: "task" });
    try {
      await apiRequest<ReviewTaskSummary>(`/documents/${encodeURIComponent(state.selectedDocumentId)}/review-tasks`, {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken),
        body: JSON.stringify({ reasonCodes })
      });
      formElement.reset();
      setSubmitState({ kind: "idle" });
      await load(state.selectedWorkspaceId, state.selectedDocumentId, state.latestCorrection, state.latestTrainingExport, state.latestDatasetTraining);
    } catch (caught) {
      setSubmitState({ kind: "error", message: caught instanceof Error ? caught.message : "REVIEW_TASK_CREATE_FAILED" });
    }
  }

  async function createCorrection(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.kind !== "ready" || !canReview || !state.selectedDocumentId) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setSubmitState({ kind: "submitting", target: "correction" });
    try {
      const correction = await apiRequest<CorrectionResultSummary>(
        `/documents/${encodeURIComponent(state.selectedDocumentId)}/corrections`,
        {
          method: "POST",
          headers: authHeaders(state.session.tokens.accessToken),
          body: JSON.stringify({
            fieldName: form.get("fieldName"),
            beforeValue: form.get("beforeValue"),
            afterValue: form.get("afterValue"),
            createAnnotation: true,
            annotationLabel: form.get("annotationLabel") || undefined
          })
        }
      );
      formElement.reset();
      setSubmitState({ kind: "idle" });
      await load(state.selectedWorkspaceId, state.selectedDocumentId, correction, state.latestTrainingExport, state.latestDatasetTraining);
    } catch (caught) {
      setSubmitState({ kind: "error", message: caught instanceof Error ? caught.message : "CORRECTION_CREATE_FAILED" });
    }
  }

  async function createLineItemCorrection(event: React.FormEvent<HTMLFormElement>, lineItemIndex: number) {
    event.preventDefault();
    if (state.kind !== "ready" || !canReview || !state.selectedDocumentId || !state.latestExtraction) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const original = state.latestExtraction.extracted.lineItems[lineItemIndex];
    if (!original) return;
    const corrected = {
      name: String(form.get("name") ?? "").trim(),
      quantity: String(form.get("quantity") ?? "").trim() || null,
      unitPrice: original.unitPrice,
      total: {
        amountMinor: String(form.get("amountMinor") ?? "").trim(),
        currency: original.total.currency
      },
      confidence: 1
    };
    if (!corrected.name || !/^-?\d+$/.test(corrected.total.amountMinor)) {
      setSubmitState({ kind: "error", message: "Satır kalemi adı ve tam sayı küçük birim toplamı zorunludur." });
      return;
    }
    setSubmitState({ kind: "submitting", target: `line-item-${lineItemIndex}` });
    try {
      const correction = await apiRequest<CorrectionResultSummary>(
        `/documents/${encodeURIComponent(state.selectedDocumentId)}/corrections`,
        {
          method: "POST",
          headers: authHeaders(state.session.tokens.accessToken),
          body: JSON.stringify({
            fieldName: `lineItems[${lineItemIndex}]`,
            beforeValue: serializeCorrectionValue(original),
            afterValue: serializeCorrectionValue(corrected),
            createAnnotation: true,
            annotationLabel: "corrected_line_item",
            annotationPayload: {
              type: "line_item_correction",
              extractionJobId: state.latestExtraction.job.id,
              lineItemIndex,
              before: original,
              after: corrected
            }
          })
        }
      );
      const reconciledLineItems = state.latestExtraction.extracted.lineItems.map((item, index) =>
        index === lineItemIndex ? corrected : item
      );
      await apiRequest<PersistedExtractionSummary>(
        `/documents/${encodeURIComponent(state.selectedDocumentId)}/extraction/line-items`,
        {
          method: "POST",
          headers: authHeaders(state.session.tokens.accessToken),
          body: JSON.stringify({ lineItems: reconciledLineItems })
        }
      );
      setSubmitState({ kind: "idle" });
      await load(state.selectedWorkspaceId, state.selectedDocumentId, correction, state.latestTrainingExport, state.latestDatasetTraining);
    } catch (caught) {
      setSubmitState({ kind: "error", message: caught instanceof Error ? caught.message : "LINE_ITEM_CORRECTION_FAILED" });
    }
  }

  async function reconcileExtractionFields(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submitExtractionFieldReviewForm(event.currentTarget);
  }

  async function submitExtractionFieldReviewForm(formElement: HTMLFormElement) {
    if (state.kind !== "ready" || !canReview || !state.selectedDocumentId || !state.latestExtraction) return;
    const form = new FormData(formElement);
    const reviewStatus = String(form.get("reviewStatus") ?? "NEEDS_REVIEW");
    const fields = [
      textPatch("merchantName", form.get("merchantName")),
      textPatch("date", form.get("date")),
      moneyPatch("total", form.get("totalMinor"), state.latestExtraction.extracted.currency),
      moneyPatch("taxTotal", form.get("taxMinor"), state.latestExtraction.extracted.currency),
      textPatch("paymentMethod", form.get("paymentMethod")),
      textPatch("receiptNumber", form.get("receiptNumber"))
    ].filter(Boolean);
    const reason = String(form.get("reason") ?? "").trim();
    if (reviewStatus === "REJECTED" && !reason) {
      setSubmitState({ kind: "error", message: "Extraction alanlarını reddetmeden önce bir ret gerekçesi girin." });
      return;
    }
    setSubmitState({ kind: "submitting", target: "field-reconciliation" });
    try {
      const reconciled = await apiRequest<PersistedExtractionSummary>(
        `/documents/${encodeURIComponent(state.selectedDocumentId)}/extraction/fields`,
        {
          method: "POST",
          headers: authHeaders(state.session.tokens.accessToken),
          body: JSON.stringify({ fields, reviewStatus, reason: reason || null })
        }
      );
      setState({ ...state, latestExtraction: reconciled });
      formElement.reset();
      setSubmitState({ kind: "idle" });
      await load(state.selectedWorkspaceId, state.selectedDocumentId, state.latestCorrection, state.latestTrainingExport, state.latestDatasetTraining);
    } catch (caught) {
      setSubmitState({ kind: "error", message: caught instanceof Error ? caught.message : "FIELD_RECONCILIATION_FAILED" });
    }
  }

  async function createBoundingBoxAnnotation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.kind !== "ready" || !canAnnotate || !state.selectedDocumentId) return;
    const label = bboxDraft.label.trim();
    const text = bboxDraft.text.trim();
    const engine = bboxDraft.engine.trim();
    const pageNumber = Math.trunc(bboxDraft.pageNumber);
    const bbox: [number, number, number, number] = [
      Math.round(bboxDraft.x),
      Math.round(bboxDraft.y),
      Math.round(bboxDraft.width),
      Math.round(bboxDraft.height)
    ];
    if (
      !label ||
      !text ||
      !Number.isInteger(pageNumber) ||
      pageNumber < 1 ||
      bbox.some((value) => !Number.isFinite(value) || value < 0) ||
      bbox[2] < 1 ||
      bbox[3] < 1
    ) {
      setSubmitState({ kind: "error", message: "Etiket, metin, sayfa ve negatif olmayan bbox değerleri zorunludur." });
      return;
    }
    setSubmitState({ kind: "submitting", target: "bbox-annotation" });
    try {
      const annotationTokens = selectedOcrTokens.map((token) => ({
        engine: token.engine,
        text: token.text,
        confidence: token.confidence,
        bbox: token.bbox,
        pageNumber: token.pageNumber
      }));
      const selectedPages = [...new Set(annotationTokens.map((token) => token.pageNumber))].sort((left, right) => left - right);
      const selectedConfidence = annotationTokens.length > 0 ? averageConfidence(annotationTokens) : bboxDraft.confidence;
      const selectedText = annotationTokens.length > 0 ? annotationTokens.map((token) => token.text).join(" ") : text;
      await apiRequest<AnnotationSummary>(`/documents/${encodeURIComponent(state.selectedDocumentId)}/annotations`, {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken),
        body: JSON.stringify({
          label,
          payload:
            annotationTokens.length > 1
              ? {
                  type: "ocr_multi_token_annotation",
                  engine,
                  text: selectedText,
                  pageNumbers: selectedPages,
                  bbox: selectedPages.length === 1 ? bbox : null,
                  tokens: annotationTokens,
                  confidence: Number.isFinite(selectedConfidence) ? Math.max(0, Math.min(1, selectedConfidence)) : null
                }
              : {
                  type: "ocr_bbox_annotation",
                  engine,
                  text,
                  pageNumber,
                  bbox,
                  confidence: Number.isFinite(bboxDraft.confidence) ? Math.max(0, Math.min(1, bboxDraft.confidence)) : null
                }
        })
      });
      setSubmitState({ kind: "idle" });
      await load(state.selectedWorkspaceId, state.selectedDocumentId, state.latestCorrection, state.latestTrainingExport, state.latestDatasetTraining);
    } catch (caught) {
      setSubmitState({ kind: "error", message: caught instanceof Error ? caught.message : "ANNOTATION_CREATE_FAILED" });
    }
  }

  async function createExtraction(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.kind !== "ready" || !canRunExtraction || !state.selectedDocumentId) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const text = String(form.get("text") ?? "").trim();
    if (!text) {
      setSubmitState({ kind: "error", message: "Çıkarım çalıştırmadan önce OCR metni girin." });
      return;
    }
    setSubmitState({ kind: "submitting", target: "extraction" });
    try {
      await apiRequest<PersistedExtractionSummary>(
        `/documents/${encodeURIComponent(state.selectedDocumentId)}/extraction`,
        {
          method: "POST",
          headers: authHeaders(state.session.tokens.accessToken),
          body: JSON.stringify({
            text,
            sourceEngine: form.get("sourceEngine") || "ENSEMBLE"
          })
        }
      );
      formElement.reset();
      setSubmitState({ kind: "idle" });
      await load(state.selectedWorkspaceId, state.selectedDocumentId, state.latestCorrection, state.latestTrainingExport, state.latestDatasetTraining);
    } catch (caught) {
      setSubmitState({ kind: "error", message: caught instanceof Error ? caught.message : "EXTRACTION_CREATE_FAILED" });
    }
  }

  async function completeTask(taskId: string) {
    if (state.kind !== "ready" || !canReview) return;
    setSubmitState({ kind: "submitting", target: taskId });
    try {
      await apiRequest<ReviewTaskSummary>(`/review/tasks/${encodeURIComponent(taskId)}/complete`, {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken)
      });
      setSubmitState({ kind: "idle" });
      await load(state.selectedWorkspaceId, state.selectedDocumentId, state.latestCorrection, state.latestTrainingExport, state.latestDatasetTraining);
    } catch (caught) {
      setSubmitState({ kind: "error", message: caught instanceof Error ? caught.message : "REVIEW_TASK_COMPLETE_FAILED" });
    }
  }

  async function assignTask(taskId: string, assignedToId?: string | null) {
    if (state.kind !== "ready" || !canReview) return;
    setSubmitState({ kind: "submitting", target: `assign-${taskId}` });
    try {
      await apiRequest<ReviewTaskSummary>(`/review/tasks/${encodeURIComponent(taskId)}/assign`, {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken),
        body: JSON.stringify(assignedToId === undefined ? {} : { assignedToId })
      });
      setSubmitState({ kind: "idle" });
      await load(state.selectedWorkspaceId, state.selectedDocumentId, state.latestCorrection, state.latestTrainingExport, state.latestDatasetTraining);
    } catch (caught) {
      setSubmitState({ kind: "error", message: caught instanceof Error ? caught.message : "REVIEW_TASK_ASSIGN_FAILED" });
    }
  }

  async function runSlaEscalations(dryRun: boolean) {
    if (state.kind !== "ready" || !canReview || !canManageReviewAssignments) return;
    const target = dryRun ? "sla-escalation-dry-run" : "sla-escalation-run";
    setSubmitState({ kind: "submitting", target });
    try {
      const result = await apiRequest<ReviewEscalationsRunResponse>("/review/escalations/run", {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken),
        body: JSON.stringify({
          workspaceId: state.selectedWorkspaceId,
          dryRun,
          maxActions: 8
        })
      });
      setSubmitState({ kind: "idle" });
      await load(
        state.selectedWorkspaceId,
        state.selectedDocumentId,
        state.latestCorrection,
        state.latestTrainingExport,
        state.latestDatasetTraining,
        result
      );
    } catch (caught) {
      setSubmitState({ kind: "error", message: caught instanceof Error ? caught.message : "REVIEW_ESCALATION_RUN_FAILED" });
    }
  }

  async function rejectTask(event: React.FormEvent<HTMLFormElement>, taskId: string) {
    event.preventDefault();
    if (state.kind !== "ready" || !canReview) return;
    const form = new FormData(event.currentTarget);
    const rejectionReason = String(form.get("rejectionReason") ?? "").trim();
    if (!rejectionReason) {
      setSubmitState({ kind: "error", message: "Bir ret gerekçesi girin." });
      return;
    }
    setSubmitState({ kind: "submitting", target: `reject-${taskId}` });
    try {
      await apiRequest<ReviewTaskSummary>(`/review/tasks/${encodeURIComponent(taskId)}/reject`, {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken),
        body: JSON.stringify({ rejectionReason })
      });
      setSubmitState({ kind: "idle" });
      await load(state.selectedWorkspaceId, state.selectedDocumentId, state.latestCorrection, state.latestTrainingExport, state.latestDatasetTraining);
    } catch (caught) {
      setSubmitState({ kind: "error", message: caught instanceof Error ? caught.message : "REVIEW_TASK_REJECT_FAILED" });
    }
  }

  async function assignTaskFromForm(event: React.FormEvent<HTMLFormElement>, taskId: string) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const assignedToId = String(form.get("assignedToId") ?? "");
    await assignTask(taskId, assignedToId === "__unassigned" ? null : assignedToId);
  }

  async function createTrainingDatasetExport() {
    if (state.kind !== "ready" || !canExportReports || !state.selectedWorkspaceId) return;
    setSubmitState({ kind: "submitting", target: "training-export" });
    try {
      const latestTrainingExport = await apiRequest<GeneratedReportSummary>("/reports/exports", {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken),
        body: JSON.stringify({
          workspaceId: state.selectedWorkspaceId,
          type: "dataset_export_jsonl"
        })
      });
      setSubmitState({ kind: "idle" });
      await load(state.selectedWorkspaceId, state.selectedDocumentId, state.latestCorrection, latestTrainingExport, state.latestDatasetTraining);
    } catch (caught) {
      setSubmitState({ kind: "error", message: caught instanceof Error ? caught.message : "TRAINING_DATASET_EXPORT_FAILED" });
    }
  }

  async function startTrainingFromDatasetExport(exportJobId: string) {
    if (state.kind !== "ready" || !canTrainModels || !state.selectedWorkspaceId) return;
    setSubmitState({ kind: "submitting", target: "dataset-training" });
    try {
      const latestDatasetTraining = await apiRequest<ModelTrainResultSummary>("/models/custom-ocr/train-from-dataset-export", {
        method: "POST",
        headers: authHeaders(state.session.tokens.accessToken),
        body: JSON.stringify({
          workspaceId: state.selectedWorkspaceId,
          exportJobId,
          seed: 42,
          samples: 8,
          epochs: 1
        })
      });
      setSubmitState({ kind: "idle" });
      await load(
        state.selectedWorkspaceId,
        state.selectedDocumentId,
        state.latestCorrection,
        state.latestTrainingExport,
        latestDatasetTraining
      );
    } catch (caught) {
      setSubmitState({ kind: "error", message: caught instanceof Error ? caught.message : "DATASET_EXPORT_TRAINING_FAILED" });
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
              <h2 className="text-xl font-semibold">{locale === "tr" ? "Düzeltme girişi" : "Correction entry"}</h2>
              <p className="mt-1 text-sm text-steel">{locale === "tr" ? "Düzeltmeler denetim destekli etiket verisi ve etkin öğrenme önerisi oluşturur." : "Corrections create audit-backed label data and active-learning suggestions."}</p>
            </div>
            <span className={canReview ? "text-xs font-semibold uppercase tracking-normal text-signal" : "text-xs font-semibold uppercase tracking-normal text-black/35"}>
              {canReview ? "Yetkili" : "Yetkisiz"}
            </span>
          </div>

          <div className="mt-6 grid gap-4">
            <Field label={locale === "tr" ? "Çalışma alanı" : "Workspace"}>
              <select
                className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal"
                value={state.selectedWorkspaceId}
                onChange={(event) => void load(event.target.value, undefined, state.latestCorrection, null, null)}
              >
                {state.workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Belge">
              <select
                className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal"
                value={state.selectedDocumentId}
                onChange={(event) => void load(state.selectedWorkspaceId, event.target.value, state.latestCorrection, state.latestTrainingExport, state.latestDatasetTraining)}
              >
                {state.documents.map((document) => (
                  <option key={document.id} value={document.id}>
                    {document.originalName}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {selectedDocument ? (
            <div className="mt-4 border-t border-black/10 pt-4">
              <div className="text-xs text-steel">{formatDocumentKind(selectedDocument.kind, locale)} - {selectedDocument.mimeType} - {selectedDocument.safeName}</div>
              {state.selectedDocumentUrl ? (
                <a
                  className="mt-3 inline-flex h-9 items-center border border-black/15 px-3 text-sm font-semibold text-ink hover:border-signal hover:text-signal"
                  href={state.selectedDocumentUrl.url}
                >
                  {locale === "tr" ? "Belgeyi aç" : "Open document"}
                </a>
              ) : null}
            </div>
          ) : (
            <div className="mt-4 border-t border-black/10 pt-4 text-sm text-steel">{locale === "tr" ? "Bu çalışma alanında incelenecek belge yok." : "There is no document to review in this workspace."}</div>
          )}

          <form onSubmit={createTask} className="mt-6 space-y-4 border-t border-black/10 pt-6">
            <Field label={text.reviewReasons}>
              <input
                name="reasonCodes"
                placeholder="LOW_CONFIDENCE, AMOUNT_MISMATCH"
                className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal"
              />
            </Field>
            <button
              className="h-11 w-full bg-ink text-sm font-semibold text-paper hover:bg-signal disabled:cursor-not-allowed disabled:bg-black/25"
              disabled={!canReview || !state.selectedDocumentId || submitState.kind === "submitting"}
            >
              {submitState.kind === "submitting" && submitState.target === "task" ? (locale === "tr" ? "Oluşturuluyor..." : "Creating...") : text.createTask}
            </button>
          </form>

          <form onSubmit={createCorrection} className="mt-6 space-y-4 border-t border-black/10 pt-6">
            <Field label="Alan">
              <input name="fieldName" placeholder="toplam" className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal" />
            </Field>
            <Field label={locale === "tr" ? "Önceki değer" : "Previous value"}>
              <input name="beforeValue" placeholder={locale === "tr" ? "önceki değer" : "previous value"} className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal" />
            </Field>
            <Field label={locale === "tr" ? "Yeni değer" : "New value"}>
              <input name="afterValue" required placeholder={locale === "tr" ? "sonraki değer" : "new value"} className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal" />
            </Field>
            <Field label={locale === "tr" ? "Anotasyon etiketi" : "Annotation label"}>
              <input name="annotationLabel" placeholder={locale === "tr" ? "düzeltilmiş_toplam" : "corrected_total"} className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal" />
            </Field>
            {submitState.kind === "error" ? <p className="text-sm font-medium text-red-700">{submitState.message}</p> : null}
            <button
              className="h-11 w-full bg-ink text-sm font-semibold text-paper hover:bg-signal disabled:cursor-not-allowed disabled:bg-black/25"
              disabled={!canReview || !state.selectedDocumentId || submitState.kind === "submitting"}
            >
              {submitState.kind === "submitting" && submitState.target === "correction" ? (locale === "tr" ? "Kaydediliyor..." : "Saving...") : locale === "tr" ? "Düzeltmeyi kaydet" : "Save correction"}
            </button>
          </form>

          {state.latestCorrection ? (
            <div className="mt-6 border-t border-black/10 pt-5">
              <p className="text-xs font-semibold uppercase tracking-normal text-steel">{locale === "tr" ? "Son düzeltme" : "Latest correction"}</p>
              <p className="mt-2 text-sm font-semibold">{state.latestCorrection.correction.fieldName ?? "field"} = {state.latestCorrection.correction.afterValue}</p>
              <p className="mt-1 text-xs font-semibold text-signal">
                {locale === "tr" ? "Eğitim örneği oluşturuldu" : "Training sample created"}
                {state.latestCorrection.annotation ? ` - ${state.latestCorrection.annotation.id.slice(0, 8)}` : ""}
              </p>
              <p className="mt-1 text-xs text-steel">{locale === "tr" ? "Öneri" : "Suggestion"} {state.latestCorrection.suggestion.reasonCode}</p>
            </div>
          ) : null}

          <div className="mt-6 border-t border-black/10 pt-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-normal text-steel">{locale === "tr" ? "Eğitim dışa aktarımı" : "Training export"}</p>
              <p className="mt-2 text-sm text-steel">{locale === "tr" ? "Düzeltilmiş etiket, düzeltme ve etkin öğrenme metadatasını veri kümesi JSONL olarak dışa aktarır." : "Exports corrected labels, corrections, and active-learning metadata as dataset JSONL."}</p>
              </div>
              <span className={canExportReports ? "text-xs font-semibold uppercase tracking-normal text-signal" : "text-xs font-semibold uppercase tracking-normal text-black/35"}>
                {canExportReports ? "Yetkili" : "Yetkisiz"}
              </span>
            </div>
            <button
              className="mt-4 h-10 w-full bg-ink px-3 text-sm font-semibold text-paper hover:bg-signal disabled:cursor-not-allowed disabled:bg-black/25"
              disabled={!canExportReports || !state.selectedWorkspaceId || submitState.kind === "submitting"}
              onClick={() => void createTrainingDatasetExport()}
            >
              {submitState.kind === "submitting" && submitState.target === "training-export" ? (locale === "tr" ? "Dışa aktarılıyor..." : "Exporting...") : locale === "tr" ? "Eğitim JSONL dışa aktar" : "Export training JSONL"}
            </button>
            {state.latestTrainingExport ? (
              <div className="mt-4 border border-black/10 bg-white p-3">
                <div className="text-xs font-semibold text-ink">{state.latestTrainingExport.contentType}</div>
                <div className="mt-2 text-xs text-steel">{locale === "tr" ? "Eğitim veri kümesi hazır." : "Training dataset is ready."}</div>
                <a className="mt-3 inline-flex h-8 items-center border border-black/15 px-3 text-xs font-semibold hover:border-signal hover:text-signal" href={state.latestTrainingExport.signedUrl}>
                  {locale === "tr" ? "Veri kümesini aç" : "Open dataset"}
                </a>
                <button
                  className="mt-3 h-8 w-full border border-black/15 px-3 text-xs font-semibold hover:border-signal hover:text-signal disabled:cursor-not-allowed disabled:text-black/30"
                  disabled={!canTrainModels || submitState.kind === "submitting"}
                  onClick={() => void startTrainingFromDatasetExport(state.latestTrainingExport!.exportJob.id)}
                >
                  {submitState.kind === "submitting" && submitState.target === "dataset-training" ? (locale === "tr" ? "Başlatılıyor..." : "Starting...") : locale === "tr" ? "Son dışa aktarımdan eğit" : "Train from latest export"}
                </button>
              </div>
            ) : null}
            {!state.latestTrainingExport && state.trainingExportJobs[0] ? (
              <button
                className="mt-4 h-9 w-full border border-black/15 px-3 text-xs font-semibold hover:border-signal hover:text-signal disabled:cursor-not-allowed disabled:text-black/30"
                disabled={!canTrainModels || state.trainingExportJobs[0].status !== "SUCCEEDED" || submitState.kind === "submitting"}
                onClick={() => void startTrainingFromDatasetExport(state.trainingExportJobs[0]!.id)}
              >
                {submitState.kind === "submitting" && submitState.target === "dataset-training" ? "Başlatılıyor..." : "Son dışa aktarımdan eğit"}
              </button>
            ) : null}
            {state.latestDatasetTraining ? (
              <div className="mt-4 border border-black/10 bg-white p-3">
                <div className="text-xs font-semibold text-ink">{state.latestDatasetTraining.modelVersion.name}</div>
                <div className="mt-2 text-xs text-steel">
                  {state.latestDatasetTraining.trainingRun.profile} - {state.latestDatasetTraining.trainingRun.status}
                </div>
                <div className="mt-1 break-all font-mono text-xs text-steel">
                  veri kümesi {state.latestDatasetTraining.trainingRun.datasetId ?? "yok"}
                </div>
              </div>
            ) : null}
            <div className="mt-4 space-y-2">
              {state.trainingExportJobs.slice(0, 3).map((job) => (
                <div key={job.id} className="grid grid-cols-[1fr_auto] gap-3 border-t border-black/10 pt-2 text-xs">
                  <span className="min-w-0 truncate text-steel">{locale === "tr" ? "Eğitim dışa aktarımı" : "Training export"}</span>
                  <span className={job.status === "SUCCEEDED" ? "font-semibold text-signal" : "font-semibold text-red-700"}>{formatJobStatus(job.status, locale)}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="border-y border-black/10 py-6">
          <div className="border-b border-black/10 pb-6">
            <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
              <div>
                <h2 className="text-xl font-semibold">{locale === "tr" ? "Belge çalışma alanı" : "Document workspace"}</h2>
                <p className="mt-1 text-sm text-steel">{locale === "tr" ? "Seçili belgenin metadatası, imzalı erişimi ve düzeltme geçmişi burada incelenir." : "Inspect the selected document metadata, signed access, and correction history here."}</p>
              </div>
              <span className="text-sm text-steel">{state.corrections.length} {locale === "tr" ? "düzeltme" : "corrections"}</span>
            </div>

            <details className="mt-5 border border-black/10 bg-paper p-4">
              <summary className="cursor-pointer text-sm font-semibold text-ink">
                {locale === "tr" ? "Gelişmiş belge ve etiketleme araçlarını aç" : "Open advanced document and annotation tools"}
              </summary>
            <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
              <div className="min-h-[220px] border border-black/10 bg-white p-4">
                {selectedDocument ? (
                  <div className="space-y-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-normal text-steel">Belge</p>
                      <p className="mt-2 break-all text-sm font-semibold">{selectedDocument.originalName}</p>
                    </div>
                    {state.selectedDocumentUrl?.url && selectedDocument.mimeType.startsWith("image/") && state.selectedDocumentUrl.url.startsWith("http") ? (
                      <img
                        alt={selectedDocument.originalName}
                        className="max-h-80 w-full border border-black/10 object-contain"
                        src={state.selectedDocumentUrl.url}
                      />
                    ) : (
                      <div className="grid min-h-32 place-items-center border border-dashed border-black/15 px-4 text-center text-sm text-steel">
                        {locale === "tr"
                          ? "Önizleme imzalı belge URL’sini kullanır. Yerel memory storage tarayıcıda render edilebilir URL üretmeyebilir, ancak aynı erişim kontrolü yolu korunur."
                          : "Preview uses the signed document URL. Local memory storage may not emit a browser-renderable URL, but the same access-control path is preserved."}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="grid min-h-32 place-items-center text-sm text-steel">{text.noDocument}</div>
                )}
              </div>

              <div className="border border-black/10 bg-white p-4">
                <p className="text-xs font-semibold uppercase tracking-normal text-steel">{locale === "tr" ? "Düzeltme geçmişi" : "Correction history"}</p>
                <div className="mt-3 divide-y divide-black/10">
                  {state.corrections.length === 0 ? (
                    <div className="py-8 text-sm text-steel">{locale === "tr" ? "Bu belge için kaydedilmiş düzeltme yok." : "No correction has been saved for this document."}</div>
                  ) : (
                    state.corrections.map((correction) => (
                      <div key={correction.id} className="py-3">
                        <div className="text-sm font-semibold">{correction.fieldName ?? "alan"}</div>
                        <div className="mt-1 text-xs text-steel">{correction.beforeValue ?? (locale === "tr" ? "boş" : "empty")} {"->"} {correction.afterValue}</div>
                        <div className="mt-1 text-xs font-medium text-signal">{locale === "tr" ? "Eğitim veri kümesine dahil edilir" : "Included in training dataset exports"}</div>
                        <div className="mt-1 text-xs text-steel">{new Date(correction.createdAt).toLocaleString(dateLocale)}</div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            <OcrReviewComparison jobs={state.ocrJobs} selectedDocumentUrl={state.selectedDocumentUrl} selectedDocument={selectedDocument} locale={locale} />

            <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
              <form onSubmit={createBoundingBoxAnnotation} className="border border-black/10 bg-white p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-base font-semibold">Kutu etiketleme</h3>
                    <p className="mt-1 text-sm text-steel">{locale === "tr" ? "Düzeltilmiş OCR token kutularını veri kümesi dışa aktarma ve model eğitimi incelemesi için kalıcı kaydeder." : "Persist corrected OCR token boxes for dataset export and model-training review."}</p>
                  </div>
                  <span className={canAnnotate ? "text-xs font-semibold uppercase tracking-normal text-signal" : "text-xs font-semibold uppercase tracking-normal text-black/35"}>
                    {canAnnotate ? "Yetkili" : "Yetkisiz"}
                  </span>
                </div>
                <BboxEditor
                  draft={bboxDraft}
                  disabled={!canAnnotate}
                  imageUrl={state.selectedDocumentUrl?.url ?? null}
                  mimeType={selectedDocument?.mimeType ?? null}
                  documentName={selectedDocument?.originalName ?? (locale === "tr" ? "Seçili belge" : "Selected document")}
                  tokens={selectableOcrTokens.filter((token) => token.engine === bboxDraft.engine && token.pageNumber === bboxDraft.pageNumber)}
                  selectedTokenIds={selectedTokenIds}
                  onToggleToken={toggleOcrToken}
                  onChange={(next) => setBboxDraft((current) => ({ ...current, ...next }))}
                />
                <div className="mt-4 border border-black/10 bg-paper p-3">
                  <div className="grid gap-3 md:grid-cols-[160px_1fr]">
                    <Field label={locale === "tr" ? "Token sayfası" : "Token page"}>
                      <select
                        value={bboxDraft.pageNumber}
                        onChange={(event) => setBboxDraft((current) => ({ ...current, pageNumber: numericInput(event.target.value, 1) }))}
                        className="h-10 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal"
                      >
                        {bboxPages.map((page) => (
                          <option key={page} value={page}>
                            {locale === "tr" ? "Sayfa" : "Page"} {page}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <div>
                      <p className="text-sm font-medium">{locale === "tr" ? "OCR token seçimi" : "OCR token selection"}</p>
                      <p className="mt-2 text-xs text-steel">
                        {selectedOcrTokens.length > 0
                          ? `${selectedOcrTokens.length} ${locale === "tr" ? "token" : "tokens"}, ${[...new Set(selectedOcrTokens.map((token) => token.pageNumber))].join(", ")} ${locale === "tr" ? "sayfa(lar)ında seçildi." : "selected on page(s)."}`
                          : locale === "tr"
                            ? "Çok token’lı eğitim etiketi oluşturmak için görsel kaplamadan veya token listesinden OCR kutuları seçin."
                            : "Select OCR boxes from the visual overlay or token list to create a multi-token training label."}
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {selectableOcrTokens.filter((token) => token.engine === bboxDraft.engine && token.pageNumber === bboxDraft.pageNumber).length === 0 ? (
                      <span className="text-sm text-steel">{locale === "tr" ? "Bu motor/sayfa için kalıcı OCR token’ı yok." : "There is no persisted OCR token for this engine/page."}</span>
                    ) : (
                      selectableOcrTokens
                        .filter((token) => token.engine === bboxDraft.engine && token.pageNumber === bboxDraft.pageNumber)
                        .slice(0, 120)
                        .map((token) => {
                          const selected = selectedTokenIds.includes(token.id);
                          return (
                            <button
                              key={token.id}
                              type="button"
                              onClick={() => toggleOcrToken(token.id)}
                              className={
                                selected
                                  ? "border border-signal bg-signal px-2 py-1 font-mono text-xs font-semibold text-white"
                                  : "border border-black/15 bg-white px-2 py-1 font-mono text-xs text-ink hover:border-signal"
                              }
                            >
                              {token.text}
                            </button>
                          );
                        })
                    )}
                  </div>
                  {selectedOcrTokens.length > 0 ? (
                    <button
                      type="button"
                      onClick={() => setSelectedTokenIds([])}
                      className="mt-3 h-9 border border-black/15 px-3 text-xs font-semibold hover:border-signal"
                    >
                      {locale === "tr" ? "Token seçimini temizle" : "Clear token selection"}
                    </button>
                  ) : null}
                </div>
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <Field label="Etiket">
                    <input
                      name="label"
                      value={bboxDraft.label}
                      onChange={(event) => setBboxDraft((current) => ({ ...current, label: event.target.value }))}
                      className="h-10 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal"
                    />
                  </Field>
                  <Field label="Motor">
                    <select
                      name="engine"
                      value={bboxDraft.engine}
                      onChange={(event) => {
                        setSelectedTokenIds([]);
                        setBboxDraft((current) => ({ ...current, engine: event.target.value }));
                      }}
                      className="h-10 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal"
                    >
                      <option value="TESSERACT">TESSERACT</option>
                      <option value="CUSTOM_CRNN">CUSTOM_CRNN</option>
                    </select>
                  </Field>
                  <Field label="Token metni">
                    <input
                      name="text"
                      value={bboxDraft.text}
                      onChange={(event) => setBboxDraft((current) => ({ ...current, text: event.target.value }))}
                      className="h-10 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal"
                    />
                  </Field>
                  <Field label="Sayfa">
                    <input
                      name="pageNumber"
                      type="number"
                      min={1}
                      value={bboxDraft.pageNumber}
                      onChange={(event) => setBboxDraft((current) => ({ ...current, pageNumber: numericInput(event.target.value, 1) }))}
                      className="h-10 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal"
                    />
                  </Field>
                  <Field label="X">
                    <input name="x" type="number" min={0} value={bboxDraft.x} onChange={(event) => setBboxDraft((current) => ({ ...current, x: numericInput(event.target.value, 0) }))} className="h-10 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal" />
                  </Field>
                  <Field label="Y">
                    <input name="y" type="number" min={0} value={bboxDraft.y} onChange={(event) => setBboxDraft((current) => ({ ...current, y: numericInput(event.target.value, 0) }))} className="h-10 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal" />
                  </Field>
                  <Field label={locale === "tr" ? "Genişlik" : "Width"}>
                    <input name="width" type="number" min={1} value={bboxDraft.width} onChange={(event) => setBboxDraft((current) => ({ ...current, width: numericInput(event.target.value, 1) }))} className="h-10 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal" />
                  </Field>
                  <Field label={locale === "tr" ? "Yükseklik" : "Height"}>
                    <input name="height" type="number" min={1} value={bboxDraft.height} onChange={(event) => setBboxDraft((current) => ({ ...current, height: numericInput(event.target.value, 1) }))} className="h-10 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal" />
                  </Field>
                  <Field label={locale === "tr" ? "Güven" : "Confidence"}>
                    <input
                      name="confidence"
                      type="number"
                      min={0}
                      max={1}
                      step="0.01"
                      value={bboxDraft.confidence}
                      onChange={(event) => setBboxDraft((current) => ({ ...current, confidence: clamp(numericInput(event.target.value, 1), 0, 1) }))}
                      className="h-10 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal"
                    />
                  </Field>
                </div>
                <button
                  className="mt-4 h-11 w-full bg-ink text-sm font-semibold text-paper hover:bg-signal disabled:cursor-not-allowed disabled:bg-black/25"
                  disabled={!canAnnotate || !state.selectedDocumentId || submitState.kind === "submitting"}
                >
                  {submitState.kind === "submitting" && submitState.target === "bbox-annotation" ? "Kaydediliyor..." : "Kutu etiketlemesini kaydet"}
                </button>
              </form>

              <div className="border border-black/10 bg-white p-4">
                <div className="flex items-center justify-between gap-4">
                  <h3 className="text-base font-semibold">{locale === "tr" ? "Anotasyon kayıtları" : "Annotation records"}</h3>
                  <span className="text-xs text-steel">{state.annotations.length}</span>
                </div>
                <div className="mt-3 divide-y divide-black/10">
                  {state.annotations.length === 0 ? (
                    <div className="py-8 text-sm text-steel">{locale === "tr" ? "Bu belge için doğrudan etiket kaydı yok." : "There is no direct label record for this document."}</div>
                  ) : (
                    state.annotations.slice(0, 8).map((annotation) => (
                      <div key={annotation.id} className="py-3">
                        <div className="text-sm font-semibold">{annotation.label}</div>
                        <div className="mt-1 text-xs text-steel">{summarizeAnnotationPayload(annotation.payload, locale)}</div>
                        <div className="mt-1 text-xs text-steel">{new Date(annotation.createdAt).toLocaleString(dateLocale)}</div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
              <form onSubmit={createExtraction} className="border border-black/10 bg-white p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-base font-semibold">{locale === "tr" ? "Yapılandırılmış extraction" : "Structured extraction"}</h3>
                    <p className="mt-1 text-sm text-steel">{locale === "tr" ? "Seçili belge için OCR metnini yerel deterministik parser ile işler." : "Process the selected document's OCR text with a local deterministic parser."}</p>
                  </div>
                  <span className={canRunExtraction ? "text-xs font-semibold uppercase tracking-normal text-signal" : "text-xs font-semibold uppercase tracking-normal text-black/35"}>
                    {canRunExtraction ? "Yetkili" : "Yetkisiz"}
                  </span>
                </div>
                <div className="mt-4 grid gap-4">
                  <Field label={locale === "tr" ? "Çıkarım motoru" : "Extraction engine"}>
                    <select
                      name="sourceEngine"
                      className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal"
                      defaultValue="ENSEMBLE"
                    >
                      <option value="ENSEMBLE">ENSEMBLE</option>
                      <option value="TESSERACT">TESSERACT</option>
                      <option value="CUSTOM_CRNN">CUSTOM_CRNN</option>
                    </select>
                  </Field>
                  <Field label={locale === "tr" ? "Çıkarım için OCR metni" : "OCR text for extraction"}>
                    <textarea
                      name="text"
                      rows={7}
                      placeholder={"MAVI MARKET\nTARIH: 12.05.2026\nTOPLAM 72,05 TL"}
                      className="w-full resize-y border border-black/15 bg-white px-3 py-2 font-mono text-sm outline-none focus:border-signal"
                    />
                  </Field>
                </div>
                <button
                  className="mt-4 h-11 w-full bg-ink text-sm font-semibold text-paper hover:bg-signal disabled:cursor-not-allowed disabled:bg-black/25"
                  disabled={!canRunExtraction || !state.selectedDocumentId || submitState.kind === "submitting"}
                >
                  {submitState.kind === "submitting" && submitState.target === "extraction" ? (locale === "tr" ? "Çıkarılıyor..." : "Extracting...") : locale === "tr" ? "Çıkarım çalıştır" : "Run extraction"}
                </button>
              </form>

              <div className="border border-black/10 bg-white p-4">
                <div className="flex items-center justify-between gap-4">
                  <h3 className="text-base font-semibold">Son extraction</h3>
                  <span className="text-xs text-steel">{state.latestExtraction ? formatJobStatus(state.latestExtraction.job.status, locale) : locale === "tr" ? "Yok" : "None"}</span>
                </div>
                {submitState.kind === "error" ? <p className="mt-3 text-sm font-medium text-red-700">{submitState.message}</p> : null}
                {state.latestExtraction ? (
                  <div className="mt-4 space-y-4">
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <ExtractionValue label={locale === "tr" ? "Satıcı" : "Merchant"} value={state.latestExtraction.extracted.merchantName ?? (locale === "tr" ? "eksik" : "missing")} />
                      <ExtractionValue label={locale === "tr" ? "Tarih" : "Date"} value={state.latestExtraction.extracted.date ?? (locale === "tr" ? "eksik" : "missing")} />
                      <ExtractionValue label={locale === "tr" ? "Toplam" : "Total"} value={state.latestExtraction.extracted.total ? formatMoney(state.latestExtraction.extracted.total) : locale === "tr" ? "eksik" : "missing"} />
                      <ExtractionValue label={locale === "tr" ? "KDV" : "VAT"} value={state.latestExtraction.extracted.taxTotal ? formatMoney(state.latestExtraction.extracted.taxTotal) : locale === "tr" ? "eksik" : "missing"} />
                      <ExtractionValue label={locale === "tr" ? "Ödeme" : "Payment"} value={state.latestExtraction.extracted.paymentMethod ?? (locale === "tr" ? "eksik" : "missing")} />
                      <ExtractionValue label={locale === "tr" ? "Fiş no" : "Receipt no"} value={state.latestExtraction.extracted.receiptNumber ?? (locale === "tr" ? "eksik" : "missing")} />
                    </div>
                    <div className="border-t border-black/10 pt-4">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-xs font-semibold uppercase tracking-normal text-steel">{locale === "tr" ? "Alan incelemesi" : "Field review"}</p>
                        <span data-testid="extraction-review-state" className="text-xs font-semibold uppercase tracking-normal text-steel">
                          {formatReviewStatus(state.latestExtraction.reviewState?.status ?? "NEEDS_REVIEW", locale)}
                        </span>
                      </div>
                      <form id="extraction-field-review-form" onSubmit={reconcileExtractionFields} className="mt-3 grid gap-2 sm:grid-cols-2">
                          <input
                            name="merchantName"
                            defaultValue={state.latestExtraction.extracted.merchantName ?? ""}
                            aria-label={locale === "tr" ? "İncelenen satıcı" : "Reviewed merchant"}
                          className="h-9 border border-black/15 bg-white px-2 text-xs outline-none focus:border-signal"
                        />
                        <input
                          name="date"
                          defaultValue={state.latestExtraction.extracted.date ?? ""}
                            aria-label={locale === "tr" ? "İncelenen tarih" : "Reviewed date"}
                          className="h-9 border border-black/15 bg-white px-2 text-xs outline-none focus:border-signal"
                        />
                        <input
                          name="totalMinor"
                          defaultValue={state.latestExtraction.extracted.total?.amountMinor ?? ""}
                            aria-label={locale === "tr" ? "İncelenen toplam küçük birim" : "Reviewed total minor units"}
                          pattern="-?\\d*"
                          className="h-9 border border-black/15 bg-white px-2 font-mono text-xs outline-none focus:border-signal"
                        />
                        <input
                          name="taxMinor"
                          defaultValue={state.latestExtraction.extracted.taxTotal?.amountMinor ?? ""}
                            aria-label={locale === "tr" ? "İncelenen KDV küçük birim" : "Reviewed VAT minor units"}
                          pattern="-?\\d*"
                          className="h-9 border border-black/15 bg-white px-2 font-mono text-xs outline-none focus:border-signal"
                        />
                        <input
                          name="paymentMethod"
                          defaultValue={state.latestExtraction.extracted.paymentMethod ?? ""}
                            aria-label={locale === "tr" ? "İncelenen ödeme yöntemi" : "Reviewed payment method"}
                          className="h-9 border border-black/15 bg-white px-2 text-xs outline-none focus:border-signal"
                        />
                        <input
                          name="receiptNumber"
                          defaultValue={state.latestExtraction.extracted.receiptNumber ?? ""}
                            aria-label={locale === "tr" ? "İncelenen fiş numarası" : "Reviewed receipt number"}
                          className="h-9 border border-black/15 bg-white px-2 text-xs outline-none focus:border-signal"
                        />
                        <select
                          name="reviewStatus"
                          defaultValue="APPROVED"
                          aria-label={locale === "tr" ? "Çıkarım inceleme durumu" : "Extraction review status"}
                          className="h-9 border border-black/15 bg-white px-2 text-xs outline-none focus:border-signal"
                        >
                          <option value="APPROVED">{locale === "tr" ? "Onaylandı" : "Approved"}</option>
                          <option value="NEEDS_REVIEW">{locale === "tr" ? "İnceleme gerekiyor" : "Needs review"}</option>
                          <option value="REJECTED">{locale === "tr" ? "Reddedildi" : "Rejected"}</option>
                        </select>
                        <input
                          name="reason"
                          aria-label={locale === "tr" ? "Çıkarım inceleme gerekçesi" : "Extraction review reason"}
                          placeholder={locale === "tr" ? "Ret gerekçesi" : "Rejection reason"}
                          className="h-9 border border-black/15 bg-white px-2 text-xs outline-none focus:border-signal"
                        />
                        <button
                          type="submit"
                          form="extraction-field-review-form"
                          onClick={(event) => {
                            event.preventDefault();
                            const form = event.currentTarget.form;
                            if (form) void submitExtractionFieldReviewForm(form);
                          }}
                          className="h-9 border border-black/15 px-3 text-xs font-semibold text-ink hover:border-signal hover:text-signal disabled:cursor-not-allowed disabled:text-black/35 sm:col-span-2"
                          disabled={!canReview || submitState.kind === "submitting"}
                        >
                          {submitState.kind === "submitting" && submitState.target === "field-reconciliation" ? (locale === "tr" ? "İnceleme kaydediliyor..." : "Saving review...") : (locale === "tr" ? "Alan incelemesini kaydet" : "Save field review")}
                        </button>
                      </form>
                    </div>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-normal text-steel">{locale === "tr" ? "Doğrulama sorunları" : "Validation issues"}</p>
                      <div className="mt-2 divide-y divide-black/10">
                        {state.latestExtraction.issues.length === 0 ? (
                          <div className="py-2 text-sm text-signal">{locale === "tr" ? "Doğrulama sorunu yok." : "No validation issues."}</div>
                        ) : (
                          state.latestExtraction.issues.map((issue) => (
                            <div key={`${issue.code}-${issue.message}`} className="py-2">
                              <div className="text-sm font-semibold">{issue.code}</div>
                              <div className="text-xs text-steel">{formatSeverity(issue.severity, locale)} - {issue.message}</div>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-normal text-steel">{locale === "tr" ? "Satır kalemleri" : "Line items"}</p>
                      <div className="mt-2 divide-y divide-black/10">
                        {state.latestExtraction.extracted.lineItems.length === 0 ? (
                          <div className="py-2 text-sm text-steel">{locale === "tr" ? "Satır kalemi çıkarılamadı." : "No line item could be extracted."}</div>
                        ) : (
                          state.latestExtraction.extracted.lineItems.map((item, index) => (
                            <div key={`${item.name}-${index}`} className="py-3">
                              <div className="flex items-center justify-between gap-3 text-sm">
                                <span className="min-w-0 truncate">{item.name}</span>
                                <span className="font-semibold">{formatMoney(item.total)}</span>
                              </div>
                              <form onSubmit={(event) => void createLineItemCorrection(event, index)} className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_90px_110px_auto]">
                                <input
                                  name="name"
                                  defaultValue={item.name}
                                  aria-label={locale === "tr" ? `Satır kalemi ${index + 1} adı` : `Line item ${index + 1} name`}
                                  className="h-9 min-w-0 border border-black/15 bg-white px-2 text-xs outline-none focus:border-signal"
                                />
                                <input
                                  name="quantity"
                                  defaultValue={item.quantity ?? ""}
                                  aria-label={locale === "tr" ? `Satır kalemi ${index + 1} miktarı` : `Line item ${index + 1} quantity`}
                                  className="h-9 border border-black/15 bg-white px-2 text-xs outline-none focus:border-signal"
                                />
                                <input
                                  name="amountMinor"
                                  defaultValue={item.total.amountMinor}
                                  aria-label={locale === "tr" ? `Satır kalemi ${index + 1} toplam küçük birimi` : `Line item ${index + 1} total minor units`}
                                  pattern="-?\\d+"
                                  className="h-9 border border-black/15 bg-white px-2 font-mono text-xs outline-none focus:border-signal"
                                />
                                <button
                                  className="h-9 border border-black/15 px-3 text-xs font-semibold text-ink hover:border-signal hover:text-signal disabled:cursor-not-allowed disabled:text-black/35"
                                  disabled={!canReview || submitState.kind === "submitting"}
                                >
                                  {submitState.kind === "submitting" && submitState.target === `line-item-${index}` ? (locale === "tr" ? "Kaydediliyor..." : "Saving...") : locale === "tr" ? "Kaydet" : "Save"}
                                </button>
                              </form>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="mt-8 text-sm text-steel">{locale === "tr" ? "Bu belge için yapılandırılmış extraction kaydedilmemiş." : "No structured extraction has been saved for this document."}</div>
                )}
              </div>
            </div>
            </details>
          </div>

          <div className="flex flex-col gap-4 border-b border-black/10 pb-5 md:flex-row md:items-end md:justify-between">
            <div>
              <h2 className="text-xl font-semibold">Kuyruk</h2>
              <p className="mt-1 text-sm text-steel">{locale === "tr" ? "İnceleme görevleri ve etkin öğrenme önerileri çalışma alanı bazında kalıcı tutulur." : "Review tasks and active-learning suggestions are stored persistently per workspace."}</p>
            </div>
            <span className="text-sm text-steel">{state.reviewTasks.length} {locale === "tr" ? "görev" : "tasks"}</span>
          </div>

          {state.workload ? (
            <div className="mt-5 border-b border-black/10 pb-5">
              <div className="grid gap-3 md:grid-cols-4">
                <ReviewMetric label="Kuyrukta" value={String(state.workload.totals.queued)} />
                <ReviewMetric label={locale === "tr" ? "Çalışıyor" : "Running"} value={String(state.workload.totals.running)} />
                <ReviewMetric label={locale === "tr" ? "Geciken" : "Overdue"} value={String(state.workload.totals.overdue)} />
                <ReviewMetric label={locale === "tr" ? "24 saatte dolacak" : "Due within 24h"} value={String(state.workload.totals.dueSoon)} />
              </div>
              <div className="mt-4 grid gap-3 lg:grid-cols-3">
                {state.workload.reviewers.slice(0, 6).map((summary) => (
                  <div key={summary.reviewer.id} className="border border-black/10 bg-white p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold">{summary.reviewer.displayName}</div>
                        <div className="mt-1 truncate text-xs text-steel">{summary.reviewer.email}</div>
                      </div>
                      <span className="font-mono text-xs text-steel">{summary.workloadScore}</span>
                    </div>
                    <div className="mt-3 grid grid-cols-4 gap-2 text-xs">
                      <span>K {summary.queued}</span>
                      <span>Ç {summary.running}</span>
                      <span className={summary.overdue > 0 ? "font-semibold text-red-700" : "text-steel"}>O {summary.overdue}</span>
                      <span className={summary.dueSoon > 0 ? "font-semibold text-amber-700" : "text-steel"}>24h {summary.dueSoon}</span>
                    </div>
                    <div className="mt-2 text-xs text-steel">{locale === "tr" ? "En eski açık" : "Oldest queued"} {formatAgeMinutes(summary.oldestQueuedAgeMinutes, locale)}</div>
                  </div>
                ))}
                <div className="border border-dashed border-black/15 bg-paper p-3">
                  <div className="text-sm font-semibold">{locale === "tr" ? "Atanmamış" : "Unassigned"}</div>
                  <div className="mt-3 grid grid-cols-4 gap-2 text-xs">
                    <span>K {state.workload.unassigned.queued}</span>
                    <span>{locale === "tr" ? "Ç" : "R"} {state.workload.unassigned.running}</span>
                    <span className={state.workload.unassigned.overdue > 0 ? "font-semibold text-red-700" : "text-steel"}>
                      O {state.workload.unassigned.overdue}
                    </span>
                    <span className={state.workload.unassigned.dueSoon > 0 ? "font-semibold text-amber-700" : "text-steel"}>
                      24h {state.workload.unassigned.dueSoon}
                    </span>
                  </div>
                    <div className="mt-2 text-xs text-steel">{locale === "tr" ? "En eski açık" : "Oldest queued"} {formatAgeMinutes(state.workload.unassigned.oldestQueuedAgeMinutes, locale)}</div>
                </div>
              </div>
            </div>
          ) : null}

          {state.rebalanceSuggestions.length > 0 ? (
            <div className="mt-5 border-b border-black/10 pb-5">
              <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
                <div>
                  <h3 className="text-base font-semibold">SLA yeniden dengeleme</h3>
                  <p className="mt-1 text-sm text-steel">{locale === "tr" ? "Önerilen kuyruk hareketleri kalıcı görev vade tarihleri ve inceleyici yükünden hesaplanır." : "Recommended queue moves are calculated from persistent task due dates and reviewer load."}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-steel">{state.rebalanceSuggestions.length} öneri</span>
                  <button
                    type="button"
                    className="h-9 border border-black/15 px-3 text-xs font-semibold hover:border-signal hover:text-signal disabled:cursor-not-allowed disabled:text-black/30"
                    disabled={!canManageReviewAssignments || submitState.kind === "submitting"}
                    onClick={() => void runSlaEscalations(true)}
                  >
                    {submitState.kind === "submitting" && submitState.target === "sla-escalation-dry-run" ? (locale === "tr" ? "Planlanıyor..." : "Planning...") : locale === "tr" ? "Escalation planla" : "Plan escalation"}
                  </button>
                  <button
                    type="button"
                    className="h-9 bg-ink px-3 text-xs font-semibold text-paper hover:bg-signal disabled:cursor-not-allowed disabled:bg-black/25"
                    disabled={!canManageReviewAssignments || submitState.kind === "submitting"}
                    onClick={() => void runSlaEscalations(false)}
                  >
                    {submitState.kind === "submitting" && submitState.target === "sla-escalation-run" ? (locale === "tr" ? "Escalation çalışıyor..." : "Running escalation...") : locale === "tr" ? "Escalation çalıştır" : "Run escalation"}
                  </button>
                </div>
              </div>
              {state.latestEscalationRun ? (
                <div className="mt-3 border border-black/10 bg-paper p-3 text-xs text-steel">
                  <span className="font-semibold text-ink">
                    {state.latestEscalationRun.dryRun ? (locale === "tr" ? "Planlandı" : "Planned") : (locale === "tr" ? "Uygulandı" : "Applied")} {state.latestEscalationRun.dryRun ? state.latestEscalationRun.planned.length : state.latestEscalationRun.applied.length} {locale === "tr" ? "escalation aksiyonu." : "escalation action(s)."}
                  </span>{" "}
                  {state.latestEscalationRun.applied.length > 0
                    ? `Son atama hedefi: ${state.latestEscalationRun.applied[0]?.targetReviewer.displayName ?? "yok"}`
                    : locale === "tr" ? "Kalıcı değişiklik yapılmadı." : "No persistent change was made."}
                </div>
              ) : null}
              <div className="mt-4 divide-y divide-black/10 border border-black/10 bg-white">
                {state.rebalanceSuggestions.slice(0, 4).map((suggestion) => (
                  <div key={`${suggestion.task.id}-${suggestion.reasonCode}`} className="grid gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_170px_140px] lg:items-center">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold">{suggestion.document.originalName}</div>
                      <div className="mt-1 text-xs text-steel">
                        {rebalanceReasonLabel(suggestion.reasonCode, locale)} - {suggestion.task.reasonCodes.join(", ")}
                      </div>
                      <div className="mt-1 text-xs text-steel">
                        {suggestion.currentAssigneeId
                          ? `${reviewerLabel(state.reviewers, suggestion.currentAssigneeId, locale)} ${locale === "tr" ? "kişisinden taşı" : "move from"}`
                          : locale === "tr" ? "Sahipsiz görevi ata" : "Assign unowned task"}{" "}
                        hedef {suggestion.targetReviewer.displayName}
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs text-steel">
                      <span>{locale === "tr" ? "Yaş" : "Age"} {formatAgeMinutes(suggestion.ageMinutes, locale)}</span>
                      <span>{formatSlaWindow(suggestion, locale)}</span>
                      <span>Hedef skor {suggestion.targetWorkloadScore}</span>
                      <span>
                        Mevcut {suggestion.currentAssigneeWorkloadScore === null ? "yok" : suggestion.currentAssigneeWorkloadScore}
                      </span>
                    </div>
                    <button
                      className="h-9 border border-black/15 px-3 text-xs font-semibold hover:border-signal hover:text-signal disabled:cursor-not-allowed disabled:text-black/30"
                      disabled={!canManageReviewAssignments || suggestion.task.status !== "QUEUED" || submitState.kind === "submitting"}
                      onClick={() => void assignTask(suggestion.task.id, suggestion.targetReviewer.id)}
                    >
                      {submitState.kind === "submitting" && submitState.target === `assign-${suggestion.task.id}`
                        ? (locale === "tr" ? "Atanıyor..." : "Assigning...")
                        : suggestion.action === "REASSIGN"
                          ? "Yeniden ata"
                          : "Ata"}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {!canReview ? (
            <div className="py-12 text-sm text-steel">{locale === "tr" ? "Bu hesap OCR çıktısını inceleme yetkisine sahip değil." : "This account cannot review OCR output."}</div>
          ) : (
            <div className="divide-y divide-black/10">
              {state.reviewTasks.length === 0 ? (
                <div className="py-12 text-sm text-steel">{locale === "tr" ? "Bu çalışma alanında inceleme görevi kuyruğu boş." : "The review task queue is empty for this workspace."}</div>
              ) : (
                state.reviewTasks.map(({ task, document }) => (
                  <div key={task.id} className="grid gap-3 py-5 lg:grid-cols-[minmax(0,1fr)_120px_160px_120px_minmax(220px,300px)]">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold">{document.originalName}</div>
                      <div className="mt-1 text-xs text-steel">{task.reasonCodes.join(", ")}</div>
                      <div className="mt-1 break-all text-xs text-steel">
                        {task.assignedToId ? `${locale === "tr" ? "Atanan" : "Assigned to"} ${reviewerLabel(state.reviewers, task.assignedToId, locale)}` : locale === "tr" ? "Atanmamış" : "Unassigned"}
                      </div>
                    </div>
                    <div className={task.status === "SUCCEEDED" ? "text-sm font-semibold text-signal" : "text-sm font-semibold text-ink"}>{formatJobStatus(task.status, locale)}</div>
                    {canManageReviewAssignments ? (
                      <form onSubmit={(event) => void assignTaskFromForm(event, task.id)} className="grid gap-2">
                        <select
                          name="assignedToId"
                          defaultValue={task.assignedToId ?? "__unassigned"}
                          className="h-9 w-full border border-black/15 bg-white px-2 text-xs outline-none focus:border-signal"
                          disabled={task.status !== "QUEUED" || submitState.kind === "submitting"}
                        >
                          <option value="__unassigned">{locale === "tr" ? "Atanmamış" : "Unassigned"}</option>
                          {state.reviewers.map((reviewer) => (
                            <option key={reviewer.id} value={reviewer.id}>
                              {reviewer.displayName}
                            </option>
                          ))}
                        </select>
                        <button
                          className="h-9 border border-black/15 px-3 text-xs font-semibold hover:border-signal hover:text-signal disabled:cursor-not-allowed disabled:text-black/30"
                          disabled={task.status !== "QUEUED" || submitState.kind === "submitting"}
                        >
                          {submitState.kind === "submitting" && submitState.target === `assign-${task.id}` ? (locale === "tr" ? "Atanıyor..." : "Assigning...") : locale === "tr" ? "Ata" : "Assign"}
                        </button>
                      </form>
                    ) : (
                      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
                        <button
                          className="h-9 border border-black/15 px-3 text-xs font-semibold hover:border-signal hover:text-signal disabled:cursor-not-allowed disabled:text-black/30"
                          disabled={task.status !== "QUEUED" || task.assignedToId === state.principal.userId || submitState.kind === "submitting"}
                          onClick={() => void assignTask(task.id)}
                        >
                          {submitState.kind === "submitting" && submitState.target === `assign-${task.id}` ? (locale === "tr" ? "Atanıyor..." : "Assigning...") : locale === "tr" ? "Bana ata" : "Assign to me"}
                        </button>
                        <button
                          className="h-9 border border-black/15 px-3 text-xs font-semibold hover:border-signal hover:text-signal disabled:cursor-not-allowed disabled:text-black/30"
                          disabled={task.status !== "QUEUED" || !task.assignedToId || submitState.kind === "submitting"}
                          onClick={() => void assignTask(task.id, null)}
                        >
                        {locale === "tr" ? "Atamayı kaldır" : "Remove assignment"}
                        </button>
                      </div>
                    )}
                    <button
                      className="h-9 border border-black/15 px-3 text-sm font-semibold hover:border-signal hover:text-signal disabled:cursor-not-allowed disabled:text-black/30"
                      disabled={task.status !== "QUEUED" || submitState.kind === "submitting"}
                      onClick={() => void completeTask(task.id)}
                    >
                      {locale === "tr" ? "OCR’ı onayla" : "Approve OCR"}
                    </button>
                    <form onSubmit={(event) => void rejectTask(event, task.id)} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_80px]">
                      <input
                        name="rejectionReason"
                        aria-label={locale === "tr" ? "Ret gerekçesi" : "Rejection reason"}
                        placeholder={locale === "tr" ? "Gerekçe" : "Reason"}
                        className="h-9 min-w-0 border border-black/15 bg-white px-2 text-xs outline-none focus:border-signal"
                        disabled={task.status !== "QUEUED" || submitState.kind === "submitting"}
                      />
                      <button
                        className="h-9 border border-black/15 px-3 text-xs font-semibold text-ink hover:border-red-700 hover:text-red-700 disabled:cursor-not-allowed disabled:text-black/30"
                        disabled={task.status !== "QUEUED" || submitState.kind === "submitting"}
                      >
                        {submitState.kind === "submitting" && submitState.target === `reject-${task.id}` ? "Reddediliyor..." : "Reddet"}
                      </button>
                    </form>
                  </div>
                ))
              )}
            </div>
          )}

          <div className="mt-8 border-t border-black/10 pt-6">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold">{locale === "tr" ? "Etkin öğrenme" : "Active learning"}</h2>
              <span className={canAnnotate ? "text-xs font-semibold uppercase tracking-normal text-signal" : "text-xs font-semibold uppercase tracking-normal text-black/35"}>
                {canAnnotate ? "Yetkili" : "Yetkisiz"}
              </span>
            </div>
            <div className="mt-5 divide-y divide-black/10">
              {state.suggestions.length === 0 ? (
                <div className="py-8 text-sm text-steel">{locale === "tr" ? "Kullanılabilir öneri yok." : "No suggestion is available."}</div>
              ) : (
                state.suggestions.map((suggestion) => (
                  <div key={suggestion.id} className="grid gap-3 py-4 md:grid-cols-[180px_1fr_80px]">
                    <div className="text-sm font-semibold">{suggestion.reasonCode}</div>
                    <div className="break-all font-mono text-xs text-steel">{suggestion.documentFileId}</div>
                    <div className="text-sm text-steel">{suggestion.score}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>
      </div>
    </Shell>
  );
}

type BboxEditorProps = {
  draft: BboxDraft;
  disabled: boolean;
  imageUrl: string | null;
  mimeType: string | null;
  documentName: string;
  tokens: SelectableOcrToken[];
  selectedTokenIds: string[];
  onToggleToken: (tokenId: string) => void;
  onChange: (next: Partial<BboxDraft>) => void;
};

type BboxInteraction = {
  mode: "move" | "resize-nw" | "resize-ne" | "resize-sw" | "resize-se";
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startDraft: Pick<BboxDraft, "x" | "y" | "width" | "height">;
  imageWidth: number;
  imageHeight: number;
  renderedWidth: number;
  renderedHeight: number;
};

function BboxEditor({
  draft,
  disabled,
  imageUrl,
  mimeType,
  documentName,
  tokens,
  selectedTokenIds,
  onToggleToken,
  onChange
}: BboxEditorProps) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const [interaction, setInteraction] = useState<BboxInteraction | null>(null);
  const canRenderImage = Boolean(imageUrl?.startsWith("http") && mimeType?.startsWith("image/"));
  const imageWidth = imageSize?.width ?? Math.max(draft.x + draft.width, 1);
  const imageHeight = imageSize?.height ?? Math.max(draft.y + draft.height, 1);
  const visibleBox = fitBboxToBounds(draft, imageWidth, imageHeight);

  function placeBox(event: React.PointerEvent<HTMLDivElement>) {
    if (disabled || !imageSize || !imageRef.current || event.target !== event.currentTarget) return;
    const rect = imageRef.current.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / Math.max(rect.width, 1)) * imageSize.width;
    const y = ((event.clientY - rect.top) / Math.max(rect.height, 1)) * imageSize.height;
    onChange({
      x: Math.round(clamp(x - draft.width / 2, 0, Math.max(0, imageSize.width - draft.width))),
      y: Math.round(clamp(y - draft.height / 2, 0, Math.max(0, imageSize.height - draft.height)))
    });
  }

  function startInteraction(mode: BboxInteraction["mode"], event: React.PointerEvent<HTMLDivElement>) {
    if (disabled || !imageSize || !imageRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = imageRef.current.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setInteraction({
      mode,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startDraft: fitBboxToBounds(draft, imageSize.width, imageSize.height),
      imageWidth: imageSize.width,
      imageHeight: imageSize.height,
      renderedWidth: rect.width,
      renderedHeight: rect.height
    });
  }

  function updateInteraction(event: React.PointerEvent<HTMLDivElement>) {
    if (!interaction || event.pointerId !== interaction.pointerId) return;
    event.preventDefault();
    const dx = ((event.clientX - interaction.startClientX) / Math.max(interaction.renderedWidth, 1)) * interaction.imageWidth;
    const dy = ((event.clientY - interaction.startClientY) / Math.max(interaction.renderedHeight, 1)) * interaction.imageHeight;
    onChange(nextBboxForInteraction(interaction, dx, dy));
  }

  function endInteraction(event: React.PointerEvent<HTMLDivElement>) {
    if (!interaction || event.pointerId !== interaction.pointerId) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setInteraction(null);
  }

  return (
    <div className="mt-4 border border-black/10 bg-paper p-3">
      {canRenderImage ? (
        <div className="flex min-h-64 items-center justify-center border border-black/10 bg-white">
          <div className="relative inline-block max-w-full touch-none select-none">
            <img
              ref={imageRef}
              alt={documentName}
              className="max-h-[420px] max-w-full object-contain"
              src={imageUrl ?? undefined}
              onLoad={(event) => {
                const image = event.currentTarget;
                setImageSize({ width: Math.max(image.naturalWidth, 1), height: Math.max(image.naturalHeight, 1) });
              }}
            />
            <div className="absolute inset-0 cursor-crosshair" onPointerDown={placeBox}>
              {tokens.slice(0, 120).map((token) => {
                const selected = selectedTokenIds.includes(token.id);
                const [left, top, boxWidth, boxHeight] = token.bbox;
                return (
                  <button
                    key={token.id}
                    type="button"
                    aria-pressed={selected}
                    disabled={disabled}
                    className={
                      selected
                        ? "absolute z-10 border-2 border-signal bg-signal/25"
                        : "absolute z-10 border border-amber-600/80 bg-white/10 hover:border-signal hover:bg-signal/15"
                    }
                    style={{
                      left: `${(left / imageWidth) * 100}%`,
                      top: `${(top / imageHeight) * 100}%`,
                      width: `${(boxWidth / imageWidth) * 100}%`,
                      height: `${(boxHeight / imageHeight) * 100}%`
                    }}
                    title={`${token.text} (${Math.round(token.confidence * 100)}%)`}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onToggleToken(token.id);
                    }}
                  />
                );
              })}
              <div
                className="absolute z-20 border-2 border-signal bg-signal/10 shadow-[0_0_0_9999px_rgba(17,24,39,0.08)]"
                style={{
                  left: `${(visibleBox.x / imageWidth) * 100}%`,
                  top: `${(visibleBox.y / imageHeight) * 100}%`,
                  width: `${(visibleBox.width / imageWidth) * 100}%`,
                  height: `${(visibleBox.height / imageHeight) * 100}%`
                }}
                onPointerDown={(event) => startInteraction("move", event)}
                onPointerMove={updateInteraction}
                onPointerUp={endInteraction}
                onPointerCancel={endInteraction}
              >
                {(["resize-nw", "resize-ne", "resize-sw", "resize-se"] as const).map((mode) => (
                  <div
                    key={mode}
                    className={`absolute h-3 w-3 border border-white bg-signal ${handlePositionClass(mode)} ${handleCursorClass(mode)}`}
                    onPointerDown={(event) => startInteraction(mode, event)}
                    onPointerMove={updateInteraction}
                    onPointerUp={endInteraction}
                    onPointerCancel={endInteraction}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid min-h-40 place-items-center border border-dashed border-black/15 px-4 text-center text-sm text-steel">
          Görsel bbox editörü, imzalı belge URL’si görsel olarak render edilebildiğinde kullanılabilir.
        </div>
      )}
      <div className="mt-3 grid grid-cols-4 gap-2 font-mono text-xs text-steel">
        <span>x={Math.round(draft.x)}</span>
        <span>y={Math.round(draft.y)}</span>
        <span>w={Math.round(draft.width)}</span>
        <span>h={Math.round(draft.height)}</span>
      </div>
    </div>
  );
}

function OcrReviewComparison({
  jobs,
  selectedDocumentUrl,
  selectedDocument,
  locale
}: {
  jobs: OcrJobsResponse["jobs"];
  selectedDocumentUrl: DocumentDownloadUrlSummary | null;
  selectedDocument: DocumentSummary | null;
  locale: "tr" | "en";
}) {
  const dateLocale = locale === "tr" ? "tr-TR" : "en-US";
  const runs = latestOcrRunsByEngine(jobs);
  const candidateRuns = runs.filter((run) => run.engine !== "ENSEMBLE");
  const ensembleRun = runs.find((run) => run.engine === "ENSEMBLE") ?? null;
  const ensemble = ensembleRun ? normalizedRecord(ensembleRun.normalizedJson) : null;
  const overlayRun =
    candidateRuns.find((run) => run.engine === ensemble?.selectedEngine && ocrOverlayTokens(run).length > 0) ??
    candidateRuns.find((run) => ocrOverlayTokens(run).length > 0) ??
    null;
  const overlayTokens = overlayRun ? ocrOverlayTokens(overlayRun) : [];
  return (
    <div className="mt-6 border border-black/10 bg-white p-4">
      <div className="flex flex-col gap-4 border-b border-black/10 pb-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h3 className="text-base font-semibold">{locale === "tr" ? "OCR inceleme karşılaştırması" : "OCR review comparison"}</h3>
          <p className="mt-1 text-sm text-steel">{locale === "tr" ? "Kalıcı OCR motor çıktısı, düzeltme incelemesi için seçili belgenin yanında gösterilir." : "Persisted OCR engine output is shown next to the selected document for correction review."}</p>
        </div>
        <span className="text-sm text-steel">{runs.length} {locale === "tr" ? "çalışma" : "runs"}</span>
      </div>
      {runs.length === 0 ? (
        <div className="py-8 text-sm text-steel">{locale === "tr" ? "Bu belge için kalıcı OCR karşılaştırma çalışması yok." : "There is no persisted OCR comparison run for this document."}</div>
      ) : (
        <div className="grid gap-5 pt-5 xl:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.2fr)]">
          <div>
            <p className="text-xs font-semibold uppercase tracking-normal text-steel">{locale === "tr" ? "Belge görseli" : "Document image"}</p>
            <div className="mt-3 flex min-h-72 items-center justify-center border border-black/10 bg-paper">
              {selectedDocumentUrl?.url && selectedDocument?.mimeType.startsWith("image/") && selectedDocumentUrl.url.startsWith("http") ? (
                <div className="relative inline-block max-w-full">
                  <img alt={selectedDocument.originalName} className="max-h-[440px] max-w-full object-contain" src={selectedDocumentUrl.url} />
                  <BoundingBoxOverlay tokens={overlayTokens} />
                </div>
              ) : (
                <div className="px-5 text-center text-sm text-steel">{locale === "tr" ? "Belge bağlantısı hazır, ancak bu dosya tarayıcı içi önizleme yerine ayrı sekmede açılıyor." : "The document link is ready, but this file opens in a separate tab instead of an inline preview."}</div>
              )}
            </div>
            <div className="mt-2 text-xs text-steel">
              {overlayTokens.length > 0
                ? `${overlayTokens.length} ${locale === "tr" ? "kalıcı" : "persisted"} ${overlayRun?.engine ?? "OCR"} ${locale === "tr" ? "kutusu" : "box(es)"}`
                : locale === "tr"
                  ? "Bu çalışma için kalıcı OCR sınırlayıcı kutusu yok."
                  : "There is no persisted OCR bounding box for this run."}
            </div>
          </div>
          <div className="min-w-0">
            <div className="grid gap-3 md:grid-cols-3">
              <ReviewMetric label={locale === "tr" ? "Seçilen" : "Selected"} value={String(ensemble?.selectedEngine ?? (locale === "tr" ? "yok" : "none"))} />
              <ReviewMetric label={locale === "tr" ? "Güven" : "Confidence"} value={formatMaybePercent(ensemble?.averageConfidence)} />
              <ReviewMetric label="CER" value={formatMaybeNumber(ensemble?.characterErrorRate)} />
            </div>
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              {candidateRuns.map((run) => (
                <OcrRunText key={run.id} run={run} locale={locale} />
              ))}
            </div>
            {ensemble ? (
              <div className="mt-4 border-t border-black/10 pt-4">
                <p className="text-xs font-semibold uppercase tracking-normal text-steel">{locale === "tr" ? "Ensemble alan kaynağı" : "Ensemble field source"}</p>
                <div className="mt-3 divide-y divide-black/10">
                  {Array.isArray(ensemble.fieldDecisions) && ensemble.fieldDecisions.length > 0 ? (
                    ensemble.fieldDecisions.slice(0, 8).map((decision, index) => {
                      const fieldDecision = normalizedRecord(decision);
                      return (
                        <div key={`${String(fieldDecision.field ?? "field")}-${index}`} className="grid gap-2 py-2 text-sm md:grid-cols-[110px_1fr_100px]">
                          <span className="font-semibold">{String(fieldDecision.field ?? "field")}</span>
                          <span className="min-w-0 break-all text-steel">{fieldDecision.value === null || fieldDecision.value === undefined ? "eksik" : String(fieldDecision.value)}</span>
                          <span className="text-xs font-semibold uppercase tracking-normal text-steel">{String(fieldDecision.sourceEngine ?? "NONE")}</span>
                        </div>
                      );
                    })
                  ) : (
                    <div className="py-2 text-sm text-steel">{locale === "tr" ? "Ensemble alan kararı yok." : "No ensemble field decision."}</div>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

type OcrOverlayToken = {
  text: string;
  confidence: number;
  bbox: [number, number, number, number];
  pageNumber: number | null;
};

type SelectableOcrToken = Omit<OcrOverlayToken, "pageNumber"> & {
  id: string;
  engine: string;
  runId: string;
  pageNumber: number;
};

function BoundingBoxOverlay({ tokens }: { tokens: OcrOverlayToken[] }) {
  const pageTokens = tokens.filter((token) => token.pageNumber === null || token.pageNumber === 1).slice(0, 80);
  if (pageTokens.length === 0) return null;
  const width = Math.max(...pageTokens.map((token) => token.bbox[0] + token.bbox[2]), 1);
  const height = Math.max(...pageTokens.map((token) => token.bbox[1] + token.bbox[3]), 1);
  return (
    <div className="pointer-events-none absolute inset-0">
      {pageTokens.map((token, index) => {
        const [left, top, boxWidth, boxHeight] = token.bbox;
        const borderColor = token.confidence >= 0.75 ? "border-signal/80" : token.confidence >= 0.45 ? "border-amber-600/80" : "border-red-700/80";
        return (
          <div
            key={`${token.text}-${index}-${left}-${top}`}
            className={`absolute border ${borderColor} bg-white/10`}
            style={{
              left: `${(left / width) * 100}%`,
              top: `${(top / height) * 100}%`,
              width: `${(boxWidth / width) * 100}%`,
              height: `${(boxHeight / height) * 100}%`
            }}
            title={`${token.text} (${Math.round(token.confidence * 100)}%)`}
          />
        );
      })}
    </div>
  );
}

function createBboxDraft(seed: { engine: string; token: OcrOverlayToken } | null): BboxDraft {
  return {
    label: "ocr_bbox_token",
    engine: seed?.engine ?? "TESSERACT",
    text: seed?.token.text ?? "",
    pageNumber: seed?.token.pageNumber ?? 1,
    x: seed?.token.bbox[0] ?? 0,
    y: seed?.token.bbox[1] ?? 0,
    width: seed?.token.bbox[2] ?? 80,
    height: seed?.token.bbox[3] ?? 28,
    confidence: seed?.token.confidence ?? 1
  };
}

function fitBboxToBounds(draft: Pick<BboxDraft, "x" | "y" | "width" | "height">, imageWidth: number, imageHeight: number) {
  const width = clamp(Math.round(draft.width), 1, Math.max(1, Math.round(imageWidth)));
  const height = clamp(Math.round(draft.height), 1, Math.max(1, Math.round(imageHeight)));
  const x = clamp(Math.round(draft.x), 0, Math.max(0, Math.round(imageWidth) - width));
  const y = clamp(Math.round(draft.y), 0, Math.max(0, Math.round(imageHeight) - height));
  return { x, y, width, height };
}

function nextBboxForInteraction(interaction: BboxInteraction, dx: number, dy: number) {
  const start = interaction.startDraft;
  const right = start.x + start.width;
  const bottom = start.y + start.height;
  if (interaction.mode === "move") {
    return fitBboxToBounds(
      {
        ...start,
        x: start.x + dx,
        y: start.y + dy
      },
      interaction.imageWidth,
      interaction.imageHeight
    );
  }
  if (interaction.mode === "resize-se") {
    return fitBboxToBounds(
      {
        ...start,
        width: start.width + dx,
        height: start.height + dy
      },
      interaction.imageWidth,
      interaction.imageHeight
    );
  }
  if (interaction.mode === "resize-ne") {
    const y = clamp(start.y + dy, 0, bottom - 1);
    return fitBboxToBounds(
      {
        ...start,
        y,
        width: start.width + dx,
        height: bottom - y
      },
      interaction.imageWidth,
      interaction.imageHeight
    );
  }
  if (interaction.mode === "resize-sw") {
    const x = clamp(start.x + dx, 0, right - 1);
    return fitBboxToBounds(
      {
        ...start,
        x,
        width: right - x,
        height: start.height + dy
      },
      interaction.imageWidth,
      interaction.imageHeight
    );
  }
  const x = clamp(start.x + dx, 0, right - 1);
  const y = clamp(start.y + dy, 0, bottom - 1);
  return fitBboxToBounds(
    {
      ...start,
      x,
      y,
      width: right - x,
      height: bottom - y
    },
    interaction.imageWidth,
    interaction.imageHeight
  );
}

function handlePositionClass(mode: BboxInteraction["mode"]): string {
  if (mode === "resize-nw") return "-left-1.5 -top-1.5";
  if (mode === "resize-ne") return "-right-1.5 -top-1.5";
  if (mode === "resize-sw") return "-bottom-1.5 -left-1.5";
  return "-bottom-1.5 -right-1.5";
}

function handleCursorClass(mode: BboxInteraction["mode"]): string {
  return mode === "resize-nw" || mode === "resize-se" ? "cursor-nwse-resize" : "cursor-nesw-resize";
}

function numericInput(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function OcrRunText({ run, locale }: { run: OcrEngineRunSummary; locale: "tr" | "en" }) {
  const json = normalizedRecord(run.normalizedJson);
  const text = typeof json.text === "string" ? json.text : "";
  return (
    <div className="min-w-0 border border-black/10 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">{run.engine}</p>
          <p className="mt-1 text-xs text-steel">{formatJobStatus(run.status, locale)}{run.latencyMs !== null ? ` - ${run.latencyMs} ms` : ""}</p>
        </div>
        <span className="font-mono text-xs text-steel">{run.confidence ?? "n/a"}</span>
      </div>
      <pre className="mt-3 max-h-52 overflow-auto whitespace-pre-wrap break-words bg-paper p-3 font-mono text-xs leading-5 text-ink">
        {text || run.failureReason || "Bu çalışma için normalize OCR metni yok."}
      </pre>
    </div>
  );
}

function ocrOverlayTokens(run: OcrEngineRunSummary): OcrOverlayToken[] {
  const json = normalizedRecord(run.normalizedJson);
  if (!Array.isArray(json.tokens)) return [];
  return json.tokens.flatMap((token): OcrOverlayToken[] => {
    const row = normalizedRecord(token);
    const bbox = row.bbox;
    if (
      typeof row.text !== "string" ||
      typeof row.confidence !== "number" ||
      !Array.isArray(bbox) ||
      bbox.length !== 4 ||
      !bbox.every((part) => typeof part === "number" && Number.isFinite(part) && part >= 0)
    ) {
      return [];
    }
    const pageNumber = row.pageNumber;
    return [
      {
        text: row.text,
        confidence: Math.max(0, Math.min(1, row.confidence)),
        bbox: [bbox[0], bbox[1], bbox[2], bbox[3]],
        pageNumber: typeof pageNumber === "number" && Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : null
      }
    ];
  });
}

function ocrSelectableTokens(jobs: OcrJobsResponse["jobs"]): SelectableOcrToken[] {
  return latestOcrRunsByEngine(jobs)
    .filter((run) => run.engine !== "ENSEMBLE")
    .flatMap((run) =>
      ocrOverlayTokens(run).map((token, index) => ({
        id: `${run.id}:${index}`,
        engine: run.engine,
        runId: run.id,
        text: token.text,
        confidence: token.confidence,
        bbox: token.bbox,
        pageNumber: token.pageNumber ?? 1
      }))
    );
}

function firstOcrOverlayToken(jobs: OcrJobsResponse["jobs"]): { engine: string; token: OcrOverlayToken } | null {
  const run = latestOcrRunsByEngine(jobs).find((candidate) => candidate.engine !== "ENSEMBLE" && ocrOverlayTokens(candidate).length > 0);
  const token = run ? ocrOverlayTokens(run)[0] : null;
  return run && token ? { engine: run.engine, token } : null;
}

function unionTokenBbox(tokens: Array<Pick<SelectableOcrToken, "bbox">>): [number, number, number, number] {
  if (tokens.length === 0) return [0, 0, 80, 28];
  const left = Math.min(...tokens.map((token) => token.bbox[0]));
  const top = Math.min(...tokens.map((token) => token.bbox[1]));
  const right = Math.max(...tokens.map((token) => token.bbox[0] + token.bbox[2]));
  const bottom = Math.max(...tokens.map((token) => token.bbox[1] + token.bbox[3]));
  return [Math.round(left), Math.round(top), Math.max(1, Math.round(right - left)), Math.max(1, Math.round(bottom - top))];
}

function averageConfidence(tokens: Array<Pick<SelectableOcrToken, "confidence">>): number {
  if (tokens.length === 0) return 1;
  return tokens.reduce((sum, token) => sum + token.confidence, 0) / tokens.length;
}

function summarizeAnnotationPayload(payload: unknown, locale: "tr" | "en"): string {
  const row = normalizedRecord(payload);
  if (row.type === "ocr_multi_token_annotation" && Array.isArray(row.tokens)) {
    const pages = Array.isArray(row.pageNumbers) ? row.pageNumbers.join(", ") : String(row.pageNumber ?? "n/a");
    return locale === "tr"
      ? `${String(row.text ?? "Token grubu")} · Sayfa ${pages} · ${row.tokens.length} parça`
      : `${String(row.text ?? "Token group")} · Page ${pages} · ${row.tokens.length} tokens`;
  }
  if (row.type === "ocr_bbox_annotation" && Array.isArray(row.bbox)) {
    const pageNumber = typeof row.pageNumber === "number" ? row.pageNumber : null;
    const pageLabel = pageNumber ? (locale === "tr" ? `Sayfa ${pageNumber}` : `Page ${pageNumber}`) : locale === "tr" ? "Sayfa bilgisi yok" : "Page not specified";
    return `${String(row.text ?? (locale === "tr" ? "OCR alanı" : "OCR region"))} · ${pageLabel}`;
  }
  const summaryParts = [
    typeof row.label === "string" ? row.label : null,
    typeof row.engine === "string" ? row.engine : null,
    typeof row.text === "string" ? row.text : null,
    typeof row.pageNumber === "number" ? (locale === "tr" ? `Sayfa ${row.pageNumber}` : `Page ${row.pageNumber}`) : null
  ].filter((value): value is string => Boolean(value));
  if (summaryParts.length > 0) {
    return summaryParts.join(" · ");
  }
  return locale === "tr" ? "Ek anotasyon ayrıntıları kaydedildi." : "Additional annotation details were saved.";
}

function formatReviewError(caught: unknown, locale: "tr" | "en"): string {
  const raw = caught instanceof Error ? caught.message : String(caught);
  const friendly = formatUserFacingError(raw, locale);
  if (friendly !== raw) return friendly;
  return locale === "tr"
    ? "İnceleme çalışma alanı yüklenemedi. Oturumu yenileyip tekrar deneyin."
    : "The review workspace could not be loaded. Refresh your session and try again.";
}

function reviewerLabel(reviewers: ReviewAssigneeSummary[], userId: string, locale: "tr" | "en"): string {
  const reviewer = reviewers.find((candidate) => candidate.id === userId);
  return reviewer ? `${reviewer.displayName} (${reviewer.email ?? (locale === "tr" ? "e-posta yok" : "no email")})` : userId;
}

function rebalanceReasonLabel(reasonCode: ReviewRebalanceSuggestionsResponse["suggestions"][number]["reasonCode"], locale: "tr" | "en"): string {
  if (reasonCode === "SLA_OVERDUE_UNASSIGNED") return locale === "tr" ? "Gecikmiş ve atanmamış" : "Overdue and unassigned";
  if (reasonCode === "SLA_DUE_SOON_UNASSIGNED") return locale === "tr" ? "Yakında dolacak ve atanmamış" : "Due soon and unassigned";
  return locale === "tr" ? "Aşırı yüklü inceleyici" : "Overloaded reviewer";
}

function formatSlaWindow(suggestion: ReviewRebalanceSuggestionsResponse["suggestions"][number], locale: "tr" | "en"): string {
  if (suggestion.overdueMinutes !== null) return locale === "tr" ? `Gecikme ${formatAgeMinutes(suggestion.overdueMinutes, locale)}` : `Overdue by ${formatAgeMinutes(suggestion.overdueMinutes, locale)}`;
  if (suggestion.dueInMinutes !== null) return locale === "tr" ? `${formatAgeMinutes(suggestion.dueInMinutes, locale)} içinde dolacak` : `Due in ${formatAgeMinutes(suggestion.dueInMinutes, locale)}`;
  return locale === "tr" ? "Vade yok" : "No due date";
}

function ReviewMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-t border-black/10 pt-3">
      <div className="text-xs font-semibold uppercase tracking-normal text-steel">{label}</div>
      <div className="mt-1 font-mono text-sm font-semibold">{value}</div>
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

function ExtractionValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs font-semibold uppercase tracking-normal text-steel">{label}</div>
      <div className="mt-1 truncate font-semibold">{value}</div>
    </div>
  );
}

function formatMoney(money: { amountMinor: string; currency: string }) {
  const amount = BigInt(money.amountMinor);
  const sign = amount < 0n ? "-" : "";
  const absolute = amount < 0n ? -amount : amount;
  return `${sign}${(absolute / 100n).toString()},${(absolute % 100n).toString().padStart(2, "0")} ${money.currency}`;
}

function formatJobStatus(status: string, locale: "tr" | "en"): string {
  const labels: Record<string, string> =
    locale === "tr"
      ? {
          PENDING: "Beklemede",
          QUEUED: "Kuyrukta",
          RUNNING: "Çalışıyor",
          SUCCEEDED: "Tamamlandı",
          COMPLETED: "Tamamlandı",
          FAILED: "Başarısız",
          CANCELLED: "İptal edildi",
          NEEDS_REVIEW: "İnceleme gerekiyor",
          APPROVED: "Onaylandı",
          REJECTED: "Reddedildi"
        }
      : {
          PENDING: "Pending",
          QUEUED: "Queued",
          RUNNING: "Running",
          SUCCEEDED: "Succeeded",
          COMPLETED: "Completed",
          FAILED: "Failed",
          CANCELLED: "Cancelled",
          NEEDS_REVIEW: "Needs review",
          APPROVED: "Approved",
          REJECTED: "Rejected"
        };
  return labels[status] ?? status.replaceAll("_", " ");
}

function formatDocumentKind(kind: DocumentSummary["kind"], locale: "tr" | "en"): string {
  const labels: Record<DocumentSummary["kind"], { tr: string; en: string }> = {
    RECEIPT: { tr: "Fiş", en: "Receipt" },
    INVOICE: { tr: "Fatura", en: "Invoice" },
    OTHER: { tr: "Diğer", en: "Other" }
  };
  return labels[kind][locale];
}

function formatReviewStatus(status: string, locale: "tr" | "en"): string {
  const labels: Record<string, string> =
    locale === "tr"
      ? {
          APPROVED: "Onaylandı",
          NEEDS_REVIEW: "İnceleme gerekiyor",
          REJECTED: "Reddedildi"
        }
      : {
          APPROVED: "Approved",
          NEEDS_REVIEW: "Needs review",
          REJECTED: "Rejected"
        };
  return labels[status] ?? status.replaceAll("_", " ");
}

function formatSeverity(severity: string, locale: "tr" | "en"): string {
  const labels: Record<string, string> =
    locale === "tr"
      ? {
          info: "Bilgi",
          warning: "Uyarı",
          critical: "Kritik",
          block: "Engel"
        }
      : {
          info: "Info",
          warning: "Warning",
          critical: "Critical",
          block: "Block"
        };
  return labels[severity] ?? severity;
}

function serializeCorrectionValue(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => (typeof nested === "bigint" ? nested.toString() : nested));
}

function textPatch(fieldName: string, value: FormDataEntryValue | null) {
  return { fieldName, value: String(value ?? "").trim() || null };
}

function moneyPatch(fieldName: string, value: FormDataEntryValue | null, currency: "TRY" | "USD" | "EUR" | "GBP") {
  const amountMinor = String(value ?? "").trim();
  if (!amountMinor) return { fieldName, value: null };
  return /^-?\d+$/.test(amountMinor) ? { fieldName, value: { amountMinor, currency } } : null;
}

function latestOcrRunsByEngine(jobs: OcrJobsResponse["jobs"]): OcrEngineRunSummary[] {
  const newestRuns = [...jobs]
    .flatMap((job) => job.runs)
    .sort((left, right) => new Date(right.completedAt ?? right.createdAt).getTime() - new Date(left.completedAt ?? left.createdAt).getTime());
  const byEngine = new Map<string, OcrEngineRunSummary>();
  for (const run of newestRuns) {
    if (!byEngine.has(run.engine)) byEngine.set(run.engine, run);
  }
  return ["TESSERACT", "CUSTOM_CRNN", "ENSEMBLE"].flatMap((engine) => {
    const run = byEngine.get(engine);
    return run ? [run] : [];
  });
}

function normalizedRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function formatMaybePercent(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value * 1000) / 10}%` : "n/a";
}

function formatMaybeNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(4) : "n/a";
}

function formatAgeMinutes(value: number | null, locale: "tr" | "en"): string {
  if (value === null) return "n/a";
  if (value < 60) return locale === "tr" ? `${value}d` : `${value}m`;
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  return minutes === 0 ? (locale === "tr" ? `${hours}s` : `${hours}h`) : locale === "tr" ? `${hours}s ${minutes}d` : `${hours}h ${minutes}m`;
}

function Shell({ title, detail, children, text }: { title: string; detail: string; children?: React.ReactNode; text: (typeof copy)[keyof typeof copy] }) {
  void text;
  return <AppShell title={title} detail={detail}>{children}</AppShell>;
}
