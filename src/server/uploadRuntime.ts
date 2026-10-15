import type { AppConfig } from "./config.js";
import { createActiveUploads } from "./activeUploads.js";
import { createUploadAdmission } from "./uploadAdmission.js";
import { getFreeDiskBytes, getStorageUsage } from "./storage.js";
// Shared by routes and maintenance. Retry work returns true only once database
// ownership and byte accounting are both settled; exceptions retain protection.
export function createUploadRuntime(config: AppConfig) {
  const admission = createUploadAdmission(config, 0, () => getFreeDiskBytes(config.storageRoot));
  const activeUploads = createActiveUploads();
  const pending = new Set<() => Promise<boolean>>();
  let retrying: Promise<void> | undefined;
  return {
    admission, activeUploads,
    rescan: () => admission.rescan(async () => (await getStorageUsage(config.storageRoot)).bytes),
    retainUnknown(work: () => Promise<boolean>) { pending.add(work); },
    unresolvedCount: () => pending.size,
    retryUnknown(): Promise<void> {
      return retrying ??= (async () => {
        for (const work of pending) {
          try { if (await work()) pending.delete(work); } catch { /* Protected until a later retry. */ }
        }
      })().finally(() => { retrying = undefined; });
    },
  };
}
export type UploadRuntime = ReturnType<typeof createUploadRuntime>;
