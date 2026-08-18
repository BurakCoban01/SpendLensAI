"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { crc32Hex } from "@spendlens/shared";
import {
  apiRequest,
  authHeaders,
  formatUserFacingError,
  type AuthResponse,
  type DocumentSummary,
  type DocumentUploadWarning,
  type UploadCompleteResponse,
  type UploadSessionStatusResponse,
  type PrincipalResponse,
  type WorkspaceSummary
} from "../lib/api";
import { readSession } from "../lib/session";
import { useLocale } from "../lib/locale";
import { AppShell } from "./app-shell";
import { SessionRecoveryActions } from "./session-recovery-actions";

const copy = {
  tr: {
    loading: "Belgeler",
    loadingDetail: "Belge çalışma alanı yükleniyor.",
    anonymousDetail: "Fiş veya fatura yüklemek için önce giriş yapın.",
    signIn: "Giriş yap",
    title: "Belge kabul ve yükleme",
    uploadTitle: "Belge yükle",
    uploadDetail: "JPG/JPEG, PNG, WebP, TIFF, BMP, GIF ve PDF dosyaları gerçek dosya imzasıyla kontrol edilir.",
    authorized: "Yetkili",
    unauthorized: "Yetkisiz",
    nextStep:
      "Okunabilir bir fiş veya fatura yükleyin. Yükleme sonrası belgeyi OCR ekranında seçip Tesseract/Custom CRNN durumunu, ham OCR metnini ve extraction sonucunu görebilirsiniz.",
    nextStepHint: "Net fotoğraf, kırpılmamış toplam alanı ve mümkünse PDF yerine yüksek çözünürlüklü görüntü kullanın.",
    workspace: "Çalışma alanı",
    documentKind: "Belge türü",
    selectFile: "Dosya seç",
    sizeHint: "Dosya başına en fazla 25 MB",
    resumableHint: "Büyük dosyalar parçalı yüklenir; her parça CRC32 ile, final dosya SHA-256 ile doğrulanır.",
    resumableMode: "Parçalı yükleme",
    directMode: "Normal yükleme",
    pause: "Duraklat",
    resume: "Sürdür",
    cancel: "İptal et",
    recover: "Durumu kurtar",
    crcOk: "CRC doğrulandı",
    chunkProgress: "Parça ilerlemesi",
    shaVerifying: "SHA-256 doğrulanıyor",
    inputLabel: "Belge dosyası",
    duplicate: "Aynı belge zaten kayıtlı",
    uploaded: "Yüklendi",
    upload: "Belgeyi yükle",
    uploading: "Yükleniyor...",
    latestDocs: "Son belgeler",
    recorded: "kayıtlı",
    shown: "kayıt bu sayfada gösteriliyor",
    searchDocuments: "Dosya adına göre ara",
    searchPlaceholder: "Örn. market veya fatura",
    allKinds: "Tüm belge türleri",
    applyFilters: "Filtrele",
    previousPage: "Önceki",
    nextPage: "Sonraki",
    empty: "Bu çalışma alanında henüz belge yok. İlk belgeyi yükleyerek OCR akışını başlatın.",
    noResults: "Arama ve filtrelerle eşleşen belge bulunamadı.",
    ocrReview: "OCR incele",
    openDocument: "Belgeyi aç/indir",
    documentReady: "Belge bağlantısı hazır.",
    exit: "Çıkış",
    ocrWorkspace: "OCR karşılaştırma",
    dashboard: "Pano"
  },
  en: {
    loading: "Documents",
    loadingDetail: "Loading the document workspace.",
    anonymousDetail: "Sign in first to upload a receipt or invoice.",
    signIn: "Sign in",
    title: "Document intake and upload",
    uploadTitle: "Upload document",
    uploadDetail: "JPG/JPEG, PNG, WebP, TIFF, BMP, GIF and PDF files are checked against the real file signature.",
    authorized: "Authorized",
    unauthorized: "Unauthorized",
    nextStep:
      "Upload a readable receipt or invoice. After upload, select the document in the OCR screen to see Tesseract/Custom CRNN status, raw OCR text and the extraction result.",
    nextStepHint: "Use a clear photo, keep the total visible, and prefer a high-resolution image over PDF when possible.",
    workspace: "Workspace",
    documentKind: "Document type",
    selectFile: "Select file",
    sizeHint: "Up to 25 MB per file",
    resumableHint: "Large files use chunked upload; each chunk is checked with CRC32 and the final file with SHA-256.",
    resumableMode: "Chunked upload",
    directMode: "Normal upload",
    pause: "Pause",
    resume: "Resume",
    cancel: "Cancel",
    recover: "Recover status",
    crcOk: "CRC verified",
    chunkProgress: "Chunk progress",
    shaVerifying: "Verifying SHA-256",
    inputLabel: "Document file",
    duplicate: "The same document is already saved",
    uploaded: "Uploaded",
    upload: "Upload document",
    uploading: "Uploading...",
    latestDocs: "Recent documents",
    recorded: "saved",
    shown: "documents shown on this page",
    searchDocuments: "Search by file name",
    searchPlaceholder: "For example, market or invoice",
    allKinds: "All document types",
    applyFilters: "Apply filters",
    previousPage: "Previous",
    nextPage: "Next",
    empty: "There are no documents in this workspace yet. Upload the first one to start the OCR flow.",
    noResults: "No documents match the current search and filters.",
    ocrReview: "Review OCR",
    openDocument: "Open/download document",
    documentReady: "Document link is ready.",
    exit: "Sign out",
    ocrWorkspace: "OCR comparison",
    dashboard: "Dashboard"
  }
} as const;

