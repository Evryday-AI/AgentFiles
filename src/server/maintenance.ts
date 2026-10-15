import type { AppConfig } from "./config.js";
import type { Queryable } from "./db.js";
import type { UploadRuntime } from "./uploadRuntime.js";
import { cleanupExpiredFiles } from "./cleanup.js";
import { reconcileStorage } from "./reconciliation.js";
import { purgeRetainedDetails } from "./retention.js";
import { createMaintenanceState } from "./maintenanceState.js";

export function createMaintenance(
  config: AppConfig,
  db: Queryable,
  runtime: UploadRuntime,
  now: () => Date = () => new Date(),
) {
  const state = createMaintenanceState();
  const run = () =>
    state.run(async () => {
      const at = now();
      await runtime.retryUnknown();
      try {
        const cleanup = await cleanupExpiredFiles({
          storageRoot: config.storageRoot,
          db,
          batchSize: config.cleanupBatchSize,
          activeUploads: runtime.activeUploads,
          maintenanceState: state,
          now: at,
          recount: runtime.rescan,
        });
        state.reconciliation.last_attempt_at = at.toISOString();
        let reconcile;
        try {
          reconcile = await reconcileStorage({
            root: config.storageRoot,
            db,
            activeUploads: runtime.activeUploads,
            graceMs: config.orphanGraceMs,
            now: at,
          });
        } catch (error) {
          state.reconciliation.failures++;
          throw error;
        }
        state.reconciliation.failures = reconcile.failures;
        if (!reconcile.failures)
          state.reconciliation.last_success_at = at.toISOString();
        await purgeRetainedDetails({
          root: config.storageRoot,
          db,
          now: at,
          metadataRetentionDays: config.metadataRetentionDays,
          eventRetentionDays: config.eventRetentionDays,
          maintenanceState: state,
        });
        return cleanup;
      } finally {
        await runtime.rescan();
      }
    });
  return { state, run, stop: state.stop };
}
