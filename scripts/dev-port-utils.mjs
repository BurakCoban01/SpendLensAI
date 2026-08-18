import { readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function localDevPorts() {
  const env = loadRootEnv();
  return [
    { label: "web", port: Number(env.WEB_PORT || 18620) },
    { label: "api", port: Number(env.API_PORT || 18621) }
  ].filter((entry) => Number.isInteger(entry.port) && entry.port > 0);
}

export function findPortListeners(ports = localDevPorts()) {
  const listeners = process.platform === "win32" ? findWindowsListeners(ports) : findPosixListeners(ports);
  return annotateComposeListeners(listeners, dockerComposePortOwners(ports));
}

export function printPortGuidance(listeners) {
  if (listeners.length === 0) {
    console.log("[dev-ports] SpendLensAI web/API development ports are free.");
    return;
  }
  console.error("[dev-ports] One or more SpendLensAI development ports are already in use.");
  for (const listener of listeners) {
    if (listener.composeService) {
      console.error(
        `[dev-ports] ${listener.label} port ${listener.port}, Docker Compose \`${listener.composeService}\` servisi tarafından yayınlanıyor.`
      );
      continue;
    }
    const pid = listener.pid ? ` PID ${listener.pid}` : " an unknown PID";
    console.error(`[dev-ports] ${listener.label} port ${listener.port} is listening on${pid}.`);
  }
  const composeListeners = listeners.filter((listener) => listener.composeService);
  const processListeners = listeners.filter((listener) => !listener.composeService);
  if (composeListeners.length > 0) {
    console.error("[dev-ports] Docker tarafından yayınlanan portun PID'sini sonlandırmayın; bu işlem Docker engine'i kapatabilir.");
    console.error("[dev-ports] Container uygulamasını kullanacaksanız SpendLensAI zaten bu portlarda çalışıyor; `pnpm dev` gerekmez.");
    console.error("[dev-ports] Hot-reload geliştirmeye geçmek için yalnız uygulama container'larını durdurun:");
    console.error("  docker compose --profile app stop web worker event-consumer api");
    console.error("[dev-ports] PostgreSQL, Redis, Redpanda, MinIO ve OCR servisi çalışmaya devam eder; ardından `pnpm dev` çalıştırın.");
  }
  if (processListeners.length === 0) return;
  console.error("[dev-ports] Docker dışındaki dinleyici önceki bir API/web geliştirme süreci olabilir.");
  console.error("[dev-ports] Inspect current listeners with: pnpm dev:ports");
  if (process.platform === "win32") {
    console.error("[dev-ports] Windows inspect command:");
    console.error(
      `  Get-NetTCPConnection -LocalPort ${[...new Set(processListeners.map((listener) => listener.port))].join(",")} -State Listen | Select-Object LocalPort,OwningProcess`
    );
    console.error("[dev-ports] Stop a confirmed old SpendLensAI process with confirmation:");
    console.error("  Stop-Process -Id <PID> -Confirm");
  } else {
    console.error("[dev-ports] Inspect command:");
    console.error("  lsof -nP -iTCP:18620 -iTCP:18621 -sTCP:LISTEN");
    console.error("[dev-ports] Stop only a confirmed old SpendLensAI process:");
    console.error("  kill <PID>");
  }
  console.error("[dev-ports] If the listener is unrelated, change WEB_PORT or API_PORT in .env and rerun pnpm dev.");
}

export function parseComposePsOutput(output) {
  const text = String(output ?? "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return text
      .split(/\r?\n/)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }
}

export function annotateComposeListeners(listeners, composeOwners) {
  return listeners.map((listener) => ({
    ...listener,
    composeService: composeOwners.get(listener.port) ?? null
  }));
}

function loadRootEnv() {
  const env = { ...process.env };
  const envPath = resolve(rootDir, ".env");
  try {
    const text = readFileSync(envPath, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const separator = line.indexOf("=");
      if (separator === -1) continue;
      const key = line.slice(0, separator).trim();
      let value = line.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (key && env[key] === undefined) env[key] = value;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return env;
}

function findWindowsListeners(ports) {
  let output = "";
  try {
    output = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" });
  } catch {
    return [];
  }
  const wanted = new Map(ports.map((entry) => [entry.port, entry.label]));
  const listeners = [];
  for (const line of output.split(/\r?\n/)) {
    if (!/\bLISTENING\b/i.test(line)) continue;
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5) continue;
    const localAddress = columns[1] ?? "";
    const pid = columns[4] ?? "";
    const port = Number(localAddress.match(/:(\d+)$/)?.[1]);
    if (!wanted.has(port)) continue;
    listeners.push({ port, label: wanted.get(port), pid });
  }
  return dedupeListeners(listeners);
}

function findPosixListeners(ports) {
  const listeners = [];
  for (const entry of ports) {
    try {
      const output = execFileSync("lsof", ["-nP", `-iTCP:${entry.port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
      for (const line of output.split(/\r?\n/).slice(1)) {
        const columns = line.trim().split(/\s+/);
        if (columns[1]) listeners.push({ ...entry, pid: columns[1] });
      }
    } catch {
      // lsof may be unavailable or the port may be free.
    }
  }
  return dedupeListeners(listeners);
}

function dockerComposePortOwners(ports) {
  const wanted = new Set(ports.map((entry) => entry.port));
  const result = spawnSync("docker", ["compose", "ps", "--format", "json"], {
    cwd: rootDir,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0) return new Map();
  const owners = new Map();
  for (const service of parseComposePsOutput(result.stdout)) {
    if (String(service.State ?? "").toLowerCase() !== "running") continue;
    for (const publisher of Array.isArray(service.Publishers) ? service.Publishers : []) {
      const port = Number(publisher.PublishedPort);
      if (wanted.has(port)) owners.set(port, String(service.Service ?? service.Name ?? "unknown"));
    }
  }
  return owners;
}

function dedupeListeners(listeners) {
  const seen = new Set();
  return listeners.filter((listener) => {
    const key = `${listener.port}:${listener.pid}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
