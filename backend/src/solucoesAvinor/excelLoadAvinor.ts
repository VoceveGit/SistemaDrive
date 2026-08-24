// backend/src/solucoesAvinor/excelLoadAvinor.ts
// Leitura XLSX via SheetJS (xlsx) — cellDates + raw:false ≈ pandas (texto DD/MM/YYYY).

import { readFile } from "fs/promises";
import * as XLSX from "xlsx";
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

function formatBr(d: Date): string {
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  if (y < 1980 || y > 2100) return "";
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${y}`;
}

function looksLikeBrDate(s: string): boolean {
  return /^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(s.trim());
}

/** Converte célula SheetJS → string; datas em DD/MM/YYYY. */
export function sheetJsCellToString(value: unknown): string {
  if (value == null || value === "") return "";
  if (value instanceof Date) return formatBr(value);
  if (typeof value === "number") {
    // Serial Excel moderno (~1982+)
    if (value >= 30000 && value < 80000) {
      const d = excelSerialToDate(value);
      const br = formatBr(
        new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
      );
      if (br) return br;
    }
    return String(value);
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  const s = sanitizeExcelText(String(value));
  // SheetJS raw:false às vezes devolve "8/1/26" ou "01/08/2026"
  if (looksLikeBrDate(s)) return s;
  // ISO residual
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const y = Number(iso[1]);
    if (y >= 1980 && y <= 2100) {
      return `${iso[3]}/${iso[2]}/${iso[1]}`;
    }
  }
  return s;
}

export type AvinorSheetLoad = {
  headers: string[];
  rows: string[][];
};

/**
 * Carrega planilha com SheetJS — mesmo espírito do pandas (datas tipadas).
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

  await onProgress?.("Lendo planilha...");
  const buffer = await readFile(filePath);
  const workbook = XLSX.read(buffer, {
    type: "buffer",
    cellDates: true,
    cellNF: false,
    cellText: false,
  });

  const name =
    (sheetName && workbook.SheetNames.includes(sheetName)
      ? sheetName
      : workbook.SheetNames[0]) ?? workbook.SheetNames[0];
  if (!name) throw new Error("Nenhuma aba encontrada no arquivo");

  const sheet = workbook.Sheets[name];
  // raw:true + cellDates → Date objects; formatamos nós (BR)
  const json = XLSX.utils.sheet_to_json<(unknown)[]>(sheet, {
    header: 1,
    defval: "",
    raw: true,
    dateNF: "dd/mm/yyyy",
  });

  if (json.length === 0) {
    throw new Error("Planilha vazia");
  }

  const headerRowIndex = Math.max(headerRow - 1, 0);
  const dataStartIndex = Math.max(dataRow - 1, headerRowIndex + 1);

  const headerCells = json[headerRowIndex] ?? [];
  let headers = (headerCells as unknown[]).map((c) =>
    sanitizeExcelText(sheetJsCellToString(c)),
  );
  while (headers.length > 0 && !headers[headers.length - 1]) headers.pop();
  if (headers.length === 0) {
    throw new Error(`Cabeçalho vazio na linha ${headerRow}`);
  }

  let dataSlice = json.slice(dataStartIndex);
  if (skipFooter > 0 && dataSlice.length > skipFooter) {
    dataSlice = dataSlice.slice(0, dataSlice.length - skipFooter);
  }

  const rows: string[][] = [];
  for (const row of dataSlice) {
    const arr = row as unknown[];
    const cells = headers.map((_, i) => sheetJsCellToString(arr?.[i]));
    if (cells.every((c) => !c)) continue;
    rows.push(cells);
    if (rows.length % 1000 === 0) {
      await onProgress?.(`Lidas ${rows.length} linhas...`, rows.length);
    }
  }

  await onProgress?.(`Leitura OK: ${rows.length} linhas de dados`, rows.length);
  return { headers, rows };
}
