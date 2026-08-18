type Labels = Record<string, string>;

type CounterSample = {
  value: number;
  labels: Labels;
};

type HistogramSample = {
  labels: Labels;
  count: number;
  sum: number;
  buckets: Map<number, number>;
};

type EventMetricsInput = {
  outboxByState: Array<{ state?: string; count: number }>;
  outboxByTopicState: Array<{ topic?: string; state?: string; count: number }>;
  inboxByStatus: Array<{ status?: string; count: number }>;
  inboxByTopicStatus: Array<{ topic?: string; status?: string; count: number }>;
  kafkaConsumerLag?: {
    samples: Array<{
      groupId?: string;
      topic?: string;
      partition?: number;
      currentOffset?: number;
      highWatermark?: number;
      lag?: number;
    }>;
  };
};

type JobMetricsInput = {
  jobsByStatus: Array<{ status?: string; count: number }>;
  jobsByQueueStatus: Array<{ queue?: string; status?: string; count: number }>;
  failedJobsByQueueWorker: Array<{ queue?: string; workerId?: string | null; count: number }>;
};

type CacheMetricsInput = {
  health: {
    backend: string;
    connected: boolean;
  };
  workerHotStateKeys: number;
  operationErrors: Array<{ operation?: string; count: number }>;
};

type StorageMetricsInput = {
  health: {
    backend: string;
    connected: boolean;
  };
  storedObjectCount?: number;
  operationErrors: Array<{ operation?: string; count: number }>;
};

type OcrMetricsInput = {
  runsByEngineStatus: Array<{ engine?: string; status?: string; count?: number }>;
  confidenceByEngine: Array<{ engine?: string; averageConfidence?: number | null }>;
  latencyByEngine: Array<{ engine?: string; averageLatencyMs?: number | null }>;
};

type ReviewMetricsInput = {
  tasksByStatus: Array<{ status?: string; count: number }>;
  correctionCount: number;
  annotationCount: number;
  activeLearningSuggestionCount: number;
  correctionRate: number;
};

const httpDurationBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export class MetricsRegistry {
  private readonly counters = new Map<string, CounterSample>();
  private readonly histograms = new Map<string, HistogramSample>();
  private readonly startedAt = Date.now();

  recordHttpRequest(input: { method: string; route: string; statusCode: number; durationSeconds: number }): void {
    const labels = {
      method: input.method,
      route: normalizeRoute(input.route),
      status_code: String(input.statusCode)
    };
    this.incrementCounter("spendlens_http_requests_total", labels);
    this.observeHistogram("spendlens_http_request_duration_seconds", labels, input.durationSeconds);
  }

  render(
    input: {
      events?: EventMetricsInput;
      jobs?: JobMetricsInput;
      cache?: CacheMetricsInput;
      storage?: StorageMetricsInput;
      ocr?: OcrMetricsInput;
      review?: ReviewMetricsInput;
    } = {}
  ): string {
    const memory = process.memoryUsage();
    const lines = [
      "# HELP spendlens_api_info Static API process info.",
      "# TYPE spendlens_api_info gauge",
      'spendlens_api_info{service="api"} 1',
      "# HELP spendlens_process_uptime_seconds API process uptime in seconds.",
      "# TYPE spendlens_process_uptime_seconds gauge",
      `spendlens_process_uptime_seconds ${((Date.now() - this.startedAt) / 1000).toFixed(3)}`,
      "# HELP spendlens_process_resident_memory_bytes API resident memory in bytes.",
      "# TYPE spendlens_process_resident_memory_bytes gauge",
      `spendlens_process_resident_memory_bytes ${memory.rss}`,
      "# HELP spendlens_process_heap_used_bytes API heap used in bytes.",
      "# TYPE spendlens_process_heap_used_bytes gauge",
      `spendlens_process_heap_used_bytes ${memory.heapUsed}`,
      "# HELP spendlens_http_requests_total Total HTTP requests handled by the API.",
      "# TYPE spendlens_http_requests_total counter",
      ...[...this.counters.values()].map((sample) => formatMetric("spendlens_http_requests_total", sample.labels, sample.value)),
      "# HELP spendlens_http_request_duration_seconds HTTP request duration in seconds.",
      "# TYPE spendlens_http_request_duration_seconds histogram",
      ...this.renderHistograms(),
      ...renderEventMetrics(input.events),
      ...renderJobMetrics(input.jobs),
      ...renderCacheMetrics(input.cache),
      ...renderStorageMetrics(input.storage),
      ...renderOcrMetrics(input.ocr),
      ...renderReviewMetrics(input.review)
    ];
    return `${lines.join("\n")}\n`;
  }

  private incrementCounter(name: string, labels: Labels): void {
    const key = metricKey(name, labels);
    const existing = this.counters.get(key);
    if (existing) {
      existing.value += 1;
      return;
    }
    this.counters.set(key, { labels, value: 1 });
  }

  private observeHistogram(name: string, labels: Labels, value: number): void {
    const key = metricKey(name, labels);
    const existing = this.histograms.get(key);
    const histogram =
      existing ??
      ({
        labels,
        count: 0,
        sum: 0,
        buckets: new Map(httpDurationBuckets.map((bucket) => [bucket, 0]))
      } satisfies HistogramSample);
    histogram.count += 1;
    histogram.sum += value;
    for (const bucket of httpDurationBuckets) {
      if (value <= bucket) histogram.buckets.set(bucket, (histogram.buckets.get(bucket) ?? 0) + 1);
    }
    if (!existing) this.histograms.set(key, histogram);
  }

  private renderHistograms(): string[] {
    const lines: string[] = [];
    for (const histogram of this.histograms.values()) {
      for (const bucket of httpDurationBuckets) {
        lines.push(
          formatMetric(
            "spendlens_http_request_duration_seconds_bucket",
            { ...histogram.labels, le: String(bucket) },
            histogram.buckets.get(bucket) ?? 0
          )
        );
      }
      lines.push(
        formatMetric("spendlens_http_request_duration_seconds_bucket", { ...histogram.labels, le: "+Inf" }, histogram.count)
      );
      lines.push(formatMetric("spendlens_http_request_duration_seconds_sum", histogram.labels, histogram.sum));
      lines.push(formatMetric("spendlens_http_request_duration_seconds_count", histogram.labels, histogram.count));
    }
    return lines;
  }
}

function renderOcrMetrics(ocr?: OcrMetricsInput): string[] {
  if (!ocr) return [];
  return [
    "# HELP spendlens_ocr_engine_runs Current OCR engine run count by engine and status.",
    "# TYPE spendlens_ocr_engine_runs gauge",
    ...ocr.runsByEngineStatus.map((sample) =>
      formatMetric("spendlens_ocr_engine_runs", { engine: sample.engine ?? "unknown", status: sample.status ?? "unknown" }, sample.count ?? 0)
    ),
    "# HELP spendlens_ocr_engine_confidence_average Average OCR confidence by engine.",
    "# TYPE spendlens_ocr_engine_confidence_average gauge",
    ...ocr.confidenceByEngine.map((sample) =>
      formatMetric("spendlens_ocr_engine_confidence_average", { engine: sample.engine ?? "unknown" }, sample.averageConfidence ?? 0)
    ),
    "# HELP spendlens_ocr_engine_latency_ms_average Average OCR latency in milliseconds by engine.",
    "# TYPE spendlens_ocr_engine_latency_ms_average gauge",
    ...ocr.latencyByEngine.map((sample) =>
      formatMetric("spendlens_ocr_engine_latency_ms_average", { engine: sample.engine ?? "unknown" }, sample.averageLatencyMs ?? 0)
    )
  ];
}

