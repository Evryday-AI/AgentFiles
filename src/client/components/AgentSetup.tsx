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
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [keyBusy, setKeyBusy] = useState(true);
  const [checking, setChecking] = useState(false);
  const busy = keyBusy || checking;
  const lifetime = useRef(0);
  const secretGeneration = useRef(0);
  const checkGeneration = useRef(0);
  useEffect(() => {
    const mounted = ++lifetime.current;
    void listApiKeys()
      .then((items) => {
        if (lifetime.current === mounted) setKeys(items);
      })
      .catch(() => {
        if (lifetime.current === mounted) setError("API keys unavailable");
      })
      .finally(() => {
        if (lifetime.current === mounted) setKeyBusy(false);
      });
    return () => {
      lifetime.current++;
      secretGeneration.current++;
      checkGeneration.current++;
    };
  }, []);
  function clearSecret() {
    secretGeneration.current++;
    checkGeneration.current++;
    setSecret(null);
    setCheckKey("");
    setConnection(null);
    setConnectionError(null);
    setChecking(false);
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || busy) return;
    clearSecret();
    const mounted = lifetime.current;
    const secretVersion = secretGeneration.current;
    setKeyBusy(true);
    setError(null);
    try {
      const created = await createApiKey({ name: name.trim(), ...permissions });
      if (lifetime.current !== mounted) return;
      if (secretGeneration.current === secretVersion)
        setSecret({ id: created.apiKey.id, value: created.secret });
      setKeys((items) => [created.apiKey, ...items]);
      setName("");
    } catch {
      if (lifetime.current === mounted)
        setError(
          "Key creation failed. Check the key list before creating another key.",
        );
    } finally {
      if (lifetime.current === mounted) setKeyBusy(false);
    }
  }
  async function check() {
    if (busy || (!checkKey && !secret)) return;
    const mounted = lifetime.current;
    const current = ++checkGeneration.current;
    const isCurrent = () =>
      lifetime.current === mounted && checkGeneration.current === current;
    setChecking(true);
    setConnectionError(null);
    setConnection(null);
    try {
      const result = await checkAgentConnection(
        checkKey || secret?.value || "",
      );
      if (!isCurrent()) return;
      if (!result.authenticated || result.principal?.type !== "api_key")
        setConnectionError(
          "Connection failed. Create a new minimal key or check the supplied secret.",
        );
      else setConnection(result.principal);
    } catch {
      if (isCurrent())
        setConnectionError(
          "Connection failed. Check the supplied key and instance connection.",
        );
    } finally {
      if (isCurrent()) setChecking(false);
    }
  }
  async function revoke(id: string) {
    if (busy) return;
    clearSecret();
    const mounted = lifetime.current;
    setError(null);
    setKeyBusy(true);
    try {
      await revokeApiKey(id);
      if (lifetime.current === mounted)
        setKeys((items) => items.filter((key) => key.id !== id));
    } catch {
      if (lifetime.current === mounted) setError("Key revocation failed");
    } finally {
      if (lifetime.current === mounted) setKeyBusy(false);
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
            checkGeneration.current++;
            setChecking(false);
            setConnectionError(null);
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
      {connectionError ? (
        <p role="alert" className="notice error">
          {connectionError}
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
