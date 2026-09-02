// backend/src/solucoesAvinor/parseFaturamento.ts — faturamento Avinor (nome + aliases)
// Sync por janela de Data (igual pedidos / Dt.Entrega): DELETE mês + INSERT planilha.

import type { drive_v3 } from "googleapis";
import { downloadDriveFileToTemp, safeUnlink } from "../services/streamSheetService.js";
import { parseDateTimeCell, type MysqlColMeta } from "./conversoes.js";
import {
  dedupeHeadersPandasStyle,
  findColumnIndex,
  mapRowsToDbColumnOrder,
} from "./columnMap.js";
import { loadAvinorXlsx } from "./excelLoadAvinor.js";
import { pedidosMonthWindowFromDates } from "./parsePedidos.js";
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
  dataColIdx: number;
  missingColumns: string[];
  headerRowUsed: number;
  dataRowUsed: number;
  /** Janela DELETE: Data >= monthFrom AND Data < monthToExclusive */
  monthFrom: string;
  monthToExclusive: string;
  dateMin: string;
  dateMax: string;
  sampleDates: string[];
  numerosInFile: number;
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
      // Layout novo: títulos na L16; legado L18+. Sonda 16→24 (Vendedor/Data/numero).
      headerMarkers: ["numero", "Número", "Numero", "vendedor", "Vendedor", "Data"],
      headerProbeExtra: 8,
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

    const dataIdxSheet = findColumnIndex(sheetHeaders, "Data", "data");
    if (dataIdxSheet < 0) {
      throw new Error(
        `Coluna "Data" não encontrada no cabeçalho (linha ${loaded.headerRowUsed}).`,
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
    const dataColIdx = findColumnIndex(mapped.headers, "Data", "data");
    if (numeroColIdx < 0) {
      throw new Error('Coluna "numero" não encontrada na tabela MySQL.');
    }
    if (dataColIdx < 0) {
      throw new Error('Coluna "data" não encontrada na tabela MySQL.');
    }

    // Se o map esvaziou Data, copia da planilha (mesma ordem)
    for (let i = 0; i < mapped.rows.length; i++) {
      const cur = String(mapped.rows[i]![dataColIdx] ?? "").trim();
      if (!cur) {
        const fromSheet = String(rawValid[i]![dataIdxSheet] ?? "").trim();
        if (fromSheet) mapped.rows[i]![dataColIdx] = fromSheet;
      }
    }

    const dates: Date[] = [];
    const dateLabels: string[] = [];
    const numeros = new Set<string>();
    for (const row of mapped.rows) {
      const num = String(row[numeroColIdx] ?? "").trim();
      if (isValidFaturamentoNumero(num)) numeros.add(num);

      const rawDt = String(row[dataColIdx] ?? "").trim();
      const dt = parseDateTimeCell(rawDt);
      if (!dt) continue;
      const d = new Date(dt.replace(" ", "T"));
      if (!Number.isNaN(d.getTime()) && d.getFullYear() >= 1980) {
        dates.push(d);
        if (dateLabels.length < 5 && rawDt) dateLabels.push(rawDt);
      }
    }

    if (dates.length === 0) {
      const sample = mapped.rows
        .slice(0, 5)
        .map((r) => `"${String(r[dataColIdx] ?? "")}"`)
        .join(" | ");
      throw new Error(
        `Nenhuma Data válida na planilha (amostra: ${sample}). Esperado DD/MM/YYYY.`,
      );
    }

    const { from, toExclusive } = pedidosMonthWindowFromDates(dates);
    let minD = dates[0]!;
    let maxD = dates[0]!;
    for (const d of dates) {
      if (d < minD) minD = d;
      if (d > maxD) maxD = d;
    }
    const fmtBr = (d: Date) => {
      const p = (n: number) => String(n).padStart(2, "0");
      return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
    };

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
      dataColIdx,
      missingColumns: mapped.missingColumns,
      headerRowUsed: loaded.headerRowUsed,
      dataRowUsed: loaded.dataRowUsed,
      monthFrom: from,
      monthToExclusive: toExclusive,
      dateMin: fmtBr(minD),
      dateMax: fmtBr(maxD),
      sampleDates: dateLabels.length ? dateLabels : [fmtBr(minD), fmtBr(maxD)],
      numerosInFile: numeros.size,
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
