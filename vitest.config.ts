import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts", "tests/unit/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 10000,
    restoreMocks: true
  }
});
