/**
 * PostgreSQL 连接池
 *
 * 所有数据库操作通过此 pool 进行连接管理。
 */

import pg from "pg";
import { logger } from "../logger.js";

const { Pool } = pg;

const connectionString =
  process.env.DATABASE_URL ??
  `postgres://${process.env.PGUSER ?? "silverwolf"}:${process.env.PGPASSWORD ?? "silverwolf_dev_2026"}@${process.env.PGHOST ?? "127.0.0.1"}:${process.env.PGPORT ?? "5432"}/${process.env.PGDATABASE ?? "silver_wolf_agent"}`;

export const pool = new Pool({
  connectionString,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (err) => {
  logger.error("database", "unexpected pool error", { error: err.message });
});

/**
 * 执行初始化 DDL（幂等）
 */
export async function initDatabase(): Promise<void> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const initSqlPath = path.join(process.cwd(), "db", "init.sql");
  let initSql: string;
  try {
    initSql = fs.readFileSync(initSqlPath, "utf-8");
  } catch {
    logger.warn("database", "init.sql not found, skipping DDL");
    return;
  }
  await pool.query(initSql);
  logger.info("database", "schema initialized");
}

/**
 * 关闭连接池
 */
export async function closePool(): Promise<void> {
  await pool.end();
}
