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
    // Só serial Excel quando quem chama já sabe que é data (formato z / t=d)
    if (value >= 1 && value < 80000) {
      const d = excelSerialToDate(value);
      return formatBr(
        new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
      );
    }
  }
  return "";
}

function cellFormatLooksLikeDate(z: unknown): boolean {
  if (z == null) return false;
  const s = String(z);
  // Ex.: dd/mm/yyyy, m/d/yy — não confundir com moeda (#,##0.00)
  return /[dy]/i.test(s) && !/[#$€£R]/i.test(s);
}

/** Converte célula SheetJS → string; NÃO assume que número = data. */
export function sheetJsCellToString(value: unknown): string {
  if (value == null || value === "") return "";
  if (value instanceof Date) return dateFromUnknown(value);
  if (typeof value === "number") {
    // Número cru: dinheiro, qtd, etc. — nunca tratar como serial de data aqui
    return String(value);
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  const s = sanitizeExcelText(String(value));
  if (looksLikeDateText(s)) return normalizeDateText(s);
  return s;
}

function cellObjectToString(cell: XLSX.CellObject | undefined): string {
  if (!cell) return "";

  // 1) Texto formatado do Excel
  if (cell.w != null && String(cell.w).trim() !== "") {
    const w = sanitizeExcelText(String(cell.w));
    // Data explícita (tipo d ou texto DD/MM)
    if (cell.t === "d" || looksLikeDateText(w)) return normalizeDateText(w);
    // Número com formato de data no Excel
    if (cell.t === "n" && cellFormatLooksLikeDate(cell.z)) {
      const fromW = normalizeDateText(w);
      if (fromW && looksLikeDateText(fromW)) return fromW;
      const fromV = dateFromUnknown(cell.v);
      if (fromV) return fromV;
    }
    // Moeda / número formatado (ex.: "39 480,00") — usa o texto do Excel
    if (cell.t === "n" || cell.t === "s") {
      return w;
    }
  }

  // 2) Tipo data nativo
  if (cell.t === "d") {
    const d = dateFromUnknown(cell.v);
    if (d) return d;
  }

  // 3) Número só vira data se o formato da célula for de data
  if (cell.t === "n" && typeof cell.v === "number" && cellFormatLooksLikeDate(cell.z)) {
    const d = dateFromUnknown(cell.v);
    if (d) return d;
  }

  return sheetJsCellToString(cell.v);
}

export type AvinorSheetLoad = {
  headers: string[];
  rows: string[][];
  /** Linha 1-based onde o cabeçalho foi encontrado. */
  headerRowUsed: number;
  /** Linha 1-based onde os dados começam. */
  dataRowUsed: number;
};

function readHeaderCells(
  sheet: XLSX.WorkSheet,
  range: XLSX.Range,
  headerRowIndex: number,
): string[] {
  const headers: string[] = [];
  for (let c = range.s.c; c <= range.e.c; c++) {
    const addr = XLSX.utils.encode_cell({ r: headerRowIndex, c });
    const text = sanitizeExcelText(cellObjectToString(sheet[addr]));
    headers.push(text);
  }
  while (headers.length > 0 && !headers[headers.length - 1]) headers.pop();
  return headers;
}

function headerLooksValid(headers: string[], markers: string[]): boolean {
  if (headers.length === 0) return false;
  if (markers.length === 0) return headers.some((h) => h.trim() !== "");
  const keys = new Set(
    headers.map((h) =>
      sanitizeExcelText(h)
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/\s+/g, "")
        .replace(/[^a-z0-9%]+/g, ""),
    ),
  );
  return markers.some((m) => {
    const k = m
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/[^a-z0-9%]+/g, "");
    return k && keys.has(k);
  });
}

/**
 * Carrega planilha com SheetJS — lê células direto (v + w) pra não perder datas.
 * Se `headerMarkers` for passado, tenta preferredHeader e as próximas linhas
 * (ex.: 18 vazia → acha títulos na 19).
 */
export async function loadAvinorXlsx(params: {
  filePath: string;
  headerRow: number; // 1-based (preferida)
  dataRow: number; // 1-based (preferida; se header “andar”, dados = header+1)
  sheetName?: string | null;
  skipFooter?: number;
  /** Ex.: ["numero","Número"] — se a linha preferida não tiver, sonda as seguintes. */
  headerMarkers?: string[];
  /** Quantas linhas além da preferida tentar (default 4 → 18..22). */
  headerProbeExtra?: number;
  onProgress?: (msg: string, n?: number) => Promise<void>;
}): Promise<AvinorSheetLoad> {
  const { filePath, headerRow, dataRow, sheetName, onProgress } = params;
  const skipFooter = params.skipFooter ?? 0;
  const markers = params.headerMarkers ?? [];
  const probeExtra = params.headerProbeExtra ?? (markers.length ? 4 : 0);

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

  let resolvedHeaderRow = headerRow;
  let headers = readHeaderCells(sheet, range, Math.max(headerRow - 1, 0));

  if (markers.length > 0 || headers.length === 0) {
    const start = Math.max(headerRow, 1);
    const end = Math.min(start + probeExtra, range.e.r + 1);
    let found = headerLooksValid(headers, markers);
    if (!found) {
      for (let tryRow = start; tryRow <= end; tryRow++) {
        const candidate = readHeaderCells(sheet, range, tryRow - 1);
        if (headerLooksValid(candidate, markers)) {
          resolvedHeaderRow = tryRow;
          headers = candidate;
          found = true;
          break;
        }
      }
    }
    if (!found && headers.length === 0) {
      throw new Error(
        `Cabeçalho vazio na linha ${headerRow}` +
          (probeExtra > 0 ? ` (também tentei até a ${end})` : ""),
      );
    }
    if (!found && markers.length > 0) {
      throw new Error(
        `Não achei cabeçalho com ${markers[0]} nas linhas ${start}–${end}. ` +
          `Confira se os títulos mudaram de lugar de novo.`,
      );
    }
  }

  if (headers.length === 0) {
    throw new Error(`Cabeçalho vazio na linha ${resolvedHeaderRow}`);
  }

  // Se o título “andou”, dados começam na linha seguinte ao cabeçalho achado
  const resolvedDataRow =
    resolvedHeaderRow !== headerRow
      ? resolvedHeaderRow + 1
      : Math.max(dataRow, resolvedHeaderRow + 1);

  const headerRowIndex = resolvedHeaderRow - 1;
  const dataStartIndex = resolvedDataRow - 1;

  if (headerRowIndex > range.e.r) {
    throw new Error(`Cabeçalho (linha ${resolvedHeaderRow}) fora da planilha`);
  }

  if (resolvedHeaderRow !== headerRow) {
    await onProgress?.(
      `Cabeçalho na linha ${resolvedHeaderRow} (preferida era ${headerRow}); dados a partir da ${resolvedDataRow}`,
    );
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
  return {
    headers,
    rows,
    headerRowUsed: resolvedHeaderRow,
    dataRowUsed: resolvedDataRow,
  };
}
