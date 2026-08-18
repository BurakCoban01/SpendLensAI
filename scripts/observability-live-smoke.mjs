const prometheusUrl = process.env.PROMETHEUS_URL ?? `http://localhost:${process.env.PROMETHEUS_HOST_PORT ?? "19090"}`;
const grafanaUrl = process.env.GRAFANA_URL ?? `http://localhost:${process.env.GRAFANA_HOST_PORT ?? "13001"}`;
const apiMetricsUrl = process.env.API_METRICS_URL ?? `http://localhost:${process.env.API_PORT ?? "18621"}/metrics`;
const grafanaUser = process.env.GRAFANA_ADMIN_USER ?? "admin";
const grafanaPassword = process.env.GRAFANA_ADMIN_PASSWORD ?? "spendlens-local-admin";

const requiredMetricNames = ["spendlens_api_info", "spendlens_process_resident_memory_bytes", "spendlens_http_requests_total"];
const requiredAlerts = [
  "SpendLensApiDown",
  "SpendLensHighHttp5xx",
  "SpendLensFailedOutboxEvents",
  "SpendLensWorkerFailures",
  "SpendLensKafkaLagHigh",
  "SpendLensCacheDisconnected",
  "SpendLensStorageDisconnected"
];

async function main() {
  const metrics = await getText(apiMetricsUrl, "API metrics endpoint");
  for (const metricName of requiredMetricNames) {
    if (!metrics.includes(metricName)) throw new Error(`API metrics output is missing ${metricName}.`);
  }

  await waitForPrometheusScrape();

  const rules = await getJson(`${prometheusUrl}/api/v1/rules`, "Prometheus rules API");
  const alertNames = JSON.stringify(rules.data ?? {});
  for (const alert of requiredAlerts) {
    if (!alertNames.includes(alert)) throw new Error(`Prometheus did not load alert rule ${alert}.`);
  }

  const datasource = await getJson(`${grafanaUrl}/api/datasources/uid/Prometheus`, "Grafana Prometheus datasource", {
    headers: authHeaders()
  });
  if (datasource.type !== "prometheus" || datasource.url !== "http://prometheus:9090") {
    throw new Error("Grafana Prometheus datasource is not provisioned with the expected internal URL.");
  }

  const dashboard = await getJson(`${grafanaUrl}/api/dashboards/uid/spendlens-local-ops`, "Grafana dashboard", {
    headers: authHeaders()
  });
  if (dashboard?.dashboard?.uid !== "spendlens-local-ops") {
    throw new Error("Grafana SpendLens dashboard is not provisioned.");
  }

  console.log("Observability live smoke passed.");
}

async function waitForPrometheusScrape() {
  const queryUrl = `${prometheusUrl}/api/v1/query?query=${encodeURIComponent('up{job="spendlens-api"}')}`;
  const deadline = Date.now() + Number(process.env.OBSERVABILITY_SMOKE_TIMEOUT_MS ?? 60000);
  let lastError = "";

  while (Date.now() < deadline) {
    try {
      const result = await getJson(queryUrl, "Prometheus API scrape query");
      const values = result?.data?.result ?? [];
      const isUp = values.some((sample) => Array.isArray(sample.value) && sample.value[1] === "1");
      if (isUp) return;
      lastError = `query returned ${JSON.stringify(values)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(3000);
  }

  throw new Error(`Prometheus did not scrape spendlens-api as up before timeout: ${lastError}`);
}

async function getText(url, label, options = {}) {
  const response = await fetchWithTimeout(url, options);
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status} from ${url}.`);
  return response.text();
}

async function getJson(url, label, options = {}) {
  const response = await fetchWithTimeout(url, options);
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status} from ${url}.`);
  return response.json();
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.OBSERVABILITY_SMOKE_REQUEST_TIMEOUT_MS ?? 20000));
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function authHeaders() {
  const token = Buffer.from(`${grafanaUser}:${grafanaPassword}`, "utf8").toString("base64");
  return { Authorization: `Basic ${token}` };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
