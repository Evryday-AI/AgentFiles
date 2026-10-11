import { describe, expect, it, vi } from "vitest";
import { cleanupExpiredFiles, startCleanupExpiredFilesJob } from "../../src/server/cleanup";

describe("cleanupExpiredFiles", () => {
  it("deletes expired non-durable files and skips durable files", async () => {
    const deleteStoredFile = vi.fn().mockResolvedValue(undefined);
    const repo = {
      findExpiredFiles: vi.fn().mockResolvedValue([
        { code: "F-OLD01", storage_key: "old.dat", is_durable: false },
      ]),
      markFileDeleted: vi.fn().mockResolvedValue(undefined),
    };

    const result = await cleanupExpiredFiles({
      storageRoot: "/tmp/storage",
      repo,
      deleteStoredFile,
      now: new Date("2026-06-15T00:00:00Z"),
    });

    expect(result.deleted).toBe(1);
    expect(result.failures).toEqual([]);
    expect(deleteStoredFile).toHaveBeenCalledWith("/tmp/storage", "old.dat");
    expect(repo.markFileDeleted).toHaveBeenCalledWith("F-OLD01");
    expect(deleteStoredFile.mock.invocationCallOrder[0]).toBeLessThan(
      repo.markFileDeleted.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("reports structured byte delete failures", async () => {
    const deleteError = new Error("disk offline");
    const repo = {
      findExpiredFiles: vi.fn().mockResolvedValue([
        { code: "F-OLD01", storage_key: "old.dat", is_durable: false },
      ]),
      markFileDeleted: vi.fn().mockResolvedValue(undefined),
    };

    const result = await cleanupExpiredFiles({
      storageRoot: "/tmp/storage",
      repo,
      deleteStoredFile: vi.fn().mockRejectedValue(deleteError),
      now: new Date("2026-06-15T00:00:00Z"),
    });

    expect(result).toEqual({
      deleted: 0,
      failed: 1,
      failures: [{ code: "F-OLD01", storageKey: "old.dat", error: "disk offline" }],
    });
    expect(repo.markFileDeleted).not.toHaveBeenCalled();
  });

  it("runs cleanup on the configured interval until stopped", async () => {
    vi.useFakeTimers();
    const cleanup = vi.fn().mockResolvedValue({ deleted: 0, failed: 0, failures: [] });

    const job = startCleanupExpiredFilesJob({
      cleanup,
      intervalMs: 60_000,
      onError: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    await job.stop();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(cleanup).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("waits for in-flight cleanup before stopping", async () => {
    vi.useFakeTimers();
    let finishCleanup!: () => void;
    const cleanup = vi.fn(
      () =>
        new Promise<{ deleted: number; failed: number; failures: [] }>((resolve) => {
          finishCleanup = () => resolve({ deleted: 0, failed: 0, failures: [] });
        }),
    );

    const job = startCleanupExpiredFilesJob({
      cleanup,
      intervalMs: 60_000,
      onError: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(60_000);
    let stopped = false;
    const stopPromise = job.stop().then(() => {
      stopped = true;
    });

    await Promise.resolve();
    expect(stopped).toBe(false);

    finishCleanup();
    await stopPromise;

    expect(stopped).toBe(true);
    vi.useRealTimers();
  });
});
