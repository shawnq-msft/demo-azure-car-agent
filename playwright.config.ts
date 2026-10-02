import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL: "http://127.0.0.1:5173", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "npm run start --workspace @car/api",
      url: "http://127.0.0.1:3001/api/health",
      reuseExistingServer: !process.env.CI,
      timeout: 60000,
      env: {
        NODE_ENV: "test",
        PORT: "3001",
        HOST: "127.0.0.1",
        PERSISTENCE_MODE: "memory",
        ALLOWED_ORIGINS: "http://127.0.0.1:5173",
        TOKEN_SIGNING_SECRET: "test-only-signing-secret-not-for-deployment"
      }
    },
    {
      command: "npm run dev",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: !process.env.CI,
      timeout: 60000,
      env: { VITE_API_BASE_URL: "http://127.0.0.1:3001" }
    }
  ]
});
