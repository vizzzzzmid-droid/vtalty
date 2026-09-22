import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/electron",
  timeout: 60_000,
  retries: 0,
  reporter: "list",
  use: {
    trace: "retain-on-failure",
  },
});
