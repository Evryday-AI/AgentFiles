import { FormEvent, useEffect, useRef, useState } from "react";
import {
  ApiKeyRecord,
  checkAgentConnection,
  createApiKey,
  InstanceInfo,
  listApiKeys,
  Principal,
  revokeApiKey,
} from "../api";
const minimal = {
  canUpload: true,
  canDownload: true,
  canList: false,
  canDelete: false,
  canMarkDurable: false,
  canShare: false,
};
const fields = [
  ["canUpload", "Upload"],
  ["canDownload", "Download"],
  ["canList", "List (optional)"],
  ["canDelete", "Delete files (destructive)"],
  ["canMarkDurable", "Keep indefinitely (persistence)"],
  ["canShare", "Create public bearer shares"],
] as const;
export function AgentSetup({
  instance,
  onCopy,
}: {
  instance: InstanceInfo | null;
  onCopy: (value: string, label: string) => void;
}) {
  const [name, setName] = useState("");
  const [permissions, setPermissions] = useState(minimal);
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [secret, setSecret] = useState<{ id: string; value: string } | null>(
    null,
  );
  const [checkKey, setCheckKey] = useState("");
  const [connection, setConnection] = useState<Principal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    void listApiKeys()
      .then((items) => {
        if (generation.current === current) setKeys(items);
      })
      .catch(() => {
        if (generation.current === current) setError("API keys unavailable");
      });
    return () => {
      generation.current++;
    };
  }, []);
  function clearSecret() {
    generation.current++;
    setSecret(null);
    setCheckKey("");
    setConnection(null);
    setBusy(false);
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || busy) return;
    clearSecret();
    const current = generation.current;
    setBusy(true);
    setError(null);
    try {
      const created = await createApiKey({ name: name.trim(), ...permissions });
      if (generation.current !== current) return;
      setSecret({ id: created.apiKey.id, value: created.secret });
      setKeys((items) => [created.apiKey, ...items]);
      setName("");
    } catch {
      if (generation.current === current)
        setError(
          "Key creation failed. Check the key list before creating another key.",
        );
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }
  async function check() {
    const current = generation.current;
    setBusy(true);
    setError(null);
    setConnection(null);
    try {
      const result = await checkAgentConnection(
        checkKey || secret?.value || "",
      );
      if (generation.current !== current) return;
      if (!result.authenticated || result.principal?.type !== "api_key")
        setError(
          "Connection failed. Create a new minimal key or check the supplied secret.",
        );
      else setConnection(result.principal);
    } catch {
      if (generation.current === current)
        setError(
          "Connection failed. Check the supplied key and instance connection.",
        );
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }
  async function revoke(id: string) {
    clearSecret();
    const current = generation.current;
    setError(null);
    setBusy(true);
    try {
      await revokeApiKey(id);
      if (generation.current === current)
        setKeys((items) => items.filter((key) => key.id !== id));
    } catch {
      if (generation.current === current) setError("Key revocation failed");
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }
  return (
    <section className="agent-setup" aria-label="Agent setup">
      <h2>Connect an agent</h2>
      <p>
        Instance base URL: <code>{instance?.base_url ?? "Unavailable"}</code>
      </p>
      <p>
        Set AGENTFILES_BASE_URL and AGENTFILES_API_KEY in your agent's secret
        provider. Copied snippets may contain credentials; keep them out of
        chats, logs and saved commands.
      </p>
      <a href="/skills/agentfiles/SKILL.md" download="agentfiles-SKILL.md">
        Download static skill (no credentials)
      </a>
      <form className="key-form" onSubmit={create}>
        <label className="field">
          <span>Key name</span>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Desktop helper"
          />
        </label>
        <div className="tile-actions">
          <button type="button" onClick={() => setPermissions({ ...minimal })}>
            Upload + download minimum
          </button>
          <button
            type="button"
            onClick={() => setPermissions({ ...minimal, canList: true })}
          >
            Also list files
          </button>
        </div>
        <div className="permission-grid">
          {fields.map(([key, label]) => (
            <label className="toggle-line" key={key}>
              <input
                type="checkbox"
                checked={permissions[key]}
                disabled={
                  key === "canMarkDurable" && !instance?.allow_persistent_files
                }
                onChange={(e) =>
                  setPermissions((p) => ({ ...p, [key]: e.target.checked }))
                }
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
        <button disabled={busy || !name.trim()} type="submit">
          Create key
        </button>
      </form>
      {secret ? (
        <div className="secret-box">
          <div>
            <p>Copy this secret now. It is only shown once.</p>
            <code>{secret.value}</code>
          </div>
          <button
            type="button"
            onClick={() => onCopy(secret.value, "Secret copied")}
          >
            Copy secret
          </button>
          <button type="button" onClick={clearSecret}>
            Dismiss secret
          </button>
        </div>
      ) : null}
      <label className="field">
        <span>Check an existing key (kept only in memory)</span>
        <input
          type="password"
          autoComplete="off"
          value={checkKey}
          onChange={(e) => {
            generation.current++;
            setBusy(false);
            setError(null);
            setCheckKey(e.target.value);
            setConnection(null);
          }}
        />
      </label>
      <button
        disabled={busy || (!secret && !checkKey)}
        type="button"
        onClick={check}
      >
        Check connection
      </button>
      {error ? (
        <p role="alert" className="notice error">
          {error}
        </p>
      ) : null}
      {connection?.type === "api_key" ? (
        <div role="status">
          <p>Connected as {connection.name}</p>
          {fields.map(([key]) => (
            <p key={key}>
              {key}: {String(connection[key])}
            </p>
          ))}
        </div>
      ) : null}
      <div className="api-key-list">
        {keys.map((key) => (
          <article className="api-key-row" key={key.id}>
            <h3>{key.name}</h3>
            <div className="key-permissions">
              {fields
                .filter(([flag]) => key[flag])
                .map(([flag]) => (
                  <span key={flag}>{flag}</span>
                ))}
            </div>
            <button
              disabled={busy}
              type="button"
              onClick={() => revoke(key.id)}
            >
              Revoke
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}
