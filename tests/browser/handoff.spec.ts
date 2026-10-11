import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import pg from "pg";
const directory = process.env.AGENTFILES_BROWSER_FIXTURE_DIR!;
test.beforeEach(async ({ page }) => {
  await expect
    .poll(async () => {
      try {
        return (await readFile(join(directory, "ready"), "utf8")) === "ready";
      } catch {
        return false;
      }
    })
    .toBe(true);
  const state = JSON.parse(
    await readFile(join(directory, "state.json"), "utf8"),
  );
  await page.goto("/");
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password", { exact: true }).fill(state.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Files", exact: true }),
  ).toBeVisible();
});
test("exact handoff beyond page, proportions, native dialog, checksum and narrow layout", async ({
  page,
}, testInfo) => {
  const { files, target } = JSON.parse(
    await readFile(join(directory, "files.json"), "utf8"),
  );
  await expect(
    page.getByRole("button", { name: target.name, exact: true }),
  ).toHaveCount(0);
  for (const file of files) {
    await page.getByLabel("File code", { exact: true }).fill(file.code);
    await page.getByLabel("File code", { exact: true }).press("Enter");
    const detail = page.getByRole("complementary", { name: "File detail" });
    await expect(
      detail.getByRole("heading", { name: file.name, exact: true }),
    ).toBeVisible();
    if (file.mime_type.startsWith("image/")) {
      const image = detail.locator(".detail-preview img");
      await expect(image).toBeVisible();
      await expect
        .poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth))
        .toBeGreaterThan(0);
      expect(await image.evaluate((el) => getComputedStyle(el).objectFit)).toBe(
        "contain",
      );
      const dimensions = await image.evaluate((el: HTMLImageElement) => ({
        natural: el.naturalWidth / el.naturalHeight,
        box:
          el.getBoundingClientRect().width / el.getBoundingClientRect().height,
      }));
      expect(dimensions.box).toBeCloseTo(dimensions.natural, 1);
      await detail.getByRole("button", { name: "Open larger preview" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: "Close preview" }),
      ).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible();
      if (file.name === "portrait.png") {
        await detail.scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(directory, `${testInfo.project.name}-portrait.png`) });
      }
    }
    if (file.mime_type.startsWith("video/")) {
      await expect(detail.locator("video")).toBeVisible();
      await expect
        .poll(() =>
          detail
            .locator("video")
            .evaluate((el: HTMLVideoElement) => el.videoWidth),
        )
        .toBe(240);
    }
    if (file.mime_type.startsWith("audio/")) {
      await expect(detail.locator("audio")).toBeVisible();
      await expect
        .poll(() =>
          detail
            .locator("audio")
            .evaluate((el: HTMLAudioElement) => el.readyState),
        )
        .toBeGreaterThan(0);
    }
    const event = page.waitForEvent("download");
    await detail.getByRole("link", { name: "Download", exact: true }).click();
    const download = await event;
    const path = await download.path();
    expect(
      createHash("sha256")
        .update(await readFile(path!))
        .digest("hex"),
    ).toBe(file.expected_sha256);
    if (testInfo.project.name !== "desktop")
      expect(await detail.evaluate((el) => el.parentElement?.className)).toBe(
        "mobile-selected-detail",
      );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.getByRole("button", { name: "list", exact: true }).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: join(directory, `${testInfo.project.name}-handoff.png`),
    fullPage: false,
  });
});
test("bad bearer check cannot use admin cookie; keys and static skill contain no saved secret", async ({
  page,
}) => {
  await page.getByRole("button", { name: "settings", exact: true }).click();
  await page.getByLabel("Check an existing key").fill("synthetic-invalid-key");
  await page.getByRole("button", { name: "Check connection" }).click();
  await expect(page.getByRole("alert")).toContainText("Connection failed");
  await page
    .getByLabel("Key name", { exact: true })
    .fill("browser synthetic agent");
  await page.getByRole("button", { name: "Create key", exact: true }).click();
  await expect(page.locator(".secret-box")).toBeVisible();
  const secret = await page.locator(".secret-box code").textContent();
  await page.getByLabel("Check an existing key").fill("");
  await page.getByRole("button", { name: "Check connection" }).click();
  await expect(page.getByRole("status")).toContainText("canList: false");
  const skill = await page.request.get("/skills/agentfiles/SKILL.md");
  expect((await skill.text()).includes(secret!)).toBe(false);
  expect(
    await page.evaluate(() => ({
      local: localStorage.length,
      session: sessionStorage.length,
    })),
  ).toEqual({ local: 0, session: 0 });
  expect(page.url().includes(secret!)).toBe(false);
  await page.getByRole("button", { name: "Dismiss secret" }).click();
  await expect(page.locator(".secret-box")).toHaveCount(0);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
});
test("expired metadata and revoked public share remain unavailable", async ({
  page,
}) => {
  const { target } = JSON.parse(
    await readFile(join(directory, "files.json"), "utf8"),
  );
  const state = JSON.parse(
    await readFile(join(directory, "state.json"), "utf8"),
  );
  await page.getByLabel("File code", { exact: true }).fill(target.code);
  await page.getByRole("button", { name: "Find file" }).click();
  const detail = page.getByRole("complementary", { name: "File detail" });
  await expect(detail).toBeVisible();
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/api/files/${target.code}/share`) &&
      r.request().method() === "POST",
  );
  await detail.getByRole("button", { name: "Create share link" }).click();
  const share = await (await response).json();
  await detail.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(detail.locator(".share-result")).toHaveCount(0);
  expect((await page.request.get(share.public_url)).status()).toBe(410);
  const db = new pg.Pool({ connectionString: state.databaseUrl });
  try {
    await db.query(
      "UPDATE files SET expires_at=now()-interval '1 second' WHERE code=$1",
      [target.code],
    );
  } finally {
    await db.end();
  }
  await detail.getByRole("link", { name: "Download", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("expired (410)");
  // Restore only this fixture row for the next viewport; no production time API.
  const restore = new pg.Pool({ connectionString: state.databaseUrl });
  try {
    await restore.query(
      "UPDATE files SET expires_at=now()+interval '7 days' WHERE code=$1",
      [target.code],
    );
  } finally {
    await restore.end();
  }
});
test("upload result gives private handoff metadata; lost response requests reconciliation", async ({
  page,
}) => {
  const { files } = JSON.parse(
    await readFile(join(directory, "files.json"), "utf8"),
  );
  await expect(
    page.getByLabel("Persistence unavailable", { exact: true }),
  ).toBeDisabled();
  await page.locator('input[type="file"]').setInputFiles(files[1].fixture_path);
  const result = page
    .getByRole("region", { name: "Upload files" })
    .getByLabel(`Upload result ${files[1].name}`);
  await expect(result).toBeVisible();
  await expect(result).toContainText(files[1].expected_sha256);
  await expect(result).toContainText("Expires");
  expect(
    await result
      .getByRole("link", { name: "Private browser link" })
      .getAttribute("href"),
  ).toMatch(/\/files\/F-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/);
  expect(
    await page.request.get("/api/admin/storage-usage").then((r) => r.status()),
  ).toBe(200);
  let posts = 0;
  await page.route("**/api/files", async (route) => {
    if (route.request().method() === "POST") {
      posts++;
      await route.abort("failed");
    } else await route.continue();
  });
  await page.locator('input[type="file"]').setInputFiles(files[1].fixture_path);
  await expect(page.getByRole("alert")).toContainText("Upload outcome unknown");
  expect(posts).toBe(1);
  await expect(page.getByRole("button", { name: /retry upload/i })).toHaveCount(
    0,
  );
});
test("slow metadata cannot replace a newer selected file", async ({ page }) => {
  const { files } = JSON.parse(
    await readFile(join(directory, "files.json"), "utf8"),
  );
  await page.getByLabel("File code", { exact: true }).fill(files[1].code);
  await page.getByRole("button", { name: "Find file" }).click();
  await expect(
    page.getByRole("complementary", { name: "File detail" }),
  ).toContainText(files[1].name);
  let release!: () => void;
  let arrived!: () => void;
  const arrivedPromise = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/files/${files[0].code}`, async (route) => {
    arrived();
    await gate;
    await route.continue();
  });
  await page.getByLabel("File code", { exact: true }).fill(files[0].code);
  await page.getByRole("button", { name: "Find file" }).click();
  await arrivedPromise;
  await page
    .locator(".file-tile")
    .filter({ hasText: files[1].code })
    .getByRole("button", { name: files[1].name, exact: true })
    .click();
  release();
  await expect(
    page.getByRole("complementary", { name: "File detail" }),
  ).toContainText(files[1].name);
  await expect(
    page.getByRole("complementary", { name: "File detail" }),
  ).not.toContainText(files[0].name);
  await page.getByLabel("File code", { exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Find file" })).toBeFocused();
});

test("initial private deep link works when listing fails and preserves actual expiry", async ({
  page,
}) => {
  // Finish beforeEach's library request before observing the navigation's responses.
  await expect(
    page.getByRole("button", { name: "Refresh", exact: true }),
  ).toBeEnabled();
  const { target } = JSON.parse(
    await readFile(join(directory, "files.json"), "utf8"),
  );
  const state = JSON.parse(
    await readFile(join(directory, "state.json"), "utf8"),
  );
  let listStatus = 403;
  // Only listing is synthetic here: exact metadata still reaches the real server.
  await page.route("**/api/files?**", (route) =>
    route.fulfill({
      status: listStatus,
      contentType: "application/json",
      body: JSON.stringify({ error: "synthetic list failure" }),
    }),
  );
  const metadata = page.waitForResponse((response) =>
    response.url().endsWith(`/api/files/${target.code}`),
  );
  const deniedList = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/files" &&
      response.request().method() === "GET",
  );
  await page.goto(`/files/${target.code}`);
  expect((await deniedList).status()).toBe(403);
  expect((await metadata).status()).toBe(200);
  await expect(
    page.getByRole("complementary", { name: "File detail" }),
  ).toContainText(target.name);
  const db = new pg.Pool({ connectionString: state.databaseUrl });
  try {
    await db.query(
      "UPDATE files SET expires_at=now()-interval '1 second' WHERE code=$1",
      [target.code],
    );
    listStatus = 500;
    const expired = page.waitForResponse((response) =>
      response.url().endsWith(`/api/files/${target.code}`),
    );
    const failedList = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/files" &&
        response.request().method() === "GET",
    );
    await page.goto(`/files/${target.code}`);
    expect((await failedList).status()).toBe(500);
    expect((await expired).status()).toBe(410);
    await expect(page.getByRole("alert")).toContainText("expired (410)");
    await expect(
      page.getByRole("heading", { name: target.name, exact: true }),
    ).toHaveCount(0);
  } finally {
    await db.query(
      "UPDATE files SET expires_at=now()+interval '7 days' WHERE code=$1",
      [target.code],
    );
    await db.end();
  }
});
