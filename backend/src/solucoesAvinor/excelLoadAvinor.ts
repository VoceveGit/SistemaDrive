// backend/src/solucoesAvinor/excelLoadAvinor.ts
// Leitura XLSX via SheetJS — prioriza texto formatado da célula (w) pra datas BR.

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

function looksLikeDateText(s: string): boolean {
  const t = s.trim();
  return (
    /^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(t) ||
    /^\d{4}-\d{2}-\d{2}/.test(t) ||
    /^\d{1,2}-\d{1,2}-\d{2,4}/.test(t)
  );
}

/** Normaliza texto de data para DD/MM/YYYY quando possível. */
function normalizeDateText(raw: string): string {
  const s = sanitizeExcelText(raw).trim();
  if (!s) return "";

  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const y = Number(iso[1]);
    if (y >= 1980 && y <= 2100) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  }

  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (slash) {
    let a = Number(slash[1]);
    let b = Number(slash[2]);
    let y = Number(slash[3]);
    if (y < 100) y += 2000;
    if (y < 1980 || y > 2100) return s;
    // Se o 2º número > 12, é DD/MM; se o 1º > 12, é MM/DD (US)
    if (b > 12 && a >= 1 && a <= 12) {
      // a=mês US, b=dia → BR day/month
      return `${pad2(b)}/${pad2(a)}/${y}`;
    }
    if (a > 12 && b >= 1 && b <= 12) {
      return `${pad2(a)}/${pad2(b)}/${y}`;
    }
    // Ambíguo (ambos ≤12): assume DD/MM (planilha Avinor BR)
    return `${pad2(a)}/${pad2(b)}/${y}`;
  }

  return s;
}

function dateFromUnknown(value: unknown): string {
  if (value instanceof Date) {
    const useUtc =
      value.getUTCHours() === 0 &&
      value.getUTCMinutes() === 0 &&
      value.getUTCSeconds() === 0;
    const d = useUtc
      ? new Date(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())
      : value;
    return formatBr(d);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // Serial Excel (~1970+)
    if (value >= 25569 && value < 80000) {
      const d = excelSerialToDate(value);
      return formatBr(
        new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
      );
    }
  }
  return "";
}

/** Converte célula SheetJS → string; datas em DD/MM/YYYY. */
export function sheetJsCellToString(value: unknown): string {
  if (value == null || value === "") return "";
  const asDate = dateFromUnknown(value);
  if (asDate) return asDate;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  const s = sanitizeExcelText(String(value));
  if (looksLikeDateText(s)) return normalizeDateText(s);
  return s;
}

function cellObjectToString(cell: XLSX.CellObject | undefined): string {
  if (!cell) return "";

  // 1) Texto formatado do Excel (melhor pra datas BR)
  if (cell.w != null && String(cell.w).trim() !== "") {
    const w = sanitizeExcelText(String(cell.w));
    if (cell.t === "d" || looksLikeDateText(w)) return normalizeDateText(w);
    // Número formatado como data (z contém d/m/y)
    if (cell.t === "n" && cell.z && /[dmy]/i.test(String(cell.z))) {
      const fromW = normalizeDateText(w);
      if (fromW && looksLikeDateText(fromW)) return fromW;
      const fromV = dateFromUnknown(cell.v);
      if (fromV) return fromV;
    }
  }

  // 2) Tipo data / serial
  if (cell.t === "d") {
    const d = dateFromUnknown(cell.v);
    if (d) return d;
  }
  if (cell.t === "n" && typeof cell.v === "number") {
    if (cell.z && /[dmy]/i.test(String(cell.z))) {
      const d = dateFromUnknown(cell.v);
      if (d) return d;
    }
    // Serial “nu” sem formato explícito, mas na faixa de datas modernas
    if (cell.v >= 30000 && cell.v < 80000) {
      const d = dateFromUnknown(cell.v);
      if (d) return d;
    }
  }

  return sheetJsCellToString(cell.v);
}

export type AvinorSheetLoad = {
  headers: string[];
  rows: string[][];
};

/**
 * Carrega planilha com SheetJS — lê células direto (v + w) pra não perder datas.
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
    cellNF: true,
    cellText: true,
  });

  const name =
    (sheetName && workbook.SheetNames.includes(sheetName)
      ? sheetName
      : workbook.SheetNames[0]) ?? workbook.SheetNames[0];
  if (!name) throw new Error("Nenhuma aba encontrada no arquivo");

  const sheet = workbook.Sheets[name];
  if (!sheet || !sheet["!ref"]) {
    throw new Error("Planilha vazia");
  }

  const range = XLSX.utils.decode_range(sheet["!ref"]);
  const headerRowIndex = Math.max(headerRow - 1, 0);
  const dataStartIndex = Math.max(dataRow - 1, headerRowIndex + 1);

  if (headerRowIndex > range.e.r) {
    throw new Error(`Cabeçalho (linha ${headerRow}) fora da planilha`);
  }

  const headers: string[] = [];
  for (let c = range.s.c; c <= range.e.c; c++) {
    const addr = XLSX.utils.encode_cell({ r: headerRowIndex, c });
    const text = sanitizeExcelText(cellObjectToString(sheet[addr]));
    headers.push(text);
  }
  while (headers.length > 0 && !headers[headers.length - 1]) headers.pop();
  if (headers.length === 0) {
    throw new Error(`Cabeçalho vazio na linha ${headerRow}`);
  }

  let lastDataRow = range.e.r;
  if (skipFooter > 0) {
    lastDataRow = Math.max(dataStartIndex, range.e.r - skipFooter);
  }

  const rows: string[][] = [];
  for (let r = dataStartIndex; r <= lastDataRow; r++) {
    const cells: string[] = [];
    let any = false;
    for (let i = 0; i < headers.length; i++) {
      const c = range.s.c + i;
      const addr = XLSX.utils.encode_cell({ r, c });
      const v = cellObjectToString(sheet[addr]);
      if (v) any = true;
      cells.push(v);
    }
    if (!any) continue;
    rows.push(cells);
    if (rows.length % 1000 === 0) {
      await onProgress?.(`Lidas ${rows.length} linhas...`, rows.length);
    }
  }

  await onProgress?.(`Leitura OK: ${rows.length} linhas de dados`, rows.length);
  return { headers, rows };
}
