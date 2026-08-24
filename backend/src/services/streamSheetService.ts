// backend/src/services/streamSheetService.ts — Download em disco + ExcelJS streaming

import { createWriteStream } from "fs";
import { unlink } from "fs/promises";
import path from "path";
import os from "os";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import type { drive_v3 } from "googleapis";
import ExcelJS from "exceljs";
import type { SheetParseOptions } from "./sheetParseService.js";
import { resolveIgnoreColumnIndex, sanitizeExcelText } from "./sheetParseService.js";
import { excelLetterToIndex } from "../utils/columnMapping.js";

function normalizeIgnoreToken(value: string): string {
  return sanitizeExcelText(value).toLowerCase().replace(/\s+/g, " ");
}

/** Excel serial (dias desde 1899-12-30) → Date UTC meia-noite. */
function excelSerialToDate(serial: number): Date {
  const utc = Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000;
  return new Date(utc);
}

function isExcelDateSerial(n: number): boolean {
  // ~1954–2119; evita confundir com IDs/anos (ex.: 2026)
  return Number.isFinite(n) && n > 20000 && n < 80000;
}

/** Formata data local como DD/MM/YYYY (padrão planilha BR). */
function formatDateBr(d: Date): string {
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  // Usar UTC do serial Excel pra não deslocar o dia
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

function formatDateBrLocal(d: Date): string {
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function cellToString(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return formatDateBrLocal(value);
  if (typeof value === "number") {
    if (isExcelDateSerial(value)) return formatDateBr(excelSerialToDate(value));
    return String(value);
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "object") {
    const obj = value as {
      text?: unknown;
      result?: unknown;
      richText?: Array<{ text?: string }>;
      formula?: unknown;
    };
    if (Array.isArray(obj.richText)) {
      return sanitizeExcelText(obj.richText.map((p) => p.text ?? "").join(""));
    }
    if ("result" in obj) return cellToString(obj.result);
    if ("text" in obj) return sanitizeExcelText(String(obj.text ?? ""));
  }
  return sanitizeExcelText(String(value));
}

function isRowEmpty(row: string[]): boolean {
  return row.every((c) => String(c ?? "").trim() === "");
}

/**
 * Baixa o arquivo do Drive direto para /tmp (stream), sem buffer completo na RAM.
 */
export async function downloadDriveFileToTemp(
  drive: drive_v3.Drive,
  file: drive_v3.Schema$File,
): Promise<string> {
  const safeName = (file.name ?? "sheet").replace(/[^\w.\-]+/g, "_").slice(0, 80);
  const tmpPath = path.join(
    os.tmpdir(),
    `sd-${file.id ?? Date.now()}-${Date.now()}-${safeName}.xlsx`,
  );

  const mime = file.mimeType ?? "";
  let data: unknown;

  if (mime === "application/vnd.google-apps.spreadsheet") {
    const res = await drive.files.export(
      {
        fileId: file.id!,
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
      { responseType: "stream" },
    );
    data = res.data;
  } else if (mime === "text/csv" || (file.name ?? "").toLowerCase().endsWith(".csv")) {
    // CSV: baixa como arquivo .csv (parser streaming separado)
    const csvPath = tmpPath.replace(/\.xlsx$/i, ".csv");
    const res = await drive.files.get(
      { fileId: file.id!, alt: "media" },
      { responseType: "stream" },
    );
    await pipeline(res.data as Readable, createWriteStream(csvPath));
    return csvPath;
  } else {
    const res = await drive.files.get(
      { fileId: file.id!, alt: "media" },
      { responseType: "stream" },
    );
    data = res.data;
  }

  await pipeline(data as Readable, createWriteStream(tmpPath));
  return tmpPath;
}

export async function safeUnlink(filePath: string | null | undefined): Promise<void> {
  if (!filePath) return;
  await unlink(filePath).catch(() => undefined);
}

export type StreamRowBatchHandler = (batch: string[][]) => Promise<void>;

export type StreamSheetCallbacks = {
  onHeaders?: (headers: string[]) => Promise<void> | void;
  onBatch: StreamRowBatchHandler;
  onProgress?: (processed: number) => Promise<void> | void;
  /** Retorna true para interromper a leitura (ex.: rodapé de faturamento). */
  shouldStop?: (rowVals: string[], rowNumber: number) => boolean;
};

export type StreamSheetResult = {
  headers: string[];
  totalRows: number;
  /** Amostra para preview (limitada) */
  previewRows: string[][];
};

/**
 * Lê XLSX linha a linha (ExcelJS stream) e chama onBatch a cada `batchSize` linhas de dados.
 * Nunca materializa a planilha inteira na RAM.
 */
export async function streamXlsxInBatches(
  filePath: string,
  options: SheetParseOptions,
  batchSize: number,
  callbacks: StreamSheetCallbacks,
): Promise<StreamSheetResult> {
  const { onBatch, onHeaders, onProgress, shouldStop } = callbacks;
  const headerRowNum = Math.max(options.headerRow ?? 1, 1);
  const dataStartNum =
    options.dataRow != null && options.dataRow > 0
      ? options.dataRow
      : headerRowNum + 1;

  const targetSheet = options.sheetName?.trim() || null;
  const skipEmpty = options.skipEmptyRows !== false;
  const autofill = Boolean(options.autofillEmpty);
  const autofillLimit = options.autofillColumns;
  const ignore = options.ignoreRules;

  let headers: string[] = [];
  let keepIdx: number[] = [];
  let colCount = 0;
  let lastFilled: string[] = [];
  let ignoreColIdx = -1;
  let ignoreLetterRawIdx: number | null = null;
  let banned: Set<string> | null = null;

  if (ignore?.column && ignore.values?.length) {
    banned = new Set(ignore.values.map(normalizeIgnoreToken));
    ignoreLetterRawIdx = excelLetterToIndex(ignore.column.trim());
  }

  let batch: string[][] = [];
  let totalRows = 0;
  const previewRows: string[][] = [];
  const previewLimit = 500;
  let sheetMatched = false;
  let sheetsSeen = 0;

  const flush = async () => {
    if (batch.length === 0) return;
    const toSend = batch;
    batch = [];
    await onBatch(toSend);
  };

  const workbookReader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
    entries: "emit",
    sharedStrings: "cache",
    styles: "cache",
    hyperlinks: "ignore",
    worksheets: "emit",
  });

  for await (const worksheet of workbookReader) {
    sheetsSeen += 1;
    const wsName = String((worksheet as { name?: string }).name ?? "");

    if (targetSheet) {
      if (wsName !== targetSheet) continue;
    } else if (sheetMatched) {
      break;
    }
    sheetMatched = true;

    for await (const row of worksheet) {
      const rowNumber = Number(row.number ?? 0);
      const values = (row.values ?? []) as unknown[];
      // ExcelJS: values[0] unused; colunas 1-based
      const cells: string[] = [];
      const maxCol = Math.max(values.length - 1, colCount || 0, headers.length || 0);
      for (let c = 1; c <= maxCol; c++) {
        // Preferir getCell: com styles em cache o ExcelJS tipa Date corretamente
        let raw: unknown = values[c];
        try {
          const cell = (
            row as { getCell?: (n: number) => { value?: unknown; text?: string } }
          ).getCell?.(c);
          if (cell) {
            if (cell.value !== undefined && cell.value !== null) raw = cell.value;
            // Se value veio numérico sem ser serial claro, text formatado (01/08/2026) ajuda
            else if (cell.text) raw = cell.text;
          }
        } catch {
          /* usa values[c] */
        }
        cells.push(cellToString(raw));
      }

      if (rowNumber === headerRowNum) {
        const rawHeaders = cells.map((c) => sanitizeExcelText(c));
        colCount = Math.max(rawHeaders.length, cells.length);
        keepIdx = rawHeaders
          .map((h, i) => ({ h, i }))
          .filter(({ h }) => h !== "")
          .map(({ i }) => i);
        headers = keepIdx.map((i) => rawHeaders[i] ?? "");
        lastFilled = Array(headers.length).fill("");
        if (ignore?.column && ignore.values?.length && ignoreLetterRawIdx == null) {
          ignoreColIdx = resolveIgnoreColumnIndex(ignore.column, headers, keepIdx);
          banned = new Set(ignore.values.map(normalizeIgnoreToken));
        }
        await onHeaders?.(headers);
        continue;
      }

      if (rowNumber < dataStartNum) continue;
      if (headers.length === 0) continue;

      while (cells.length < colCount) cells.push("");

      // Ignore por letra Excel (posição original, antes do keepIdx)
      if (ignoreLetterRawIdx != null && banned) {
        const cell = normalizeIgnoreToken(cells[ignoreLetterRawIdx] ?? "");
        if (banned.has(cell)) continue;
      }

      let rowVals = keepIdx.map((i) => cells[i] ?? "");

      if (autofill) {
        const limit = autofillLimit ?? rowVals.length;
        rowVals = rowVals.map((v, i) => {
          if (i >= limit) return v;
          if (v !== "") {
            lastFilled[i] = v;
            return v;
          }
          return lastFilled[i] ?? "";
        });
      }

      if (skipEmpty && isRowEmpty(rowVals)) continue;

      if (ignoreLetterRawIdx == null && ignoreColIdx >= 0 && banned) {
        const cell = normalizeIgnoreToken(rowVals[ignoreColIdx] ?? "");
        if (banned.has(cell)) continue;
      }

      if (shouldStop?.(rowVals, rowNumber)) break;

      batch.push(rowVals);
      totalRows += 1;
      if (previewRows.length < previewLimit) {
        previewRows.push(rowVals);
      }

      if (batch.length >= batchSize) {
        await flush();
        await onProgress?.(totalRows);
      }
    }

    if (targetSheet && sheetMatched) break;
    if (!targetSheet && sheetMatched) break;
  }

  await flush();
  await onProgress?.(totalRows);

  if (!sheetMatched && sheetsSeen === 0) {
    throw new Error("Nenhuma aba encontrada no arquivo");
  }
  if (targetSheet && !sheetMatched) {
    throw new Error(`Aba "${targetSheet}" não encontrada no arquivo`);
  }
  if (headers.length === 0) {
    throw new Error("Cabeçalho não encontrado — confira headerRow na configuração");
  }

  return { headers, totalRows, previewRows };
}

/**
 * CSV simples em stream (linha a linha). Suficiente para exports CSV do Drive.
 */
export async function streamCsvInBatches(
  filePath: string,
  options: SheetParseOptions,
  batchSize: number,
  callbacks: StreamSheetCallbacks,
): Promise<StreamSheetResult> {
  const { onBatch, onHeaders, onProgress, shouldStop } = callbacks;
  const { createReadStream } = await import("fs");
  const readline = await import("readline");

  const headerRowNum = Math.max(options.headerRow ?? 1, 1);
  const dataStartNum =
    options.dataRow != null && options.dataRow > 0
      ? options.dataRow
      : headerRowNum + 1;

  const skipEmpty = options.skipEmptyRows !== false;
  const autofill = Boolean(options.autofillEmpty);
  const autofillLimit = options.autofillColumns;
  const ignore = options.ignoreRules;

  let headers: string[] = [];
  let keepIdx: number[] = [];
  let lastFilled: string[] = [];
  let ignoreColIdx = -1;
  let ignoreLetterRawIdx: number | null = null;
  let banned: Set<string> | null = null;
  if (ignore?.column && ignore.values?.length) {
    banned = new Set(ignore.values.map(normalizeIgnoreToken));
    ignoreLetterRawIdx = excelLetterToIndex(ignore.column.trim());
  }
  let batch: string[][] = [];
  let totalRows = 0;
  let lineNo = 0;
  const previewRows: string[][] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    const toSend = batch;
    batch = [];
    await onBatch(toSend);
  };

  const rl = readline.createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    lineNo += 1;
    const cells = parseCsvLine(line);

    if (lineNo === headerRowNum) {
      headers = cells.map((c) => c.trim());
      keepIdx = headers
        .map((h, i) => ({ h, i }))
        .filter(({ h }) => h !== "")
        .map(({ i }) => i);
      headers = keepIdx.map((i) => headers[i] ?? "");
      lastFilled = Array(headers.length).fill("");
      if (ignore?.column && ignore.values?.length && ignoreLetterRawIdx == null) {
        ignoreColIdx = resolveIgnoreColumnIndex(ignore.column, headers, keepIdx);
        banned = new Set(ignore.values.map(normalizeIgnoreToken));
      }
      await onHeaders?.(headers);
      continue;
    }

    if (lineNo < dataStartNum || headers.length === 0) continue;

    if (ignoreLetterRawIdx != null && banned) {
      const cell = normalizeIgnoreToken(String(cells[ignoreLetterRawIdx] ?? "").trim());
      if (banned.has(cell)) continue;
    }

    let rowVals = keepIdx.map((i) => String(cells[i] ?? "").trim());
    if (autofill) {
      const limit = autofillLimit ?? rowVals.length;
      rowVals = rowVals.map((v, i) => {
        if (i >= limit) return v;
        if (v !== "") {
          lastFilled[i] = v;
          return v;
        }
        return lastFilled[i] ?? "";
      });
    }
    if (skipEmpty && isRowEmpty(rowVals)) continue;
    if (ignoreLetterRawIdx == null && ignoreColIdx >= 0 && banned) {
      const cell = normalizeIgnoreToken(rowVals[ignoreColIdx] ?? "");
      if (banned.has(cell)) continue;
    }

    if (shouldStop?.(rowVals, lineNo)) break;

    batch.push(rowVals);
    totalRows += 1;
    if (previewRows.length < 500) previewRows.push(rowVals);
    if (batch.length >= batchSize) {
      await flush();
      await onProgress?.(totalRows);
    }
  }

  await flush();
  await onProgress?.(totalRows);

  if (headers.length === 0) {
    throw new Error("Cabeçalho CSV não encontrado");
  }

  return { headers, totalRows, previewRows };
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

export async function streamSheetFileInBatches(
  filePath: string,
  options: SheetParseOptions,
  batchSize: number,
  callbacks: StreamSheetCallbacks,
): Promise<StreamSheetResult> {
  if (filePath.toLowerCase().endsWith(".csv")) {
    return streamCsvInBatches(filePath, options, batchSize, callbacks);
  }
  return streamXlsxInBatches(filePath, options, batchSize, callbacks);
}
