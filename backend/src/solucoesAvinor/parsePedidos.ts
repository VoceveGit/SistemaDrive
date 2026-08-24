// backend/src/solucoesAvinor/parsePedidos.ts
// Pedidos Avinor: filtro TOTAL → ffill → map por nome (igual upload_avinor).

import type { drive_v3 } from "googleapis";
import { downloadDriveFileToTemp, safeUnlink } from "../services/streamSheetService.js";
import { parseDateTimeCell } from "./conversoes.js";
import {
  dedupeHeadersPandasStyle,
  findColumnIndex,
  ffillAllColumns,
  mapRowsToDbColumnOrder,
} from "./columnMap.js";
import type { MysqlColMeta } from "./conversoes.js";
import { loadAvinorXlsx } from "./excelLoadAvinor.js";
import { padRow } from "./rowFilters.js";

/** Igual skipfooter=3 do pandas no script antigo. */
const SKIP_FOOTER_ROWS = 3;

export type PedidosParseResult = {
  headers: string[];
  validRows: string[][];
  linesRead: number;
  ignoredTotal: number;
  dtColIdx: number;
  pedidoColIdx: number;
  monthFrom: string;
  monthToExclusive: string;
  pedidosInFile: number;
};

function isTotalDescricao(desc: string): boolean {
  return String(desc ?? "")
    .trim()
    .toUpperCase()
    .startsWith("TOTAL");
}

function isEmptyDesc(desc: string): boolean {
  return String(desc ?? "").trim() === "";
}

export function pedidosMonthWindowFromDates(dates: Date[]): {
  from: string;
  toExclusive: string;
} {
  if (!dates.length) {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    const from = `${y}-${String(m + 1).padStart(2, "0")}-01`;
    const next = new Date(y, m + 1, 1);
    const toExclusive = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-01`;
    return { from, toExclusive };
  }
  let min = dates[0]!;
  let max = dates[0]!;
  for (const d of dates) {
    if (d < min) min = d;
    if (d > max) max = d;
  }
  const from = `${min.getFullYear()}-${String(min.getMonth() + 1).padStart(2, "0")}-01`;
  const next = new Date(max.getFullYear(), max.getMonth() + 1, 1);
  const toExclusive = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-01`;
  return { from, toExclusive };
}

export async function parsePedidosSpreadsheet(params: {
  drive: drive_v3.Drive;
  file: drive_v3.Schema$File;
  dbColumns: MysqlColMeta[];
  headerRow: number;
  dataRow: number;
  onProgress?: (msg: string, n?: number) => Promise<void>;
}): Promise<PedidosParseResult> {
  const { drive, file, dbColumns, headerRow, dataRow, onProgress } = params;
  let tmpPath: string | null = null;

  try {
    tmpPath = await downloadDriveFileToTemp(drive, file);
    await onProgress?.("Pedidos Avinor: baixando e lendo...");

    const loaded = await loadAvinorXlsx({
      filePath: tmpPath,
      headerRow,
      dataRow,
      skipFooter: SKIP_FOOTER_ROWS,
      onProgress,
    });

    const sheetHeaders = dedupeHeadersPandasStyle(loaded.headers);
    const linesRead = loaded.rows.length;

    const descIdx = findColumnIndex(sheetHeaders, "Descrição", "Descricao");
    const pedidoIdxSheet = findColumnIndex(sheetHeaders, "Pedido");
    const dtIdxSheet = findColumnIndex(sheetHeaders, "Dt.Entrega", "Dt Entrega");

    if (descIdx < 0) {
      throw new Error('Coluna "Descrição" não encontrada no cabeçalho.');
    }
    if (pedidoIdxSheet < 0) {
      throw new Error('Coluna "Pedido" não encontrada no cabeçalho.');
    }
    if (dtIdxSheet < 0) {
      throw new Error('Coluna "Dt.Entrega" não encontrada no cabeçalho.');
    }

    let ignoredTotal = 0;
    const filtered: string[][] = [];
    for (const raw of loaded.rows) {
      const row = padRow(raw, sheetHeaders.length);
      const desc = row[descIdx] ?? "";
      if (isTotalDescricao(desc) || isEmptyDesc(desc)) {
        ignoredTotal += 1;
        continue;
      }
      filtered.push(row);
    }

    // fill-down em TODAS as colunas (depois do filtro) — igual .ffill()
    const filled = ffillAllColumns(filtered);

    const withPedido: string[][] = [];
    for (const row of filled) {
      if (!String(row[pedidoIdxSheet] ?? "").trim()) {
        ignoredTotal += 1;
        continue;
      }
      withPedido.push(row);
    }

    if (withPedido.length === 0) {
      throw new Error("Nenhuma linha válida após filtros (TOTAL / Descrição vazia).");
    }

    const mapped = mapRowsToDbColumnOrder({
      sheetHeaders,
      sheetRows: withPedido,
      dbColumns,
    });

    const dtColIdx = findColumnIndex(mapped.headers, "Dt.Entrega", "Dt Entrega");
    const pedidoColIdx = findColumnIndex(mapped.headers, "Pedido");
    if (dtColIdx < 0 || pedidoColIdx < 0) {
      throw new Error("Após mapear, Dt.Entrega ou Pedido não encontrados nas cols do MySQL.");
    }

    const dates: Date[] = [];
    const pedidos = new Set<string>();
    for (const row of mapped.rows) {
      pedidos.add(String(row[pedidoColIdx] ?? "").trim());
      const dt = parseDateTimeCell(row[dtColIdx] ?? "");
      if (!dt) continue;
      const d = new Date(dt.replace(" ", "T"));
      if (!Number.isNaN(d.getTime()) && d.getFullYear() >= 1980) dates.push(d);
    }

    if (dates.length === 0) {
      const sample = mapped.rows
        .slice(0, 5)
        .map((r) => `"${String(r[dtColIdx] ?? "")}"`)
        .join(" | ");
      throw new Error(
        `Nenhuma Dt.Entrega válida na planilha (amostra: ${sample}). ` +
          `Esperado DD/MM/YYYY — confira a leitura das datas.`,
      );
    }

    const { from, toExclusive } = pedidosMonthWindowFromDates(dates);

    return {
      headers: mapped.headers,
      validRows: mapped.rows,
      linesRead,
      ignoredTotal,
      dtColIdx,
      pedidoColIdx,
      monthFrom: from,
      monthToExclusive: toExclusive,
      pedidosInFile: [...pedidos].filter(Boolean).length,
    };
  } finally {
    await safeUnlink(tmpPath);
  }
}
