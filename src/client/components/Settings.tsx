import { FormEvent, useEffect, useState } from "react";
import {
  ApiKeyRecord,
  createApiKey,
  getStorageUsage,
  listApiKeys,
  Principal,
  revokeApiKey,
  StorageUsage,
} from "../api";

interface SettingsProps {
  principal: Principal;
  onCopy: (value: string, label: string) => void;
}

const defaultPermissions = {
  canUpload: true,
  canDownload: true,
  canList: true,
  canDelete: false,
  canMarkDurable: false,
  canShare: false,
};

export function Settings({ principal, onCopy }: SettingsProps) {
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [usage, setUsage] = useState<StorageUsage | null | undefined>(undefined);
  const [name, setName] = useState("");
  const [permissions, setPermissions] = useState(defaultPermissions);
  const [secret, setSecret] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isAdmin = principal.type === "admin";
  const storageLabel =
    loading && usage === undefined ? "Checking..." : usage ? formatBytes(usage.bytes) : "Unavailable";
  const keyListState = error
    ? "error"
    : loading && keys.length === 0
      ? "loading"
      : keys.length === 0
        ? "empty"
        : "ready";

  useEffect(() => {
    if (!isAdmin) return;
    void refresh();
  }, [isAdmin]);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [apiKeys, storageUsage] = await Promise.all([listApiKeys(), getStorageUsage()]);
      setKeys(apiKeys);
      setUsage(storageUsage);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Settings unavailable");
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const created = await createApiKey({ name: name.trim(), ...permissions });
      setSecret(created.secret);
      setName("");
      setKeys((current) => [created.apiKey, ...current]);
    } catch (error) {
      setError(error instanceof Error ? error.message : "API key creation failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleRevoke(id: string) {
    setLoading(true);
    setError(null);
    try {
      await revokeApiKey(id);
      setKeys((current) => current.filter((key) => key.id !== id));
    } catch (error) {
      setError(error instanceof Error ? error.message : "API key revoke failed");
    } finally {
      setLoading(false);
    }
  }

  if (!isAdmin) {
    return (
      <section className="settings-panel">
        <div className="empty-state">Admin session required.</div>
      </section>
    );
  }

  return (
    <section className="settings-panel" aria-label="Settings">
      <div className="settings-head">
        <div>
          <h2>API access</h2>
        </div>
        <button disabled={loading} type="button" onClick={refresh}>
          Refresh
        </button>
      </div>

      {error ? <p className="notice error" role="alert">{error}</p> : null}

      <div className="usage-strip">
        <span>Storage</span>
        <strong>{storageLabel}</strong>
      </div>

      <form className="key-form" onSubmit={handleCreate}>
        <label className="field">
          <span>Key name</span>
          <input
            placeholder="Desktop helper"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <div className="permission-grid">
          {permissionFields.map((field) => (
            <label className="toggle-line" key={field.key}>
              <input
                checked={permissions[field.key]}
                type="checkbox"
                onChange={(event) =>
                  setPermissions((current) => ({ ...current, [field.key]: event.target.checked }))
                }
              />
              <span>{field.label}</span>
            </label>
          ))}
        </div>
        <button className="primary-action" disabled={loading || !name.trim()} type="submit">
          Create key
        </button>
      </form>

      {secret ? (
        <div className="secret-box">
          <div><p>Copy this secret now. It is only shown once.</p><code>{secret}</code></div>
          <button type="button" onClick={() => onCopy(secret, "Secret copied")}>
            Copy secret
          </button>
          <button type="button" onClick={() => setSecret(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      <div className="api-key-list">
        {keyListState === "loading" ? <div className="empty-state">Loading...</div> : null}
        {keyListState === "empty" ? <div className="empty-state">No API keys.</div> : null}
        {keyListState === "ready" ? (
          keys.map((key) => (
            <article className="api-key-row" key={key.id}>
              <div>
                <h3>{key.name}</h3>
                <p>{key.lastUsedAt ? `Last used ${formatDate(key.lastUsedAt)}` : "Unused"}</p>
              </div>
              <div className="key-permissions">
                {permissionFields
                  .filter((field) => key[field.key])
                  .map((field) => (
                    <span className="status-pill" key={field.key}>
                      {field.short}
                    </span>
                  ))}
              </div>
              <button disabled={loading} type="button" onClick={() => handleRevoke(key.id)}>
                Revoke
              </button>
            </article>
          ))
        ) : null}
      </div>
    </section>
  );
}

const permissionFields: Array<{
  key: keyof typeof defaultPermissions;
  label: string;
  short: string;
}> = [
  { key: "canUpload", label: "Upload", short: "up" },
  { key: "canDownload", label: "Download", short: "down" },
  { key: "canList", label: "List", short: "list" },
  { key: "canDelete", label: "Delete", short: "del" },
  { key: "canMarkDurable", label: "Durable", short: "dur" },
  { key: "canShare", label: "Share", short: "share" },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units.shift() ?? "KB";
  while (value >= 1024 && units.length > 0) {
    value /= 1024;
    unit = units.shift() ?? unit;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}
