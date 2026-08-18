import { execFileSync } from "node:child_process";

const rendered = renderKustomize();
const documents = rendered
  .split(/^---\s*$/m)
  .map((document) => document.trim())
  .filter(Boolean)
  .map((text) => ({
    text,
    kind: matchValue(text, /^kind:\s*(.+)$/m),
    name: matchValue(text, /^\s*name:\s*(.+)$/m)
  }));

const findings = [];

requireDocument("Namespace", "spendlens");
requireDocument("ServiceAccount", "spendlens-runtime");
requireDocument("ConfigMap", "spendlens-config");
requireDocument("Secret", "spendlens-secrets");
requireDocument("HorizontalPodAutoscaler", "spendlens-api");

for (const name of ["postgres", "redis", "redpanda", "minio"]) {
  requireDocument("Service", name);
  requireDocument("StatefulSet", name);
}

for (const name of ["spendlens-api", "spendlens-web", "spendlens-ocr-service"]) {
  requireDocument("Service", name);
  requireDocument("Deployment", name);
}

for (const name of ["spendlens-worker", "spendlens-event-consumer", "spendlens-event-drainer"]) {
  requireDocument("Deployment", name);
}

requireDocument("Job", "spendlens-migrate");
requireDocument("CronJob", "spendlens-cleanup");

for (const name of ["spendlens-api-ingress", "spendlens-web-ingress", "spendlens-ocr-service-ingress"]) {
  requireDocument("NetworkPolicy", name);
}

if (/type:\s*(?:LoadBalancer|NodePort)\b/.test(rendered)) {
  findings.push("Services must stay local-only: LoadBalancer/NodePort service type found.");
}

const runtimeServiceAccount = getDocument("ServiceAccount", "spendlens-runtime");
expectIncludes(runtimeServiceAccount, "automountServiceAccountToken: false", "runtime ServiceAccount disables token automount");

for (const serviceName of ["postgres", "redis", "redpanda", "minio", "spendlens-api", "spendlens-web", "spendlens-ocr-service"]) {
  const service = getDocument("Service", serviceName);
  expectNotMatches(service, /type:\s*(?:LoadBalancer|NodePort)\b/, `${serviceName} remains ClusterIP/local-only`);
}

for (const workload of documents.filter((document) => ["Deployment", "StatefulSet", "Job", "CronJob"].includes(document.kind))) {
  const label = `${workload.kind}/${workload.name}`;
  expectIncludes(workload.text, "serviceAccountName: spendlens-runtime", `${label} uses runtime ServiceAccount`);
  expectIncludes(workload.text, "automountServiceAccountToken: false", `${label} disables pod token automount`);
  expectIncludes(workload.text, "seccompProfile:", `${label} sets pod seccomp profile`);
  expectIncludes(workload.text, "type: RuntimeDefault", `${label} uses RuntimeDefault seccomp`);
  expectIncludes(workload.text, "allowPrivilegeEscalation: false", `${label} disables privilege escalation`);
  expectIncludes(workload.text, "drop:", `${label} drops Linux capabilities`);
  expectIncludes(workload.text, "- ALL", `${label} drops all Linux capabilities`);
  expectIncludes(workload.text, "imagePullPolicy: IfNotPresent", `${label} uses local-cluster image pull policy`);
  expectIncludes(workload.text, "resources:", `${label} declares resources`);
  expectIncludes(workload.text, "requests:", `${label} declares resource requests`);
  expectIncludes(workload.text, "limits:", `${label} declares resource limits`);
}

for (const deploymentName of ["spendlens-api", "spendlens-web", "spendlens-ocr-service"]) {
  const deployment = getDocument("Deployment", deploymentName);
  expectIncludes(deployment, "readinessProbe:", `${deploymentName} has readiness probe`);
  expectIncludes(deployment, "livenessProbe:", `${deploymentName} has liveness probe`);
}

for (const statefulSetName of ["postgres", "redis", "redpanda", "minio"]) {
  const statefulSet = getDocument("StatefulSet", statefulSetName);
  expectIncludes(statefulSet, "readinessProbe:", `${statefulSetName} has readiness probe`);
  expectIncludes(statefulSet, "livenessProbe:", `${statefulSetName} has liveness probe`);
  expectIncludes(statefulSet, "volumeClaimTemplates:", `${statefulSetName} declares persistent storage`);
}

expectIncludes(getDocument("Deployment", "spendlens-worker"), "- apps/api/dist/worker.js", "worker deployment runs dedicated worker entrypoint");
expectIncludes(
  getDocument("Deployment", "spendlens-event-consumer"),
  "apps/api/dist/event-consumer.js",
  "event consumer deployment runs consumer entrypoint"
);
expectIncludes(
  getDocument("Deployment", "spendlens-event-drainer"),
  "- apps/api/dist/event-drainer.js",
  "event drainer deployment runs drainer entrypoint"
);
expectIncludes(getDocument("Deployment", "spendlens-api"), "image: spendlens/api:local", "API deployment uses local API image");
expectIncludes(getDocument("Deployment", "spendlens-worker"), "image: spendlens/api:local", "worker deployment uses local API image");
expectIncludes(
  getDocument("Deployment", "spendlens-event-consumer"),
  "image: spendlens/api:local",
  "event consumer deployment uses local API image"
);
expectIncludes(
  getDocument("Deployment", "spendlens-event-drainer"),
  "image: spendlens/api:local",
  "event drainer deployment uses local API image"
);
expectIncludes(getDocument("Job", "spendlens-migrate"), "image: spendlens/api:local", "migration job uses local API image");
expectIncludes(getDocument("CronJob", "spendlens-cleanup"), "image: spendlens/api:local", "cleanup CronJob uses local API image");
expectIncludes(getDocument("Deployment", "spendlens-web"), "image: spendlens/web:local", "web deployment uses local web image");
expectIncludes(
  getDocument("Deployment", "spendlens-ocr-service"),
  "image: spendlens/ocr-service:local",
  "OCR deployment uses local OCR image"
);
expectIncludes(getDocument("StatefulSet", "postgres"), "image: postgres:16-alpine", "PostgreSQL StatefulSet uses the local Compose image");
expectIncludes(getDocument("StatefulSet", "redis"), "image: redis:7-alpine", "Redis StatefulSet uses the local Compose image");
expectIncludes(
  getDocument("StatefulSet", "redpanda"),
  "image: docker.redpanda.com/redpandadata/redpanda:v24.1.7",
  "Redpanda StatefulSet uses the local Compose image"
);
expectIncludes(
  getDocument("StatefulSet", "redpanda"),
  "--advertise-kafka-addr=PLAINTEXT://redpanda:9092",
  "Redpanda advertises the in-cluster Kafka service address"
);
expectIncludes(
  getDocument("StatefulSet", "minio"),
  "image: minio/minio:RELEASE.2024-05-10T01-41-38Z",
  "MinIO StatefulSet uses the local Compose image"
);

