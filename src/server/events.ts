export const FILE_EVENT_TYPES = {
  created: "file.created",
  downloaded: "file.downloaded",
  shared: "file.shared",
  durableChanged: "file.durable_changed",
  deleted: "file.deleted",
  expired: "file.expired",
  revoked: "file.share_revoked",
} as const;

export type FileEventType =
  (typeof FILE_EVENT_TYPES)[keyof typeof FILE_EVENT_TYPES];

export type EventActorType = "admin" | "api_key" | "system";

export interface EventRecord {
  id: string;
  fileId: string | null;
  eventType: FileEventType | string;
  actorType: EventActorType;
  actorName: string | null;
  details: Record<string, unknown>;
  createdAt: Date;
}

import { unconfiguredDatabase, type Queryable } from "./db.js";
import type { MaintenanceState } from "./maintenanceState.js";
export interface EventInput {
  fileId: string;
  eventType: FileEventType;
  actorType: EventActorType;
  actorId?: string;
  details?: { durable?: boolean; share_id?: string };
}
export async function recordEvent(
  input: EventInput,
  db: Queryable = unconfiguredDatabase,
): Promise<void> {
  if (
    !Object.values(FILE_EVENT_TYPES).includes(input.eventType) ||
    !["admin", "api_key", "system"].includes(input.actorType) ||
    !/^[a-f0-9-]{36}$/i.test(input.fileId)
  )
    throw new Error("Invalid lifecycle event");
  if (input.actorId !== undefined && !/^[a-f0-9-]{36}$/i.test(input.actorId))
    throw new Error("Invalid lifecycle actor");
  const details = input.details ?? {};
  if (
    Object.keys(details).some(
      (key) => !["durable", "share_id"].includes(key),
    ) ||
    (details.durable !== undefined && typeof details.durable !== "boolean") ||
    (details.share_id !== undefined &&
      !/^[a-f0-9-]{36}$/i.test(details.share_id))
  )
    throw new Error("Invalid lifecycle event details");
  await db.query(
    `INSERT INTO events(file_id,event_type,actor_type,details,actor_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [
      input.fileId,
      input.eventType,
      input.actorType,
      details,
      input.actorId ?? null,
    ],
  );
}
export async function recordSafeEvent(
  input: EventInput,
  db?: Queryable,
  state?: MaintenanceState,
): Promise<void> {
  try {
    await recordEvent(input, db);
  } catch {
    if (state) state.eventFailures++;
  }
}