function renderReviewMetrics(review?: ReviewMetricsInput): string[] {
  if (!review) return [];
  return [
    "# HELP spendlens_review_tasks Current OCR review task count by status.",
    "# TYPE spendlens_review_tasks gauge",
    ...review.tasksByStatus.map((sample) => formatMetric("spendlens_review_tasks", { status: sample.status ?? "unknown" }, sample.count)),
    "# HELP spendlens_review_corrections Current OCR correction count.",
    "# TYPE spendlens_review_corrections gauge",
    formatMetric("spendlens_review_corrections", {}, review.correctionCount),
    "# HELP spendlens_review_annotations Current annotation count created from review workflows.",
    "# TYPE spendlens_review_annotations gauge",
    formatMetric("spendlens_review_annotations", {}, review.annotationCount),
    "# HELP spendlens_review_active_learning_suggestions Current active-learning suggestion count.",
    "# TYPE spendlens_review_active_learning_suggestions gauge",
    formatMetric("spendlens_review_active_learning_suggestions", {}, review.activeLearningSuggestionCount),
    "# HELP spendlens_review_correction_rate OCR corrections per completed review task.",
    "# TYPE spendlens_review_correction_rate gauge",
    formatMetric("spendlens_review_correction_rate", {}, review.correctionRate)
  ];
}

function renderJobMetrics(jobs?: JobMetricsInput): string[] {
  if (!jobs) return [];
  return [
    "# HELP spendlens_worker_jobs Current durable worker job count by status.",
    "# TYPE spendlens_worker_jobs gauge",
    ...jobs.jobsByStatus.map((sample) => formatMetric("spendlens_worker_jobs", { status: sample.status ?? "unknown" }, sample.count)),
    "# HELP spendlens_worker_queue_jobs Current durable worker job count by queue and status.",
    "# TYPE spendlens_worker_queue_jobs gauge",
    ...jobs.jobsByQueueStatus.map((sample) =>
      formatMetric("spendlens_worker_queue_jobs", { queue: sample.queue ?? "unknown", status: sample.status ?? "unknown" }, sample.count)
    ),
    "# HELP spendlens_worker_failed_jobs Current failed worker job count by queue and last processing worker.",
    "# TYPE spendlens_worker_failed_jobs gauge",
    ...jobs.failedJobsByQueueWorker.map((sample) =>
      formatMetric(
        "spendlens_worker_failed_jobs",
        { queue: sample.queue ?? "unknown", worker: sample.workerId ?? "unknown" },
        sample.count
      )
    )
  ];
}

function renderCacheMetrics(cache?: CacheMetricsInput): string[] {
  if (!cache) return [];
  const labels = { backend: cache.health.backend };
  return [
    "# HELP spendlens_cache_connected Cache backend connectivity status.",
    "# TYPE spendlens_cache_connected gauge",
    formatMetric("spendlens_cache_connected", labels, cache.health.connected ? 1 : 0),
    "# HELP spendlens_cache_worker_hot_state_keys Worker job hot-state key count visible in cache.",
    "# TYPE spendlens_cache_worker_hot_state_keys gauge",
    formatMetric("spendlens_cache_worker_hot_state_keys", labels, cache.workerHotStateKeys),
    "# HELP spendlens_cache_operation_errors_total Cache backend operation errors observed by this API process.",
    "# TYPE spendlens_cache_operation_errors_total counter",
    ...cache.operationErrors.map((sample) =>
      formatMetric(
        "spendlens_cache_operation_errors_total",
        { ...labels, operation: sample.operation ?? "unknown" },
        sample.count
      )
    )
  ];
}

function renderStorageMetrics(storage?: StorageMetricsInput): string[] {
  if (!storage) return [];
  const labels = { backend: storage.health.backend };
  return [
    "# HELP spendlens_storage_connected Object storage backend connectivity status.",
    "# TYPE spendlens_storage_connected gauge",
    formatMetric("spendlens_storage_connected", labels, storage.health.connected ? 1 : 0),
    "# HELP spendlens_storage_objects Current object count when the storage backend can report it.",
    "# TYPE spendlens_storage_objects gauge",
    ...(typeof storage.storedObjectCount === "number"
      ? [formatMetric("spendlens_storage_objects", labels, storage.storedObjectCount)]
      : []),
    "# HELP spendlens_storage_operation_errors_total Object storage operation errors observed by this API process.",
    "# TYPE spendlens_storage_operation_errors_total counter",
    ...storage.operationErrors.map((sample) =>
      formatMetric(
        "spendlens_storage_operation_errors_total",
        { ...labels, operation: sample.operation ?? "unknown" },
        sample.count
      )
    )
  ];
}

