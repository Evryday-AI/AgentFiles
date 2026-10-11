import { listFiles, markFileDeleted } from "./filesRepo.js";
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
  repo?: {
    findExpiredFiles?: (now: Date) => Promise<ExpiredFileRecord[]>;
    markFileDeleted?: (code: string) => Promise<unknown>;
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

const defaultRepo = {
  async findExpiredFiles(now: Date): Promise<ExpiredFileRecord[]> {
    return listFiles({ expiresBefore: now, isDurable: false });
  },
  markFileDeleted,
};

export async function cleanupExpiredFiles(
  options: CleanupExpiredFilesOptions,
): Promise<CleanupExpiredFilesResult> {
  const repo = { ...defaultRepo, ...options.repo };
  const deleteStoredFile = options.deleteStoredFile ?? defaultDeleteStoredFile;
  const now = options.now ?? new Date();
  const files = await repo.findExpiredFiles(now);
  let deleted = 0;
  const failures: CleanupExpiredFilesFailure[] = [];

  for (const file of files) {
    if (isDurable(file)) {
      continue;
    }

    const key = storageKey(file);
    try {
      await deleteStoredFile(options.storageRoot, key);
      await repo.markFileDeleted(file.code);
      deleted += 1;
    } catch (error) {
      failures.push({
        code: file.code,
        storageKey: key,
        error: errorMessage(error),
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

function isDurable(file: ExpiredFileRecord): boolean {
  return file.isDurable === true || file.is_durable === true;
}

function storageKey(file: ExpiredFileRecord): string {
  return file.storageKey ?? file.storage_key ?? "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
