import type { Queryable } from "./db.js";
import { unconfiguredDatabase } from "./db.js";
import {
  findExpiredBatch,
  findPendingBatch,
  claimFileDeletion,
  finalizeFileDeletion,
  type FileRecord,
} from "./filesRepo.js";
import { deleteStoredFile } from "./storage.js";
import { completeDeletion } from "./deletion.js";
import {
  createMaintenanceState,
  type MaintenanceState,
} from "./maintenanceState.js";
import type { ActiveUploads } from "./activeUploads.js";

export interface ExpiredFileRecord {
  code: string;
  storage_key?: string;
  storageKey?: string;
  is_durable?: boolean;
  isDurable?: boolean;
}
export interface CleanupExpiredFilesOptions {
  storageRoot: string;
  db?: Queryable;
  batchSize?: number;
  now?: Date;
  activeUploads?: ActiveUploads;
  maintenanceState?: MaintenanceState;
  recount?: () => Promise<void>;
  repo?: {
    findExpiredFiles?: (now: Date) => Promise<ExpiredFileRecord[]>;
    claimFileDeletion?: (code: string) => Promise<FileRecord | null>;
    finalizeFileDeletion?: (code: string, claimId: string) => Promise<unknown>;
  };
  deleteStoredFile?: typeof deleteStoredFile;
}
export interface CleanupExpiredFilesFailure {
  code: string;
  storageKey: string;
  error: string;
}
export interface CleanupExpiredFilesResult {
  deleted: number;
  failed: number;
  failures: CleanupExpiredFilesFailure[];
  attempted: number;
  pendingBytes: number;
  complete: boolean;
}
export async function cleanupExpiredFiles(
  options: CleanupExpiredFilesOptions,
): Promise<CleanupExpiredFilesResult> {
  const state = options.maintenanceState ?? createMaintenanceState();
  const db = options.db ?? unconfiguredDatabase;
  const now = options.now ?? new Date();
  // A finished stream starts another sweep on the next tick even if the other
  // stream is still traversing a long failing prefix. Otherwise later arrivals
  // to the completed stream could starve until that unrelated sweep finishes.
  if (state.pendingComplete) {
    state.pendingComplete = false;
    state.pendingCursor = undefined;
  }
  if (state.expiredComplete) {
    state.expiredComplete = false;
    state.expiredCursor = undefined;
  }
  state.cleanup.last_attempt_at = now.toISOString();
  const result: CleanupExpiredFilesResult = {
    deleted: 0,
    failed: 0,
    failures: [],
    attempted: 0,
    pendingBytes: 0,
    complete: false,
  };
  const processFile = async (candidate: ExpiredFileRecord) => {
    result.attempted++;
    try {
      const file = options.repo?.claimFileDeletion
        ? await options.repo.claimFileDeletion(candidate.code)
        : await claimFileDeletion(
            candidate.code,
            "expired",
            db,
            () => options.now ?? new Date(),
          );
      if (!file) return;
      await completeDeletion({
        file,
        root: options.storageRoot,
        db,
        maintenanceState: state,
        activeUploads: options.activeUploads,
        remove: options.deleteStoredFile,
        recount: options.recount,
        ...(options.repo && !options.db
          ? {
              verify: async () => file,
              finish: async (code, claimId) =>
                (await options.repo?.finalizeFileDeletion?.(
                  code,
                  claimId,
                )) as FileRecord,
            }
          : {}),
      });
      result.deleted++;
    } catch {
      result.failures.push({
        code: candidate.code,
        storageKey: candidate.storageKey ?? candidate.storage_key ?? "",
        error: "File deletion failed; claim retained for recovery",
      });
    }
  };
  try {
    if (options.repo?.findExpiredFiles) {
      for (const file of await options.repo.findExpiredFiles(now))
        await processFile(file);
      result.complete = true;
    } else {
      // Each independent sweep gets at least half the tick. Pending failures
      // cannot monopolize expiry, and each precision-preserving cursor survives.
      for (const kind of ["pending", "expired"] as const) {
        const cursorKey =
          kind === "pending" ? "pendingCursor" : "expiredCursor";
        const completeKey =
          kind === "pending" ? "pendingComplete" : "expiredComplete";
        let budget = kind === "pending" ? 500 : 1000 - result.attempted;
        while (!state[completeKey] && budget > 0) {
          const limit = Math.min(options.batchSize ?? 100, budget);
          const rows =
            kind === "pending"
              ? await findPendingBatch({ after: state[cursorKey], limit }, db)
              : await findExpiredBatch(
                  { now, after: state[cursorKey], limit },
                  db,
                );
          for (const file of rows) {
            await processFile(file);
            state[cursorKey] = { timestamp: file.sweepTimestamp!, id: file.id };
          }
          budget -= rows.length;
          if (rows.length < limit) state[completeKey] = true;
        }
      }
      result.complete = state.pendingComplete && state.expiredComplete;
      const pending = await db.query<{ bytes: string; oldest: Date | null }>(
        `SELECT COALESCE(sum(size_bytes),0) AS bytes,
        min(COALESCE(deletion_claimed_at,expires_at)) AS oldest FROM files WHERE lifecycle_state='deleting'
        OR (lifecycle_state='active' AND NOT is_durable AND expires_at <= $1)`,
        [now],
      );
      result.pendingBytes = Number(pending.rows[0].bytes);
      state.cleanup.oldest_pending_at =
        pending.rows[0].oldest?.toISOString() ?? null;
    }
  } catch (error) {
    state.sweepFailures++;
    state.cleanup.failed_files = state.sweepFailures;
    throw error;
  } finally {
    state.sweepFailures += result.failures.length;
    state.cleanup.failed_files = state.sweepFailures;
    state.cleanup.pending_expired_bytes = result.pendingBytes;
  }
  result.failed = result.failures.length;
  if (result.complete) {
    if (!state.sweepFailures) state.cleanup.last_success_at = now.toISOString();
    state.pendingCursor = state.expiredCursor = undefined;
    state.pendingComplete = state.expiredComplete = false;
    state.sweepFailures = 0;
  }
  return result;
}
export interface CleanupExpiredFilesJobOptions {
  cleanup: () => Promise<unknown>;
  intervalMs: number;
  onError?: (error: unknown) => void;
}
export interface CleanupExpiredFilesJob {
  stop(): Promise<void>;
  run(): Promise<void>;
}
export function startCleanupExpiredFilesJob(
  options: CleanupExpiredFilesJobOptions,
): CleanupExpiredFilesJob {
  let active: Promise<void> | undefined;
  let stopped = false;
  const run = async () => {
    if (stopped) return;
    if (active) return active;
    active = Promise.resolve()
      .then(options.cleanup)
      .then(
        () => {},
        (error) => options.onError?.(error),
      )
      .finally(() => {
        active = undefined;
      });
    return active;
  };
  const timer = setInterval(() => {
    void run();
  }, options.intervalMs);
  timer.unref?.();
  return {
    run,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await active;
    },
  };
}
