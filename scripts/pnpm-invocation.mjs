import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function resolvePnpmInvocation(env = process.env) {
  if (process.platform !== "win32") return { command: "pnpm", args: [] };
  const candidates = [
    resolve(dirname(process.execPath), "node_modules", "corepack", "dist", "pnpm.js"),
    env.npm_execpath,
    env.APPDATA ? resolve(env.APPDATA, "npm", "node_modules", "pnpm", "bin", "pnpm.mjs") : null
  ].filter(Boolean);
  const cliPath = candidates.find((candidate) => existsSync(candidate));
  if (!cliPath) throw new Error("PNPM_CLI_ENTRYPOINT_NOT_FOUND");
  return { command: process.execPath, args: [cliPath] };
}
