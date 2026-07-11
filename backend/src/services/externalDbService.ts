// backend/src/services/externalDbService.ts — Conexão e queries no banco de destino

import mysql from "mysql2/promise";
import pg from "pg";
import type { AppSettings } from "../../generated/prisma/client.js";
import type { RowDataPacket } from "mysql2";

export type DbSettings = Pick<
  AppSettings,
  "dbType" | "dbHost" | "dbPort" | "dbName" | "dbUser" | "dbPassword"
>;

export async function testConnection(settings: DbSettings): Promise<{ success: boolean; message: string }> {
  try {
    if (settings.dbType === "mysql") {
      const conn = await mysql.createConnection({
        host: settings.dbHost,
        port: settings.dbPort,
        user: settings.dbUser,
        password: settings.dbPassword,
        database: settings.dbName,
      });
      await conn.ping();
      await conn.end();
      return { success: true, message: "Conexão MySQL estabelecida com sucesso" };
    }

    const client = new pg.Client({
      host: settings.dbHost,
      port: settings.dbPort,
      user: settings.dbUser,
      password: settings.dbPassword,
      database: settings.dbName,
      ssl: settings.dbHost.includes("neon") ? { rejectUnauthorized: false } : undefined,
    });
    await client.connect();
    await client.query("SELECT 1");
    await client.end();
    return { success: true, message: "Conexão PostgreSQL estabelecida com sucesso" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro desconhecido";
    return { success: false, message };
  }
}

export async function listTables(settings: DbSettings): Promise<string[]> {
  if (settings.dbType === "mysql") {
    const conn = await mysql.createConnection({
      host: settings.dbHost,
      port: settings.dbPort,
      user: settings.dbUser,
      password: settings.dbPassword,
      database: settings.dbName,
    });
    const [rows] = await conn.query<RowDataPacket[]>(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
      [settings.dbName],
    );
    await conn.end();
    return rows.map((r) => String(r.TABLE_NAME));
  }

  const client = new pg.Client(buildPgConfig(settings));
  await client.connect();
  const result = await client.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  await client.end();
  return result.rows.map((r) => r.tablename);
}

export type ColumnInfo = {
  column_name: string;
  data_type: string;
  isDateType: boolean;
  isAutoIncrement: boolean;
};

export async function listColumns(
  settings: DbSettings,
  tableName: string,
): Promise<ColumnInfo[]> {
  if (settings.dbType === "mysql") {
    const conn = await mysql.createConnection({
      host: settings.dbHost,
      port: settings.dbPort,
      user: settings.dbUser,
      password: settings.dbPassword,
      database: settings.dbName,
    });
    const [rows] = await conn.query<RowDataPacket[]>(
      "SELECT COLUMN_NAME, DATA_TYPE, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
      [settings.dbName, tableName],
    );
    await conn.end();
    return rows.map((r) => ({
      column_name: String(r.COLUMN_NAME),
      data_type: String(r.DATA_TYPE),
      isDateType: isDateType(String(r.DATA_TYPE)),
      isAutoIncrement: String(r.EXTRA ?? "").toLowerCase().includes("auto_increment"),
    }));
  }

  const client = new pg.Client(buildPgConfig(settings));
  await client.connect();
  const result = await client.query<{
    column_name: string;
    data_type: string;
    column_default: string | null;
    is_identity: string;
  }>(
    `SELECT column_name, data_type, column_default, is_identity FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [tableName],
  );
  await client.end();
  return result.rows.map((r) => ({
    column_name: r.column_name,
    data_type: r.data_type,
    isDateType: isDateType(r.data_type),
    isAutoIncrement:
      r.is_identity === "YES" ||
      (r.column_default?.startsWith("nextval(") ?? false),
  }));
}

function isDateType(dataType: string): boolean {
  const t = dataType.toLowerCase();
  return t.includes("date") || t.includes("time") || t.includes("timestamp");
}

function isNumericType(dataType: string): boolean {
  const t = dataType.toLowerCase();
  return (
    t.includes("int") ||
    t.includes("decimal") ||
    t.includes("numeric") ||
    t.includes("float") ||
    t.includes("double") ||
    t.includes("real") ||
    t === "bit"
  );
}

/** Normaliza célula para INSERT — vazio vira NULL em datas e números (MySQL rejeita '' em DECIMAL). */
export function normalizeCellForInsert(value: string, column: ColumnInfo): string | null {
  const trimmed = value.trim();
  if (column.isDateType) {
    return normalizeDateCellValue(trimmed, true);
  }
  if (isNumericType(column.data_type)) {
    return trimmed ? trimmed : null;
  }
  return trimmed || null;
}

function formatDateTimeForInsert(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function formatDateForCompare(date: Date): string {
  const y = date.getUTCFullYear();
  const mo = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

/** Formato único para comparar datas (serial Excel, ISO ou Date do driver). */
export function normalizeDateForCompare(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return formatDateForCompare(value);
  const trimmed = String(value).trim();
  if (!trimmed) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    const date = new Date(trimmed);
    if (!Number.isNaN(date.getTime())) return formatDateForCompare(date);
    return trimmed;
  }
  const n = Number(trimmed);
  if (!Number.isNaN(n) && n >= 1 && n <= 2_958_465) {
    const ms = Math.round((n - 25_569) * 86_400_000);
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) return formatDateForCompare(date);
  }
  return trimmed;
}

export function normalizeDateCellValue(value: string, isDateColumn: boolean): string | null {
  if (!isDateColumn) return value;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    const date = new Date(trimmed);
    if (!Number.isNaN(date.getTime())) return formatDateTimeForInsert(date);
    return trimmed;
  }
  const n = Number(trimmed);
  if (!Number.isNaN(n) && n >= 1 && n <= 2_958_465) {
    const ms = Math.round((n - 25_569) * 86_400_000);
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) return formatDateTimeForInsert(date);
  }
  return null;
}

export const DB_COMPARE_LIMIT = 100;

/** Alinha colunas da planilha com a tabela destino (ignora colunas extras da planilha). */
export function alignRowsToTableColumns(
  headers: string[],
  rows: string[][],
  tableColumns: ColumnInfo[],
  options?: { primaryKeyColumn?: string | null; tableName?: string },
): { headers: string[]; rows: string[][]; primaryKeyColumn: string | null; skipped: string[] } {
  const columnByLower = new Map(
    tableColumns.map((c) => [c.column_name.toLowerCase(), c]),
  );

  const indices: number[] = [];
  const dbHeaders: string[] = [];
  const skipped: string[] = [];

  headers.forEach((h, i) => {
    const col = columnByLower.get(h.toLowerCase());
    if (col) {
      const isPkUpsert =
        options?.primaryKeyColumn &&
        options.primaryKeyColumn.toLowerCase() === col.column_name.toLowerCase();
      if (col.isAutoIncrement && !isPkUpsert) {
        skipped.push(h);
        return;
      }
      dbHeaders.push(col.column_name);
      indices.push(i);
    } else {
      skipped.push(h);
    }
  });

  if (dbHeaders.length === 0) {
    const tableLabel = options?.tableName ?? "destino";
    const tableCols = tableColumns.map((c) => c.column_name).join(", ");
    throw new Error(
      `A planilha não tem colunas em comum com a tabela "${tableLabel}". ` +
        `Colunas da tabela: ${tableCols}. ` +
        `Para teste, use uma planilha com os mesmos nomes de coluna da tabela.`,
    );
  }

  const dbRows = rows.map((row) => indices.map((i) => row[i] ?? ""));

  let primaryKeyColumn: string | null = null;
  if (options?.primaryKeyColumn) {
    const resolved = columnByLower.get(options.primaryKeyColumn.toLowerCase());
    if (resolved && dbHeaders.includes(resolved.column_name)) primaryKeyColumn = resolved.column_name;
  }

  return { headers: dbHeaders, rows: dbRows, primaryKeyColumn, skipped };
}

function buildPgConfig(settings: DbSettings): pg.ClientConfig {
  return {
    host: settings.dbHost,
    port: settings.dbPort,
    user: settings.dbUser,
    password: settings.dbPassword,
    database: settings.dbName,
    ssl: settings.dbHost.includes("neon") ? { rejectUnauthorized: false } : undefined,
  };
}

export async function fetchRecentDbRows(
  settings: DbSettings,
  tableName: string,
  dateColumn: string,
  windowDays = 3,
): Promise<Record<string, unknown>[]> {
  if (settings.dbType === "mysql") {
    const conn = await mysql.createConnection({
      host: settings.dbHost,
      port: settings.dbPort,
      user: settings.dbUser,
      password: settings.dbPassword,
      database: settings.dbName,
    });
    const safeTable = `\`${tableName.replace(/`/g, "")}\``;
    const safeCol = `\`${dateColumn.replace(/`/g, "")}\``;
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT * FROM ${safeTable} WHERE ${safeCol} >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
      [windowDays],
    );
    await conn.end();
    return rows as Record<string, unknown>[];
  }

  const client = new pg.Client(buildPgConfig(settings));
  await client.connect();
  const safeTable = `"${tableName.replace(/"/g, "")}"`;
  const safeCol = `"${dateColumn.replace(/"/g, "")}"`;
  const result = await client.query(
    `SELECT * FROM ${safeTable} WHERE ${safeCol} >= NOW() - INTERVAL '${windowDays} days'`,
  );
  await client.end();
  return result.rows;
}

