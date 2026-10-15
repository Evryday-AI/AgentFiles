import { FormEvent, useState } from "react";

interface LoginProps {
  loading: boolean;
  error: string | null;
  onLogin: (username: string, password: string) => Promise<void>;
}

export function Login({ loading, error, onLogin }: LoginProps) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onLogin(username, password);
  }

  return (
    <main className="login-shell">
      <form className="login-panel" onSubmit={handleSubmit}>
        <div>
          <h1>AgentFiles</h1>
          <p className="login-description">Sign in to upload, preview, and share your files.</p>
        </div>
        <label className="field">
          <span>Username</span>
          <input
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            autoComplete="current-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {error ? <p className="notice error" role="alert">{error}</p> : null}
        <button className="primary-action" disabled={loading || !password} type="submit">
          {loading ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
