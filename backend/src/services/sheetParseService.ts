// backend/src/services/sheetParseService.ts — Leitura configurável de planilhas

import * as XLSX from "xlsx";
import type { ParsedSpreadsheet } from "./diffService.js";
import { excelLetterToIndex } from "../utils/columnMapping.js";

export type IgnoreRules = {
  column: string;
  values: string[];
};

export type SheetParseOptions = {
  headerRow?: number; // 1-based
  dataRow?: number | null;
  sheetName?: string | null;
  autofillEmpty?: boolean;
  skipEmptyRows?: boolean;
  ignoreRules?: IgnoreRules | null;
};

function normalizeIgnoreToken(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Resolve coluna de ignore: letra Excel (C, AF) ou nome do cabeçalho.
 * Com keepIdx (após limpar headers vazios), a letra é mapeada para o índice limpo.
 */
export function resolveIgnoreColumnIndex(
  column: string,
  headers: string[],
  originalKeepIdx?: number[],
): number {
  const key = column.trim();
  if (!key) return -1;

  const letterIdx = excelLetterToIndex(key);
  if (letterIdx != null) {
    if (originalKeepIdx && originalKeepIdx.length > 0) {
      return originalKeepIdx.indexOf(letterIdx);
    }
    return letterIdx;
  }

  return headers.findIndex((h) => h.toLowerCase() === key.toLowerCase());
}

function applyAutofill(rows: string[][]): string[][] {
  if (rows.length === 0) return rows;
  const cols = Math.max(...rows.map((r) => r.length), 0);
  const last: string[] = Array(cols).fill("");
  return rows.map((row) => {
    const out: string[] = [];
    for (let c = 0; c < cols; c++) {
      const raw = String(row[c] ?? "").trim();
      if (raw !== "") {
        last[c] = raw;
        out[c] = raw;
      } else {
        out[c] = last[c] ?? "";
      }
    }
    return out;
  });
}

function isRowEmpty(row: string[]): boolean {
  return row.every((c) => String(c ?? "").trim() === "");
}

export function parseWorkbookBuffer(
  buffer: Buffer,
  options: SheetParseOptions = {},
): ParsedSpreadsheet {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetName =
    (options.sheetName && workbook.SheetNames.includes(options.sheetName)
      ? options.sheetName
      : workbook.SheetNames[0]) ?? workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const json = XLSX.utils.sheet_to_json<(string | number | boolean | Date | null)[]>(sheet, {
    header: 1,
    defval: "",
    raw: false,
  });

  if (json.length === 0) {
    return { headers: [], rows: [] };
  }

  const headerRowIndex = Math.max((options.headerRow ?? 1) - 1, 0);
  const dataStartIndex =
    options.dataRow != null && options.dataRow > 0
      ? options.dataRow - 1
      : headerRowIndex + 1;

  const headerCells = json[headerRowIndex] ?? [];
  const headers = headerCells.map((c) => String(c ?? "").trim());
  const colCount = headers.length;

  let rows = json.slice(dataStartIndex).map((row) =>
    headers.map((_, i) => String(row?.[i] ?? "").trim()),
  );

  // Garante largura
  rows = rows.map((row) => {
    const padded = [...row];
    while (padded.length < colCount) padded.push("");
    return padded.slice(0, colCount);
  });

  if (options.autofillEmpty) {
    rows = applyAutofill(rows);
  }

  if (options.skipEmptyRows !== false) {
    rows = rows.filter((row) => !isRowEmpty(row));
  }

  const ignore = options.ignoreRules;
  if (ignore?.column && ignore.values?.length) {
    const colIdx = resolveIgnoreColumnIndex(ignore.column, headers);
    if (colIdx >= 0) {
      const banned = new Set(ignore.values.map(normalizeIgnoreToken));
      rows = rows.filter((row) => {
        const cell = normalizeIgnoreToken(row[colIdx] ?? "");
        return !banned.has(cell);
      });
    }
  }

  // Remove colunas sem título
  const keepIdx = headers
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => h !== "")
    .map(({ i }) => i);
  const cleanHeaders = keepIdx.map((i) => headers[i]);
  const cleanRows = rows.map((row) => keepIdx.map((i) => row[i] ?? ""));

  return { headers: cleanHeaders, rows: cleanRows };
}

export function parseOptionsFromCompany(company: {
  headerRow?: number | null;
  dataRow?: number | null;
  sheetName?: string | null;
  autofillEmpty?: boolean | null;
  skipEmptyRows?: boolean | null;
  ignoreRules?: unknown;
}): SheetParseOptions {
  const ignoreRules = company.ignoreRules as IgnoreRules | null | undefined;
  return {
    headerRow: company.headerRow ?? 1,
    dataRow: company.dataRow ?? null,
    sheetName: company.sheetName ?? null,
    autofillEmpty: Boolean(company.autofillEmpty),
    skipEmptyRows: company.skipEmptyRows !== false,
    ignoreRules: ignoreRules?.column ? ignoreRules : null,
  };
}
