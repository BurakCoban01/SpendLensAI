# Kubernetes

Local clusters supported by the manifests:

- kind
- k3d
- minikube

The manifests are local-cluster templates only. They do not deploy anything publicly and they do not contain real secrets.

Render and inspect the full manifest bundle:

```bash
kubectl kustomize k8s
```

Run the local manifest invariant gate:

```bash
pnpm k8s:validate
```

The validation command renders the bundle and checks that services stay local-only, local dependency StatefulSets exist, workloads use the runtime ServiceAccount with token automount disabled, hardened security contexts and resource requests/limits are present, API/web/OCR/dependency probes exist, the API HPA and NetworkPolicies are present, in-cluster dependency URLs are wired and secret values remain placeholders.

Build local workload images and load them into a local cluster:

```bash
pnpm k8s:images -- --cluster kind --cluster-name spendlens
pnpm k8s:images -- --cluster k3d --cluster-name spendlens
pnpm k8s:images -- --cluster minikube
```

Use `pnpm k8s:images -- --dry-run` to print the Docker build and cluster image-load commands without requiring Docker or an active cluster. Use `--build-only` to build images without loading them, or `--load-only` after the images already exist locally.

k3d lifecycle helpers are available for the private local validation cluster:

```bash
pnpm k3d:status
pnpm k3d:up
pnpm k3d:down
pnpm k3d:delete -- -ConfirmDelete
```

`pnpm k3d:status` reports local tool availability, `k3d-spendlens-*` Docker containers, kube contexts and Kubernetes resources. `pnpm k3d:up` starts an existing `spendlens` cluster or creates a new local one bound to `127.0.0.1:53428`; it does not apply manifests or inject secrets. `pnpm k3d:down` stops the cluster without deleting containers, volumes or kubeconfig entries. `pnpm k3d:delete` is destructive and refuses to run unless `-ConfirmDelete` is passed.

The `k3d-spendlens-server-0` and `k3d-spendlens-serverlb` containers are k3d infrastructure for the optional Kubernetes validation path. They are not Docker Compose application services and they are not required for the normal local development flow.

Apply the bundle to an existing local cluster only after replacing secret placeholders:

```bash
kubectl apply -k k8s
```

For browser access during local testing, port-forward both services:

```bash
kubectl -n spendlens port-forward svc/spendlens-api 4000:4000
kubectl -n spendlens port-forward svc/spendlens-web 3000:3000
```

The secret manifest is a template only. Replace local values before applying and do not commit real secrets.

Docker Compose remains the primary local development path:

```bash
pnpm dev:up
pnpm dev
pnpm dev:down
```

Use the k3d path only when validating Kubernetes ownership/readiness. A healthy k3d validation must show the `spendlens` cluster as `1/1` server ready and `kubectl --context k3d-spendlens get nodes,pods,svc -A` must return live resources without timeout. If `k3d` is missing from `PATH`, install/restore the CLI first; if Docker containers exist but kubectl cannot reach `https://host.docker.internal:53428`, repair or recreate the local k3d cluster before claiming live Kubernetes readiness.

Current Kubernetes hardening includes:

- a `kustomization.yaml` entry point
- namespace-level common app labels
- local-cluster PostgreSQL, Redis, Redpanda and MinIO StatefulSets with ClusterIP services and PVC templates
- a runtime ServiceAccount with token automount disabled
- ClusterIP services only
- readiness/liveness probes for API, web, OCR service and local dependencies
- a separate `spendlens-worker` Deployment that runs `node apps/api/dist/worker.js`
- a separate `spendlens-event-consumer` Deployment that runs `node apps/api/dist/event-consumer.js`
- a separate `spendlens-event-drainer` Deployment that runs `node apps/api/dist/event-drainer.js`
- CPU/memory requests and limits
- pod seccomp profile set to `RuntimeDefault`
- container privilege escalation disabled and Linux capabilities dropped
- port-scoped NetworkPolicy templates for API, web and OCR pods
- an automated `pnpm k8s:validate` render and hardening check
- a local image build/load helper through `pnpm k8s:images`

The app manifests include local PostgreSQL, Redis, Redpanda/Kafka and MinIO dependencies for private local clusters. `spendlens-secrets` still owns all credentials and connection strings, including `DATABASE_URL`, `REDIS_URL`, `KAFKA_BROKERS`, `MINIO_ENDPOINT`, `POSTGRES_PASSWORD` and `MINIO_ROOT_PASSWORD`; replace the placeholders before applying. The worker can use `WORKER_ACCESS_TOKEN` or the `WORKER_TENANT_SLUG`/`WORKER_EMAIL`/`WORKER_PASSWORD` login trio. The event consumer uses `KAFKA_BROKERS` plus the `EVENT_CONSUMER_*` config values from `spendlens-config`. The event drainer uses `EVENT_DRAINER_*` config values and either `EVENT_DRAINER_ACCESS_TOKEN` or the drainer login trio from `spendlens-secrets`. On 2026-05-20, the bundle was live-verified on a local k3d cluster with API/web/OCR image build/import, dependency StatefulSet readiness, app Deployment rollouts, migration Job completion and HPA CPU metrics. On 2026-06-03, `pnpm k3d:status` found `k3d` missing from `PATH`, exited `k3d-spendlens-server-0` / `k3d-spendlens-serverlb` containers, and an unreachable `k3d-spendlens` kube context timing out against `https://host.docker.internal:53428`. Classify the current k3d state as optional Kubernetes validation infrastructure requiring repair or explicit deletion by the user, not as a normal Docker Compose app service and not as current final readiness proof.
