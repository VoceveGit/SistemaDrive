// backend/src/services/diffService.ts — Diff configurável (incremental / update / principal / snapshot)

import type { Company } from "../../generated/prisma/client.js";
import { hashRow, normalizeCell } from "../utils/hash.js";
import {
  DB_COMPARE_LIMIT,
  fetchDbRowsByMonth,
  fetchDistinctColumnValues,
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

export type FieldChange = {
  column: string;
  from: string;
  to: string;
};

export type DiffRow = {
  isNew: boolean;
  isNewInDb: boolean;
  mustSend: boolean;
  /** Linha existe no banco (mesma chave) mas conteúdo mudou */
  isUpdated: boolean;
  mustUpdate: boolean;
  changes: FieldChange[];
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
    mustUpdate: number;
  };
  skippedColumns: string[];
  dbRowsLoaded: number;
  dbWindowDays: number;
  dateColumnUsed: string | null;
  compareColumnUsed: string | null;
  dbCompareLimit: number | null;
  dbCompareMode: "date" | "month" | "last_records" | "principal" | "snapshot" | "skipped";
  dbCheckSkipped: boolean;
  syncMode: string;
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

function parseYearMonthFromCell(raw: string): { year: number; month: number } | null {
  const normalized = normalizeDateForCompare(raw);
  if (!normalized) return null;
  // yyyy-mm-dd
  const iso = normalized.match(/^(\d{4})-(\d{2})/);
  if (iso) return { year: Number(iso[1]), month: Number(iso[2]) };
  // dd/mm/yyyy
  const br = String(raw).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (br) return { year: Number(br[3]), month: Number(br[2]) };
  const d = new Date(normalized);
  if (!Number.isNaN(d.getTime())) return { year: d.getFullYear(), month: d.getMonth() + 1 };
  return null;
}

function emptyDiffRow(data: string[], overrides: Partial<DiffRow> = {}): DiffRow {
  return {
    isNew: true,
    isNewInDb: true,
    mustSend: false,
    isUpdated: false,
    mustUpdate: false,
    changes: [],
    data,
    ...overrides,
  };
}

function computeFieldChanges(
  headers: string[],
  sheetValues: string[],
  dbValues: string[],
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (let i = 0; i < headers.length; i++) {
    const from = dbValues[i] ?? "";
    const to = sheetValues[i] ?? "";
    if (from !== to) {
      changes.push({ column: headers[i], from, to });
    }
  }
  return changes;
}

export async function computeDiff(
  current: ParsedSpreadsheet,
  previous: ParsedSpreadsheet | null,
  company: Company,
  dbSettings: DbSettings | null,
): Promise<DiffResult> {
  const syncMode = company.syncMode || "incremental";
  const mapping = company.columnMapping as ColumnMapping | null;
  let compareHeaders = applyColumnMapping(current.headers, mapping);
  const principalColumn = company.compareColumn ?? null;
  const useDateFilter = Boolean(company.useDateFilter);
  const dbWindowDays = 3;

  let dateColumnUsed: string | null = company.dateColumn || null;
  let dbCompareMode: DiffResult["dbCompareMode"] = "skipped";
  let dbCompareLimit: number | null = null;
  let dbCheckSkipped = false;
  let dateColumnNames = new Set<string>();
  let skippedColumns: string[] = [];
  let dbRowsLoaded = 0;

  let dbHashCounts = new Map<string, number>();
  /** principalKey → lista de rows normalizadas do banco */
  let dbByPrincipal = new Map<string, string[][]>();
  let principalKeysInDb = new Set<string>();

  // Snapshot: tudo deve ser enviado (após limpar tabela)
  if (syncMode === "snapshot") {
    const rows = current.rows.map((row) =>
      emptyDiffRow(row, { mustSend: true, isNew: true, isNewInDb: true }),
    );
    return {
      headers: current.headers,
      rows,
      summary: {
        totalRows: rows.length,
        newRows: rows.length,
        previousRows: previous?.rows.length ?? 0,
        alreadyInDb: 0,
        mustSend: rows.length,
        mustUpdate: 0,
      },
      skippedColumns: [],
      dbRowsLoaded: 0,
      dbWindowDays,
      dateColumnUsed: null,
      compareColumnUsed: principalColumn,
      dbCompareLimit: null,
      dbCompareMode: "snapshot",
      dbCheckSkipped: false,
      syncMode,
    };
  }

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
        if (!dateCol) dateColumnUsed = null;
      }

      const tableColSet = new Set(tableColumns.map((c) => c.column_name.toLowerCase()));
      skippedColumns = applyColumnMapping(current.headers, mapping).filter(
        (h) => !tableColSet.has(h.toLowerCase()),
      );

      const orderCol =
        tableColumns.find((c) => c.isDateType)?.column_name ??
        tableColumns.find((c) => c.column_name.toLowerCase() !== "id")?.column_name ??
        null;

      // --- principal_only: só checa existência da coluna principal ---
      if (syncMode === "principal_only" && principalColumn) {
        const mappedPrincipal =
          mapping?.[principalColumn] ??
          compareHeaders.find((h) => h.toLowerCase() === principalColumn.toLowerCase()) ??
          principalColumn;
        principalKeysInDb = await fetchDistinctColumnValues(
          dbSettings,
          company.targetTable,
          mappedPrincipal,
        );
        dbRowsLoaded = principalKeysInDb.size;
        dbCompareMode = "principal";
        dbCheckSkipped = false;
      } else {
        let dbRows: Record<string, unknown>[] = [];

        if (useDateFilter && dateColumnUsed && current.rows.length > 0) {
          const dateIdx = current.headers.findIndex(
            (h) => h.toLowerCase() === (company.dateColumn ?? "").toLowerCase(),
          );
          const firstDateRaw = dateIdx >= 0 ? current.rows[0]?.[dateIdx] ?? "" : "";
          const ym = parseYearMonthFromCell(firstDateRaw);
          if (ym) {
            dbRows = await fetchDbRowsByMonth(
              dbSettings,
              company.targetTable,
              dateColumnUsed,
              ym.year,
              ym.month,
            );
            dbCompareMode = "month";
          }
        }

        if (dbRows.length === 0 && dateColumnUsed && !useDateFilter) {
          dbRows = await fetchRecentDbRows(
            dbSettings,
            company.targetTable,
            dateColumnUsed,
            dbWindowDays,
          );
          dbCompareMode = "date";
        }

        if (dbRows.length === 0) {
          const compareLimit = current.rows.length + DB_COMPARE_LIMIT;
          dbRows = await fetchLastDbRows(
            dbSettings,
            company.targetTable,
            compareLimit,
            orderCol,
          );
          dbCompareMode = "last_records";
          dbCompareLimit = compareLimit;
          if (!useDateFilter) dateColumnUsed = null;
        }

        dbRowsLoaded = dbRows.length;
        dbHashCounts = new Map();
        dbByPrincipal = new Map();

        const principalHeader =
          principalColumn &&
          compareHeaders.find((h) => h.toLowerCase() === principalColumn.toLowerCase());

        for (const record of dbRows) {
          const values = dbRecordToValues(record, compareHeaders, dateColumnNames);
          const h = hashRow(values, compareHeaders);
          dbHashCounts.set(h, (dbHashCounts.get(h) ?? 0) + 1);

          if (principalHeader) {
            const pIdx = compareHeaders.findIndex(
              (x) => x.toLowerCase() === principalHeader.toLowerCase(),
            );
            const pVal = pIdx >= 0 ? values[pIdx] : "";
            if (pVal) {
              const list = dbByPrincipal.get(pVal) ?? [];
              list.push(values);
              dbByPrincipal.set(pVal, list);
            }
          }
        }
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
    previousHashes = new Set(prevMapped.map((values) => hashRow(values, compareHeaders)));
  }

  const remainingDbHashes = new Map(dbHashCounts);
  const principalHeader =
    principalColumn &&
    compareHeaders.find((h) => h.toLowerCase() === principalColumn.toLowerCase());

  const diffRows: DiffRow[] = current.rows.map((row) => {
    const dbRow = rowValuesForCompare(current.headers, row, compareHeaders, dateColumnNames);
    const fullHash = hashRow(dbRow, compareHeaders);
    const isNewVsPrev = previous ? !previousHashes.has(fullHash) : true;

    // Modo: só coluna principal
    if (syncMode === "principal_only" && principalHeader) {
      const pIdx = compareHeaders.findIndex(
        (x) => x.toLowerCase() === principalHeader.toLowerCase(),
      );
      const pVal = pIdx >= 0 ? dbRow[pIdx] : "";
      const exists = pVal !== "" && principalKeysInDb.has(pVal);
      return emptyDiffRow(row, {
        isNew: isNewVsPrev,
        isNewInDb: !exists,
        mustSend: !exists && pVal !== "",
        isUpdated: false,
        mustUpdate: false,
        changes: [],
      });
    }

    // Hash exact match no banco
    let exactInDb = false;
    if (!dbCheckSkipped) {
      const left = remainingDbHashes.get(fullHash) ?? 0;
      if (left > 0) {
        remainingDbHashes.set(fullHash, left - 1);
        exactInDb = true;
      }
    }

    if (exactInDb) {
      return emptyDiffRow(row, {
        isNew: isNewVsPrev,
        isNewInDb: false,
        mustSend: false,
        isUpdated: false,
        mustUpdate: false,
        changes: [],
      });
    }

    // Incremental + UPDATE: mesma chave principal, conteúdo diferente
    if (syncMode === "incremental_update" && principalHeader && !dbCheckSkipped) {
      const pIdx = compareHeaders.findIndex(
        (x) => x.toLowerCase() === principalHeader.toLowerCase(),
      );
      const pVal = pIdx >= 0 ? dbRow[pIdx] : "";
      const candidates = pVal ? dbByPrincipal.get(pVal) : undefined;
      if (candidates && candidates.length > 0) {
        // Usa o primeiro registro do banco com essa chave pra montar o diff de campos
        const dbValues = candidates[0];
        const changes = computeFieldChanges(compareHeaders, dbRow, dbValues);
        if (changes.length > 0) {
          return emptyDiffRow(row, {
            isNew: isNewVsPrev,
            isNewInDb: false,
            mustSend: false,
            isUpdated: true,
            mustUpdate: true,
            changes,
          });
        }
      }
    }

    // Novo → INSERT
    return emptyDiffRow(row, {
      isNew: isNewVsPrev,
      isNewInDb: true,
      mustSend: true,
      isUpdated: false,
      mustUpdate: false,
      changes: [],
    });
  });

  return {
    headers: current.headers,
    rows: diffRows,
    summary: {
      totalRows: diffRows.length,
      newRows: diffRows.filter((r) => r.isNew).length,
      previousRows: previous?.rows.length ?? 0,
      alreadyInDb: diffRows.filter((r) => !r.isNewInDb && !r.isUpdated).length,
      mustSend: diffRows.filter((r) => r.mustSend).length,
      mustUpdate: diffRows.filter((r) => r.mustUpdate).length,
    },
    skippedColumns,
    dbRowsLoaded,
    dbWindowDays,
    dateColumnUsed,
    compareColumnUsed: principalColumn,
    dbCompareLimit,
    dbCompareMode,
    dbCheckSkipped,
    syncMode,
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

export function getMustUpdateRows(diff: DiffResult): DiffRow[] {
  return diff.rows.filter((r) => r.mustUpdate);
}

export function getMustSendRowsByIndices(diff: DiffResult, indices: number[]): string[][] {
  const mustSend = diff.rows.filter((r) => r.mustSend);
  return indices
    .filter((i) => i >= 0 && i < mustSend.length)
    .map((i) => mustSend[i].data);
}

export function parseRawData(rawData: string): ParsedSpreadsheet {
  return JSON.parse(rawData) as ParsedSpreadsheet;
}
