// backend/src/solucoesAvinor/avinorPedidos.ts
// Sync igual upload_avinor: apaga janela de meses (Dt.Entrega) + insert total.
// Neon: só resumo + datas (sem linhas).

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
    pedidosChanged: parsed.pedidosInFile,
    pedidosUnchanged: 0,
    rowsToInsert,
    insertedRowCount: forCommit ? insertedRowCount : rowsToInsert,
    monthFrom: parsed.monthFrom,
    monthToExclusive: parsed.monthToExclusive,
    dateMin: parsed.dateMin,
    dateMax: parsed.dateMax,
    sampleDates: parsed.sampleDates,
    note: forCommit
      ? `Pedidos OK: janela ${parsed.monthFrom} → ${parsed.monthToExclusive} (apagou ${deletedRows}, inseriu ${insertedRowCount}). Datas ${parsed.dateMin} … ${parsed.dateMax}. ${parsed.ignoredTotal} ignorada(s) (TOTAL).`
      : `Pronto p/ enviar: ${parsed.validRows.length} linhas, ${parsed.pedidosInFile} pedidos. Dt.Entrega ${parsed.dateMin} … ${parsed.dateMax}. Janela ${parsed.monthFrom} ≤ x < ${parsed.monthToExclusive}. ${parsed.ignoredTotal} ignorada(s) (TOTAL).`,
  };

  return { headers: parsed.headers, summary };
}

async function runImport(ctx: CodedSolutionContext): Promise<CodedSolutionRunResult> {
  const result = await analyzePedidos(ctx, false);
  return {
    headers: result.headers,
    previewRows: [],
    importSummary: result.summary,
    truncated: true,
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
    "Direto planilha→MySQL. TOTAL ignorado. Fill-down. Apaga janela Dt.Entrega e reinsere. Neon só resumo.",
  defaultTargetTable: "base_pedidos_avinor",
  headerRow: 7,
  dataRow: 8,
  autoCommitOnImport: false,
  runImport,
  runCommit,
};
