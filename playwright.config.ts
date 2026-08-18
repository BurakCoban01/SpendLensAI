import { defineConfig, devices } from "@playwright/test";

const apiPort = process.env.SPENDLENS_E2E_API_PORT ?? "4100";
const webPort = process.env.SPENDLENS_E2E_WEB_PORT ?? "3000";
const webBaseUrl = process.env.SPENDLENS_E2E_WEB_BASE_URL ?? `http://127.0.0.1:${webPort}`;
const useExternalServers = process.env.SPENDLENS_E2E_EXTERNAL_SERVERS === "1";
const chromiumExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const testIgnore = [
  ...(process.env.PLAYWRIGHT_PORTFOLIO_SCREENSHOTS ? [] : ["**/portfolio-screenshots.spec.ts"]),
  ...(process.env.SPENDLENS_E2E_DOCKER === "1" ? [] : ["**/docker-backed.spec.ts"])
];

export default defineConfig({
  testDir: "./e2e",
  testIgnore,
  timeout: 60_000,
  expect: {
    timeout: 10_000
  },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: webBaseUrl,
    trace: "retain-on-failure"
  },
  webServer: useExternalServers
    ? undefined
    : [
        {
          command: "node scripts/start-api-e2e.mjs",
          url: `http://127.0.0.1:${apiPort}/health/ready`,
          reuseExistingServer: false,
          timeout: 90_000
        },
        {
          command: "node scripts/start-web-e2e.mjs",
          url: `${webBaseUrl}/register`,
          reuseExistingServer: false,
          timeout: 240_000
        }
      ],
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(chromiumExecutablePath ? { launchOptions: { executablePath: chromiumExecutablePath } } : {})
      }
    }
  ]
});
