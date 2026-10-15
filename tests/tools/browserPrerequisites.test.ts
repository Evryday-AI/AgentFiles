import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "vitest";
import { isolatedEnvironment } from "../../scripts/smoke-compose.mjs";

test("missing FFmpeg fails before database startup with a safe prerequisite message", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentfiles-browser-prerequisite-"));
  const password = "synthetic-missing-media-password";
  try {
    const result = spawnSync(process.execPath, ["scripts/test-browser.mjs", "--project=desktop"], {
      cwd: resolve("."),
      env: {
        ...isolatedEnvironment(process.env),
        PATH: directory,
        AGENTFILES_TEST_DATABASE_URL: `postgresql://fixture:${password}@127.0.0.1:1/agentfiles_test_0123456789ab`,
      },
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(result.status).toBe(1);
    expect(output).toContain("Browser fixtures require FFmpeg on PATH");
    expect(output).not.toContain("config.webServer");
    expect(output).not.toContain(password);
    expect(output).not.toContain("postgresql://");
  } finally {
    if (dirname(directory) !== tmpdir() || !directory.startsWith(join(tmpdir(), "agentfiles-browser-prerequisite-")))
      throw new Error("Unowned prerequisite test cleanup refused");
    rmSync(directory, { recursive: true });
  }
}, 35000);
