import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react()],
    base: env.VITE_BASE_PATH || "/",
    server: { host: "127.0.0.1", port: 5173, strictPort: true },
    // Discover popup-auth dependencies before the in-memory demo begins.
    optimizeDeps: { include: ["@azure/msal-browser", "@azure/msal-browser/redirect-bridge"] },
    build: { sourcemap: false }
  };
});
