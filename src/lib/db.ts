import "server-only";
import pg from "pg";

// Postgres returns BIGINT and NUMERIC as strings by default (to avoid losing
// precision). Our values are counts, rupee totals and ratios well inside the
// safe range of a JavaScript number, so parse them as numbers. DATE stays a
// 'YYYY-MM-DD' string so no time-zone conversion can shift a day.
pg.types.setTypeParser(20, (v) => Number(v)); // int8
pg.types.setTypeParser(1700, (v) => Number(v)); // numeric
pg.types.setTypeParser(1082, (v) => v); // date

const globalForPool = globalThis as unknown as { pgPool?: pg.Pool };

// One pool per server process, created on first use (never at import time, so
// `next build` does not need a database), and reused across hot reloads.
export function getPool(): pg.Pool {
  if (!globalForPool.pgPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    globalForPool.pgPool = new pg.Pool({ connectionString, max: 5, idleTimeoutMillis: 10_000 });
  }
  return globalForPool.pgPool;
}

export async function query<T extends pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await getPool().query<T>(text, params);
  return res.rows;
}

export type Actor = "user" | "copilot" | "system";

// Runs fn inside a transaction with app.actor set, so the change-log trigger
// records who made each change.
export async function withTransaction<T>(actor: Actor, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.actor', $1, true)", [actor]);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}
