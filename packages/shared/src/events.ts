export const kafkaTopics = [
  "document.uploaded",
  "ocr.job.created",
  "ocr.preprocessing.completed",
  "ocr.tesseract.completed",
  "ocr.custom_model.completed",
  "ocr.ensemble.completed",
  "extraction.completed",
  "extraction.needs_review",
  "expense.created",
  "expense.updated",
  "expense.approved",
  "expense.rejected",
  "model.training.started",
  "model.training.completed",
  "model.evaluation.completed",
  "annotation.created",
  "audit.event.created",
  "report.generated",
  "webhook.delivery.requested"
] as const;

export type KafkaTopic = (typeof kafkaTopics)[number];

export const eventCatalog: Record<
  KafkaTopic,
  {
    producer: string;
    aggregate: string;
    description: string;
    durable: boolean;
    dlqTopic: string;
  }
> = {
  "document.uploaded": {
    producer: "api.documents",
    aggregate: "DocumentFile",
    description: "A receipt, invoice or other supported document file was accepted and stored.",
    durable: true,
    dlqTopic: "document.uploaded.dlq"
  },
  "ocr.job.created": {
    producer: "api.ocr",
    aggregate: "OCRJob",
    description: "An OCR job was requested for a persisted document.",
    durable: true,
    dlqTopic: "ocr.job.created.dlq"
  },
  "ocr.preprocessing.completed": {
    producer: "worker.preprocessing",
    aggregate: "DocumentPage",
    description: "Image preprocessing finished and page artifacts are ready for OCR.",
    durable: true,
    dlqTopic: "ocr.preprocessing.completed.dlq"
  },
  "ocr.tesseract.completed": {
    producer: "worker.ocr",
    aggregate: "OCREngineRun",
    description: "A Tesseract OCR run completed with text, confidence and artifacts.",
    durable: true,
    dlqTopic: "ocr.tesseract.completed.dlq"
  },
  "ocr.custom_model.completed": {
    producer: "worker.ocr",
    aggregate: "OCREngineRun",
    description: "A custom CRNN OCR run completed with text, confidence and artifacts.",
    durable: true,
    dlqTopic: "ocr.custom_model.completed.dlq"
  },
  "ocr.ensemble.completed": {
    producer: "worker.ocr",
    aggregate: "OCRJob",
    description: "OCR engine comparison and field fusion completed.",
    durable: true,
    dlqTopic: "ocr.ensemble.completed.dlq"
  },
  "extraction.completed": {
    producer: "worker.extraction",
    aggregate: "ExtractionJob",
    description: "Structured extraction completed without critical review blockers.",
    durable: true,
    dlqTopic: "extraction.completed.dlq"
  },
  "extraction.needs_review": {
    producer: "worker.extraction",
    aggregate: "ExtractionJob",
    description: "Structured extraction found validation issues requiring human review.",
    durable: true,
    dlqTopic: "extraction.needs_review.dlq"
  },
  "expense.created": {
    producer: "api.expenses",
    aggregate: "Expense",
    description: "An expense was created manually or from a document extraction.",
    durable: true,
    dlqTopic: "expense.created.dlq"
  },
  "expense.updated": {
    producer: "api.expenses",
    aggregate: "Expense",
    description: "An expense changed outside approval decisions.",
    durable: true,
    dlqTopic: "expense.updated.dlq"
  },
  "expense.approved": {
    producer: "api.expenses",
    aggregate: "Expense",
    description: "An authorized approver approved an expense.",
    durable: true,
    dlqTopic: "expense.approved.dlq"
  },
  "expense.rejected": {
    producer: "api.expenses",
    aggregate: "Expense",
    description: "An authorized approver rejected an expense.",
    durable: true,
    dlqTopic: "expense.rejected.dlq"
  },
  "model.training.started": {
    producer: "worker.model",
    aggregate: "ModelTrainingRun",
    description: "A local custom model training run started.",
    durable: true,
    dlqTopic: "model.training.started.dlq"
  },
  "model.training.completed": {
    producer: "worker.model",
    aggregate: "ModelTrainingRun",
    description: "A local custom model training run completed with metrics or failure details.",
    durable: true,
    dlqTopic: "model.training.completed.dlq"
  },
  "model.evaluation.completed": {
    producer: "worker.model",
    aggregate: "ModelEvaluationRun",
    description: "A local model evaluation run completed with benchmark metrics.",
    durable: true,
    dlqTopic: "model.evaluation.completed.dlq"
  },
  "annotation.created": {
    producer: "api.review",
    aggregate: "Annotation",
    description: "A correction or review action produced a training annotation.",
    durable: true,
    dlqTopic: "annotation.created.dlq"
  },
  "audit.event.created": {
    producer: "api.audit",
    aggregate: "AuditLog",
    description: "A sensitive action was written to the audit trail.",
    durable: true,
    dlqTopic: "audit.event.created.dlq"
  },
  "report.generated": {
    producer: "api.reports",
    aggregate: "ExportJob",
    description: "A report or export artifact was generated and persisted.",
    durable: true,
    dlqTopic: "report.generated.dlq"
  },
  "webhook.delivery.requested": {
    producer: "worker.webhooks",
    aggregate: "WebhookEndpoint",
    description: "A tenant webhook delivery was requested for an event.",
    durable: true,
    dlqTopic: "webhook.delivery.requested.dlq"
  }
};

export type DomainEvent<TPayload extends Record<string, unknown> = Record<string, unknown>> = Readonly<{
  id: string;
  topic: KafkaTopic;
  schemaVersion: number;
  tenantId: string;
  aggregateId: string;
  occurredAt: string;
  correlationId: string;
  payload: TPayload;
}>;

export function isKafkaTopic(value: string): value is KafkaTopic {
  return (kafkaTopics as readonly string[]).includes(value);
}

export function assertKafkaTopic(value: string): KafkaTopic {
  if (!isKafkaTopic(value)) {
    throw new Error("UNKNOWN_KAFKA_TOPIC");
  }
  return value;
}
