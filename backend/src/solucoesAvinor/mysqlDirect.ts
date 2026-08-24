// backend/src/solucoesAvinor/mysqlDirect.ts — insert/delete direto (pedidos / faturamento)

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

export async function insertBatchDirect(params: {
  settings: DbSettings;
  table: string;
  columns: MysqlColMeta[];
  sheetRows: string[][];
}): Promise<number> {
  const { settings, table, columns, sheetRows } = params;
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
      `INSERT INTO ${qIdent(table)} (${colsSql}) VALUES ${placeholders}`,
      values.flat(),
    );
    return values.length;
  } finally {
    await conn.end();
  }
}

export async function fetchExistingNumeros(
  settings: DbSettings,
  table: string,
  numeroCol: string,
  numeros: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!numeros.length) return out;

  const conn = await openConn(settings);
  try {
    const chunk = 500;
    for (let i = 0; i < numeros.length; i += chunk) {
      const slice = numeros.slice(i, i + chunk);
      const placeholders = slice.map(() => "?").join(",");
      const [rows] = await conn.query<RowDataPacket[]>(
        `SELECT ${qIdent(numeroCol)} AS n FROM ${qIdent(table)} WHERE ${qIdent(numeroCol)} IN (${placeholders})`,
        slice,
      );
      for (const r of rows) {
        const v = String(r.n ?? "").trim();
        if (v) out.add(v);
      }
    }
    return out;
  } finally {
    await conn.end();
  }
}

/**
 * Igual upload_avinor: DELETE WHERE data >= from AND data < toExclusive
 * (janela de meses coberta pela planilha).
 */
export async function deleteByDateWindow(params: {
  settings: DbSettings;
  table: string;
  dtCol: string;
  dateFrom: string;
  dateToExclusive: string;
}): Promise<number> {
  const { settings, table, dtCol, dateFrom, dateToExclusive } = params;
  const conn = await openConn(settings);
  try {
    const [result] = await conn.query(
      `DELETE FROM ${qIdent(table)} WHERE ${qIdent(dtCol)} >= ? AND ${qIdent(dtCol)} < ?`,
      [dateFrom, dateToExclusive],
    );
    return Number((result as { affectedRows?: number }).affectedRows ?? 0);
  } finally {
    await conn.end();
  }
}
