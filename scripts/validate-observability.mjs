import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

const requiredFiles = [
  "ops/prometheus/prometheus.yml",
  "ops/prometheus/rules/spendlens-alerts.yml",
  "ops/grafana/provisioning/datasources/prometheus.yaml",
  "ops/grafana/provisioning/dashboards/spendlens.yaml",
  "ops/grafana/dashboards/spendlens-overview.json",
  "docker-compose.observability.yml"
];

const requiredDashboardExpressions = [
  "spendlens_http_requests_total",
  "spendlens_http_request_duration_seconds_bucket",
  "spendlens_process_resident_memory_bytes",
  "spendlens_event_outbox_events",
  "spendlens_worker_queue_jobs",
  "spendlens_kafka_consumer_lag",
  "spendlens_cache_connected",
  "spendlens_storage_connected",
  "spendlens_ocr_engine_confidence_average",
  "spendlens_review_tasks"
];

const requiredAlerts = [
  "SpendLensApiDown",
  "SpendLensHighHttp5xx",
  "SpendLensFailedOutboxEvents",
  "SpendLensWorkerFailures",
  "SpendLensKafkaLagHigh",
  "SpendLensCacheDisconnected",
  "SpendLensStorageDisconnected"
];

const requiredAlertExpressions = [
  "up{job=\"spendlens-api\"}",
  "spendlens_http_requests_total",
  "spendlens_event_outbox_events",
  "spendlens_worker_jobs",
  "spendlens_kafka_consumer_lag",
  "spendlens_cache_connected",
  "spendlens_storage_connected"
];

const errors = [];

function read(relativePath) {
  try {
    return readFileSync(join(root, relativePath), "utf8");
  } catch (error) {
    errors.push(`Missing ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
    return "";
  }
}

for (const file of requiredFiles) read(file);

const compose = read("docker-compose.observability.yml");
if (!compose.includes("./ops/prometheus:/etc/prometheus:ro")) errors.push("Prometheus rules directory is not mounted in docker-compose.observability.yml.");
if (!compose.includes("./ops/grafana/dashboards:/var/lib/grafana/dashboards:ro")) errors.push("Grafana dashboards directory is not mounted in docker-compose.observability.yml.");
if (!compose.includes("${PROMETHEUS_HOST_PORT:-19090}:9090")) errors.push("Prometheus host port must default to 19090 to avoid common local port conflicts.");
if (!compose.includes("${GRAFANA_HOST_PORT:-13001}:3000")) errors.push("Grafana host port must default to 13001 to avoid common local port conflicts.");
if (!compose.includes("host.docker.internal:host-gateway")) errors.push("Prometheus must include a host.docker.internal host-gateway mapping for Linux-compatible local scrapes.");

const prometheus = read("ops/prometheus/prometheus.yml");
if (!prometheus.includes("rule_files:")) errors.push("Prometheus config does not load rule files.");
if (!prometheus.includes("/etc/prometheus/rules/*.yml")) errors.push("Prometheus config does not include SpendLens alert rule glob.");
if (!prometheus.includes("host.docker.internal:18621")) errors.push("Prometheus config does not scrape the local API metrics endpoint on the default local API port.");

const datasource = read("ops/grafana/provisioning/datasources/prometheus.yaml");
if (!datasource.includes("name: Prometheus")) errors.push("Grafana Prometheus datasource name is missing.");
if (!datasource.includes("uid: Prometheus")) errors.push("Grafana Prometheus datasource uid is missing.");
if (!datasource.includes("url: http://prometheus:9090")) errors.push("Grafana Prometheus datasource URL is missing.");

const dashboardProvider = read("ops/grafana/provisioning/dashboards/spendlens.yaml");
if (!dashboardProvider.includes("path: /var/lib/grafana/dashboards")) errors.push("Grafana dashboard provider path is missing.");

const alerts = read("ops/prometheus/rules/spendlens-alerts.yml");
for (const alert of requiredAlerts) {
  if (!alerts.includes(`alert: ${alert}`)) errors.push(`Missing alert rule ${alert}.`);
}
for (const expression of requiredAlertExpressions) {
  if (!alerts.includes(expression)) errors.push(`Alert rules do not reference ${expression}.`);
}

const dashboardRaw = read("ops/grafana/dashboards/spendlens-overview.json");
let dashboard;
try {
  dashboard = JSON.parse(dashboardRaw);
} catch (error) {
  errors.push(`Grafana dashboard JSON is invalid: ${error instanceof Error ? error.message : String(error)}`);
}

if (dashboard) {
  if (dashboard.uid !== "spendlens-local-ops") errors.push("Grafana dashboard uid must be spendlens-local-ops.");
  if (!Array.isArray(dashboard.panels) || dashboard.panels.length < 8) errors.push("Grafana dashboard must include at least 8 panels.");
  const expressions = dashboard.panels
    .flatMap((panel) => (Array.isArray(panel.targets) ? panel.targets : []))
    .map((target) => target?.expr)
    .filter((expr) => typeof expr === "string")
    .join("\n");
  for (const expression of requiredDashboardExpressions) {
    if (!expressions.includes(expression)) errors.push(`Dashboard does not reference ${expression}.`);
  }
  for (const panel of dashboard.panels ?? []) {
    if (!panel.title) errors.push(`Dashboard panel ${panel.id ?? "unknown"} is missing a title.`);
    if (!panel.datasource || panel.datasource.type !== "prometheus") {
      errors.push(`Dashboard panel ${panel.title ?? panel.id ?? "unknown"} is not using the Prometheus datasource.`);
    }
  }
}

if (errors.length > 0) {
  console.error("Observability validation failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log("Observability validation passed.");
