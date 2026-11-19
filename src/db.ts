import mysql from 'mysql2/promise';

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.DB_PORT || '3306');
const DB_NAME = process.env.DB_NAME || 'lore_ai_db';
const DB_USER = process.env.DB_USER || 'root';
const DB_PASS = process.env.DB_PASSWORD || '';
const DB_SSL = process.env.DB_SSL === 'true';

let pool: mysql.Pool | null = null;

/** Values accepted by mysql2's prepared statements. */
type SqlParam = string | number | bigint | boolean | Date | null | Buffer | Uint8Array;

export function getPool(): mysql.Pool {
  if (!pool) {
    pool = mysql.createPool({
      host: DB_HOST,
      port: DB_PORT,
      database: DB_NAME,
      user: DB_USER,
      password: DB_PASS,
      charset: 'utf8mb4',
      waitForConnections: true,
      connectionLimit: 5,
      ssl: DB_SSL ? { rejectUnauthorized: true } : undefined,
    });
  }
  return pool;
}

/**
 * Read query. Returns [] on failure so a database outage degrades to the
 * built-in catalogue instead of a 500 — but the failure is logged, because a
 * silent [] is indistinguishable from an empty table.
 */
export async function query<T>(sql: string, params: SqlParam[] = []): Promise<T[]> {
  try {
    const [rows] = await getPool().execute(sql, params);
    return rows as T[];
  } catch (err) {
    console.error('[DB] query failed:', (err as Error).message);
    return [];
  }
}

/** Write query. Throws: callers decide whether a failed write is fatal. */
export async function execute(
  sql: string,
  params: SqlParam[] = [],
): Promise<{ affectedRows: number; insertId: number }> {
  const [result] = await getPool().execute(sql, params);
  const header = result as mysql.ResultSetHeader;
  return { affectedRows: header.affectedRows, insertId: header.insertId };
}

/**
 * Idempotent schema upgrade for existing databases. `schema.sql` only runs on
 * a fresh volume, so a deployed instance would otherwise miss new columns.
 * Written against information_schema because MySQL 8 has no
 * `ADD COLUMN IF NOT EXISTS`.
 */
export async function ensureSchema(): Promise<void> {
  const columns = await query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chat_sessions' AND COLUMN_NAME = 'visitor_id'",
  );
  if (!columns[0]?.n) {
    await execute("ALTER TABLE chat_sessions ADD COLUMN visitor_id VARCHAR(64) NOT NULL DEFAULT ''");
    console.log('[DB] added chat_sessions.visitor_id');
  }
  const indexes = await query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chat_sessions' AND INDEX_NAME = 'idx_chat_sessions_visitor'",
  );
  if (!indexes[0]?.n) {
    await execute('ALTER TABLE chat_sessions ADD KEY idx_chat_sessions_visitor (visitor_id, updated_at)');
    console.log('[DB] added idx_chat_sessions_visitor');
  }
}
