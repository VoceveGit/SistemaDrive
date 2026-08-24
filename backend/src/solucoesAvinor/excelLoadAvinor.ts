// backend/src/solucoesAvinor/excelLoadAvinor.ts
// Leitura XLSX para soluções Avinor — datas como openpyxl/pandas (não serial torto).

import ExcelJS from "exceljs";
import { sanitizeExcelText } from "../services/sheetParseService.js";

/** Serial Excel → Date via época Unix (fórmula 25569). */
export function excelSerialToDate(serial: number): Date {
  const utcDays = Math.floor(serial - 25569);
  const utcMs = utcDays * 86400 * 1000;
  const fractionalDay = serial - Math.floor(serial) + 1e-7;
  const totalSeconds = Math.floor(86400 * fractionalDay);
  return new Date(utcMs + totalSeconds * 1000);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatBrFromUtc(d: Date): string {
  return `${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

function formatBrLocal(d: Date): string {
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function isDateNumFmt(numFmt: string | undefined): boolean {
  if (!numFmt) return false;
  const f = numFmt.toLowerCase();
  if (f === "general" || f === "@") return false;
  if (/^[#0,.e+\-\s%()]+$/i.test(f) && !/[dmy]/i.test(f)) return false;
  return /[dmy]|yyyy|dddd|mmmm/i.test(f);
}

function looksLikeBrDate(s: string): boolean {
  return /^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(s.trim());
}

/**
 * Converte célula ExcelJS → string (datas em DD/MM/YYYY).
 * Prioridade: texto formatado BR → Date válida → serial moderno + numFmt → número/texto.
 */
export function avinorCellToString(cell: ExcelJS.Cell): string {
  const text = sanitizeExcelText(String(cell.text ?? ""));
  const value = cell.value;
  const numFmt = cell.numFmt;
  const dateFmt = cell.type === ExcelJS.ValueType.Date || isDateNumFmt(numFmt);

  // O que o Excel mostra (igual openpyxl “visível”)
  if (text && looksLikeBrDate(text)) return text;

  if (value == null || value === "") return text || "";

  if (value instanceof Date) {
    const y = value.getFullYear();
    if (y >= 1980 && y <= 2100) return formatBrLocal(value);
    // Date lixo (1905): tenta serial se value numérico veio errado — usa text
    return text && looksLikeBrDate(text) ? text : "";
  }

  if (typeof value === "number") {
    // Serial Excel moderno (~1982+) só se for coluna de data
    if (dateFmt && value >= 30000 && value < 80000) {
      return formatBrFromUtc(excelSerialToDate(value));
    }
    if (text && looksLikeBrDate(text)) return text;
    return String(value);
  }

  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";

  if (typeof value === "object") {
    const obj = value as {
      result?: unknown;
      richText?: Array<{ text?: string }>;
      text?: string;
      formula?: string;
    };
    if (Array.isArray(obj.richText)) {
      return sanitizeExcelText(obj.richText.map((p) => p.text ?? "").join(""));
    }
    if (obj.result != null) {
      if (obj.result instanceof Date) {
        const y = obj.result.getFullYear();
        if (y >= 1980 && y <= 2100) return formatBrLocal(obj.result);
      }
      if (typeof obj.result === "number" && dateFmt && obj.result >= 30000) {
        return formatBrFromUtc(excelSerialToDate(obj.result));
      }
      return sanitizeExcelText(String(obj.result));
    }
    if (obj.text) return sanitizeExcelText(obj.text);
  }

  return text || sanitizeExcelText(String(value));
}

export type AvinorSheetLoad = {
  headers: string[];
  /** Linhas de dados (após headerRow), 0-based interno */
  rows: string[][];
};

/**
 * Carrega aba com ExcelJS completo (não stream) — datas confiáveis como pandas.
 * Adequado pra ~10k linhas Avinor.
 */
export async function loadAvinorXlsx(params: {
  filePath: string;
  headerRow: number; // 1-based
  dataRow: number; // 1-based
  sheetName?: string | null;
  skipFooter?: number;
  onProgress?: (msg: string, n?: number) => Promise<void>;
}): Promise<AvinorSheetLoad> {
  const { filePath, headerRow, dataRow, sheetName, onProgress } = params;
  const skipFooter = params.skipFooter ?? 0;

  await onProgress?.("Lendo planilha (ExcelJS)...");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  let worksheet = sheetName
    ? workbook.getWorksheet(sheetName)
    : workbook.worksheets[0];
  if (!worksheet && workbook.worksheets.length) {
    worksheet = workbook.worksheets[0];
  }
  if (!worksheet) {
    throw new Error("Nenhuma aba encontrada no arquivo");
  }

  const headerExcelRow = worksheet.getRow(headerRow);
  const colCount = Math.max(headerExcelRow.cellCount, worksheet.columnCount || 0, 1);
  const headers: string[] = [];
  for (let c = 1; c <= colCount; c++) {
    headers.push(avinorCellToString(headerExcelRow.getCell(c)));
  }

  // Trim trailing empty headers
  while (headers.length > 0 && !headers[headers.length - 1]) {
    headers.pop();
  }
  if (headers.length === 0) {
    throw new Error(`Cabeçalho vazio na linha ${headerRow}`);
  }

  const lastRow = worksheet.rowCount || dataRow;
  const endRow = skipFooter > 0 ? Math.max(dataRow - 1, lastRow - skipFooter) : lastRow;
  const rows: string[][] = [];

  for (let r = dataRow; r <= endRow; r++) {
    const excelRow = worksheet.getRow(r);
    const cells: string[] = [];
    let empty = true;
    for (let c = 1; c <= headers.length; c++) {
      const v = avinorCellToString(excelRow.getCell(c));
      if (v) empty = false;
      cells.push(v);
    }
    if (empty) continue;
    rows.push(cells);
    if (rows.length % 500 === 0) {
      await onProgress?.(`Lidas ${rows.length} linhas...`, rows.length);
    }
  }

  await onProgress?.(`Leitura OK: ${rows.length} linhas de dados`, rows.length);
  return { headers, rows };
}
