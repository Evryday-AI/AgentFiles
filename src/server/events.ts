export const FILE_EVENT_TYPES = {
  created: "file.created",
  downloaded: "file.downloaded",
  shared: "file.shared",
  durableChanged: "file.durable_changed",
  deleted: "file.deleted",
  expired: "file.expired",
} as const;

export type FileEventType = (typeof FILE_EVENT_TYPES)[keyof typeof FILE_EVENT_TYPES];

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
