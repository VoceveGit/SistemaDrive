// backend/src/solucoesAvinor/avinorFaturamento.ts
// Neon: só resumo. Linhas novas: zz_import_staging. Enviar lê staging (sem reler Drive).

import type {
  CodedSolution,
  CodedSolutionCommitResult,
  CodedSolutionContext,
  CodedSolutionRunResult,
  FaturamentoSummary,
} from "./types.js";
import { listMysqlColumnsOrdered } from "./snapshotMysql.js";
import { fetchExistingNumeros, insertBatchDirect } from "./mysqlDirect.js";
import { extractNumeros, parseFaturamentoSpreadsheet } from "./parseFaturamento.js";
import { isValidFaturamentoNumero } from "./rowFilters.js";
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

  const numeroCol = columns[parsed.numeroColIdx]?.name ?? "numero";
  const numeros = extractNumeros(parsed.validRows, parsed.numeroColIdx);

  await ctx.onProgress?.("Verificando números no banco...");
  const existing = await fetchExistingNumeros(
    ctx.dbSettings,
    targetTable,
    numeroCol,
    numeros,
  );

  const rowsToInsert: string[][] = [];
  let numerosNovos = 0;
  let numerosExistentes = 0;
  const seenNumero = new Set<string>();

  for (const row of parsed.validRows) {
    const numero = String(row[parsed.numeroColIdx] ?? "").trim();
    if (!isValidFaturamentoNumero(numero)) continue;
    if (seenNumero.has(numero)) continue;
    seenNumero.add(numero);
    if (existing.has(numero)) {
      numerosExistentes += 1;
    } else {
      numerosNovos += 1;
      rowsToInsert.push(row);
    }
  }

  await ctx.onProgress?.(
    `Gravando ${rowsToInsert.length} nota(s) nova(s) no staging...`,
  );
  await ensureStagingTable(ctx.dbSettings);
  await clearStagingJob(ctx.dbSettings, ctx.spreadsheetId);

  for (let i = 0; i < rowsToInsert.length; i += STAGING_WRITE) {
    const chunk = rowsToInsert.slice(i, i + STAGING_WRITE);
    await insertStagingBatch({
      settings: ctx.dbSettings,
      jobId: ctx.spreadsheetId,
      companyId: ctx.company.id,
      startRowNum: i,
      rows: chunk,
    });
  }

  const skippedTotal =
    parsed.headerRowsSkipped + parsed.skippedNoNumero + parsed.skippedFooter;
  const missingNote =
    parsed.missingColumns.length > 0
      ? ` Colunas MySQL sem par na planilha (vão vazias): ${parsed.missingColumns.join(", ")}.`
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
    numerosNovos,
    numerosExistentes,
    insertedRowCount: numerosNovos,
    note:
      `Pronto p/ enviar: ${rowsToInsert.length} nota(s) no staging ` +
      `(${numerosExistentes} já no banco). ` +
      `Cabeçalho L${parsed.headerRowUsed}, dados L${parsed.dataRowUsed}. ` +
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

  const staged = await countStagingRows(ctx.dbSettings, ctx.spreadsheetId);
  if (staged === 0 && (prev?.numerosNovos ?? 0) > 0) {
    throw new Error(
      "Nenhuma linha no staging. Clique em Processar de novo e depois Enviar.",
    );
  }

  let insertedRowCount = 0;
  if (staged > 0) {
    await ctx.onProgress?.(`Inserindo ${staged} nota(s) do staging...`);
    await forEachStagingBatch(ctx.dbSettings, ctx.spreadsheetId, BATCH, async (rows) => {
      insertedRowCount += await insertBatchDirect({
        settings: ctx.dbSettings,
        table: targetTable,
        columns,
        sheetRows: rows,
      });
    });
    await clearStagingJob(ctx.dbSettings, ctx.spreadsheetId);
  }

  const summary: FaturamentoSummary = {
    mode: "faturamento",
    codedSolutionId: AVINOR_FATURAMENTO.id,
    targetTable,
    fileName: prev?.fileName ?? ctx.file.name ?? "planilha",
    linesRead: prev?.linesRead ?? staged,
    validRows: prev?.validRows ?? staged,
    ignoredRows: prev?.ignoredRows ?? 0,
    ignoredResumo: prev?.ignoredResumo ?? 0,
    ignoredNoNumero: prev?.ignoredNoNumero ?? 0,
    numerosNovos: prev?.numerosNovos ?? insertedRowCount,
    numerosExistentes: prev?.numerosExistentes ?? 0,
    insertedRowCount,
    note:
      `Faturamento OK: ${insertedRowCount} nota(s) inserida(s). ` +
      `${prev?.numerosExistentes ?? 0} já existiam no Processar.`,
  };

  return { summary };
}

export const AVINOR_FATURAMENTO: CodedSolution = {
  id: "avinor_faturamento",
  label: "Faturamento Avinor",
  description:
    "Processar → staging EXTRACTOR (só números novos). Enviar → INSERT. Neon só resumo.",
  defaultTargetTable: "faturamento_avinor",
  headerRow: 18,
  dataRow: 19,
  autoCommitOnImport: false,
  runImport,
  runCommit,
};
