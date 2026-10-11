import type { Queryable } from "./db.js";
import {
  listDeletionCandidates,
  claimFileDeletion,
  finalizeFileDeletion,
  type FileRecord,
} from "./filesRepo.js";
import { deleteStoredFile as defaultDeleteStoredFile } from "./storage.js";

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
  repo?: {
    findExpiredFiles?: (now: Date) => Promise<ExpiredFileRecord[]>;
    claimFileDeletion?: (code: string) => Promise<FileRecord | null>;
    finalizeFileDeletion?: (code: string, claimId: string) => Promise<unknown>;
  };
  deleteStoredFile?: (storageRoot: string, storageKey: string) => Promise<void>;
  now?: Date;
}

export interface CleanupExpiredFilesResult {
  deleted: number;
  failed: number;
  failures: CleanupExpiredFilesFailure[];
}

export interface CleanupExpiredFilesFailure {
  code: string;
  storageKey: string;
  error: string;
}

export interface CleanupExpiredFilesJobOptions {
  cleanup: () => Promise<CleanupExpiredFilesResult>;
  intervalMs: number;
  onError?: (error: unknown) => void;
}

export interface CleanupExpiredFilesJob {
  stop(): Promise<void>;
}

export async function cleanupExpiredFiles(
  options: CleanupExpiredFilesOptions,
): Promise<CleanupExpiredFilesResult> {
  const repo = {
    findExpiredFiles: (now: Date) =>
      listDeletionCandidates(now, options.batchSize, options.db),
    claimFileDeletion: (code: string) =>
      claimFileDeletion(
        code,
        "expired",
        options.db,
        () => options.now ?? new Date(),
      ),
    finalizeFileDeletion: (code: string, claimId: string) =>
      finalizeFileDeletion(code, claimId, options.db),
    ...options.repo,
  };
  const deleteStoredFile = options.deleteStoredFile ?? defaultDeleteStoredFile;
  const now = options.now ?? new Date();
  const files = await repo.findExpiredFiles(now);
  let deleted = 0;
  const failures: CleanupExpiredFilesFailure[] = [];

  for (const file of files) {
    let key = storageKey(file);
    try {
      const claimed = await repo.claimFileDeletion(file.code);
      if (!claimed) continue;
      if (!claimed.deletionClaimId) throw new Error("Deletion claim missing");
      key = claimed.storageKey;
      await deleteStoredFile(options.storageRoot, key);
      if (claimed.thumbnailKey)
        await deleteStoredFile(options.storageRoot, claimed.thumbnailKey);
      const finalized = await repo.finalizeFileDeletion(
        file.code,
        claimed.deletionClaimId,
      );
      if (!finalized) throw new Error("Deletion finalization failed");
      deleted += 1;
    } catch {
      failures.push({
        code: file.code,
        storageKey: key,
        error: "File deletion failed; claim retained for recovery",
      });
    }
  }

  return { deleted, failed: failures.length, failures };
}

export function startCleanupExpiredFilesJob(
  options: CleanupExpiredFilesJobOptions,
): CleanupExpiredFilesJob {
  let activePromise: Promise<void> | null = null;
  const run = async () => {
    if (activePromise) {
      return;
    }
    activePromise = (async () => {
      try {
        await options.cleanup();
      } catch (error) {
        options.onError?.(error);
      } finally {
        activePromise = null;
      }
    })();
    await activePromise;
  };

  const timer = setInterval(() => {
    void run();
  }, options.intervalMs);
  timer.unref?.();

  return {
    async stop() {
      clearInterval(timer);
      await activePromise;
    },
  };
}

function storageKey(file: ExpiredFileRecord): string {
  return file.storageKey ?? file.storage_key ?? "";
}
