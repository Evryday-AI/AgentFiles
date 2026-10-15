import { FormEvent, useState } from "react";
export function CodeLookup({
  onLookup,
}: {
  onLookup: (code: string) => Promise<void>;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = code.trim().toUpperCase();
    if (!/^F-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/.test(value)) {
      setError("Enter a file code in F-XXXXX format.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await onLookup(value);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="code-lookup" onSubmit={submit}>
      <label className="field">
        <span>File code</span>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="F-XXXXX"
        />
      </label>
      <button disabled={busy} type="submit">
        {busy ? "Finding…" : "Find file"}
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </form>
  );
}
