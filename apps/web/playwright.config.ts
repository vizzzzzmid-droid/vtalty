import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  retries: process.env["CI"] === "true" ? 1 : 0,
  // Serial workers: every spec registers the FIRST user (owner + seed) and
  // invite-only mode rejects the losers — parallel files race registration.
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
  },
});
