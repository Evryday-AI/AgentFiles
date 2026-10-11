export type FileLifecycleState = "active" | "deleting" | "deleted";

export function fileIsAvailable(
  file: {
    isDurable: boolean;
    expiresAt: Date | null;
    expiresAtExact?: string | null;
    deletedAt: Date | null;
    lifecycleState: FileLifecycleState;
  },
  now: Date,
): boolean {
  return (
    file.lifecycleState === "active" &&
    file.deletedAt === null &&
    (file.isDurable || expiryIsAfter(file, now))
  );
}

// PostgreSQL retains microseconds; JS Date has millisecond precision. At an
// equal millisecond, any nonzero remaining SQL fractional digit is still future.
export function expiryIsAfter(
  file: { expiresAt: Date | null; expiresAtExact?: string | null },
  now: Date,
): boolean {
  if (!file.expiresAt) return false;
  const delta = file.expiresAt.getTime() - now.getTime();
  return (
    delta > 0 ||
    (delta === 0 &&
      /[1-9]/.test(/\.\d{3}(\d+)/.exec(file.expiresAtExact ?? "")?.[1] ?? ""))
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