type DocumentUploadCopy = (typeof copy)[keyof typeof copy];

type UploadState =
  | { kind: "loading" }
  | { kind: "anonymous" }
  | {
      kind: "ready";
      session: AuthResponse;
      principal: PrincipalResponse["principal"];
      workspaces: WorkspaceSummary[];
      selectedWorkspaceId: string;
      documents: DocumentSummary[];
      nextCursor: string | null;
    }
  | { kind: "error"; message: string };

type SubmissionState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; duplicate: boolean; document: DocumentSummary; warnings: DocumentUploadWarning[] }
  | { kind: "error"; message: string };

type ResumableUploadState =
  | { kind: "idle" }
  | {
      kind: "running" | "paused" | "completing" | "success";
      uploadId: string;
      uploadedChunks: number[];
      missingChunks: number[];
      totalChunks: number;
      progressBytes: number;
      totalBytes: number;
      retries: number;
      message: string;
    }
  | { kind: "error"; message: string };

type DownloadActionState = {
  documentId: string;
  documentName: string;
  url: string;
};

const kinds = ["RECEIPT", "INVOICE", "OTHER"] as const;
const directUploadLimitBytes = 25 * 1024 * 1024;
const resumableThresholdBytes = 8 * 1024 * 1024;
const resumableChunkSizeBytes = 5 * 1024 * 1024;
const resumableConcurrency = 3;
const documentPageSize = 6;

function kindLabel(kind: (typeof kinds)[number], locale: "tr" | "en"): string {
  if (locale === "tr") {
    return kind === "RECEIPT" ? "Fiş" : kind === "INVOICE" ? "Fatura" : "Diğer";
  }
  return kind === "RECEIPT" ? "Receipt" : kind === "INVOICE" ? "Invoice" : "Other";
}

function documentListPath(
  workspaceId: string,
  options: {
    limit: number;
    cursor?: string | null;
    search?: string;
    kind?: "ALL" | (typeof kinds)[number];
  }
): string {
  const params = new URLSearchParams({ workspaceId, limit: String(options.limit) });
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.search?.trim()) params.set("search", options.search.trim());
  if (options.kind && options.kind !== "ALL") params.set("kind", options.kind);
  return `/documents?${params.toString()}`;
}

