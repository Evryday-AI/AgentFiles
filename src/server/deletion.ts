import type { Queryable } from "./db.js";
import {
  readDeletionOwnership,
  finalizeFileDeletion,
  type FileRecord,
} from "./filesRepo.js";
import { deleteStoredFile } from "./storage.js";
import type { ActiveUploads } from "./activeUploads.js";
import { recordSafeEvent } from "./events.js";
import type { MaintenanceState } from "./maintenanceState.js";
import { verifyStorageAssociation } from "./storageIdentity.js";

const inflight = new WeakMap<Queryable, Map<string, Promise<FileRecord>>>();
export async function completeDeletion(input: {
  file: FileRecord;
  root: string;
  db: Queryable;
  activeUploads?: ActiveUploads;
  remove?: typeof deleteStoredFile;
  verify?: typeof readDeletionOwnership;
  finish?: typeof finalizeFileDeletion;
  recount?: () => Promise<void>;
  maintenanceState?: MaintenanceState;
  actorType?: "admin" | "api_key" | "system";
  actorId?: string;
}): Promise<FileRecord> {
  let jobs = inflight.get(input.db);
  if (!jobs) {
    jobs = new Map();
    inflight.set(input.db, jobs);
  }
  const existing = jobs.get(input.file.id);
  if (existing) return existing;
  const run = (async () => {
    const claimed = input.file;
    const file = await (input.verify ?? readDeletionOwnership)(
      claimed.code,
      input.db,
    );
    if (
      !file ||
      !file.deletionClaimId ||
      file.deletionClaimId !== claimed.deletionClaimId ||
      file.storageKey !== claimed.storageKey ||
      file.thumbnailKey !== claimed.thumbnailKey
    )
      throw new Error("Deletion ownership is unconfirmed");
    if (file.lifecycleState === "deleted") return file;
    if (
      file.lifecycleState !== "deleting" ||
      input.activeUploads?.has(file.storageKey) ||
      (file.thumbnailKey && input.activeUploads?.has(file.thumbnailKey))
    )
      throw new Error("Deletion is pending");
    if (!input.verify) await verifyStorageAssociation(input.root, input.db);
    try {
      await (input.remove ?? deleteStoredFile)(input.root, file.storageKey);
      if (file.thumbnailKey)
        await (input.remove ?? deleteStoredFile)(input.root, file.thumbnailKey);
      const finished = await (input.finish ?? finalizeFileDeletion)(
        file.code,
        file.deletionClaimId,
        input.db,
      );
      if (!finished) throw new Error("Deletion finalization is pending");
      await recordSafeEvent(
        {
          fileId: file.id,
          eventType:
            file.deletionClaimReason === "expired"
              ? "file.expired"
              : "file.deleted",
          actorType: input.actorType ?? "system",
          actorId: input.actorId,
        },
        input.db,
        input.maintenanceState,
      );
      return finished;
    } finally {
      // Replace the measurement, never subtract a guessed size twice. Admission
      // defers this recount while reservations are still active.
      await input.recount?.();
    }
  })();
  jobs.set(input.file.id, run);
  try {
    return await run;
  } finally {
    jobs.delete(input.file.id);
  }
}
