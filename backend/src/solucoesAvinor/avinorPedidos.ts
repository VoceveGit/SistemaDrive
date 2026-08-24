// backend/src/solucoesAvinor/avinorPedidos.ts
// Sync igual upload_avinor: apaga janela de meses (Dt.Entrega) + insert total.
// Neon: só resumo. Linhas: zz_import_staging (job_id = spreadsheetId).

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
import { findColumnIndex } from "./columnMap.js";
import {
  clearStagingJob,
  countStagingRows,
  ensureStagingTable,
  forEachStagingBatch,
  insertStagingBatch,
} from "../services/stagingService.js";

const BATCH = 400;
const STAGING_WRITE = 200;

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

function asPedidosSummary(raw: unknown): PedidosSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as PedidosSummary;
  if (s.mode !== "pedidos") return null;
  if (!s.monthFrom || !s.monthToExclusive) return null;
  return s;
}

async function runImport(ctx: CodedSolutionContext): Promise<CodedSolutionRunResult> {
  const { targetTable, columns } = await loadColumns(ctx);

  const parsed = await parsePedidosSpreadsheet({
    drive: ctx.drive,
    file: ctx.file,
    dbColumns: columns,
    headerRow: AVINOR_PEDIDOS.headerRow,
    dataRow: AVINOR_PEDIDOS.dataRow,
    onProgress: ctx.onProgress,
  });

  await ctx.onProgress?.(
    `Gravando ${parsed.validRows.length} linha(s) no staging (EXTRACTOR)...`,
  );
  await ensureStagingTable(ctx.dbSettings);
  await clearStagingJob(ctx.dbSettings, ctx.spreadsheetId);

  for (let i = 0; i < parsed.validRows.length; i += STAGING_WRITE) {
    const chunk = parsed.validRows.slice(i, i + STAGING_WRITE);
    await insertStagingBatch({
      settings: ctx.dbSettings,
      jobId: ctx.spreadsheetId,
      companyId: ctx.company.id,
      startRowNum: i,
      rows: chunk,
    });
    if ((i + chunk.length) % 1000 === 0 || i + chunk.length >= parsed.validRows.length) {
      await ctx.onProgress?.(
        `Staging: ${Math.min(i + chunk.length, parsed.validRows.length)}/${parsed.validRows.length}`,
        Math.min(i + chunk.length, parsed.validRows.length),
      );
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
    rowsToInsert: parsed.validRows.length,
    insertedRowCount: parsed.validRows.length,
    monthFrom: parsed.monthFrom,
    monthToExclusive: parsed.monthToExclusive,
    dateMin: parsed.dateMin,
    dateMax: parsed.dateMax,
    sampleDates: parsed.sampleDates,
    note:
      `Pronto p/ enviar: ${parsed.validRows.length} linhas no staging, ${parsed.pedidosInFile} pedidos. ` +
      `Dt.Entrega ${parsed.dateMin} … ${parsed.dateMax}. ` +
      `Janela ${parsed.monthFrom} ≤ x < ${parsed.monthToExclusive}. ` +
      `${parsed.ignoredTotal} ignorada(s) (TOTAL).`,
  };

  return {
    headers: parsed.headers,
    previewRows: [],
    importSummary: summary,
    truncated: true,
  };
}

async function runCommit(ctx: CodedSolutionContext): Promise<CodedSolutionCommitResult> {
  const { targetTable, columns } = await loadColumns(ctx);
  const prev = asPedidosSummary(ctx.previousSummary);

  if (!prev?.monthFrom || !prev.monthToExclusive) {
    throw new Error(
      "Resumo da importação incompleto (sem janela de datas). Clique em Processar de novo e depois Enviar.",
    );
  }

  const staged = await countStagingRows(ctx.dbSettings, ctx.spreadsheetId);
  if (staged === 0) {
    throw new Error(
      "Nenhuma linha no staging. Clique em Processar de novo (grava as linhas no EXTRACTOR) e depois Enviar.",
    );
  }

  const dtIdx = findColumnIndex(
    columns.map((c) => c.name),
    "Dt.Entrega",
    "Dt Entrega",
  );
  const dtCol = dtIdx >= 0 ? columns[dtIdx]!.name : "Dt.Entrega";

  await ctx.onProgress?.(
    `Apagando janela ${prev.monthFrom} ≤ Dt.Entrega < ${prev.monthToExclusive}...`,
  );
  const deletedRows = await deleteByDateWindow({
    settings: ctx.dbSettings,
    table: targetTable,
    dtCol,
    dateFrom: prev.monthFrom,
    dateToExclusive: prev.monthToExclusive,
  });

  await ctx.onProgress?.(`Inserindo ${staged} linha(s) do staging...`);
  let insertedRowCount = 0;
  await forEachStagingBatch(ctx.dbSettings, ctx.spreadsheetId, BATCH, async (rows) => {
    insertedRowCount += await insertBatchDirect({
      settings: ctx.dbSettings,
      table: targetTable,
      columns,
      sheetRows: rows,
    });
    await ctx.onProgress?.(
      `Inseridas ${insertedRowCount}/${staged}...`,
      insertedRowCount,
    );
  });

  await clearStagingJob(ctx.dbSettings, ctx.spreadsheetId);

  const summary: PedidosSummary = {
    ...prev,
    targetTable,
    rowsToInsert: staged,
    validRows: staged,
    insertedRowCount,
    note:
      `Pedidos OK: janela ${prev.monthFrom} → ${prev.monthToExclusive} ` +
      `(apagou ${deletedRows}, inseriu ${insertedRowCount}). ` +
      `Datas ${prev.dateMin ?? "?"} … ${prev.dateMax ?? "?"}.`,
  };

  return { summary };
}

export const AVINOR_PEDIDOS: CodedSolution = {
  id: "avinor_pedidos",
  label: "Pedidos Avinor",
  description:
    "Processar → staging EXTRACTOR. Enviar → DELETE janela + INSERT. Neon só resumo.",
  defaultTargetTable: "base_pedidos_avinor",
  headerRow: 7,
  dataRow: 8,
  autoCommitOnImport: false,
  runImport,
  runCommit,
};
