import { useEffect, useRef, useState } from "react";
import { getStorageUsage, InstanceInfo, Principal, StorageUsage } from "../api";
import { AgentSetup } from "./AgentSetup";
export function Settings({
  principal,
  instance,
  onCopy,
}: {
  principal: Principal;
  instance: InstanceInfo | null;
  onCopy: (value: string, label: string) => void;
}) {
  const [usage, setUsage] = useState<StorageUsage | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    if (principal.type === "admin") void refresh(current);
    return () => {
      generation.current++;
    };
  }, [principal]);
  async function refresh(current = generation.current) {
    try {
      const value = await getStorageUsage();
      if (current === generation.current) {
        setUsage(value);
        setError(null);
      }
    } catch {
      if (current === generation.current) {
        setUsage(null);
        setError("Storage status unavailable");
      }
    }
  }
  if (principal.type !== "admin")
    return (
      <section className="settings-panel">
        <p>Admin session required.</p>
      </section>
    );
  return (
    <section className="settings-panel" aria-label="Settings">
      <div className="settings-head">
        <h2>Storage and cleanup</h2>
        <button type="button" onClick={() => void refresh()}>
          Refresh storage
        </button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {usage ? (
        <div className="storage-facts">
          <p>Used: {usage.managed_bytes} B</p>
          <p>Reserved: {usage.reserved_bytes} B</p>
          <p>Capacity: {usage.max_storage_bytes} B</p>
          <p>Pending expiry: {usage.cleanup?.pending_expired_bytes} B</p>
          <p>
            Last successful cleanup:{" "}
            {usage.cleanup?.last_success_at ?? "Not yet reported"}
          </p>
          {usage.cleanup?.failed_files ? (
            <p role="alert">
              Cleanup delayed. Ask the operator to inspect storage and cleanup
              status.
            </p>
          ) : null}
        </div>
      ) : (
        <p>{usage === undefined ? "Checking storage..." : "Storage status unavailable"}</p>
      )}
      <AgentSetup instance={instance} onCopy={onCopy} />
    </section>
  );
}
