import mysql from 'mysql2/promise';

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.DB_PORT || '3306');
const DB_NAME = process.env.DB_NAME || 'lore_ai_db';
const DB_USER = process.env.DB_USER || 'root';
const DB_PASS = process.env.DB_PASSWORD || '';
const DB_SSL = process.env.DB_SSL === 'true';

let pool: mysql.Pool | null = null;

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

export async function query<T = any>(sql: string, params?: any[]): Promise<T[]> {
  try {
    const conn = getPool();
    const [rows] = await conn.execute<any[]>(sql, params || []);
    return rows;
  } catch {
    return [];
  }
}

export async function execute(sql: string, params?: any[]): Promise<{ affectedRows: number; insertId: number }> {
  const conn = getPool();
  const [result] = await conn.execute<any>(sql, params || []);
  return { affectedRows: result.affectedRows, insertId: result.insertId };
}
