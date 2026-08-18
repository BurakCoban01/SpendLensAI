import { buildApp } from "./app";
import { loadConfig } from "./config";

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp();

  try {
    await app.listen({ host: "0.0.0.0", port: config.API_PORT });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

void main();