expectIncludes(getDocument("HorizontalPodAutoscaler", "spendlens-api"), "kind: Deployment", "API HPA targets a Deployment");
expectIncludes(getDocument("HorizontalPodAutoscaler", "spendlens-api"), "name: spendlens-api", "API HPA targets spendlens-api");
expectIncludes(getDocument("HorizontalPodAutoscaler", "spendlens-api"), "averageUtilization: 70", "API HPA has CPU target");

expectIncludes(getDocument("NetworkPolicy", "spendlens-api-ingress"), "port: 4000", "API NetworkPolicy scopes port 4000");
expectIncludes(getDocument("NetworkPolicy", "spendlens-web-ingress"), "port: 3000", "web NetworkPolicy scopes port 3000");
expectIncludes(getDocument("NetworkPolicy", "spendlens-ocr-service-ingress"), "port: 8000", "OCR NetworkPolicy scopes port 8000");

const secret = getDocument("Secret", "spendlens-secrets");
for (const key of ["POSTGRES_PASSWORD", "MINIO_ROOT_PASSWORD"]) {
  expectMatches(secret, new RegExp(`${key}: replace_me`), `${key} remains a placeholder`);
}
for (const key of [
  "JWT_ACCESS_SECRET",
  "JWT_REFRESH_SECRET",
  "API_KEY_PEPPER",
  "SESSION_COOKIE_SECRET",
  "WORKER_TENANT_SLUG",
  "WORKER_EMAIL",
  "WORKER_PASSWORD",
  "EVENT_DRAINER_TENANT_SLUG",
  "EVENT_DRAINER_EMAIL",
  "EVENT_DRAINER_PASSWORD"
]) {
  expectMatches(secret, new RegExp(`${key}: replace_me`), `${key} remains a placeholder`);
}
expectMatches(secret, /WORKER_ACCESS_TOKEN: replace_me/, "worker access token remains a placeholder");
expectMatches(secret, /EVENT_DRAINER_ACCESS_TOKEN: replace_me/, "event drainer access token remains a placeholder");

const configMap = getDocument("ConfigMap", "spendlens-config");
expectIncludes(configMap, "OCR_SERVICE_URL: http://spendlens-ocr-service:8000", "API and worker use the in-cluster OCR service URL");
expectIncludes(configMap, "MINIO_BUCKET_DOCUMENTS: spendlens-documents", "document bucket is configured");
expectIncludes(configMap, "MINIO_BUCKET_ARTIFACTS: spendlens-artifacts", "artifact bucket is configured");
expectIncludes(secret, "DATABASE_URL: postgresql://spendlens:replace_me@postgres:5432/spendlens?schema=public", "database URL uses the in-cluster PostgreSQL service");
expectIncludes(secret, "REDIS_URL: redis://redis:6379", "Redis URL uses the in-cluster Redis service");
expectIncludes(secret, "KAFKA_BROKERS: redpanda:9092", "Kafka brokers use the in-cluster Redpanda service");
expectIncludes(secret, "MINIO_ENDPOINT: http://minio:9000", "MinIO endpoint uses the in-cluster MinIO service");

if (findings.length > 0) {
  console.error("Kubernetes validation failed:");
  for (const finding of findings) {
    console.error(`- ${finding}`);
  }
  process.exit(1);
}

console.log(
  `Kubernetes validation passed. ${documents.length} rendered resources checked for local-only services, workload hardening, probes, HPA, NetworkPolicy and secret placeholders.`
);

function renderKustomize() {
  try {
    return execFileSync("kubectl", ["kustomize", "k8s"], { encoding: "utf8" });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    console.error(`Failed to render k8s manifests with kubectl kustomize: ${detail}`);
    process.exit(1);
  }
}

function requireDocument(kind, name) {
  if (!getDocument(kind, name)) {
    findings.push(`Missing ${kind}/${name}.`);
  }
}

function getDocument(kind, name) {
  return documents.find((document) => document.kind === kind && document.name === name)?.text ?? "";
}

function expectIncludes(text, snippet, label) {
  if (!text.includes(snippet)) {
    findings.push(`${label}: expected to include ${JSON.stringify(snippet)}.`);
  }
}

function expectMatches(text, regex, label) {
  if (!regex.test(text)) {
    findings.push(`${label}: expected ${regex}.`);
  }
}

function expectNotMatches(text, regex, label) {
  if (regex.test(text)) {
    findings.push(`${label}: forbidden ${regex}.`);
  }
}

function matchValue(text, regex) {
  const match = text.match(regex);
  return match?.[1]?.trim() ?? "";
}
