import { startCleanupExpiredFilesJob } from "../../src/server/cleanup";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer, shutdownServer, validateStorageRoot } from "../../src/server/index";
import { checkReadiness, READINESS_TIMEOUT_MS } from "../../src/server/health";
import { loadMigrations } from "../../src/server/migrate";
import type { Database, Queryable } from "../../src/server/db";
import { testConfig } from "../helpers/config";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterEach(() => vi.useRealTimers());
const rowsDb = (rows: unknown[]): Queryable => ({ query: async <T>() => ({ rows: rows as T[], rowCount: rows.length }) });
async function ledger() { return (await loadMigrations()).map(({ version, checksum }) => ({ version, checksum })); }
describe("readiness", () => {
  it("requires the complete expected version and checksums", async () => {
    const rows = await ledger();
    expect(await checkReadiness(rowsDb(rows), 2)).toBe(true);
    expect(await checkReadiness(rowsDb(rows.slice(0, 1)), 2)).toBe(false);
    expect(await checkReadiness(rowsDb([...rows, { version: 3, checksum: "extra" }]), 2)).toBe(false);
    expect(await checkReadiness(rowsDb([{ ...rows[0], checksum: "changed" }, rows[1]]), 2)).toBe(false);
    expect(await checkReadiness(rowsDb(rows.reverse()), 2)).toBe(false);
    expect(await checkReadiness(rowsDb(await ledger()), 1)).toBe(false);
  });
  it("fails closed on database errors", async () => {
    expect(await checkReadiness({ query: async () => { throw new Error("synthetic secret"); } }, 2)).toBe(false);
  });
  it("bounds a hanging query", async () => {
    vi.useFakeTimers();
    let called!: () => void;
    const began = new Promise<void>(resolve => { called = resolve; });
    const result = checkReadiness({ query: () => { called(); return new Promise(() => {}); } }, 2);
    await began;
    await vi.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS);
    expect(await result).toBe(false);
  });
  it("keeps liveness independent and exposes only the readiness boolean", async () => {
    let queries = 0;
    const db: Database = { query: async () => { queries++; throw new Error("synthetic secret"); }, withClient: async () => { throw new Error(); }, close: async () => {} };
    const server = buildServer(testConfig(), { db });
    try {
      expect((await server.inject("/api/health")).statusCode).toBe(200);
      expect(queries).toBe(0);
      const response = await server.inject("/api/ready");
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ ready: false });
      expect(response.body).not.toContain("synthetic secret");
    } finally { await server.close(); }
  });
});
describe("startup storage and shutdown", () => {
  it("requires an owned writable directory and sanitizes errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentfiles-preflight-"));
    try {
      await expect(validateStorageRoot(root)).resolves.toBeUndefined();
      const file = join(root, "fixture"); await writeFile(file, "fixture");
      await expect(validateStorageRoot(file)).rejects.toThrow("STORAGE_ROOT is not an owned writable directory");
      await expect(validateStorageRoot(join(root, "missing"))).rejects.toThrow("STORAGE_ROOT is not an owned writable directory");
    } finally { await rm(root, { recursive: true }); }
  });
  it("rejects a symlink or junction storage root", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentfiles-preflight-"));
    const target = join(root, "target"); const link = join(root, "link");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(target);
    try {
      await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
      await expect(validateStorageRoot(link)).rejects.toThrow("STORAGE_ROOT is not an owned writable directory");
    } finally { await rm(root, { recursive: true }); }
  });
  it("waits for server cleanup before closing connections", async () => {
    const order: string[] = []; let finish!: () => void;
    const server = { close: () => new Promise<void>(resolve => { finish = () => { order.push("cleanup"); resolve(); }; }) };
    const db = { close: async () => { order.push("database"); } };
    const result = shutdownServer(server as never, db as never, 100);
    expect(order).toEqual([]); finish();
    expect(await result).toBe(true); expect(order).toEqual(["cleanup", "database"]);
  });
  it("drains an active cleanup hook on a real Fastify server before database close", async () => {
    vi.useFakeTimers(); const order: string[] = []; let finish!: () => void;
    const db: Database = { ...rowsDb([]), withClient: async () => { throw new Error(); }, close: async () => { order.push("database"); } };
    const server = buildServer(testConfig(), { db });
    const job = startCleanupExpiredFilesJob({ intervalMs: 10, cleanup: () => new Promise(resolve => { finish = () => { order.push("cleanup"); resolve({ deleted: 0, failed: 0, failures: [] }); }; }) });
    server.addHook("onClose", async () => { await job.stop(); });
    await server.ready(); await vi.advanceTimersByTimeAsync(10);
    const draining = shutdownServer(server, db, 100);
    await vi.advanceTimersByTimeAsync(1);
    expect(order).toEqual([]); finish();
    expect(await draining).toBe(true); expect(order).toEqual(["cleanup", "database"]);
  });
  it("attempts database close even when server drain hangs and finishes within the bound", async () => {
    vi.useFakeTimers(); let closed = false;
    const result = shutdownServer({ close: () => new Promise(() => {}) } as never, { close: async () => { closed = true; } } as never, 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toBe(false); expect(closed).toBe(true);
  });
  it("bounds hanging database close", async () => {
    vi.useFakeTimers();
    const result = shutdownServer({ close: async () => {} } as never, { close: () => new Promise(() => {}) } as never, 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toBe(false);
  });
});