/** Últimos N registros da tabela (quando não há coluna de data configurada). */
export async function fetchLastDbRows(
  settings: DbSettings,
  tableName: string,
  limit = DB_COMPARE_LIMIT,
  orderColumn?: string | null,
): Promise<Record<string, unknown>[]> {
  if (settings.dbType === "mysql") {
    const conn = await mysql.createConnection({
      host: settings.dbHost,
      port: settings.dbPort,
      user: settings.dbUser,
      password: settings.dbPassword,
      database: settings.dbName,
    });
    const safeTable = `\`${tableName.replace(/`/g, "")}\``;
    let sql = `SELECT * FROM ${safeTable}`;
    if (orderColumn) {
      const safeCol = `\`${orderColumn.replace(/`/g, "")}\``;
      sql += ` ORDER BY ${safeCol} DESC`;
    }
    sql += ` LIMIT ?`;
    const [rows] = await conn.query<RowDataPacket[]>(sql, [limit]);
    await conn.end();
    return rows as Record<string, unknown>[];
  }

  const client = new pg.Client(buildPgConfig(settings));
  await client.connect();
  const safeTable = `"${tableName.replace(/"/g, "")}"`;
  let sql = `SELECT * FROM ${safeTable}`;
  const params: unknown[] = [];
  if (orderColumn) {
    sql += ` ORDER BY "${orderColumn.replace(/"/g, "")}" DESC`;
  }
  params.push(limit);
  sql += ` LIMIT $${params.length}`;
  const result = await client.query(sql, params);
  await client.end();
  return result.rows;
}

