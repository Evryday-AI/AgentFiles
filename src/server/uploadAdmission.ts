import type { AppConfig } from "./config.js";
import { FilePolicyError } from "./filePolicy.js";
export interface UploadLease {
  commit(actualBytes: number): Promise<void>;
  abort(retainedBytes: number): Promise<void>;
}
type Limits = Pick<
  AppConfig,
  "maxUploadBytes" | "maxStorageBytes" | "minFreeDiskBytes" | "maxConcurrentUploads"
>;
const capacity = () =>
  new FilePolicyError(507, "Storage capacity unavailable", "STORAGE_CAPACITY_EXCEEDED");
function bytes(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw capacity();
}
export function createUploadAdmission(
  config: Limits,
  initialManagedBytes: number,
  freeDiskBytes: () => Promise<number>,
) {
  bytes(initialManagedBytes);
  let managedBytes = initialManagedBytes;
  let reservedBytes = 0;
  let active = 0;
  let scanFailed = false;
  let pendingScan: (() => Promise<number>) | undefined;
  let tail = Promise.resolve();
  function locked<T>(work: () => Promise<T>): Promise<T> {
    const run = tail.then(work);
    tail = run.then(
      () => {},
      () => {},
    );
    return run;
  }
  async function free() {
    try {
      const value = await freeDiskBytes();
      bytes(value);
      return value;
    } catch {
      throw capacity();
    }
  }
  async function measure(scan: () => Promise<number>) {
    try {
      const value = await scan();
      bytes(value);
      managedBytes = value;
      scanFailed = false;
    } catch {
      scanFailed = true;
      throw capacity();
    }
  }
  return {
    acquire(): Promise<UploadLease> {
      return locked(async () => {
        if (scanFailed) throw capacity();
        if (active >= config.maxConcurrentUploads) {
          throw new FilePolicyError(429, "Upload concurrency limit reached", "UPLOAD_CONCURRENCY_LIMIT");
        }
        if (
          managedBytes + reservedBytes + config.maxUploadBytes > config.maxStorageBytes ||
          await free() - reservedBytes - config.maxUploadBytes < config.minFreeDiskBytes
        ) throw capacity();
        reservedBytes += config.maxUploadBytes;
        active++;
        let settled = false;
        const settle = (amount: number) => locked(async () => {
          bytes(amount);
          if (settled) throw new Error("Upload lease already settled");
          settled = true;
          reservedBytes -= config.maxUploadBytes;
          active--;
          managedBytes += amount;
          if (!active && pendingScan) {
            const scan = pendingScan;
            pendingScan = undefined;
            // The lease is already settled. A failed maintenance measurement
            // blocks future admission but cannot change a confirmed upload result.
            await measure(scan).catch(() => {});
          }
        });
        return { commit: settle, abort: settle };
      });
    },
    // Streaming checkpoints deliberately reserve other streams' entire maxima.
    // Already-written bytes may therefore be charged twice here, conservatively.
    checkpoint(): Promise<void> {
      return locked(async () => {
        if (await free() - reservedBytes < config.minFreeDiskBytes) throw capacity();
      });
    },
    // Only an idle scan may replace totals: active bytes are already reserved.
    // A failed scan keeps the last charge and blocks subsequent admission.
    rescan(scan: () => Promise<number>): Promise<void> {
      return locked(async () => {
        if (active) {
          pendingScan = scan;
          return;
        }
        await measure(scan);
      });
    },
    snapshot() {
      return { managedBytes, reservedBytes, active };
    },
  };
}
export type UploadAdmission = ReturnType<typeof createUploadAdmission>;
