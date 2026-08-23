// backend/src/solucoesAvinor/snapshotMysql.ts

import mysql from "mysql2/promise";
import type { RowDataPacket } from "mysql2";
import type { DbSettings } from "../services/externalDbService.js";
import { convertCellForMysql, type MysqlColMeta } from "./conversoes.js";

function openConn(settings: DbSettings) {
  return mysql.createConnection({
    host: settings.dbHost,
    port: settings.dbPort,
    user: settings.dbUser,
    password: settings.dbPassword,
    database: settings.dbName,
  });
}

function qIdent(name: string): string {
  return `\`${String(name).replace(/`/g, "")}\``;
}

export function mirrorTableName(targetTable: string): string {
  return `${String(targetTable).replace(/`/g, "").trim()}_novo`;
}

export async function listMysqlColumnsOrdered(
  settings: DbSettings,
  tableName: string,
): Promise<MysqlColMeta[]> {
  const conn = await openConn(settings);
  try {
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT COLUMN_NAME AS name, DATA_TYPE AS dataType
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION ASC`,
      [settings.dbName, tableName],
    );
    return rows.map((r) => ({
      name: String(r.name),
      dataType: String(r.dataType),
    }));
  } finally {
    await conn.end();
  }
}

export async function countRows(settings: DbSettings, tableName: string): Promise<number> {
  const conn = await openConn(settings);
  try {
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS cnt FROM ${qIdent(tableName)}`,
    );
    return Number(rows[0]?.cnt ?? 0);
  } finally {
    await conn.end();
  }
}

export async function prepareMirrorTable(
  settings: DbSettings,
  targetTable: string,
): Promise<string> {
  const mirror = mirrorTableName(targetTable);
  const conn = await openConn(settings);
  try {
    await conn.query(
      `CREATE TABLE IF NOT EXISTS ${qIdent(mirror)} LIKE ${qIdent(targetTable)}`,
    );
    await conn.query(`TRUNCATE TABLE ${qIdent(mirror)}`);
  } finally {
    await conn.end();
  }
  return mirror;
}

export async function insertBatchIntoMirror(params: {
  settings: DbSettings;
  mirrorTable: string;
  columns: MysqlColMeta[];
  sheetRows: string[][];
}): Promise<number> {
  const { settings, mirrorTable, columns, sheetRows } = params;
  if (!sheetRows.length) return 0;

  const values = sheetRows.map((row) =>
    columns.map((col, i) => convertCellForMysql(row[i] ?? "", col)),
  );

  const conn = await openConn(settings);
  try {
    const colsSql = columns.map((c) => qIdent(c.name)).join(", ");
    const one = `(${columns.map(() => "?").join(",")})`;
    const placeholders = values.map(() => one).join(",");
    await conn.query(
      `INSERT INTO ${qIdent(mirrorTable)} (${colsSql}) VALUES ${placeholders}`,
      values.flat(),
    );
    return values.length;
  } finally {
    await conn.end();
  }
}

export async function commitMirrorSwap(params: {
  settings: DbSettings;
  targetTable: string;
  mirrorTable: string;
}): Promise<void> {
  const { settings, targetTable, mirrorTable } = params;
  const conn = await openConn(settings);
  try {
    await conn.beginTransaction();
    await conn.query(`DELETE FROM ${qIdent(targetTable)}`);
    await conn.query(
      `INSERT INTO ${qIdent(targetTable)} SELECT * FROM ${qIdent(mirrorTable)}`,
    );
    await conn.commit();
  } catch (e) {
    await conn.rollback().catch(() => undefined);
    throw e;
  } finally {
    await conn.end();
  }
}

export async function truncateMirror(
  settings: DbSettings,
  mirrorTable: string,
): Promise<void> {
  const conn = await openConn(settings);
  try {
    await conn.query(`TRUNCATE TABLE ${qIdent(mirrorTable)}`);
  } finally {
    await conn.end();
  }
}