export function DocumentUploadClient() {
  const { locale } = useLocale();
  const text = copy[locale];
  const localized = (path: string) => `${path}?lang=${encodeURIComponent(locale)}`;
  const [state, setState] = useState<UploadState>({ kind: "loading" });
  const [submission, setSubmission] = useState<SubmissionState>({ kind: "idle" });
  const [resumable, setResumable] = useState<ResumableUploadState>({ kind: "idle" });
  const [forceResumable, setForceResumable] = useState(false);
  const [selectedKind, setSelectedKind] = useState<(typeof kinds)[number]>("RECEIPT");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [downloadAction, setDownloadAction] = useState<DownloadActionState | null>(null);
  const [documentPage, setDocumentPage] = useState(0);
  const [documentCursor, setDocumentCursor] = useState<string | null>(null);
  const [documentCursorHistory, setDocumentCursorHistory] = useState<Array<string | null>>([]);
  const [documentSearch, setDocumentSearch] = useState("");
  const [appliedDocumentSearch, setAppliedDocumentSearch] = useState("");
  const [documentKindFilter, setDocumentKindFilter] = useState<"ALL" | (typeof kinds)[number]>("ALL");
  const [documentListLoading, setDocumentListLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pauseRequestedRef = useRef(false);
  const cancelRequestedRef = useRef(false);

  async function load(
    preferredWorkspaceId?: string,
    options: { cursor?: string | null; search?: string; kind?: "ALL" | (typeof kinds)[number] } = {}
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
      const listResult = selectedWorkspaceId
        ? await apiRequest<{ documents: DocumentSummary[]; nextCursor: string | null }>(
            documentListPath(selectedWorkspaceId, {
              limit: documentPageSize,
              ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
              ...(options.search !== undefined ? { search: options.search } : {}),
              ...(options.kind !== undefined ? { kind: options.kind } : {})
            }),
            { headers: authHeaders(session.tokens.accessToken) }
          )
        : { documents: [], nextCursor: null };
      setState({
        kind: "ready",
        session,
        principal: principal.principal,
        workspaces,
        selectedWorkspaceId,
        documents: listResult.documents,
        nextCursor: listResult.nextCursor
      });
    } catch (caught) {
      setState({ kind: "error", message: caught instanceof Error ? caught.message : "SESSION_FAILED" });
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function resetDocumentPaging() {
    setDocumentPage(0);
    setDocumentCursor(null);
    setDocumentCursorHistory([]);
  }

  async function fetchDocumentPage(cursor: string | null, page: number, history: Array<string | null>) {
    if (state.kind !== "ready") return;
    setDocumentListLoading(true);
    setDownloadAction(null);
    try {
      const result = await apiRequest<{ documents: DocumentSummary[]; nextCursor: string | null }>(
        documentListPath(state.selectedWorkspaceId, {
          limit: documentPageSize,
          cursor,
          search: appliedDocumentSearch,
          kind: documentKindFilter
        }),
        { headers: authHeaders(state.session.tokens.accessToken) }
      );
      setState((current) =>
        current.kind === "ready"
          ? { ...current, documents: result.documents, nextCursor: result.nextCursor }
          : current
      );
      setDocumentCursor(cursor);
      setDocumentCursorHistory(history);
      setDocumentPage(page);
    } catch (caught) {
      setState({ kind: "error", message: caught instanceof Error ? caught.message : "DOCUMENT_LIST_FAILED" });
    } finally {
      setDocumentListLoading(false);
    }
  }

  async function applyDocumentFilters(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.kind !== "ready") return;
    const search = documentSearch.trim();
    setAppliedDocumentSearch(search);
    resetDocumentPaging();
    setDocumentListLoading(true);
    try {
      const result = await apiRequest<{ documents: DocumentSummary[]; nextCursor: string | null }>(
        documentListPath(state.selectedWorkspaceId, {
          limit: documentPageSize,
          search,
          kind: documentKindFilter
        }),
        { headers: authHeaders(state.session.tokens.accessToken) }
      );
      setState((current) =>
        current.kind === "ready"
          ? { ...current, documents: result.documents, nextCursor: result.nextCursor }
          : current
      );
    } catch (caught) {
      setState({ kind: "error", message: caught instanceof Error ? caught.message : "DOCUMENT_LIST_FAILED" });
    } finally {
      setDocumentListLoading(false);
    }
  }

  async function showLatestDocuments(workspaceId: string) {
    setDocumentSearch("");
    setAppliedDocumentSearch("");
    setDocumentKindFilter("ALL");
    resetDocumentPaging();
    await load(workspaceId, { search: "", kind: "ALL" });
  }

  const canUpload = state.kind === "ready" && state.principal.permissions.includes("documents.upload");
  const canRead = state.kind === "ready" && state.principal.permissions.includes("documents.read");

  const acceptedTypes = useMemo(() => ".jpg,.jpeg,.jpe,.png,.webp,.tif,.tiff,.bmp,.gif,.pdf", []);
  const shouldUseResumable = Boolean(selectedFile && (forceResumable || selectedFile.size > resumableThresholdBytes));

  async function submitUpload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.kind !== "ready" || !selectedFile || !canUpload) return;
    if (shouldUseResumable) {
      await submitResumableUpload(selectedFile);
      return;
    }
    setSubmission({ kind: "submitting" });
    setDownloadAction(null);
    const body = new FormData();
    body.append("file", selectedFile);
    try {
      const result = await apiRequest<{ document: DocumentSummary; duplicate: boolean; warnings?: DocumentUploadWarning[] }>(
        `/documents/upload?workspaceId=${encodeURIComponent(state.selectedWorkspaceId)}&kind=${selectedKind}`,
        {
          method: "POST",
          headers: authHeaders(state.session.tokens.accessToken),
          body
        }
      );
      setSubmission({ kind: "success", duplicate: result.duplicate, document: result.document, warnings: result.warnings ?? [] });
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      await showLatestDocuments(state.selectedWorkspaceId);
    } catch (caught) {
      setSubmission({ kind: "error", message: caught instanceof Error ? caught.message : "UPLOAD_FAILED" });
    }
  }

  async function submitResumableUpload(file: File) {
    if (state.kind !== "ready" || !canUpload) return;
    setSubmission({ kind: "submitting" });
    setDownloadAction(null);
    pauseRequestedRef.current = false;
    cancelRequestedRef.current = false;
    try {
      const totalChunks = Math.ceil(file.size / resumableChunkSizeBytes);
      const init = await apiRequest<UploadSessionStatusResponse>("/documents/uploads/init", {
        method: "POST",
        headers: {
          ...authHeaders(state.session.tokens.accessToken),
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          workspaceId: state.selectedWorkspaceId,
          kind: selectedKind,
          filename: file.name,
          mimeType: file.type || "application/octet-stream",
          totalSizeBytes: file.size,
          chunkSizeBytes: resumableChunkSizeBytes
        })
      });
      rememberUploadSession(state.selectedWorkspaceId, init.upload.id);
      setResumable({
        kind: "running",
        uploadId: init.upload.id,
        uploadedChunks: init.uploadedChunks,
        missingChunks: init.missingChunks,
        totalChunks,
        progressBytes: init.uploadedChunks.length * resumableChunkSizeBytes,
        totalBytes: file.size,
        retries: 0,
        message: locale === "tr" ? "Parçalar yükleniyor." : "Uploading chunks."
      });
      await uploadMissingChunks(file, init.upload.id, new Set(init.uploadedChunks));
      if (cancelRequestedRef.current || pauseRequestedRef.current) return;
      await completeResumableUpload(file, init.upload.id, totalChunks);
    } catch (caught) {
      setSubmission({ kind: "error", message: formatUploadError(caught, locale) });
      setResumable({ kind: "error", message: formatUploadError(caught, locale) });
    }
  }

  async function completeResumableUpload(file: File, uploadId: string, totalChunks: number) {
    if (state.kind !== "ready") return;
    setResumable((current) =>
      current.kind === "running" || current.kind === "paused"
        ? { ...current, kind: "completing", message: text.shaVerifying }
        : current
    );
    const sha256 = await sha256Hex(file);
    const completed = await apiRequest<UploadCompleteResponse>(`/documents/uploads/${encodeURIComponent(uploadId)}/complete`, {
      method: "POST",
      headers: {
        ...authHeaders(state.session.tokens.accessToken),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ sha256 })
    });
    forgetUploadSession(state.selectedWorkspaceId);
    setSubmission({ kind: "success", duplicate: completed.duplicate, document: completed.document, warnings: completed.warnings ?? [] });
    setResumable({
      kind: "success",
      uploadId,
      uploadedChunks: completed.upload.uploadedChunks,
      missingChunks: completed.upload.missingChunks,
      totalChunks,
      progressBytes: file.size,
      totalBytes: file.size,
      retries: 0,
      message: locale === "tr" ? "Parçalı yükleme tamamlandı." : "Chunked upload completed."
    });
    setSelectedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    await showLatestDocuments(state.selectedWorkspaceId);
  }

  async function uploadMissingChunks(file: File, uploadId: string, alreadyUploaded: Set<number>) {
    if (state.kind !== "ready") return;
    const totalChunks = Math.ceil(file.size / resumableChunkSizeBytes);
    const queue = Array.from({ length: totalChunks }, (_, index) => index).filter((index) => !alreadyUploaded.has(index));
    let cursor = 0;
    let retries = 0;
    const worker = async () => {
      while (cursor < queue.length && !pauseRequestedRef.current && !cancelRequestedRef.current) {
        const chunkIndex = queue[cursor]!;
        cursor += 1;
        const start = chunkIndex * resumableChunkSizeBytes;
        const chunk = file.slice(start, Math.min(start + resumableChunkSizeBytes, file.size));
        const bytes = new Uint8Array(await chunk.arrayBuffer());
        const crc = crc32Hex(bytes);
        try {
          const response = await apiRequest<{ uploadedChunks: number[]; missingChunks: number[] }>(
            `/documents/uploads/${encodeURIComponent(uploadId)}/chunks/${chunkIndex}`,
            {
              method: "PUT",
              headers: {
                ...authHeaders(state.session.tokens.accessToken),
                "Content-Type": "application/octet-stream",
                "x-client-crc32": crc
              },
              body: bytes
            }
          );
          setResumable((current) =>
            current.kind === "running"
              ? {
                  ...current,
                  uploadedChunks: response.uploadedChunks,
                  missingChunks: response.missingChunks,
                  progressBytes: Math.min(file.size, response.uploadedChunks.length * resumableChunkSizeBytes),
                  retries,
                  message: `${text.crcOk}: ${chunkIndex + 1}/${totalChunks}`
                }
              : current
          );
        } catch (caught) {
          if (String(caught instanceof Error ? caught.message : caught).includes("CHUNK_CRC_MISMATCH")) {
            retries += 1;
            queue.push(chunkIndex);
          } else {
            throw caught;
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(resumableConcurrency, queue.length) }, () => worker()));
    if (pauseRequestedRef.current) {
      await pauseUpload(uploadId);
    }
    if (cancelRequestedRef.current) {
      await cancelUpload(uploadId);
    }
  }

  async function pauseUpload(uploadId?: string) {
    if (state.kind !== "ready") return;
    const target = uploadId ?? (resumable.kind !== "idle" && resumable.kind !== "error" ? resumable.uploadId : null);
    if (!target) return;
    pauseRequestedRef.current = true;
    if (!uploadId) {
      setResumable((current) =>
        current.kind === "running"
          ? { ...current, message: locale === "tr" ? "Yükleme güvenli noktada duraklatılacak." : "Upload will pause at a safe point." }
          : current
      );
      return;
    }
    const status = await apiRequest<UploadSessionStatusResponse>(`/documents/uploads/${encodeURIComponent(target)}/pause`, {
      method: "POST",
      headers: authHeaders(state.session.tokens.accessToken)
    });
    setResumable(toResumableState(status, "paused", locale === "tr" ? "Yükleme duraklatıldı." : "Upload paused."));
  }

  async function resumeUpload() {
    if (state.kind !== "ready" || resumable.kind === "idle" || resumable.kind === "error" || !selectedFile) return;
    pauseRequestedRef.current = false;
    await apiRequest<UploadSessionStatusResponse>(`/documents/uploads/${encodeURIComponent(resumable.uploadId)}/resume`, {
      method: "POST",
      headers: authHeaders(state.session.tokens.accessToken)
    });
    setResumable({ ...resumable, kind: "running", message: locale === "tr" ? "Yükleme sürdürülüyor." : "Upload resumed." });
    await uploadMissingChunks(selectedFile, resumable.uploadId, new Set(resumable.uploadedChunks));
    if (cancelRequestedRef.current || pauseRequestedRef.current) return;
    await completeResumableUpload(selectedFile, resumable.uploadId, Math.ceil(selectedFile.size / resumableChunkSizeBytes));
  }

  async function cancelUpload(uploadId?: string) {
    if (state.kind !== "ready") return;
    const target = uploadId ?? (resumable.kind !== "idle" && resumable.kind !== "error" ? resumable.uploadId : null);
    if (!target) return;
    cancelRequestedRef.current = true;
    const status = await apiRequest<UploadSessionStatusResponse>(`/documents/uploads/${encodeURIComponent(target)}/cancel`, {
      method: "POST",
      headers: authHeaders(state.session.tokens.accessToken)
    });
    forgetUploadSession(state.selectedWorkspaceId);
    setResumable(toResumableState(status, "success", locale === "tr" ? "Yükleme iptal edildi." : "Upload canceled."));
    setSubmission({ kind: "idle" });
  }

  async function recoverUploadStatus() {
    if (state.kind !== "ready") return;
    const uploadId = readRememberedUploadSession(state.selectedWorkspaceId);
    if (!uploadId) {
      setResumable({ kind: "error", message: locale === "tr" ? "Kurtarılacak aktif yükleme bulunamadı." : "No active upload was found." });
      return;
    }
    const status = await apiRequest<UploadSessionStatusResponse>(`/documents/uploads/${encodeURIComponent(uploadId)}/status`, {
      headers: authHeaders(state.session.tokens.accessToken)
    });
    setResumable(toResumableState(status, status.upload.status === "PAUSED" ? "paused" : "running", locale === "tr" ? "Yükleme durumu alındı." : "Upload status recovered."));
  }

  async function createSignedUrl(documentId: string) {
    if (state.kind !== "ready" || !canRead) return;
    const document = state.documents.find((item) => item.id === documentId);
    setDownloadAction(null);
    const result = await apiRequest<{ url: string; expiresInSeconds: number }>(`/documents/${documentId}/download-url`, {
      method: "POST",
      headers: authHeaders(state.session.tokens.accessToken)
    });
    setDownloadAction({
      documentId,
      documentName: document?.originalName ?? document?.safeName ?? (locale === "tr" ? "Belge" : "Document"),
      url: result.url
    });
  }

  if (state.kind === "loading") return <Shell title={text.loading} detail={text.loadingDetail} text={text} locale={locale} />;

  if (state.kind === "anonymous") {
    return (
      <Shell title={text.loading} detail={text.anonymousDetail} text={text} locale={locale}>
        <Link className="mt-6 inline-flex h-10 items-center bg-ink px-4 text-sm font-semibold text-paper" href="/login">
          {text.signIn}
        </Link>
      </Shell>
    );
  }

  if (state.kind === "error") {
    return (
      <Shell title={text.loading} detail={formatUploadError(state.message, locale)} text={text} locale={locale}>
        <SessionRecoveryActions locale={locale} />
      </Shell>
    );
  }

  return (
    <Shell
      title={text.title}
      detail={`${state.principal.displayName} - ${state.workspaces.length} ${locale === "tr" ? "çalışma alanı" : state.workspaces.length === 1 ? "workspace" : "workspaces"}`}
      text={text}
      locale={locale}
    >
      <div className="grid gap-8 lg:grid-cols-[minmax(0,0.95fr)_minmax(380px,1.2fr)]">
        <section className="border-y border-black/10 py-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold">{text.uploadTitle}</h2>
              <p className="mt-1 text-sm text-steel">{text.uploadDetail}</p>
            </div>
            <span className={canUpload ? "text-xs font-semibold uppercase tracking-[0.16em] text-signal" : "text-xs font-semibold uppercase tracking-[0.16em] text-black/35"}>
              {canUpload ? text.authorized : text.unauthorized}
            </span>
          </div>

          <div className="mt-5 border-l-2 border-signal bg-white px-4 py-3 text-sm leading-6 text-steel">
            <strong className="text-ink">{locale === "tr" ? "Sıradaki adım:" : "Next step:"}</strong> {text.nextStep}
            <br />
            {text.nextStepHint}
          </div>

          <form onSubmit={submitUpload} className="mt-6 space-y-5">
            <label className="block text-sm font-medium" htmlFor="workspace">
              {text.workspace}
            </label>
            <select
              id="workspace"
              className="h-11 w-full border border-black/15 bg-white px-3 text-sm outline-none focus:border-signal"
              value={state.selectedWorkspaceId}
              onChange={(event) => void showLatestDocuments(event.target.value)}
            >
              {state.workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>

            <div>
              <div className="mb-2 text-sm font-medium">{text.documentKind}</div>
              <div className="grid grid-cols-3 border border-black/15 bg-white">
                {kinds.map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    className={
                      kind === selectedKind
                        ? "h-10 bg-ink text-sm font-semibold text-paper"
                        : "h-10 text-sm font-semibold text-steel hover:text-ink"
                    }
                    onClick={() => setSelectedKind(kind)}
                  >
                    {kindLabel(kind, locale)}
                  </button>
                ))}
              </div>
            </div>

            <button
              type="button"
              className="flex min-h-36 w-full flex-col items-center justify-center border border-dashed border-black/25 bg-white px-4 text-center hover:border-signal"
              onClick={() => fileInputRef.current?.click()}
            >
              <span className="text-base font-semibold">{selectedFile ? selectedFile.name : text.selectFile}</span>
              <span className="mt-2 text-sm text-steel">{selectedFile ? formatBytes(selectedFile.size) : text.sizeHint}</span>
            </button>
            <input
              id="document-file"
              ref={fileInputRef}
              className="sr-only"
              type="file"
              accept={acceptedTypes}
              aria-label={text.inputLabel}
              onChange={(event) => {
                setSelectedFile(event.target.files?.[0] ?? null);
                setSubmission({ kind: "idle" });
                setResumable({ kind: "idle" });
              }}
            />

            <div className="border border-black/10 bg-white px-4 py-3">
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={forceResumable}
                  onChange={(event) => setForceResumable(event.target.checked)}
                />
                <span>
                  <span className="font-semibold">{forceResumable || shouldUseResumable ? text.resumableMode : text.directMode}</span>
                  <span className="mt-1 block text-steel">{text.resumableHint}</span>
                </span>
              </label>
              {resumable.kind !== "idle" && resumable.kind !== "error" ? (
                <div className="mt-4 space-y-3">
                  <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-normal text-steel">
                    <span>{text.chunkProgress}</span>
                    <span>
                      {resumable.uploadedChunks.length}/{resumable.totalChunks}
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden bg-black/10">
                    <div className="h-full bg-signal" style={{ width: `${uploadPercent(resumable.progressBytes, resumable.totalBytes)}%` }} />
                  </div>
                  <div className="grid gap-2 text-xs text-steel sm:grid-cols-3">
                    <span>{formatBytes(resumable.progressBytes)} / {formatBytes(resumable.totalBytes)}</span>
                    <span>{resumable.missingChunks.length} {locale === "tr" ? "eksik parça" : "missing chunks"}</span>
                    <span>{resumable.retries} {locale === "tr" ? "yeniden deneme" : "retries"}</span>
                  </div>
                  <p className="text-sm font-medium text-steel">{resumable.message}</p>
                  <div className="grid gap-2 sm:grid-cols-3">
                    <button
                      type="button"
                      className="h-9 border border-black/15 text-sm font-semibold hover:border-signal disabled:text-black/35"
                      disabled={resumable.kind !== "running"}
                      onClick={() => void pauseUpload()}
                    >
                      {text.pause}
                    </button>
                    <button
                      type="button"
                      className="h-9 border border-black/15 text-sm font-semibold hover:border-signal disabled:text-black/35"
                      disabled={resumable.kind !== "paused" || !selectedFile}
                      onClick={() => void resumeUpload()}
                    >
                      {text.resume}
                    </button>
                    <button
                      type="button"
                      className="h-9 border border-red-700 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:text-black/35"
                      disabled={resumable.kind === "success"}
                      onClick={() => void cancelUpload()}
                    >
                      {text.cancel}
                    </button>
                  </div>
                </div>
              ) : null}
              {resumable.kind === "error" ? <p className="mt-3 text-sm font-medium text-red-700">{resumable.message}</p> : null}
              <button
                type="button"
                className="mt-3 h-9 border border-black/15 px-3 text-sm font-semibold hover:border-signal"
                onClick={() => void recoverUploadStatus()}
              >
                {text.recover}
              </button>
            </div>

            {submission.kind === "error" ? <p className="text-sm font-medium text-red-700">{submission.message}</p> : null}
            {submission.kind === "success" ? (
              <div className="space-y-2">
                <p className="text-sm font-medium text-signal">
                  {submission.duplicate ? text.duplicate : text.uploaded} - {submission.document.safeName}
                </p>
                {submission.warnings.map((warning) => (
                  <p key={`${warning.code}-${warning.detectedMimeType}`} className="border-l-2 border-amber-500 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900">
                    {locale === "tr" ? warning.message : `The filename ends with .${warning.originalExtension}, but the content is ${warning.detectedMimeType}. It was processed as ${warning.detectedMimeType}.`}
                  </p>
                ))}
              </div>
            ) : null}

            <button
              className="h-11 w-full bg-ink text-sm font-semibold text-paper hover:bg-signal disabled:cursor-not-allowed disabled:bg-black/25"
              disabled={!canUpload || !selectedFile || submission.kind === "submitting" || !state.selectedWorkspaceId}
            >
              {submission.kind === "submitting" ? (shouldUseResumable ? text.resumableMode : text.uploading) : text.upload}
            </button>
          </form>
        </section>

        <section className="border-y border-black/10 py-6">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-xl font-semibold">{text.latestDocs}</h2>
            <span className="text-sm text-steel">{state.documents.length} {text.shown}</span>
          </div>

          <form className="mt-5 grid gap-3 sm:grid-cols-[minmax(0,1fr)_180px_auto]" onSubmit={applyDocumentFilters}>
            <label className="grid gap-1 text-xs font-semibold text-steel">
              {text.searchDocuments}
              <input
                className="h-10 border border-black/15 bg-white px-3 text-sm font-normal text-ink outline-none focus:border-signal"
                value={documentSearch}
                placeholder={text.searchPlaceholder}
                maxLength={120}
                onChange={(event) => setDocumentSearch(event.target.value)}
              />
            </label>
            <label className="grid gap-1 text-xs font-semibold text-steel">
              {text.documentKind}
              <select
                className="h-10 border border-black/15 bg-white px-3 text-sm font-normal text-ink outline-none focus:border-signal"
                value={documentKindFilter}
                onChange={(event) => setDocumentKindFilter(event.target.value as "ALL" | (typeof kinds)[number])}
              >
                <option value="ALL">{text.allKinds}</option>
                {kinds.map((kind) => <option key={kind} value={kind}>{kindLabel(kind, locale)}</option>)}
              </select>
            </label>
            <button className="product-button-secondary self-end" disabled={documentListLoading} type="submit">
              {text.applyFilters}
            </button>
          </form>

          <div className={`mt-5 divide-y divide-black/10 ${documentListLoading ? "opacity-60" : ""}`} aria-busy={documentListLoading}>
            {state.documents.length === 0 ? (
              <div className="py-12 text-sm text-steel">
                {appliedDocumentSearch || documentKindFilter !== "ALL" ? text.noResults : text.empty}
              </div>
            ) : (
              state.documents.map((document) => (
                <div key={document.id} className="grid gap-3 py-4 md:grid-cols-[1fr_110px_120px_120px]">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">{document.originalName}</div>
                    <div className="mt-1 text-xs text-steel">{new Date(document.createdAt).toLocaleDateString(locale === "tr" ? "tr-TR" : "en-US")}</div>
                  </div>
                  <div className="text-sm text-steel">
                    {kindLabel(document.kind, locale)}
                    <br />
                    {formatBytes(Number(document.sizeBytes))}
                  </div>
                  <button
                    className="h-9 border border-black/15 text-sm font-semibold hover:border-signal hover:text-signal disabled:text-black/35"
                    disabled={!canRead}
                    onClick={() => void createSignedUrl(document.id)}
                  >
                    {text.openDocument}
                  </button>
                  <Link
                    className="inline-flex h-9 items-center justify-center border border-black/15 text-sm font-semibold hover:border-signal hover:text-signal"
                    href={`${localized("/documents/ocr")}&workspaceId=${encodeURIComponent(state.selectedWorkspaceId)}&documentId=${encodeURIComponent(document.id)}`}
                  >
                    {text.ocrReview}
                  </Link>
                </div>
              ))
            )}
          </div>

          {documentCursorHistory.length > 0 || state.nextCursor ? (
            <div className="mt-4 flex items-center justify-between gap-3 border-t border-black/10 pt-4">
              <button
                type="button"
                className="product-button-secondary disabled:cursor-not-allowed disabled:opacity-40"
                disabled={documentCursorHistory.length === 0 || documentListLoading}
                onClick={() => {
                  const history = documentCursorHistory.slice(0, -1);
                  void fetchDocumentPage(documentCursorHistory.at(-1) ?? null, Math.max(0, documentPage - 1), history);
                }}
              >
                {text.previousPage}
              </button>
              <span className="text-xs text-steel">{documentPage + 1}</span>
              <button
                type="button"
                className="product-button-secondary disabled:cursor-not-allowed disabled:opacity-40"
                disabled={!state.nextCursor || documentListLoading}
                onClick={() => {
                  if (!state.nextCursor) return;
                  void fetchDocumentPage(state.nextCursor, documentPage + 1, [...documentCursorHistory, documentCursor]);
                }}
              >
                {text.nextPage}
              </button>
            </div>
          ) : null}

          {downloadAction ? (
            <div className="mt-5 border-t border-black/10 pt-4">
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-signal">{downloadAction.documentName}</div>
              <p className="mt-2 text-sm text-steel">{text.documentReady}</p>
              <a
                className="mt-3 inline-flex h-9 items-center border border-black/15 px-3 text-sm font-semibold hover:border-signal hover:text-signal"
                href={downloadAction.url}
                rel="noreferrer"
                target="_blank"
              >
                {text.openDocument}
              </a>
            </div>
          ) : null}
        </section>
      </div>
    </Shell>
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
  text: DocumentUploadCopy;
  locale: "tr" | "en";
}) {
  return <AppShell title={title} detail={detail}>{children}</AppShell>;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function uploadPercent(progressBytes: number, totalBytes: number): number {
  if (!Number.isFinite(progressBytes) || !Number.isFinite(totalBytes) || totalBytes <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((progressBytes / totalBytes) * 100)));
}

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function rememberedUploadKey(workspaceId: string): string {
  return `spendlens:document-upload:${workspaceId}`;
}

