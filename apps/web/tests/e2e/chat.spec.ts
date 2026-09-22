import { expect, test } from "@playwright/test";

// 1x1 transparent PNG.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("register -> create channel -> send -> edit -> delete -> upload image", async ({
  page,
}) => {
  const suffix = Date.now().toString(36);
  const username = `e2e${suffix}`;
  const serverName = `e2e-srv-${suffix}`;
  const channelName = `e2e-chan-${suffix}`;

  await page.goto("/");

  // Register (first user becomes owner; later users are members — either
  // way this spec creates its OWN server below, so file order is safe).
  await page.getByRole("tab", { name: "Register" }).click();
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill("password-123");
  await page.getByRole("button", { name: "Register", exact: true }).click();

  // Seeded shell is visible.
  await expect(
    page.getByRole("button", { name: "Open channel general" }),
  ).toBeVisible();

  // Own server: creator is always its owner with manage_channels.
  await page.getByRole("button", { name: "Create a server" }).click();
  await page.getByLabel("Server name").fill(serverName);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("button", { name: `Open server ${serverName}` }).click();

  // Create a text channel via Settings -> Channels.
  await page.getByRole("button", { name: "Open user settings" }).click();
  await page.getByRole("tab", { name: "Channels" }).click();
  await page.getByRole("button", { name: "New channel" }).click();
  await page.getByLabel("Channel name").fill(channelName);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  // The create dialog closes on success; close Settings to return to the
  // shell (the modal keeps the background sidebar inert while open).
  await page.getByRole("button", { name: "Close settings" }).click();

  // Open the new channel and send a message.
  await page.getByRole("button", { name: `Open channel ${channelName}` }).click();
  await page.getByLabel("Message text").fill("hello e2e");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("hello e2e", { exact: true })).toBeVisible();

  // Edit it.
  await page
    .getByRole("button", { name: `Message actions by ${username}` })
    .click({ force: true });
  await page.getByRole("menuitem", { name: "Edit message" }).click();
  await page.getByLabel("Edit message").fill("hello e2e edited");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("hello e2e edited", { exact: true })).toBeVisible();

  // Delete it.
  await page
    .getByRole("button", { name: `Message actions by ${username}` })
    .click({ force: true });
  await page.getByRole("menuitem", { name: "Delete message" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("hello e2e edited", { exact: true })).toHaveCount(0);

  // Upload an image and send it with a caption.
  await page.locator('input[type="file"]').setInputFiles({
    name: "hello.png",
    mimeType: "image/png",
    buffer: PNG_BYTES,
  });
  await expect(page.getByText("hello.png")).toBeVisible();
  await page.getByLabel("Message text").fill("with image");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("with image", { exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "hello.png" })).toBeVisible();
});
