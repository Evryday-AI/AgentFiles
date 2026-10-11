export type FileLifecycleState = "active" | "deleting" | "deleted";

export function fileIsAvailable(
  file: {
    isDurable: boolean;
    expiresAt: Date | null;
    deletedAt: Date | null;
    lifecycleState: FileLifecycleState;
  },
  now: Date,
): boolean {
  return (
    file.lifecycleState === "active" &&
    file.deletedAt === null &&
    (file.isDurable ||
      (file.expiresAt !== null && file.expiresAt.getTime() > now.getTime()))
  );
}

export class FilePolicyError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
  }
}
