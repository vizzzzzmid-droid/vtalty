import AxeBuilder from "@axe-core/playwright";
import { expect, request as playwrightRequest, test, type Page } from "@playwright/test";

// Accessibility gate: zero serious/critical axe violations on the main
// screens. Runs in the regular `e2e` CI job (no LiveKit needed).

async function uiLogin(page: Page, username: string): Promise<void> {
  await page.goto("/");
  await page.getByRole("tab", { name: "Log in" }).click();
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill("password-123");
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Open channel general" }),
  ).toBeVisible({ timeout: 15000 });
}

async function assertNoSerious(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  const blocking = results.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  expect(
    blocking.map((violation) => `${violation.id}: ${violation.help}`),
    "axe serious/critical violations",
  ).toEqual([]);
}

test("login page has no serious axe violations", async ({ page }) => {
  await page.goto("/");
  await assertNoSerious(page);
});

test("shell, settings and channel switching have no serious violations", async ({
  browser,
}) => {
  const suffix = Date.now().toString(36);
  const setup = await playwrightRequest.newContext({ baseURL: "http://127.0.0.1:3000" });
  try {
    await setup.post(`/api/v1/auth/register`, {
      data: { username: `a11y${suffix}`, password: "password-123" },
    });
  } finally {
    await setup.dispose();
  }
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await uiLogin(page, `a11y${suffix}`);
    await page.getByRole("button", { name: "Open channel general" }).click();
    await page.getByLabel("Message text").fill("hello");
    await assertNoSerious(page);

    await page.getByRole("button", { name: "Open user settings" }).click();
    await expect(page.getByRole("tab", { name: "Voice & Audio" })).toBeVisible();
    await assertNoSerious(page);
  } finally {
    await ctx.close();
  }
});
