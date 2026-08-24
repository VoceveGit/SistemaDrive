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
  /** Linhas de dados lidas após o cabeçalho (até parar no rodapé). */
  linesRead: number;
  /** Linhas 1..(dataRow-1) — topo do relatório (filtros / RESUMO CFOP). */
  headerRowsSkipped: number;
  /** Sem número válido / rótulos de resumo no meio. */
  skippedNoNumero: number;
  /** Linhas do rodapé (a partir do 1º marcador até o fim do arquivo lido). */
  skippedFooter: number;
  /** @deprecated use skippedNoNumero */
  ignoredResumo: number;
  /** @deprecated use skippedNoNumero */
  ignoredNoNumero: number;
  stoppedAtFooter: boolean;
  numeroColIdx: number;
  missingColumns: string[];
  headerRowUsed: number;
  dataRowUsed: number;
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
  let skippedNoNumero = 0;
  let skippedFooter = 0;
  let stoppedAtFooter = false;

  try {
    tmpPath = await downloadDriveFileToTemp(drive, file);
    await onProgress?.("Faturamento Avinor: baixando e lendo...");

    const loaded = await loadAvinorXlsx({
      filePath: tmpPath,
      headerRow,
      dataRow,
      skipFooter: 0,
      // Linha 18 às vezes vem vazia — tenta 18, 19, 20…
      headerMarkers: ["numero", "Número", "Numero", "vendedor", "Vendedor"],
      headerProbeExtra: 4,
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
      throw new Error(
        `Coluna "numero" não encontrada no cabeçalho (linha ${loaded.headerRowUsed}).`,
      );
    }

    const headerRowsSkipped = Math.max(0, loaded.dataRowUsed - 1);
    const rawValid: string[][] = [];
    let linesRead = 0;

    for (let i = 0; i < loaded.rows.length; i++) {
      const raw = loaded.rows[i]!;
      linesRead += 1;
      const row = padRow(raw, sheetHeaders.length);

      if (isFaturamentoFooterStopRow(row)) {
        stoppedAtFooter = true;
        skippedFooter = loaded.rows.length - i;
        break;
      }

      if (isFaturamentoSkipRow(row, numeroIdxSheet)) {
        skippedNoNumero += 1;
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
      headerRowsSkipped,
      skippedNoNumero,
      skippedFooter,
      ignoredResumo: 0,
      ignoredNoNumero: skippedNoNumero,
      stoppedAtFooter,
      numeroColIdx,
      missingColumns: mapped.missingColumns,
      headerRowUsed: loaded.headerRowUsed,
      dataRowUsed: loaded.dataRowUsed,
    };
  } finally {
    await safeUnlink(tmpPath);
  }
}

export function extractNumeros(rows: string[][], numeroColIdx: number): string[] {
  const out: string[] = [];
  for (const row of rows) {
    const n = String(row[numeroColIdx] ?? "").trim();
    if (isValidFaturamentoNumero(n)) out.push(n);
  }
  return out;
}
