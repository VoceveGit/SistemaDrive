// backend/src/solucoesAvinor/avinorPedidos.ts

import type {
  CodedSolution,
  CodedSolutionCommitResult,
  CodedSolutionContext,
  CodedSolutionRunResult,
  PedidosSummary,
} from "./types.js";
import { listMysqlColumnsOrdered } from "./snapshotMysql.js";
import {
  deletePedidoRowsInRange,
  fetchPedidoRowsInRange,
  insertBatchDirect,
} from "./mysqlDirect.js";
import {
  comparePedidoGroups,
  groupRowsByPedido,
  normalizeDbRowForHash,
  normalizeSheetRowForHash,
  parsePedidosSpreadsheet,
  pedidosDateRange,
  PEDIDO_COL_IDX,
  DT_ENTREGA_COL_IDX,
} from "./parsePedidos.js";

const MAX_PREVIEW_ROWS = 4000;
const BATCH = 400;

async function loadColumns(ctx: CodedSolutionContext) {
  const targetTable =
    ctx.company.targetTable?.trim() || AVINOR_PEDIDOS.defaultTargetTable;
  if (ctx.dbSettings.dbType !== "mysql") {
    throw new Error("Pedidos Avinor exige MySQL (EXTRACTOR)");
  }
  const columns = await listMysqlColumnsOrdered(ctx.dbSettings, targetTable);
  if (columns.length !== 23) {
    throw new Error(`Tabela ${targetTable} tem ${columns.length} colunas; esperado 23.`);
  }
  const pedidoCol = columns[PEDIDO_COL_IDX].name;
  const dtCol = columns[DT_ENTREGA_COL_IDX].name;
  return { targetTable, columns, pedidoCol, dtCol };
}

async function analyzePedidos(
  ctx: CodedSolutionContext,
  forCommit: boolean,
): Promise<{
  headers: string[];
  validRows: string[][];
  previewRows: string[][];
  summary: PedidosSummary;
  changedPedidos: string[];
  fileGroups: Map<string, string[][]>;
  dateRange: { from: string; to: string };
  columns: Awaited<ReturnType<typeof loadColumns>>["columns"];
  targetTable: string;
  pedidoCol: string;
  dtCol: string;
}> {
  const { targetTable, columns, pedidoCol, dtCol } = await loadColumns(ctx);

  const parsed = await parsePedidosSpreadsheet({
    drive: ctx.drive,
    file: ctx.file,
    columnCount: columns.length,
    headerRow: AVINOR_PEDIDOS.headerRow,
    dataRow: AVINOR_PEDIDOS.dataRow,
    onProgress: ctx.onProgress,
  });

  const fileGroups = groupRowsByPedido(parsed.validRows);
  const fileGroupsNorm = new Map<string, string[][]>();
  for (const [pedido, rows] of fileGroups) {
    fileGroupsNorm.set(
      pedido,
      rows.map((r) => normalizeSheetRowForHash(r, columns)),
    );
  }

  const dateRange = pedidosDateRange(parsed.validRows);
  const pedidoIds = [...fileGroups.keys()];

  await ctx.onProgress?.("Comparando pedidos com o banco...");
  const dbRaw = await fetchPedidoRowsInRange({
    settings: ctx.dbSettings,
    table: targetTable,
    pedidoCol,
    dtCol,
    pedidoIds,
    dateFrom: dateRange.from,
    dateTo: dateRange.to,
    columnNames: columns.map((c) => c.name),
  });

  const dbGroups = new Map<string, string[][]>();
  for (const r of dbRaw) {
    const pedido = String(r[pedidoCol] ?? "").trim();
    if (!pedido) continue;
    const norm = normalizeDbRowForHash(r as Record<string, unknown>, columns);
    const list = dbGroups.get(pedido) ?? [];
    list.push(norm);
    dbGroups.set(pedido, list);
  }

  const { changed, unchanged } = comparePedidoGroups({
    fileGroups: fileGroupsNorm,
    dbGroups,
  });
  const rowsToInsert = changed.reduce((acc, p) => {
    return acc + (fileGroups.get(p)?.length ?? 0);
  }, 0);

  let insertedRowCount = 0;
  if (forCommit) {
    await ctx.onProgress?.(`Gravando ${changed.length} pedido(s) alterados...`);
    for (const pedidoId of changed) {
      const rows = fileGroups.get(pedidoId) ?? [];
      if (!rows.length) continue;
      await deletePedidoRowsInRange({
        settings: ctx.dbSettings,
        table: targetTable,
        pedidoCol,
        dtCol,
        pedidoId,
        dateFrom: dateRange.from,
        dateTo: dateRange.to,
      });
      for (let i = 0; i < rows.length; i += BATCH) {
        insertedRowCount += await insertBatchDirect({
          settings: ctx.dbSettings,
          table: targetTable,
          columns,
          sheetRows: rows.slice(i, i + BATCH),
        });
      }
    }
  }

  const truncated = parsed.validRows.length > MAX_PREVIEW_ROWS;
  const previewRows = parsed.validRows.slice(0, MAX_PREVIEW_ROWS);

  const summary: PedidosSummary = {
    mode: "pedidos",
    codedSolutionId: AVINOR_PEDIDOS.id,
    targetTable,
    fileName: ctx.file.name ?? "planilha",
    linesRead: parsed.linesRead,
    validRows: parsed.validRows.length,
    ignoredRows: parsed.ignoredTotal,
    ignoredTotal: parsed.ignoredTotal,
    pedidosInFile: fileGroups.size,
    pedidosChanged: changed.length,
    pedidosUnchanged: unchanged.length,
    rowsToInsert,
    insertedRowCount: forCommit ? insertedRowCount : rowsToInsert,
    note: forCommit
      ? `Pedidos OK: ${changed.length} pedido(s) atualizados, ${insertedRowCount} linha(s) inseridas. ${unchanged.length} pedido(s) iguais (ignorados).`
      : `Preview: ${parsed.validRows.length} linha(s) válidas, ${fileGroups.size} pedido(s). ${changed.length} pedido(s) com diferença, ${unchanged.length} iguais. ${parsed.ignoredTotal} ignorada(s) (TOTAL).`,
  };

  return {
    headers: parsed.headers,
    validRows: parsed.validRows,
    previewRows,
    summary,
    changedPedidos: changed,
    fileGroups,
    dateRange,
    columns,
    targetTable,
    pedidoCol,
    dtCol,
  };
}

async function runImport(ctx: CodedSolutionContext): Promise<CodedSolutionRunResult> {
  const result = await analyzePedidos(ctx, false);
  return {
    headers: result.headers,
    previewRows: result.previewRows,
    importSummary: result.summary,
    truncated: result.previewRows.length < result.validRows.length,
  };
}

async function runCommit(ctx: CodedSolutionContext): Promise<CodedSolutionCommitResult> {
  const result = await analyzePedidos(ctx, true);
  return { summary: result.summary };
}

export const AVINOR_PEDIDOS: CodedSolution = {
  id: "avinor_pedidos",
  label: "Pedidos Avinor",
  description:
    "Linha 7 = títulos, dados L8+. Fill-down Emp→Vendedor. Ignora TOTAL na Descrição. Sync por Pedido (Dt.Entrega).",
  defaultTargetTable: "base_pedidos_avinor",
  headerRow: 7,
  dataRow: 8,
  autoCommitOnImport: false,
  runImport,
  runCommit,
};
