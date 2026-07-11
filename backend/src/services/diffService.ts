// backend/src/services/diffService.ts — Diff dupla camada (planilha + banco)

import type { Company } from "../../generated/prisma/client.js";
import { hashRow, normalizeCell } from "../utils/hash.js";
import {
  DB_COMPARE_LIMIT,
  fetchLastDbRows,
  fetchRecentDbRows,
  getAppDbSettings,
  listColumns,
  normalizeDateForCompare,
  type DbSettings,
} from "./externalDbService.js";

export type ParsedSpreadsheet = {
  headers: string[];
  rows: string[][];
};

export type DiffRow = {
  isNew: boolean;
  isNewInDb: boolean;
  mustSend: boolean;
  data: string[];
};

export type DiffResult = {
  headers: string[];
  rows: DiffRow[];
  summary: {
    totalRows: number;
    newRows: number;
    previousRows: number;
    alreadyInDb: number;
    mustSend: number;
  };
  skippedColumns: string[];
  dbRowsLoaded: number;
  dbWindowDays: number;
  dateColumnUsed: string | null;
  compareColumnUsed: string | null;
  dbCompareLimit: number | null;
  dbCompareMode: "date" | "last_records" | "skipped";
  dbCheckSkipped: boolean;
};

type ColumnMapping = Record<string, string>;

function applyColumnMapping(headers: string[], mapping?: ColumnMapping | null): string[] {
  if (!mapping) return headers;
  return headers.map((h) => mapping[h] ?? h);
}

function filterHeadersToTable(
  headers: string[],
  tableColumns: { column_name: string }[],
): string[] {
  const tableCols = new Set(tableColumns.map((c) => c.column_name.toLowerCase()));
  return headers.filter((h) => tableCols.has(h.toLowerCase()));
}

function rowValuesForCompare(
  sourceHeaders: string[],
  row: string[],
  targetHeaders: string[],
  dateColumnNames: Set<string>,
): string[] {
  return targetHeaders.map((h) => {
    const idx = sourceHeaders.findIndex((sh) => sh.toLowerCase() === h.toLowerCase());
    const raw = idx >= 0 ? row[idx] ?? "" : "";
    if (dateColumnNames.has(h.toLowerCase())) {
      return normalizeDateForCompare(raw);
    }
    return normalizeCell(raw);
  });
}


function dbRecordToValues(
  record: Record<string, unknown>,
  headers: string[],
  dateColumnNames: Set<string>,
): string[] {
  return headers.map((col) => {
    const key = Object.keys(record).find((k) => k.toLowerCase() === col.toLowerCase());
    const raw = key ? record[key] : "";
    if (dateColumnNames.has(col.toLowerCase())) {
      return normalizeDateForCompare(raw);
    }
    return normalizeCell(raw);
  });
}