function renderEventMetrics(events?: EventMetricsInput): string[] {
  if (!events) return [];
  return [
    "# HELP spendlens_event_outbox_events Current durable outbox event count by state.",
    "# TYPE spendlens_event_outbox_events gauge",
    ...events.outboxByState.map((sample) => formatMetric("spendlens_event_outbox_events", { state: sample.state ?? "unknown" }, sample.count)),
    "# HELP spendlens_event_outbox_topic_events Current durable outbox event count by topic and state.",
    "# TYPE spendlens_event_outbox_topic_events gauge",
    ...events.outboxByTopicState.map((sample) =>
      formatMetric("spendlens_event_outbox_topic_events", { state: sample.state ?? "unknown", topic: sample.topic ?? "unknown" }, sample.count)
    ),
    "# HELP spendlens_event_inbox_events Current consumer inbox event count by status.",
    "# TYPE spendlens_event_inbox_events gauge",
    ...events.inboxByStatus.map((sample) => formatMetric("spendlens_event_inbox_events", { status: sample.status ?? "unknown" }, sample.count)),
    "# HELP spendlens_event_inbox_topic_events Current consumer inbox event count by topic and status.",
    "# TYPE spendlens_event_inbox_topic_events gauge",
    ...events.inboxByTopicStatus.map((sample) =>
      formatMetric("spendlens_event_inbox_topic_events", { status: sample.status ?? "unknown", topic: sample.topic ?? "unknown" }, sample.count)
    ),
    ...renderKafkaLagMetrics(events.kafkaConsumerLag)
  ];
}

function renderKafkaLagMetrics(lag?: NonNullable<EventMetricsInput["kafkaConsumerLag"]>): string[] {
  if (!lag) return [];
  return [
    "# HELP spendlens_kafka_consumer_lag Current Kafka consumer lag by configured group, topic and partition.",
    "# TYPE spendlens_kafka_consumer_lag gauge",
    ...lag.samples.map((sample) =>
      formatMetric(
        "spendlens_kafka_consumer_lag",
        {
          group: sample.groupId ?? "unknown",
          topic: sample.topic ?? "unknown",
          partition: String(sample.partition ?? 0)
        },
        sample.lag ?? 0
      )
    ),
    "# HELP spendlens_kafka_consumer_committed_offset Current Kafka committed consumer offset by configured group, topic and partition.",
    "# TYPE spendlens_kafka_consumer_committed_offset gauge",
    ...lag.samples.map((sample) =>
      formatMetric(
        "spendlens_kafka_consumer_committed_offset",
        {
          group: sample.groupId ?? "unknown",
          topic: sample.topic ?? "unknown",
          partition: String(sample.partition ?? 0)
        },
        sample.currentOffset ?? 0
      )
    ),
    "# HELP spendlens_kafka_topic_high_watermark Current Kafka topic high watermark by configured group, topic and partition.",
    "# TYPE spendlens_kafka_topic_high_watermark gauge",
    ...lag.samples.map((sample) =>
      formatMetric(
        "spendlens_kafka_topic_high_watermark",
        {
          group: sample.groupId ?? "unknown",
          topic: sample.topic ?? "unknown",
          partition: String(sample.partition ?? 0)
        },
        sample.highWatermark ?? 0
      )
    )
  ];
}

function normalizeRoute(route: string): string {
  if (!route) return "unmatched";
  return route.split("?")[0] || "unmatched";
}

function metricKey(name: string, labels: Labels): string {
  return `${name}:${Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join(",")}`;
}

function formatMetric(name: string, labels: Labels, value: number): string {
  const formattedLabels = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, labelValue]) => `${key}="${escapeLabel(labelValue)}"`)
    .join(",");
  const sample = Number.isInteger(value) ? value : value.toFixed(6);
  return formattedLabels ? `${name}{${formattedLabels}} ${sample}` : `${name} ${sample}`;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}
