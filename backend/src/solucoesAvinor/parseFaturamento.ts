// backend/src/solucoesAvinor/parseFaturamento.ts — faturamento Avinor (nome + aliases)

import type { drive_v3 } from "googleapis";
import { downloadDriveFileToTemp, safeUnlink } from "../services/streamSheetService.js";
import type { MysqlColMeta } from "./conversoes.js";
import {
  dedupeHeadersPandasStyle,
  findColumnIndex,
  mapRowsToDbColumnOrder,
} from "./columnMap.js";
import { loadAvinorXlsx } from "./excelLoadAvinor.js";
import {
  isFaturamentoFooterStopRow,
  isFaturamentoSkipRow,
  isValidFaturamentoNumero,
  padRow,
} from "./rowFilters.js";

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
  let ignoredResumo = 0;
  let ignoredNoNumero = 0;
  let stoppedAtFooter = false;

  try {
    tmpPath = await downloadDriveFileToTemp(drive, file);
    await onProgress?.("Faturamento Avinor: baixando e lendo...");

    const loaded = await loadAvinorXlsx({
      filePath: tmpPath,
      headerRow,
      dataRow,
      skipFooter: 0,
      onProgress,
    });

    const sheetHeaders = dedupeHeadersPandasStyle(loaded.headers);
    const numeroIdxSheet = findColumnIndex(
      sheetHeaders,
      "numero",
      "Número",
      "Numero",
      "Nro",
    );
    if (numeroIdxSheet < 0) {
      throw new Error('Coluna "numero" não encontrada no cabeçalho (linha 18).');
    }

    const rawValid: string[][] = [];
    let linesRead = 0;

    for (const raw of loaded.rows) {
      linesRead += 1;
      const row = padRow(raw, sheetHeaders.length);

      if (isFaturamentoFooterStopRow(row)) {
        stoppedAtFooter = true;
        break;
      }

      if (isFaturamentoSkipRow(row, numeroIdxSheet)) {
        const numero = String(row[numeroIdxSheet] ?? "").trim();
        if (!isValidFaturamentoNumero(numero)) ignoredNoNumero += 1;
        else ignoredResumo += 1;
        continue;
      }

      rawValid.push(row);
    }

    if (rawValid.length === 0) {
      throw new Error("Nenhuma linha válida (sem numero / só resumos).");
    }

    const mapped = mapRowsToDbColumnOrder({
      sheetHeaders,
      sheetRows: rawValid,
      dbColumns,
    });

    const numeroColIdx = findColumnIndex(
      mapped.headers,
      "numero",
      "Número",
      "Numero",
    );
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
