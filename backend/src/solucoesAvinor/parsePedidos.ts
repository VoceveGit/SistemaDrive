// backend/src/solucoesAvinor/parsePedidos.ts — leitura + agrupamento pedidos Avinor

import {
  downloadDriveFileToTemp,
  safeUnlink,
  streamSheetFileInBatches,
} from "../services/streamSheetService.js";
import type { drive_v3 } from "googleapis";
import { hashRow } from "../utils/hash.js";
import { parseDateTimeCell, convertCellForMysql, type MysqlColMeta } from "./conversoes.js";
import { isPedidosSkipRow, padRow } from "./rowFilters.js";

export const PEDIDO_COL_IDX = 3;
export const DT_ENTREGA_COL_IDX = 2;
export const DESCRICAO_COL_IDX = 12;
export const PEDIDOS_AUTOFILL_COLS = 10;

const BATCH = 400;

export type PedidosParseResult = {
  headers: string[];
  validRows: string[][];
  linesRead: number;
  ignoredTotal: number;
};

export async function parsePedidosSpreadsheet(params: {
  drive: drive_v3.Drive;
  file: drive_v3.Schema$File;
  columnCount: number;
  headerRow: number;
  dataRow: number;
  onProgress?: (msg: string, n?: number) => Promise<void>;
}): Promise<PedidosParseResult> {
  const { drive, file, columnCount, headerRow, dataRow, onProgress } = params;
  let tmpPath: string | null = null;
  const validRows: string[][] = [];
  let headers: string[] = [];
  let linesRead = 0;
  let ignoredTotal = 0;

  try {
    tmpPath = await downloadDriveFileToTemp(drive, file);
    await onProgress?.("Pedidos Avinor: lendo planilha...");

    await streamSheetFileInBatches(
      tmpPath,
      {
        headerRow,
        dataRow,
        skipEmptyRows: true,
        autofillEmpty: true,
        autofillColumns: PEDIDOS_AUTOFILL_COLS,
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
            if (isPedidosSkipRow(row, DESCRICAO_COL_IDX)) {
              ignoredTotal += 1;
              continue;
            }
            const pedido = String(row[PEDIDO_COL_IDX] ?? "").trim();
            if (!pedido) {
              ignoredTotal += 1;
              continue;
            }
            validRows.push(row);
          }
        },
        onProgress: async (n) => {
          await onProgress?.(`Lidas ${n} linhas...`, n);
        },
      },
    );

    if (!headers.length) {
      throw new Error("Cabeçalho não encontrado — confira linha 7 (títulos).");
    }
    if (validRows.length === 0) {
      throw new Error("Nenhuma linha válida após filtros (TOTAL / sem Pedido).");
    }

    return { headers, validRows, linesRead, ignoredTotal };
  } finally {
    await safeUnlink(tmpPath);
  }
}

export function groupRowsByPedido(rows: string[][]): Map<string, string[][]> {
  const map = new Map<string, string[][]>();
  for (const row of rows) {
    const pedido = String(row[PEDIDO_COL_IDX] ?? "").trim();
    if (!pedido) continue;
    const list = map.get(pedido) ?? [];
    list.push(row);
    map.set(pedido, list);
  }
  return map;
}

function formatDateLikeMysql(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function normalizeSheetRowForHash(row: string[], columns: MysqlColMeta[]): string[] {
  return columns.map((col, i) => {
    const v = convertCellForMysql(row[i] ?? "", col);
    if (v == null) return "";
    return String(v).trim();
  });
}

export function normalizeDbRowForHash(
  r: Record<string, unknown>,
  columns: MysqlColMeta[],
): string[] {
  return columns.map((col) => {
    const raw = r[col.name];
    if (raw == null) return "";
    if (raw instanceof Date) return formatDateLikeMysql(raw);
    return String(raw).trim();
  });
}

function rowHashNormalized(values: string[]): string {
  return hashRow(values);
}

export function hashPedidoGroupNormalized(rows: string[][]): string {
  const sorted = [...rows].sort((a, b) =>
    rowHashNormalized(a).localeCompare(rowHashNormalized(b)),
  );
  return hashRow(sorted.flat());
}

export function pedidosDateRange(rows: string[][]): { from: string; to: string } {
  let minMs = Infinity;
  let maxMs = -Infinity;
  for (const row of rows) {
    const dt = parseDateTimeCell(row[DT_ENTREGA_COL_IDX] ?? "");
    if (!dt) continue;
    const ms = new Date(dt.replace(" ", "T")).getTime();
    if (Number.isFinite(ms)) {
      minMs = Math.min(minMs, ms);
      maxMs = Math.max(maxMs, ms);
    }
  }
  if (!Number.isFinite(minMs)) {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    return { from: `${y}-${m}-01 00:00:00`, to: `${y}-${m}-31 23:59:59` };
  }
  const from = new Date(minMs);
  from.setHours(0, 0, 0, 0);
  const to = new Date(maxMs);
  to.setHours(23, 59, 59, 999);
  const fmt = (d: Date) => {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  return { from: fmt(from), to: fmt(to) };
}

export function comparePedidoGroups(params: {
  fileGroups: Map<string, string[][]>;
  dbGroups: Map<string, string[][]>;
}): { changed: string[]; unchanged: string[] } {
  const changed: string[] = [];
  const unchanged: string[] = [];
  for (const [pedido, fileRows] of params.fileGroups) {
    const dbRows = params.dbGroups.get(pedido) ?? [];
    const fileH = hashPedidoGroupNormalized(fileRows);
    const dbH = dbRows.length ? hashPedidoGroupNormalized(dbRows) : "";
    if (fileH === dbH && dbRows.length > 0) unchanged.push(pedido);
    else changed.push(pedido);
  }
  return { changed, unchanged };
}
