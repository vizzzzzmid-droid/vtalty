import { expect, request as playwrightRequest, test, type Page } from "@playwright/test";

// Voice e2e needs real microphone input: Chromium fake devices stand in.
// NOTE: this spec needs a running stack with LiveKit (see the CI e2e-voice
// job). Media/ICE behavior cannot be verified on machines without Docker,
// so the scenario asserts server-driven state (presence, mute/deafen icons)
// rather than actual audio levels.
test.use({
  ignoreHTTPSErrors: true,
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--disable-dev-shm-usage",
    ],
  },
});

const API = "http://127.0.0.1:3000";

interface ApiUser {
  id: string;
  accessToken: string;
}

async function apiRegister(
  username: string,
  inviteCode?: string,
): Promise<ApiUser> {
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
      throw new Error(`register failed: ${res.status()} ${await res.text()}`);
    }
    const body = (await res.json()) as { user: { id: string }; accessToken: string };
    return { id: body.user.id, accessToken: body.accessToken };
  } finally {
    await request.dispose();
  }
}

async function apiInvite(owner: ApiUser, serverId: string): Promise<string> {
  const request = await playwrightRequest.newContext({ baseURL: API });
  try {
    const res = await request.post(`/api/v1/servers/${serverId}/invites`, {
      headers: { authorization: `Bearer ${owner.accessToken}` },
      data: {},
    });
    if (!res.ok()) {
      throw new Error(`invite failed: ${res.status()}`);
    }
    return ((await res.json()) as { code: string }).code;
  } finally {
    await request.dispose();
  }
}

async function apiServerId(owner: ApiUser): Promise<string> {
  const request = await playwrightRequest.newContext({ baseURL: API });
  try {
    const res = await request.get(`/api/v1/servers`, {
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const servers = (await res.json()) as { id: string }[];
    const id = servers[0]?.id;
    if (id === undefined) {
      throw new Error("no server");
    }
    return id;
  } finally {
    await request.dispose();
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

test("two users join voice, mute/deafen propagate, outsider still sees list", async ({
  browser,
}) => {
  const suffix = Date.now().toString(36);
  const owner = await apiRegister(`vowner${suffix}`);
  const serverId = await apiServerId(owner);
  const code = await apiInvite(owner, serverId);
  await apiRegister(`vfriend${suffix}`, code);
  await apiRegister(`vlurker${suffix}`, code);

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const ctxC = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  const pageC = await ctxC.newPage();
  try {
    await uiLogin(pageA, `vowner${suffix}`);
    await uiLogin(pageB, `vfriend${suffix}`);
    await uiLogin(pageC, `vlurker${suffix}`);

    // Both join the seeded voice channel.
    await pageA.getByRole("button", { name: "Join voice channel General" }).click();
    await pageB.getByRole("button", { name: "Join voice channel General" }).click();

    // Each sidebar shows the other participant…
    await expect(
      pageB.getByRole("button", { name: /Voice options for vowner/ }),
    ).toBeVisible({ timeout: 30000 });
    await expect(
      pageA.getByRole("button", { name: /Voice options for vfriend/ }),
    ).toBeVisible({ timeout: 30000 });
    // …and so does the lurker who never joined.
    await expect(
      pageC.getByRole("button", { name: /Voice options for vowner/ }),
    ).toBeVisible({ timeout: 30000 });

    // A mutes -> B sees the muted icon.
    await pageA.getByRole("button", { name: "Mute microphone" }).click();
    await expect(pageB.getByRole("img", { name: /is muted/ })).toBeVisible({ timeout: 15000 });

    // A deafens -> icon state changes.
    await pageA.getByRole("button", { name: "Deafen audio" }).click();
    await expect(pageB.getByRole("img", { name: /is deafened/ })).toBeVisible({ timeout: 15000 });
    await pageA.getByRole("button", { name: "Undeafen audio" }).click();
    await pageA.getByRole("button", { name: "Unmute microphone" }).click();

    // A leaves -> B's list updates.
    await pageA.getByRole("button", { name: "Disconnect from voice" }).click();
    await expect(
      pageB.getByRole("button", { name: /Voice options for vowner/ }),
    ).toHaveCount(0, { timeout: 15000 });
  } finally {
    await ctxA.close();
    await ctxB.close();
    await ctxC.close();
  }
});
