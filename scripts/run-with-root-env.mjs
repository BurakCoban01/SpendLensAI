import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { resolvePnpmInvocation } from "./pnpm-invocation.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [packageDir, command, ...args] = process.argv.slice(2);

if (!packageDir || !command) {
  console.error("Usage: node scripts/run-with-root-env.mjs <package-dir> <command> [...args]");
  process.exit(1);
}

const env = loadRootEnv();
const pnpm = resolvePnpmInvocation(env);
const child = spawn(pnpm.command, [...pnpm.args, "--dir", resolve(rootDir, packageDir), "exec", command, ...args], {
  cwd: rootDir,
  env,
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

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
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && env[key] === undefined) env[key] = value;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return env;
}
