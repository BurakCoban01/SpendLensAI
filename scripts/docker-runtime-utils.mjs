import { spawnSync } from "node:child_process";

export function inspectDockerRuntime(run = spawnSync) {
  const result = run("docker", ["info", "--format", "{{.ServerVersion}}"], {
    encoding: "utf8",
    windowsHide: true
  });
  if (result?.error?.code === "ENOENT") {
    return { available: false, reason: "cli_missing", detail: "Docker CLI was not found on PATH." };
  }
  if (result?.status !== 0) {
    return {
      available: false,
      reason: "engine_unavailable",
      detail: compactDockerError(result?.stderr || result?.stdout || result?.error?.message)
    };
  }
  return { available: true, reason: null, detail: String(result.stdout ?? "").trim() };
}

export function printDockerRuntimeGuidance(status, prefix = "[dev:ocr]") {
  if (status.available) return;
  if (status.reason === "cli_missing") {
    console.error(`${prefix} Docker CLI bulunamadı. Docker Desktop veya Docker Engine kurulumunu ve PATH ayarını kontrol edin.`);
  } else {
    console.error(`${prefix} Docker engine çalışmıyor veya Linux container engine henüz hazır değil.`);
    console.error(`${prefix} Docker Desktop'ı açın, engine hazır olana kadar bekleyin ve \`docker info\` komutunu doğrulayın.`);
  }
  if (status.detail) console.error(`${prefix} Ayrıntı: ${status.detail}`);
  console.error(`${prefix} Docker hazır olduktan sonra aynı komutu yeniden çalıştırın.`);
}

function compactDockerError(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}
