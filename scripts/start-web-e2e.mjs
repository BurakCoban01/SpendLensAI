import { spawn } from "node:child_process";

const webPort = process.env.SPENDLENS_E2E_WEB_PORT ?? "3000";
const apiPort = process.env.SPENDLENS_E2E_API_PORT ?? "4100";
const apiBaseUrl = process.env.SPENDLENS_E2E_API_BASE_URL ?? `http://127.0.0.1:${apiPort}`;

const child = spawn("pnpm", ["--filter", "@spendlens/web", "dev"], {
  env: {
    ...process.env,
    NEXT_DIST_DIR: process.env.SPENDLENS_E2E_NEXT_DIST_DIR ?? ".next-e2e",
    PORT: webPort,
    WEB_PORT: webPort,
    NEXT_PUBLIC_API_BASE_URL: apiBaseUrl
  },
  shell: true,
  stdio: "inherit"
});

function stop(signal) {
  child.kill(signal);
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
child.on("exit", (code) => process.exit(code ?? 0));
