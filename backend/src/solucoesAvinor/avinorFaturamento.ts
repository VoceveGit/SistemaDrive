// backend/src/solucoesAvinor/avinorFaturamento.ts
// Igual pedidos: DELETE janela (coluna Data) + INSERT da planilha (staging).
// Neon: só resumo.

import type {
  CodedSolution,
  CodedSolutionCommitResult,
  CodedSolutionContext,
  CodedSolutionRunResult,
  FaturamentoSummary,
} from "./types.js";
import { listMysqlColumnsOrdered } from "./snapshotMysql.js";
import { deleteByDateWindow, insertBatchDirect } from "./mysqlDirect.js";
import { parseFaturamentoSpreadsheet } from "./parseFaturamento.js";
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
    ctx.company.targetTable?.trim() || AVINOR_FATURAMENTO.defaultTargetTable;
  if (ctx.dbSettings.dbType !== "mysql") {
    throw new Error("Faturamento Avinor exige MySQL (EXTRACTOR)");
  }
  const columns = await listMysqlColumnsOrdered(ctx.dbSettings, targetTable);
  if (columns.length !== 44) {
    throw new Error(`Tabela ${targetTable} tem ${columns.length} colunas; esperado 44.`);
  }
  return { targetTable, columns };
}

function asFaturamentoSummary(raw: unknown): FaturamentoSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as FaturamentoSummary;
  if (s.mode !== "faturamento") return null;
  if (!s.monthFrom || !s.monthToExclusive) return null;
  return s;
}

async function runImport(ctx: CodedSolutionContext): Promise<CodedSolutionRunResult> {
  const { targetTable, columns } = await loadColumns(ctx);

  const parsed = await parseFaturamentoSpreadsheet({
    drive: ctx.drive,
    file: ctx.file,
    dbColumns: columns,
    headerRow: AVINOR_FATURAMENTO.headerRow,
    dataRow: AVINOR_FATURAMENTO.dataRow,
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
    if (
      (i + chunk.length) % 1000 === 0 ||
      i + chunk.length >= parsed.validRows.length
    ) {
      await ctx.onProgress?.(
        `Staging: ${Math.min(i + chunk.length, parsed.validRows.length)}/${parsed.validRows.length}`,
        Math.min(i + chunk.length, parsed.validRows.length),
      );
    }
  }

  const skippedTotal =
    parsed.headerRowsSkipped + parsed.skippedNoNumero + parsed.skippedFooter;
  const missingNote =
    parsed.missingColumns.length > 0
      ? ` Colunas MySQL sem par (vão vazias): ${parsed.missingColumns.join(", ")}.`
      : "";

  const summary: FaturamentoSummary = {
    mode: "faturamento",
    codedSolutionId: AVINOR_FATURAMENTO.id,
    targetTable,
    fileName: ctx.file.name ?? "planilha",
    linesRead: parsed.linesRead,
    validRows: parsed.validRows.length,
    ignoredRows: skippedTotal,
    headerRowsSkipped: parsed.headerRowsSkipped,
    skippedNoNumero: parsed.skippedNoNumero,
    skippedFooter: parsed.skippedFooter,
    ignoredResumo: parsed.skippedFooter,
    ignoredNoNumero: parsed.skippedNoNumero,
    numerosNovos: parsed.numerosInFile,
    numerosExistentes: 0,
    rowsToInsert: parsed.validRows.length,
    insertedRowCount: parsed.validRows.length,
    monthFrom: parsed.monthFrom,
    monthToExclusive: parsed.monthToExclusive,
    dateMin: parsed.dateMin,
    dateMax: parsed.dateMax,
    sampleDates: parsed.sampleDates,
    note:
      `Pronto p/ enviar: ${parsed.validRows.length} linhas no staging, ` +
      `${parsed.numerosInFile} número(s). ` +
      `Data ${parsed.dateMin} … ${parsed.dateMax}. ` +
      `Janela ${parsed.monthFrom} ≤ Data < ${parsed.monthToExclusive}. ` +
      `Cabeçalho L${parsed.headerRowUsed}. ` +
      `Saltadas: ${skippedTotal} ` +
      `(topo ${parsed.headerRowsSkipped}, sem nº ${parsed.skippedNoNumero}, rodapé ${parsed.skippedFooter}).` +
      missingNote,
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
  const prev = asFaturamentoSummary(ctx.previousSummary);

  if (!prev?.monthFrom || !prev.monthToExclusive) {
    throw new Error(
      "Resumo da importação incompleto (sem janela de Data). Clique em Processar de novo e depois Enviar.",
    );
  }

  const staged = await countStagingRows(ctx.dbSettings, ctx.spreadsheetId);
  if (staged === 0) {
    throw new Error(
      "Nenhuma linha no staging. Clique em Processar de novo e depois Enviar.",
    );
  }

  const dataIdx = findColumnIndex(columns.map((c) => c.name), "data", "Data");
  const dtCol = dataIdx >= 0 ? columns[dataIdx]!.name : "data";

  await ctx.onProgress?.(
    `Apagando janela ${prev.monthFrom} ≤ Data < ${prev.monthToExclusive}...`,
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

  const summary: FaturamentoSummary = {
    ...prev,
    targetTable,
    rowsToInsert: staged,
    validRows: staged,
    insertedRowCount,
    numerosNovos: prev.numerosNovos,
    numerosExistentes: 0,
    note:
      `Faturamento OK: janela ${prev.monthFrom} → ${prev.monthToExclusive} ` +
      `(apagou ${deletedRows}, inseriu ${insertedRowCount}). ` +
      `Data ${prev.dateMin ?? "?"} … ${prev.dateMax ?? "?"}.`,
  };

  return { summary };
}

export const AVINOR_FATURAMENTO: CodedSolution = {
  id: "avinor_faturamento",
  label: "Faturamento Avinor",
  description:
    "Processar → staging. Enviar → DELETE janela (Data) + INSERT planilha. Neon só resumo.",
  defaultTargetTable: "faturamento_avinor",
  /** Preferida legada; a busca real é pela lista oficial de títulos (até L50). */
  headerRow: 16,
  dataRow: 17,
  autoCommitOnImport: false,
  runImport,
  runCommit,
};
