import type { JobStatus } from "@prisma/client";

export const reportExportTypes = [
  "expense_ledger_csv",
  "category_breakdown_csv",
  "merchant_spend_csv",
  "monthly_expense_report_pdf",
  "approval_evidence_csv",
  "reimbursement_batch_csv",
  "reimbursement_claim_report_pdf",
  "ocr_quality_report_csv",
  "model_evaluation_report_csv",
  "audit_pack_csv",
  "dataset_export_jsonl"
] as const;
export type ReportExportType = (typeof reportExportTypes)[number];

export type StoredExportJob = {
  id: string;
  tenantId: string;
  workspaceId: string;
  type: string;
  status: JobStatus;
  bucket: string | null;
  objectKey: string | null;
  createdById: string;
  createdAt: Date;
  completedAt: Date | null;
  failureReason: string | null;
};

export type CreateExportJobInput = {
  tenantId: string;
  workspaceId: string;
  type: ReportExportType;
  bucket: string;
  objectKey: string;
  createdById: string;
};

export type ReportRepository = {
  createExportJob(input: CreateExportJobInput): Promise<StoredExportJob>;
  listExportJobs(input: { tenantId: string; workspaceId: string }): Promise<StoredExportJob[]>;
};

export type GeneratedReport = {
  exportJob: StoredExportJob;
  filename: string;
  contentType: "text/csv" | "application/pdf" | "application/x-ndjson";
  sizeBytes: number;
  sha256: string;
  signedUrl: string;
};
