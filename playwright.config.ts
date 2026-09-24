import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./apps/web/e2e",
  use: { baseURL: "http://127.0.0.1:4311" },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:4311",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});