export async function computeDiff(
  current: ParsedSpreadsheet,
  previous: ParsedSpreadsheet | null,
  company: Company,
  dbSettings: DbSettings | null,
): Promise<DiffResult> {
  const mapping = company.columnMapping as ColumnMapping | null;
  let compareHeaders = applyColumnMapping(current.headers, mapping);
  const dbWindowDays = 3;
  const compareColumn = company.compareColumn ?? null;

  let dbHashCounts = new Map<string, number>();
  let dateColumnUsed: string | null = company.dateColumn || null;
  let dbCompareMode: DiffResult["dbCompareMode"] = "skipped";
  let dbCompareLimit: number | null = null;
  let dbCheckSkipped = false;
  let dateColumnNames = new Set<string>();

  let skippedColumns: string[] = [];
  let dbRowsLoaded = 0;

  if (dbSettings && company.targetTable) {
    try {
      const tableColumns = await listColumns(dbSettings, company.targetTable);
      compareHeaders = filterHeadersToTable(compareHeaders, tableColumns);
      dateColumnNames = new Set(
        tableColumns.filter((c) => c.isDateType).map((c) => c.column_name.toLowerCase()),
      );

      if (dateColumnUsed) {
        const dateCol = tableColumns.find(
          (c) => c.column_name.toLowerCase() === dateColumnUsed!.toLowerCase(),
        );
        if (!dateCol?.isDateType) dateColumnUsed = null;
      }

      let dbRows: Record<string, unknown>[];
      const sheetRowCount = current.rows.length;
      // Janela: linhas da planilha + últimos N do banco (ex.: 12 + 100)
      const compareLimit = sheetRowCount + DB_COMPARE_LIMIT;

      // Preferir ordenar por coluna de data da tabela (não por id — notas repetem o mesmo id)
      const orderCol =
        tableColumns.find((c) => c.isDateType)?.column_name ??
        tableColumns.find((c) => c.column_name.toLowerCase() !== "id")?.column_name ??
        null;

      if (dateColumnUsed) {
        dbRows = await fetchRecentDbRows(
          dbSettings,
          company.targetTable,
          dateColumnUsed,
          dbWindowDays,
        );
        dbCompareMode = "date";
        // Datas Excel (ex.: 13302 → 1936) ficam fora de "últimos 3 dias de hoje".
        // Sem fallback, a comparação volta 0 linhas e tudo parece NOVO (reenvia duplicata).
        if (dbRows.length === 0) {
          dbRows = await fetchLastDbRows(
            dbSettings,
            company.targetTable,
            compareLimit,
            orderCol,
          );
          dbCompareMode = "last_records";
          dateColumnUsed = null;
          dbCompareLimit = compareLimit;
        }
      } else {
        dbRows = await fetchLastDbRows(
          dbSettings,
          company.targetTable,
          compareLimit,
          orderCol,
        );
        dbCompareMode = "last_records";
        dbCompareLimit = compareLimit;
      }

      const tableColSet = new Set(
        tableColumns.map((c) => c.column_name.toLowerCase()),
      );
      skippedColumns = current.headers.filter(
        (h) => !tableColSet.has(h.toLowerCase()),
      );
      dbRowsLoaded = dbRows.length;

      const dbRowArrays = dbRows.map((record) =>
        dbRecordToValues(record, compareHeaders, dateColumnNames),
      );
      dbHashCounts = new Map();
      for (const values of dbRowArrays) {
        const h = hashRow(values, compareHeaders);
        dbHashCounts.set(h, (dbHashCounts.get(h) ?? 0) + 1);
      }
    } catch (err) {
      console.error("[diff] falha ao comparar com banco:", err);
      dbCheckSkipped = true;
      dbCompareMode = "skipped";
    }
  } else {
    dbCheckSkipped = true;
  }

  let previousHashes = new Set<string>();
  if (previous && previous.rows.length > 0) {
    const prevMapped = previous.rows.map((row) =>
      rowValuesForCompare(previous.headers, row, compareHeaders, dateColumnNames),
    );
    previousHashes = new Set(
      prevMapped.map((values) => hashRow(values, compareHeaders)),
    );
  }

  const remainingDbHashes = new Map(dbHashCounts);

  const diffRows: DiffRow[] = current.rows.map((row) => {
    const dbRow = rowValuesForCompare(current.headers, row, compareHeaders, dateColumnNames);
    const fullHash = hashRow(dbRow, compareHeaders);
    const isNew = previous ? !previousHashes.has(fullHash) : true;
    let isNewInDb = true;
    if (!dbCheckSkipped) {
      const left = remainingDbHashes.get(fullHash) ?? 0;
      if (left > 0) {
        remainingDbHashes.set(fullHash, left - 1);
        isNewInDb = false;
      }
    }
    const mustSend = isNew && isNewInDb;
    return { isNew, isNewInDb, mustSend, data: row };
  });

  const mustSendCount = diffRows.filter((r) => r.mustSend).length;
  const alreadyInDb = diffRows.filter((r) => r.isNew && !r.isNewInDb).length;

  return {
    headers: current.headers,
    rows: diffRows,
    summary: {
      totalRows: diffRows.length,
      newRows: diffRows.filter((r) => r.isNew).length,
      previousRows: previous?.rows.length ?? 0,
      alreadyInDb,
      mustSend: mustSendCount,
    },
    skippedColumns,
    dbRowsLoaded,
    dbWindowDays,
    dateColumnUsed,
    compareColumnUsed: compareColumn,
    dbCompareLimit,
    dbCompareMode,
    dbCheckSkipped,
  };
}

export async function computeDiffForSpreadsheet(
  current: ParsedSpreadsheet,
  previous: ParsedSpreadsheet | null,
  company: Company,
): Promise<DiffResult> {
  const dbSettings = await getAppDbSettings();
  return computeDiff(current, previous, company, dbSettings);
}

export function getMustSendRows(diff: DiffResult): string[][] {
  return diff.rows.filter((r) => r.mustSend).map((r) => r.data);
}

export function getMustSendRowsByIndices(diff: DiffResult, indices: number[]): string[][] {
  const mustSend = diff.rows.filter((r) => r.mustSend);
  return indices
    .filter((i) => i >= 0 && i < mustSend.length)
    .map((i) => mustSend[i].data);
}

export function parseRawData(rawData: string): ParsedSpreadsheet {
  const parsed = JSON.parse(rawData) as ParsedSpreadsheet;
  return parsed;
}
