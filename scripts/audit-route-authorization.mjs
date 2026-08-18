import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const sourceRoot = join(root, "apps", "api", "src");
const routePattern = /app\.(get|post|patch|put|delete)\(\s*["'`]([^"'`]+)["'`]/g;

const publicRoutes = new Set([
  "GET /catalog",
  "GET /metrics",
  "GET /health/live",
  "GET /health/ready",
  "POST /auth/register",
  "POST /auth/login",
  "POST /auth/refresh",
  "POST /auth/logout"
]);

const authOnlyRoutes = new Set([
  "GET /auth/me",
  "GET /auth/sessions",
  "POST /auth/logout-all",
  "GET /workspaces",
  "GET /notifications",
  "POST /notifications/:id/read"
]);

const findings = [];
let checked = 0;
let publicCount = 0;
let authOnlyCount = 0;
let permissionCount = 0;

for (const file of listSourceFiles(sourceRoot)) {
  const text = readFileSync(file, "utf8");
  const routes = [...text.matchAll(routePattern)];
  for (let index = 0; index < routes.length; index += 1) {
    const route = routes[index];
    const method = String(route[1]).toUpperCase();
    const path = route[2];
    const key = `${method} ${path}`;
    const start = route.index ?? 0;
    const end = index + 1 < routes.length ? routes[index + 1].index ?? text.length : text.length;
    const block = text.slice(start, end);
    const location = `${relative(root, file).replace(/\\/g, "/")}:${lineNumber(text, start)}`;

    checked += 1;

    if (publicRoutes.has(key)) {
      publicCount += 1;
      continue;
    }

    const hasAuthentication =
      block.includes("authenticateRequest(") ||
      block.includes("apiKeys.authenticate(");

    const hasPermission =
      block.includes("requirePermission(") ||
      block.includes("requireAnyPermission(");

    if (!hasAuthentication) {
      findings.push({ key, location, issue: "missing authentication guard" });
    }

    if (authOnlyRoutes.has(key)) {
      authOnlyCount += 1;
      continue;
    }

    if (!hasPermission) {
      findings.push({ key, location, issue: "missing route permission guard" });
      continue;
    }

    permissionCount += 1;
  }
}

if (findings.length > 0) {
  console.error("Route authorization audit failed:");
  for (const finding of findings) {
    console.error(`- ${finding.location} ${finding.key}: ${finding.issue}`);
  }
  process.exit(1);
}

console.log(
  `Route authorization audit passed. ${checked} routes checked (${publicCount} public, ${authOnlyCount} auth-only, ${permissionCount} permission-guarded).`
);

function* listSourceFiles(directory) {
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry === "dist" || entry.endsWith(".test.ts")) continue;
    const path = join(directory, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      yield* listSourceFiles(path);
      continue;
    }
    if (stat.isFile() && path.endsWith(".ts")) yield path;
  }
}

function lineNumber(text, index) {
  return text.slice(0, index).split("\n").length;
}
