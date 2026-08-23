// backend/src/solucoesAvinor/avinorFaturamento.ts

import type {
  CodedSolution,
  CodedSolutionCommitResult,
  CodedSolutionContext,
  CodedSolutionRunResult,
  FaturamentoSummary,
} from "./types.js";
import { listMysqlColumnsOrdered } from "./snapshotMysql.js";
import { fetchExistingNumeros, insertBatchDirect } from "./mysqlDirect.js";
import {
  extractNumeros,
  NUMERO_COL_IDX,
  parseFaturamentoSpreadsheet,
} from "./parseFaturamento.js";
import { isValidFaturamentoNumero } from "./rowFilters.js";

const MAX_PREVIEW_ROWS = 4000;
const BATCH = 400;

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
  const numeroCol = columns[NUMERO_COL_IDX].name;
  return { targetTable, columns, numeroCol };
}

async function analyzeFaturamento(
  ctx: CodedSolutionContext,
  forCommit: boolean,
): Promise<{
  headers: string[];
  validRows: string[][];
  previewRows: string[][];
  summary: FaturamentoSummary;
  rowsToInsert: string[][];
}> {
  const { targetTable, columns, numeroCol } = await loadColumns(ctx);

  const parsed = await parseFaturamentoSpreadsheet({
    drive: ctx.drive,
    file: ctx.file,
    columnCount: columns.length,
    headerRow: AVINOR_FATURAMENTO.headerRow,
    dataRow: AVINOR_FATURAMENTO.dataRow,
    onProgress: ctx.onProgress,
  });

  const numeros = extractNumeros(parsed.validRows);
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
    const numero = String(row[NUMERO_COL_IDX] ?? "").trim();
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

  let insertedRowCount = 0;
  if (forCommit && rowsToInsert.length > 0) {
    await ctx.onProgress?.(`Inserindo ${rowsToInsert.length} nota(s) nova(s)...`);
    for (let i = 0; i < rowsToInsert.length; i += BATCH) {
      insertedRowCount += await insertBatchDirect({
        settings: ctx.dbSettings,
        table: targetTable,
        columns,
        sheetRows: rowsToInsert.slice(i, i + BATCH),
      });
    }
  }

  const previewRows = parsed.validRows.slice(0, MAX_PREVIEW_ROWS);
  const ignoredRows = parsed.ignoredResumo + parsed.ignoredNoNumero;

  const summary: FaturamentoSummary = {
    mode: "faturamento",
    codedSolutionId: AVINOR_FATURAMENTO.id,
    targetTable,
    fileName: ctx.file.name ?? "planilha",
    linesRead: parsed.linesRead,
    validRows: parsed.validRows.length,
    ignoredRows,
    ignoredResumo: parsed.ignoredResumo,
    ignoredNoNumero: parsed.ignoredNoNumero,
    numerosNovos,
    numerosExistentes,
    insertedRowCount: forCommit ? insertedRowCount : numerosNovos,
    note: forCommit
      ? `Faturamento OK: ${insertedRowCount} nota(s) inserida(s). ${numerosExistentes} já existiam. ${ignoredRows} linha(s) ignorada(s).`
      : `Preview: ${parsed.validRows.length} linha(s) com numero válido. ${numerosNovos} número(s) novo(s), ${numerosExistentes} já no banco. ${ignoredRows} ignorada(s) (resumo/sem numero).`,
  };

  return {
    headers: parsed.headers,
    validRows: parsed.validRows,
    previewRows,
    summary,
    rowsToInsert,
  };
}

async function runImport(ctx: CodedSolutionContext): Promise<CodedSolutionRunResult> {
  const result = await analyzeFaturamento(ctx, false);
  return {
    headers: result.headers,
    previewRows: result.previewRows,
    importSummary: result.summary,
    truncated: result.previewRows.length < result.validRows.length,
  };
}

async function runCommit(ctx: CodedSolutionContext): Promise<CodedSolutionCommitResult> {
  const result = await analyzeFaturamento(ctx, true);
  return { summary: result.summary };
}

export const AVINOR_FATURAMENTO: CodedSolution = {
  id: "avinor_faturamento",
  label: "Faturamento Avinor",
  description:
    "Linha 18 = títulos, dados L19+. Ignora L1–6, CFOP e rodapés por texto. Insert se numero não existe.",
  defaultTargetTable: "faturamento_avinor",
  headerRow: 18,
  dataRow: 19,
  autoCommitOnImport: false,
  runImport,
  runCommit,
};
