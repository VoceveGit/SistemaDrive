// backend/src/solucoesAvinor/avinorPedidos.ts
// Sync igual upload_avinor: apaga janela de meses (Dt.Entrega) + insert total.

import type {
  CodedSolution,
  CodedSolutionCommitResult,
  CodedSolutionContext,
  CodedSolutionRunResult,
  PedidosSummary,
} from "./types.js";
import { listMysqlColumnsOrdered } from "./snapshotMysql.js";
import { deleteByDateWindow, insertBatchDirect } from "./mysqlDirect.js";
import { parsePedidosSpreadsheet } from "./parsePedidos.js";

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
  return { targetTable, columns };
}

async function analyzePedidos(
  ctx: CodedSolutionContext,
  forCommit: boolean,
): Promise<{
  headers: string[];
  validRows: string[][];
  previewRows: string[][];
  summary: PedidosSummary;
}> {
  const { targetTable, columns } = await loadColumns(ctx);

  const parsed = await parsePedidosSpreadsheet({
    drive: ctx.drive,
    file: ctx.file,
    dbColumns: columns,
    headerRow: AVINOR_PEDIDOS.headerRow,
    dataRow: AVINOR_PEDIDOS.dataRow,
    onProgress: ctx.onProgress,
  });

  const dtCol = columns[parsed.dtColIdx]?.name ?? "Dt.Entrega";
  const rowsToInsert = parsed.validRows.length;

  let insertedRowCount = 0;
  let deletedRows = 0;

  if (forCommit) {
    await ctx.onProgress?.(
      `Apagando janela ${parsed.monthFrom} ≤ Dt.Entrega < ${parsed.monthToExclusive}...`,
    );
    deletedRows = await deleteByDateWindow({
      settings: ctx.dbSettings,
      table: targetTable,
      dtCol,
      dateFrom: parsed.monthFrom,
      dateToExclusive: parsed.monthToExclusive,
    });

    await ctx.onProgress?.(`Inserindo ${rowsToInsert} linha(s)...`);
    for (let i = 0; i < parsed.validRows.length; i += BATCH) {
      insertedRowCount += await insertBatchDirect({
        settings: ctx.dbSettings,
        table: targetTable,
        columns,
        sheetRows: parsed.validRows.slice(i, i + BATCH),
      });
    }
  }

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
    pedidosInFile: parsed.pedidosInFile,
    // Janela inteira: tudo será reescrito (sem comparação pedido a pedido)
    pedidosChanged: parsed.pedidosInFile,
    pedidosUnchanged: 0,
    rowsToInsert,
    insertedRowCount: forCommit ? insertedRowCount : rowsToInsert,
    monthFrom: parsed.monthFrom,
    monthToExclusive: parsed.monthToExclusive,
    note: forCommit
      ? `Pedidos OK: janela ${parsed.monthFrom} → ${parsed.monthToExclusive} (apagou ${deletedRows}, inseriu ${insertedRowCount}). ${parsed.pedidosInFile} pedido(s), ${parsed.ignoredTotal} linha(s) ignorada(s).`
      : `Preview: ${parsed.validRows.length} linha(s), ${parsed.pedidosInFile} pedido(s). Janela ${parsed.monthFrom} ≤ Dt.Entrega < ${parsed.monthToExclusive}. Enviar apaga a janela e reinsere tudo. ${parsed.ignoredTotal} ignorada(s) (TOTAL/vazio).`,
  };

  return {
    headers: parsed.headers,
    validRows: parsed.validRows,
    previewRows,
    summary,
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
    "Linha 7 = títulos. Por nome (pandas). Fill-down em todas as cols após filtrar TOTAL. Apaga janela de meses (Dt.Entrega) e reinsere.",
  defaultTargetTable: "base_pedidos_avinor",
  headerRow: 7,
  dataRow: 8,
  autoCommitOnImport: false,
  runImport,
  runCommit,
};
