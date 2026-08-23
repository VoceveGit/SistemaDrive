// backend/src/solucoesAvinor/parseFaturamento.ts — leitura faturamento Avinor

import {
  downloadDriveFileToTemp,
  safeUnlink,
  streamSheetFileInBatches,
} from "../services/streamSheetService.js";
import type { drive_v3 } from "googleapis";
import {
  isFaturamentoFooterStopRow,
  isFaturamentoSkipRow,
  isValidFaturamentoNumero,
  padRow,
} from "./rowFilters.js";

export const NUMERO_COL_IDX = 8;

const BATCH = 400;

export type FaturamentoParseResult = {
  headers: string[];
  validRows: string[][];
  linesRead: number;
  ignoredResumo: number;
  ignoredNoNumero: number;
  stoppedAtFooter: boolean;
};

export async function parseFaturamentoSpreadsheet(params: {
  drive: drive_v3.Drive;
  file: drive_v3.Schema$File;
  columnCount: number;
  headerRow: number;
  dataRow: number;
  onProgress?: (msg: string, n?: number) => Promise<void>;
}): Promise<FaturamentoParseResult> {
  const { drive, file, columnCount, headerRow, dataRow, onProgress } = params;
  let tmpPath: string | null = null;
  const validRows: string[][] = [];
  let headers: string[] = [];
  let linesRead = 0;
  let ignoredResumo = 0;
  let ignoredNoNumero = 0;
  let stoppedAtFooter = false;

  try {
    tmpPath = await downloadDriveFileToTemp(drive, file);
    await onProgress?.("Faturamento Avinor: lendo planilha...");

    await streamSheetFileInBatches(
      tmpPath,
      {
        headerRow,
        dataRow,
        skipEmptyRows: true,
        autofillEmpty: false,
      },
      BATCH,
      {
        onHeaders: async (h) => {
          headers = h.slice(0, columnCount);
        },
        onBatch: async (batch) => {
          for (const raw of batch) {
            linesRead += 1;
            const row = padRow(raw, columnCount);

            if (isFaturamentoFooterStopRow(row)) {
              stoppedAtFooter = true;
              return;
            }

            if (isFaturamentoSkipRow(row, NUMERO_COL_IDX)) {
              const numero = String(row[NUMERO_COL_IDX] ?? "").trim();
              if (!isValidFaturamentoNumero(numero)) ignoredNoNumero += 1;
              else ignoredResumo += 1;
              continue;
            }

            validRows.push(row);
          }
        },
        shouldStop: (rowVals) => {
          if (isFaturamentoFooterStopRow(rowVals)) {
            stoppedAtFooter = true;
            return true;
          }
          return false;
        },
        onProgress: async (n) => {
          await onProgress?.(`Lidas ${n} linhas...`, n);
        },
      },
    );

    if (!headers.length) {
      throw new Error("Cabeçalho não encontrado — confira linha 18 (títulos).");
    }
    if (validRows.length === 0) {
      throw new Error("Nenhuma linha válida (sem numero / só resumos).");
    }

    return {
      headers,
      validRows,
      linesRead,
      ignoredResumo,
      ignoredNoNumero,
      stoppedAtFooter,
    };
  } finally {
    await safeUnlink(tmpPath);
  }
}

export function extractNumeros(rows: string[][]): string[] {
  const set = new Set<string>();
  for (const row of rows) {
    const n = String(row[NUMERO_COL_IDX] ?? "").trim();
    if (n) set.add(n);
  }
  return [...set];
}
