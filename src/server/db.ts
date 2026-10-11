import pg from "pg";
import { parse, toClientConfig } from "pg-connection-string";
import { validatedDatabaseUrl } from "./config.js";

export interface QueryResultLike<T> { rows: T[]; rowCount: number | null }
export interface Queryable { query<T = unknown>(text: string, params?: readonly unknown[]): Promise<QueryResultLike<T>> }
export interface Database extends Queryable {
  withClient<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// A missing root injection must fail without consulting ambient runtime configuration.
export const unconfiguredDatabase: Queryable = {
  async query() { throw new Error("Database dependency is required"); },
};

export function createDatabase(databaseUrl: string): Database {
  validatedDatabaseUrl({ DATABASE_URL: databaseUrl });
  let config: pg.ClientConfig;
  try {
    const parsed = parse(databaseUrl);
    // pg reparses this reserved option after applying explicit defaults/timeouts.
    if (Object.hasOwn(parsed, "connectionString")) throw new Error();
    // toClientConfig drops string SSL settings; normalize pg's explicit alias
    // before conversion so a URL requesting TLS cannot silently disable it.
    if (parsed.ssl === "no-verify") parsed.ssl = { rejectUnauthorized: false };
    if (typeof parsed.ssl === "string") throw new Error();
    config = toClientConfig(parsed);
  }
  catch { throw new Error("DATABASE_URL is invalid"); }
  const poolOptions: pg.PoolConfig & { replication: string } = {
    ...config,
    // pg treats empty strings as absent and consults PG*. A password callback
    // is truthy even when the explicitly configured password is empty.
    user: config.user || "postgres",
    password: config.password || (() => ""),
    port: config.port || 5432,
    ssl: config.ssl ?? false,
    sslnegotiation: config.sslnegotiation ?? "postgres",
    options: config.options || "-c application_name=agentfiles",
    application_name: config.application_name || "agentfiles",
    client_encoding: config.client_encoding || "UTF8",
    replication: String((config as pg.ClientConfig & { replication?: string }).replication || "false"),
    connectionTimeoutMillis: 2500,
    statement_timeout: 2500,
    query_timeout: 2500,
  };
  const pool = new pg.Pool(poolOptions);
  // Pool background errors have no safe request context. Readiness reports outages.
  pool.on("error", () => {});
  let closing: Promise<void> | undefined;
  return {
    async query<T>(text: string, params: readonly unknown[] = []) {
      const result = await pool.query(text, params as unknown[]);
      return { rows: result.rows as T[], rowCount: result.rowCount };
    },
    async withClient(work) {
      const client = await pool.connect();
      try { return await work(client); }
      finally { client.release(); }
    },
    close() { return closing ??= pool.end(); },
  };
}
