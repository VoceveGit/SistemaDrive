// backend/src/services/stagingService.ts
// Tabela genérica zz_import_staging no EXTRACTOR — 1 tabela, N jobs (job_id).

import mysql from "mysql2/promise";
import type { DbSettings } from "./externalDbService.js";

export const STAGING_TABLE = "zz_import_staging";

function mysqlConn(settings: DbSettings) {
  return mysql.createConnection({
    host: settings.dbHost,
    port: settings.dbPort,
    user: settings.dbUser,
    password: settings.dbPassword,
    database: settings.dbName,
  });
}

/** Cria a tabela genérica uma vez (IF NOT EXISTS). Fica no banco; dados do job são limpos depois. */
export async function ensureStagingTable(settings: DbSettings): Promise<void> {
  if (settings.dbType !== "mysql") {
    throw new Error("Tabela job (staging) disponível apenas para MySQL (EXTRACTOR)");
  }
  const conn = await mysqlConn(settings);
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`${STAGING_TABLE}\` (
        \`id\` BIGINT NOT NULL AUTO_INCREMENT,
        \`job_id\` VARCHAR(64) NOT NULL,
        \`company_id\` VARCHAR(64) NOT NULL,
        \`row_num\` INT NOT NULL,
        \`payload_json\` MEDIUMTEXT NOT NULL,
        \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        KEY \`idx_staging_job\` (\`job_id\`),
        KEY \`idx_staging_job_row\` (\`job_id\`, \`row_num\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  } finally {
    await conn.end();
  }
}

export async function clearStagingJob(
  settings: DbSettings,
  jobId: string,
): Promise<void> {
  const conn = await mysqlConn(settings);
  try {
    await conn.query(`DELETE FROM \`${STAGING_TABLE}\` WHERE \`job_id\` = ?`, [jobId]);
  } finally {
    await conn.end();
  }
}

export async function insertStagingBatch(params: {
  settings: DbSettings;
  jobId: string;
  companyId: string;
  startRowNum: number;
  rows: string[][];
}): Promise<number> {
  const { settings, jobId, companyId, startRowNum, rows } = params;
  if (rows.length === 0) return 0;

  const conn = await mysqlConn(settings);
  try {
    const values: unknown[] = [];
    const placeholders: string[] = [];
    rows.forEach((row, i) => {
      placeholders.push("(?, ?, ?, ?)");
      values.push(jobId, companyId, startRowNum + i, JSON.stringify(row));
    });
    await conn.query(
      `INSERT INTO \`${STAGING_TABLE}\` (\`job_id\`, \`company_id\`, \`row_num\`, \`payload_json\`)
       VALUES ${placeholders.join(", ")}`,
      values,
    );
    return rows.length;
  } finally {
    await conn.end();
  }
}

export async function countStagingRows(
  settings: DbSettings,
  jobId: string,
): Promise<number> {
  const conn = await mysqlConn(settings);
  try {
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS cnt FROM \`${STAGING_TABLE}\` WHERE \`job_id\` = ?`,
      [jobId],
    );
    return Number(rows[0]?.cnt ?? 0);
  } finally {
    await conn.end();
  }
}

export async function fetchStagingPreview(
  settings: DbSettings,
  jobId: string,
  limit = 300,
): Promise<string[][]> {
  const conn = await mysqlConn(settings);
  try {
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT \`payload_json\` FROM \`${STAGING_TABLE}\`
       WHERE \`job_id\` = ?
       ORDER BY \`row_num\` ASC
       LIMIT ?`,
      [jobId, limit],
    );
    return rows.map((r) => {
      try {
        return JSON.parse(String(r.payload_json)) as string[];
      } catch {
        return [];
      }
    });
  } finally {
    await conn.end();
  }
}

/**
 * Lê o staging em lotes (para o Enviar), sem carregar tudo na RAM.
 */
export async function forEachStagingBatch(
  settings: DbSettings,
  jobId: string,
  batchSize: number,
  onBatch: (rows: string[][]) => Promise<void>,
): Promise<number> {
  const conn = await mysqlConn(settings);
  let offset = 0;
  let total = 0;
  try {
    for (;;) {
      const [rows] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT \`payload_json\` FROM \`${STAGING_TABLE}\`
         WHERE \`job_id\` = ?
         ORDER BY \`row_num\` ASC
         LIMIT ? OFFSET ?`,
        [jobId, batchSize, offset],
      );
      if (!rows.length) break;
      const parsed = rows.map((r) => {
        try {
          return JSON.parse(String(r.payload_json)) as string[];
        } catch {
          return [];
        }
      });
      await onBatch(parsed);
      total += parsed.length;
      offset += rows.length;
      if (rows.length < batchSize) break;
    }
    return total;
  } finally {
    await conn.end();
  }
}
