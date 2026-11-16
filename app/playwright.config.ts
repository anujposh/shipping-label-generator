import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests", fullyParallel: true, workers: 1,
  use: { baseURL: "http://127.0.0.1:3018", headless: true },
  webServer: { command: "npx next dev -H 127.0.0.1 -p 3018", url: "http://127.0.0.1:3018", reuseExistingServer: false, timeout: 120000 },
});