function rememberUploadSession(workspaceId: string, uploadId: string): void {
  try {
    localStorage.setItem(rememberedUploadKey(workspaceId), uploadId);
  } catch {
    // Recovery is best-effort; the durable upload session remains server-side.
  }
}

function readRememberedUploadSession(workspaceId: string): string | null {
  try {
    return localStorage.getItem(rememberedUploadKey(workspaceId));
  } catch {
    return null;
  }
}

function forgetUploadSession(workspaceId: string): void {
  try {
    localStorage.removeItem(rememberedUploadKey(workspaceId));
  } catch {
    // Recovery cleanup is best-effort.
  }
}

function toResumableState(
  status: UploadSessionStatusResponse,
  kind: "running" | "paused" | "completing" | "success",
  message: string
): ResumableUploadState {
  return {
    kind,
    uploadId: status.upload.id,
    uploadedChunks: status.uploadedChunks,
    missingChunks: status.missingChunks,
    totalChunks: status.upload.totalChunks,
    progressBytes: Math.min(Number(status.upload.totalSizeBytes), status.uploadedChunks.length * status.upload.chunkSizeBytes),
    totalBytes: Number(status.upload.totalSizeBytes),
    retries: status.chunks.reduce((total, chunk) => total + chunk.retryCount, 0),
    message
  };
}

