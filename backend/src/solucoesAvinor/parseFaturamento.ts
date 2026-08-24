// backend/src/solucoesAvinor/parseFaturamento.ts — leitura faturamento Avinor (por nome)

import {
  downloadDriveFileToTemp,
  safeUnlink,
  streamSheetFileInBatches,
} from "../services/streamSheetService.js";
import type { drive_v3 } from "googleapis";
import type { MysqlColMeta } from "./conversoes.js";
import {
  dedupeHeadersPandasStyle,
  findColumnIndex,
  mapRowsToDbColumnOrder,
} from "./columnMap.js";
import {
  isFaturamentoFooterStopRow,
  isFaturamentoSkipRow,
  isValidFaturamentoNumero,
  padRow,
} from "./rowFilters.js";

const BATCH = 400;

export type FaturamentoParseResult = {
  headers: string[];
  validRows: string[][];
  linesRead: number;
  ignoredResumo: number;
  ignoredNoNumero: number;
  stoppedAtFooter: boolean;
  numeroColIdx: number;
};

export async function parseFaturamentoSpreadsheet(params: {
  drive: drive_v3.Drive;
  file: drive_v3.Schema$File;
  dbColumns: MysqlColMeta[];
  headerRow: number;
  dataRow: number;
  onProgress?: (msg: string, n?: number) => Promise<void>;
}): Promise<FaturamentoParseResult> {
  const { drive, file, dbColumns, headerRow, dataRow, onProgress } = params;
  let tmpPath: string | null = null;
  const rawValid: string[][] = [];
  let sheetHeaders: string[] = [];
  let linesRead = 0;
  let ignoredResumo = 0;
  let ignoredNoNumero = 0;
  let stoppedAtFooter = false;
  let numeroIdxSheet = -1;

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
          sheetHeaders = dedupeHeadersPandasStyle(h);
          numeroIdxSheet = findColumnIndex(sheetHeaders, "numero", "Número", "Numero");
          if (numeroIdxSheet < 0) {
            throw new Error('Coluna "numero" não encontrada no cabeçalho (linha 18).');
          }
        },
        onBatch: async (batch) => {
          for (const raw of batch) {
            linesRead += 1;
            const row = padRow(raw, sheetHeaders.length || raw.length);

            if (isFaturamentoFooterStopRow(row)) {
              stoppedAtFooter = true;
              return;
            }

            if (isFaturamentoSkipRow(row, numeroIdxSheet)) {
              const numero = String(row[numeroIdxSheet] ?? "").trim();
              if (!isValidFaturamentoNumero(numero)) ignoredNoNumero += 1;
              else ignoredResumo += 1;
              continue;
            }

            rawValid.push(row);
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

    if (!sheetHeaders.length) {
      throw new Error("Cabeçalho não encontrado — confira linha 18 (títulos).");
    }
    if (rawValid.length === 0) {
      throw new Error("Nenhuma linha válida (sem numero / só resumos).");
    }

    const mapped = mapRowsToDbColumnOrder({
      sheetHeaders,
      sheetRows: rawValid,
      dbColumns,
    });

    const numeroColIdx = findColumnIndex(mapped.headers, "numero", "Número", "Numero");
    if (numeroColIdx < 0) {
      throw new Error('Coluna "numero" não encontrada na tabela MySQL.');
    }

    return {
      headers: mapped.headers,
      validRows: mapped.rows,
      linesRead,
      ignoredResumo,
      ignoredNoNumero,
      stoppedAtFooter,
      numeroColIdx,
    };
  } finally {
    await safeUnlink(tmpPath);
  }
}

export function extractNumeros(rows: string[][], numeroColIdx: number): string[] {
  const set = new Set<string>();
  for (const row of rows) {
    const n = String(row[numeroColIdx] ?? "").trim();
    if (n) set.add(n);
  }
  return [...set];
}
