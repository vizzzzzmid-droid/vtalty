import { expect, request as playwrightRequest, test, type Page } from "@playwright/test";

// Screen-share + noise-mode e2e. Needs a running stack WITH LiveKit (see
// the CI e2e-voice job) and a Chromium that can capture a screen. Both are
// unreliable in headless CI, so failures SKIP gracefully instead of burning
// the suite: the documented manual scenario (docs/MANUAL_TESTS.md) remains
// the acceptance bar. Only server-driven state is asserted — never pixels.
test.use({
  ignoreHTTPSErrors: true,
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--auto-select-desktop-capture-source=Entire screen",
      "--disable-dev-shm-usage",
    ],
  },
});

const API = "http://127.0.0.1:3000";

async function apiRegister(username: string, inviteCode?: string): Promise<void> {
  const request = await playwrightRequest.newContext({ baseURL: API });
  try {
    const res = await request.post(`/api/v1/auth/register`, {
      data: {
        username,
        password: "password-123",
        ...(inviteCode === undefined ? {} : { inviteCode }),
      },
    });
    if (!res.ok()) {
      throw new Error(`register failed: ${res.status()}`);
    }
  } finally {
    await request.dispose();
  }
}

async function apiInvite(ownerToken: string, serverId: string): Promise<string> {
  const request = await playwrightRequest.newContext({ baseURL: API });
  try {
    const res = await request.post(`/api/v1/servers/${serverId}/invites`, {
      headers: { authorization: `Bearer ${ownerToken}` },
      data: {},
    });
    return ((await res.json()) as { code: string }).code;
  } finally {
    await request.dispose();
  }
}

async function setupPair(suffix: string): Promise<{ ownerToken: string; serverId: string }> {
  const setup = await playwrightRequest.newContext({ baseURL: API });
  try {
    const ownerRes = await setup.post(`/api/v1/auth/register`, {
      data: { username: `sowner${suffix}`, password: "password-123" },
    });
    const owner = (await ownerRes.json()) as {
      accessToken: string;
    };
    const serversRes = await setup.get(`/api/v1/servers`, {
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const serverId = ((await serversRes.json()) as { id: string }[])[0]?.id ?? "";
    const code = await apiInvite(owner.accessToken, serverId);
    await apiRegister(`sfriend${suffix}`, code);
    return { ownerToken: owner.accessToken, serverId };
  } finally {
    await setup.dispose();
  }
}

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

test("screen share opt-in: badge, watch, stop", async ({ browser }) => {
  const suffix = Date.now().toString(36);
  await setupPair(suffix);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  try {
    await uiLogin(pageA, `sowner${suffix}`);
    await uiLogin(pageB, `sfriend${suffix}`);
    await pageA.getByRole("button", { name: "Join voice channel General" }).click();
    await pageB.getByRole("button", { name: "Join voice channel General" }).click();
    await expect(
      pageB.getByRole("button", { name: /Voice options for sowner/ }),
    ).toBeVisible({ timeout: 30000 });

    await pageA.getByRole("button", { name: "Share screen" }).click();
    await pageA.getByRole("button", { name: "Start sharing", exact: true }).click();
    // Headless screen capture may be unavailable: skip instead of failing.
    const started = await pageA
      .getByRole("button", { name: "Stop sharing" })
      .isVisible({ timeout: 15000 })
      .catch(() => false);
    if (!started) {
      test.skip(true, "screen capture unavailable in this Chromium");
      return;
    }

    // B sees the live badge and can opt in.
    await expect(pageB.getByText("LIVE").first()).toBeVisible({ timeout: 15000 });
    await pageB.getByRole("button", { name: "Watch stream" }).first().click();
    await expect(
      pageB.getByLabel(/Screen share video by sowner/),
    ).toBeVisible({ timeout: 15000 });

    // A stops: the tile disappears for B.
    await pageA.getByRole("button", { name: "Stop sharing" }).click();
    await expect(pageB.getByRole("button", { name: "Watch stream" })).toHaveCount(0, {
      timeout: 15000,
    });
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

test("switching noise mode does not drop the call", async ({ browser }) => {
  const suffix = Date.now().toString(36);
  await setupPair(suffix);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await uiLogin(page, `sowner${suffix}`);
    await page.getByRole("button", { name: "Join voice channel General" }).click();
    await expect(
      page.getByRole("button", { name: "Disconnect from voice" }),
    ).toBeVisible({ timeout: 30000 });

    await page.getByRole("button", { name: "Open user settings" }).click();
    await page.getByRole("tab", { name: "Voice & Audio" }).click();
    await page.getByLabel("Enhanced — RNNoise neural suppression").check();
    // Either Enhanced engages or the fallback notice appears — but the
    // voice connection must survive the live chain swap either way.
    await expect(
      page.getByRole("button", { name: "Disconnect from voice" }),
    ).toBeVisible({ timeout: 15000 });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Open user settings" }).click();
    await page.getByRole("tab", { name: "Voice & Audio" }).click();
    await page.getByLabel("Standard — browser processing").check();
    await expect(
      page.getByRole("button", { name: "Disconnect from voice" }),
    ).toBeVisible({ timeout: 15000 });
  } finally {
    await ctx.close();
  }
});