function formatUploadError(caught: unknown, locale: "tr" | "en"): string {
  const message = caught instanceof Error ? caught.message : String(caught);
  const tr: Record<string, string> = {
    CHUNK_CRC_MISMATCH: "Parça CRC32 doğrulaması başarısız oldu. Parça yeniden yüklenecek.",
    UPLOAD_PAUSED: "Yükleme duraklatıldı. Devam etmek için Sürdür düğmesini kullanın.",
    INCOMPLETE_UPLOAD: "Yükleme tamamlanmadı. Eksik parçaları yükleyip tekrar deneyin.",
    FINAL_SHA256_MISMATCH: "Final SHA-256 doğrulaması başarısız oldu. Dosya bozulmuş olabilir.",
    TENANT_STORAGE_QUOTA_EXCEEDED: "Depolama kotası aşıldı. Daha küçük bir dosya deneyin veya eski belgeleri temizleyin.",
    UNSUPPORTED_MEDIA_TYPE: "Bu dosya türü şu anda OCR için desteklenmiyor.",
    MIME_SIGNATURE_MISMATCH: "Dosya içeriği uzantı veya MIME bilgisiyle güvenli şekilde eşleşmiyor.",
    UPLOAD_SESSION_NOT_FOUND: "Yükleme oturumu bulunamadı. Yeni bir yükleme başlatın.",
    UPLOAD_SESSION_NOT_ACTIVE: "Yükleme oturumu aktif değil. Yeni bir yükleme başlatın."
  };
  const en: Record<string, string> = {
    CHUNK_CRC_MISMATCH: "Chunk CRC32 validation failed. The chunk will be retried.",
    UPLOAD_PAUSED: "Upload is paused. Use Resume to continue.",
    INCOMPLETE_UPLOAD: "Upload is incomplete. Upload the missing chunks and try again.",
    FINAL_SHA256_MISMATCH: "Final SHA-256 validation failed. The file may be corrupted.",
    TENANT_STORAGE_QUOTA_EXCEEDED: "Storage quota was exceeded. Try a smaller file or remove old documents.",
    UNSUPPORTED_MEDIA_TYPE: "This file type is not currently supported for OCR.",
    MIME_SIGNATURE_MISMATCH: "The file content does not safely match its extension or MIME value.",
    UPLOAD_SESSION_NOT_FOUND: "Upload session was not found. Start a new upload.",
    UPLOAD_SESSION_NOT_ACTIVE: "Upload session is not active. Start a new upload."
  };
  const dictionary = locale === "tr" ? tr : en;
  const code = Object.keys(dictionary).find((item) => message.includes(item));
  if (code) return dictionary[code]!;
  const friendly = formatUserFacingError(message, locale);
  if (friendly !== message) return friendly;
  return locale === "tr"
    ? "Belge işlemi tamamlanamadı. Dosyayı ve bağlantınızı kontrol edip tekrar deneyin."
    : "The document action could not be completed. Check the file and your connection, then try again.";
}