export async function countTableRows(
  settings: DbSettings,
  tableName: string,
): Promise<number> {
  if (settings.dbType === "mysql") {
    const conn = await mysql.createConnection({
      host: settings.dbHost,
      port: settings.dbPort,
      user: settings.dbUser,
      password: settings.dbPassword,
      database: settings.dbName,
    });
    const safeTable = `\`${tableName.replace(/`/g, "")}\``;
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS cnt FROM ${safeTable}`,
    );
    await conn.end();
    return Number(rows[0]?.cnt ?? 0);
  }

  const client = new pg.Client(buildPgConfig(settings));
  await client.connect();
  const safeTable = `"${tableName.replace(/"/g, "")}"`;
  const result = await client.query<{ cnt: string }>(`SELECT COUNT(*) AS cnt FROM ${safeTable}`);
  await client.end();
  return Number(result.rows[0]?.cnt ?? 0);
}

export async function insertRows(
  settings: DbSettings,
  tableName: string,
  headers: string[],
  rows: string[][],
  primaryKeyColumn?: string | null,
): Promise<{ insertedCount: number; skippedColumns: string[] }> {
  if (rows.length === 0) return { insertedCount: 0, skippedColumns: [] };

  const tableColumns = await listColumns(settings, tableName);
  const aligned = alignRowsToTableColumns(headers, rows, tableColumns, {
    primaryKeyColumn,
    tableName,
  });
  const { headers: dbHeaders, rows: dbRows, primaryKeyColumn: pk, skipped } = aligned;

  const columnByName = new Map(
    tableColumns.map((c) => [c.column_name.toLowerCase(), c]),
  );
  const normalizedRows = dbRows.map((row) =>
    row.map((cell, i) => {
      const col = columnByName.get(dbHeaders[i].toLowerCase());
      if (!col) return cell.trim() || null;
      return normalizeCellForInsert(cell ?? "", col);
    }),
  );

  if (settings.dbType === "mysql") {
    const conn = await mysql.createConnection({
      host: settings.dbHost,
      port: settings.dbPort,
      user: settings.dbUser,
      password: settings.dbPassword,
      database: settings.dbName,
    });
    const safeTable = `\`${tableName.replace(/`/g, "")}\``;
    const cols = dbHeaders.map((h) => `\`${h.replace(/`/g, "")}\``).join(", ");
    let inserted = 0;

    for (const row of normalizedRows) {
      const placeholders = row.map(() => "?").join(", ");
      if (pk) {
        const updates = dbHeaders
          .filter((h) => h !== pk)
          .map((h) => `\`${h.replace(/`/g, "")}\` = VALUES(\`${h.replace(/`/g, "")}\`)`)
          .join(", ");
        await conn.query(
          `INSERT INTO ${safeTable} (${cols}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updates}`,
          row,
        );
      } else {
        await conn.query(`INSERT INTO ${safeTable} (${cols}) VALUES (${placeholders})`, row);
      }
      inserted++;
    }
    await conn.end();
    return { insertedCount: inserted, skippedColumns: skipped };
  }

  const client = new pg.Client(buildPgConfig(settings));
  await client.connect();
  const safeTable = `"${tableName.replace(/"/g, "")}"`;
  const cols = dbHeaders.map((h) => `"${h.replace(/"/g, "")}"`).join(", ");
  let inserted = 0;

  for (const row of normalizedRows) {
    const placeholders = row.map((_, i) => `$${i + 1}`).join(", ");
    if (pk) {
      const updates = dbHeaders
        .filter((h) => h !== pk)
        .map((h) => `"${h.replace(/"/g, "")}" = EXCLUDED."${h.replace(/"/g, "")}"`)
        .join(", ");
      await client.query(
        `INSERT INTO ${safeTable} (${cols}) VALUES (${placeholders})
         ON CONFLICT ("${pk.replace(/"/g, "")}") DO UPDATE SET ${updates}`,
        row,
      );
    } else {
      await client.query(`INSERT INTO ${safeTable} (${cols}) VALUES (${placeholders})`, row);
    }
    inserted++;
  }
  await client.end();
  return { insertedCount: inserted, skippedColumns: skipped };
}

export async function getAppDbSettings(): Promise<DbSettings | null> {
  const { prisma } = await import("../lib/prisma.js");
  const settings = await prisma.appSettings.findUnique({ where: { id: 1 } });
  if (!settings || !settings.dbHost) return null;
  return settings;
}
