import pg from "pg";

export interface QueryResultLike<T> {
  rows: T[];
  rowCount: number | null;
}

export interface Queryable {
  query<T = unknown>(text: string, params?: readonly unknown[]): Promise<QueryResultLike<T>>;
}

let pool: pg.Pool | null = null;

function getDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to connect to Postgres");
  }
  return databaseUrl;
}

export function getPool() {
  pool ??= new pg.Pool({
    connectionString: getDatabaseUrl(),
  });
  return pool;
}

export async function query<T = unknown>(
  text: string,
  params: readonly unknown[] = [],
): Promise<QueryResultLike<T>> {
  const result = await getPool().query(text, params as unknown[]);
  return {
    rows: result.rows as T[],
    rowCount: result.rowCount,
  };
}

export async function closeDb() {
  if (!pool) {
    return;
  }
  await pool.end();
  pool = null;
}
