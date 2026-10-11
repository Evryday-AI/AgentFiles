// Process-local references cover staging, finalization, SQL ownership and compensation.
// A replica or an external writer on this mount is not supported.
export function createActiveUploads() {
  const paths = new Map<string, number>();
  const waiters = new Set<() => void>();
  return {
    hold(key: string): () => void {
      paths.set(key, (paths.get(key) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const count = paths.get(key)! - 1;
        if (count) paths.set(key, count); else paths.delete(key);
        if (!paths.size) { for (const wake of waiters) wake(); waiters.clear(); }
      };
    },
    has(key: string) { return paths.has(key); },
    drain(): Promise<void> {
      return paths.size ? new Promise(resolve => waiters.add(resolve)) : Promise.resolve();
    },
  };
}
export type ActiveUploads = ReturnType<typeof createActiveUploads>;
