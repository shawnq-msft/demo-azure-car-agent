import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { fileURLToPath } from "node:url";

if (process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test") {
  try { process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url))); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
}

const config = loadConfig();
const app = await buildApp({ config });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
await app.listen({ port: config.port, host: "0.0.0.0" });
console.log(`Car demo API listening on port ${config.port}; persistence=${config.persistence}; request/PII logging disabled`);
