import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  utimes,
  access,
  rm,
  rename,
  symlink,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as storage from "../../src/server/storage";
import { createActiveUploads } from "../../src/server/activeUploads";
import { Readable } from "node:stream";
import { reconcileStorage } from "../../src/server/reconciliation";
import type { Queryable } from "../../src/server/db";
const volumeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function syntheticDatabase() {
  const db: Queryable & {
    withClient: <T>(work: (client: Queryable) => Promise<T>) => Promise<T>;
  } = {
    query: async <T>(sql: string) => ({
      rows: (sql.includes("SELECT volume_id")
        ? [{ volume_id: volumeId }]
        : []) as T[],
      rowCount: 0,
    }),
    withClient: async (work) => work(db),
  };
  return db;
}
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function root() {
  const path = await mkdtemp(join(tmpdir(), "agentfiles-reconcile-"));
  roots.push(path);
  return path;
}
const now = new Date("2030-01-01T00:00:00Z");
const key = "files/11111111-1111-4111-8111-111111111111.txt";
async function oldFile(path: string, name = key, age = 1000) {
  await mkdir(join(path, name.split("/")[0]), { recursive: true });
  await writeFile(join(path, name), "bytes");
  await utimes(join(path, name), new Date(+now - age), new Date(+now - age));
}
describe("owned storage safety", () => {
  it("retains a recent synthetic final and active old temp then reclaims after grace and release", async () => {
    const path = await root();
    await writeFile(join(path, ".agentfiles-volume"), volumeId);
    await oldFile(path, key, 999);
    const temp = ".tmp/22222222-2222-4222-8222-222222222222.upload";
    await oldFile(path, temp);
    const activeUploads = createActiveUploads(),
      release = activeUploads.hold(temp);
    const input = {
      root: path,
      db: syntheticDatabase(),
      activeUploads,
      graceMs: 1000,
      now,
    };
    expect(await reconcileStorage(input)).toEqual({
      removedBytes: 0,
      failures: 0,
    });
    release();
    expect(
      await reconcileStorage({ ...input, now: new Date(+now + 1) }),
    ).toEqual({ removedBytes: 10, failures: 0 });
    expect(await reconcileStorage(input)).toEqual({
      removedBytes: 0,
      failures: 0,
    });
  });
  it.skipIf(process.platform === "win32")(
    "retains symlink bait and malformed orphan names without touching their target",
    async () => {
      const path = await root();
      await writeFile(join(path, ".agentfiles-volume"), volumeId);
      await mkdir(join(path, "files"));
      const target = join(path, "outside.txt");
      await writeFile(target, "sentinel");
      await symlink(target, join(path, key));
      const malformed = "files/" + "a".repeat(36);
      await oldFile(path, malformed);
      expect(
        await reconcileStorage({
          root: path,
          db: syntheticDatabase(),
          activeUploads: createActiveUploads(),
          graceMs: 1000,
          now,
        }),
      ).toEqual({ removedBytes: 0, failures: 2 });
      await access(target);
      await access(join(path, malformed));
    },
  );
  it.skipIf(process.platform === "win32")(
    "creates actual temporary and final byte files and directories with private POSIX modes",
    async () => {
      const path = await root();
      const staged = await storage.stageUpload({
        storageRoot: path,
        originalName: "fixture.txt",
        stream: Readable.from(["fixture"]),
        maxBytes: 100,
      });
      expect((await stat(join(path, ".tmp"))).mode & 0o777).toBe(0o700);
      expect((await stat(join(path, staged.tempKey))).mode & 0o777).toBe(0o600);
      const final = await storage.finalizeUpload(path, staged);
      expect((await stat(join(path, "files"))).mode & 0o777).toBe(0o700);
      expect((await stat(join(path, final.storageKey))).mode & 0o777).toBe(
        0o600,
      );
    },
  );
  it("does not mistake a missing root for confirmed file absence", async () => {
    const path = await root();
    await rm(path, { recursive: true });
    await expect(storage.deleteStoredFile(path, key)).rejects.toThrow();
  });
  it("detects replaced root identity before destructive operations", async () => {
    const path = await root();
    await oldFile(path);
    await storage.getStorageUsage(path);
    const moved = path + "-moved";
    roots.push(moved);
    await rename(path, moved);
    await mkdir(path);
    await oldFile(path);
    await expect(storage.deleteStoredFile(path, key)).rejects.toThrow();
    await access(join(path, key));
  });
});
