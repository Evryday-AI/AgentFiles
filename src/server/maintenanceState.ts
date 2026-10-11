import type { SweepCursor } from "./filesRepo.js";

export interface MaintenanceSnapshot {
  bytes: number;
  managed_bytes: number;
  reserved_bytes: number;
  free_disk_bytes: number;
  max_storage_bytes: number;
  min_free_disk_bytes: number;
  active_uploads: number;
  cleanup: {
    last_attempt_at: string | null;
    last_success_at: string | null;
    pending_expired_bytes: number;
    failed_files: number;
    oldest_pending_at: string | null;
  };
}
export function createMaintenanceState() {
  let running: Promise<unknown> | undefined;
  return {
    expiredCursor: undefined as SweepCursor | undefined,
    pendingCursor: undefined as SweepCursor | undefined,
    expiredComplete: false,
    pendingComplete: false,
    sweepFailures: 0,
    purgeCursor: undefined as SweepCursor | undefined,
    eventFailures: 0,
    reconciliation: {
      last_attempt_at: null as string | null,
      last_success_at: null as string | null,
      failures: 0,
    },
    purge: {
      last_attempt_at: null as string | null,
      last_success_at: null as string | null,
      complete: false,
      retained: 0,
      failures: 0,
    },
    cleanup: {
      last_attempt_at: null as string | null,
      last_success_at: null as string | null,
      pending_expired_bytes: 0,
      failed_files: 0,
      oldest_pending_at: null as string | null,
    },
    async run<T>(work: () => Promise<T>): Promise<T> {
      if (running) return running as Promise<T>;
      const task = work();
      running = task;
      try {
        return await task;
      } finally {
        running = undefined;
      }
    },
    async stop() {
      await running;
    },
  };
}
export type MaintenanceState = ReturnType<typeof createMaintenanceState>;
