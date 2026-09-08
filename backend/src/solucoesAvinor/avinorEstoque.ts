// backend/src/solucoesAvinor/avinorEstoque.ts
// Snapshot estoque_avinor: DELETE tudo + INSERT planilha (L20 títulos, dados L21+).
// Ignora rodapé "Totais". Colunas MySQL sem par na planilha ficam vazias/NULL.

import { downloadDriveFileToTemp, safeUnlink } from "../services/streamSheetService.js";
import type {
  CodedSolution,
  CodedSolutionContext,
  CodedSolutionRunResult,
} from "./types.js";
import {
  commitMirrorSwap,
  countRows,
  insertBatchIntoMirror,
  listMysqlColumnsOrdered,
  prepareMirrorTable,
  truncateMirror,
} from "./snapshotMysql.js";
import {
  dedupeHeadersPandasStyle,
  findColumnIndex,
  mapRowsToDbColumnOrder,
} from "./columnMap.js";
import { loadAvinorXlsx } from "./excelLoadAvinor.js";
import {
  isEstoqueFooterStopRow,
  isEstoqueSkipRow,
  padRow,
} from "./rowFilters.js";

const BATCH = 200;

async function runImport(ctx: CodedSolutionContext): Promise<CodedSolutionRunResult> {
  const targetTable =
    ctx.company.targetTable?.trim() || AVINOR_ESTOQUE.defaultTargetTable;

  if (ctx.dbSettings.dbType !== "mysql") {
    throw new Error("Avinor Estoque exige MySQL (EXTRACTOR)");
  }

  await ctx.onProgress?.("Avinor Estoque: lendo colunas do MySQL...");
  const columns = await listMysqlColumnsOrdered(ctx.dbSettings, targetTable);
  if (!columns.length) {
    throw new Error(`Tabela ${targetTable} sem colunas.`);
  }

  const previousRowCount = await countRows(ctx.dbSettings, targetTable);
  await ctx.onProgress?.(
    `Avinor Estoque: tabela atual tem ${previousRowCount} linhas — preparando espelho...`,
  );
  const mirrorTable = await prepareMirrorTable(ctx.dbSettings, targetTable);

  let tmpPath: string | null = null;
  let insertedRowCount = 0;

  try {
    await ctx.onProgress?.("Avinor Estoque: baixando arquivo...");
    tmpPath = await downloadDriveFileToTemp(ctx.drive, ctx.file);

    await ctx.onProgress?.("Avinor Estoque: lendo planilha (L20+)...");
    const loaded = await loadAvinorXlsx({
      filePath: tmpPath,
      headerRow: AVINOR_ESTOQUE.headerRow,
      dataRow: AVINOR_ESTOQUE.dataRow,
      skipFooter: 0,
      headerMarkers: [
        "codigo",
        "Código",
        "Codigo",
        "descricao",
        "Descrição Produto",
        "Saldo",
      ],
      // L20 preferida; se andar, tenta até ~L28
      headerProbeExtra: 8,
      onProgress: ctx.onProgress,
    });

    const sheetHeaders = dedupeHeadersPandasStyle(loaded.headers);
    const codigoIdx = findColumnIndex(
      sheetHeaders,
      "codigo",
      "Código",
      "Codigo",
      "Cód",
      "Cod",
    );
    if (codigoIdx < 0) {
      throw new Error(
        `Coluna "Código" não encontrada no cabeçalho (linha ${loaded.headerRowUsed}).`,
      );
    }

    const validSheetRows: string[][] = [];
    let skippedFooter = 0;
    let skippedInvalid = 0;

    for (const raw of loaded.rows) {
      const row = padRow(raw, sheetHeaders.length);
      if (isEstoqueFooterStopRow(row)) {
        skippedFooter += 1;
        break;
      }
      if (isEstoqueSkipRow(row, codigoIdx)) {
        skippedInvalid += 1;
        continue;
      }
      validSheetRows.push(row);
    }

    if (!validSheetRows.length) {
      throw new Error(
        "Nenhuma linha de produto válida. Verifique títulos na linha 20 e dados abaixo.",
      );
    }

    const mapped = mapRowsToDbColumnOrder({
      sheetHeaders,
      sheetRows: validSheetRows,
      dbColumns: columns,
    });

    await ctx.onProgress?.(
      `Avinor Estoque: gravando ${mapped.rows.length} produto(s) no espelho...`,
    );

    for (let i = 0; i < mapped.rows.length; i += BATCH) {
      const batch = mapped.rows.slice(i, i + BATCH);
      insertedRowCount += await insertBatchIntoMirror({
        settings: ctx.dbSettings,
        mirrorTable,
        columns,
        sheetRows: batch,
      });
      await ctx.onProgress?.(`Espelho: ${insertedRowCount} linhas...`, insertedRowCount);
    }

    await ctx.onProgress?.(
      `Trocando snapshot (${previousRowCount} → ${insertedRowCount}) em transação...`,
    );
    await commitMirrorSwap({
      settings: ctx.dbSettings,
      targetTable,
      mirrorTable,
    });
    await truncateMirror(ctx.dbSettings, mirrorTable);

    const finalRowCount = await countRows(ctx.dbSettings, targetTable);
    const note =
      `Snapshot estoque OK: havia ${previousRowCount}, inseriu ${insertedRowCount}, ` +
      `tabela ficou com ${finalRowCount}. ` +
      `Cabeçalho L${loaded.headerRowUsed}. ` +
      `Ignorados: rodapé ${skippedFooter}, inválidos ${skippedInvalid}.` +
      (mapped.missingColumns.length
        ? ` Colunas MySQL sem par na planilha (vazias): ${mapped.missingColumns.join(", ")}.`
        : "");

    return {
      headers: columns.map((c) => c.name),
      summary: {
        mode: "snapshot",
        codedSolutionId: AVINOR_ESTOQUE.id,
        targetTable,
        previousRowCount,
        insertedRowCount,
        finalRowCount,
        fileName: ctx.file.name ?? "planilha",
        note,
      },
    };
  } catch (err) {
    await truncateMirror(ctx.dbSettings, mirrorTable).catch(() => undefined);
    throw err;
  } finally {
    await safeUnlink(tmpPath);
  }
}

export const AVINOR_ESTOQUE: CodedSolution = {
  id: "avinor_estoque",
  label: "Estoque Avinor",
  description:
    "Snapshot: apaga estoque_avinor e insere a planilha (L20 títulos). Ignora Totais. Auto-grava no Processar.",
  defaultTargetTable: "estoque_avinor",
  headerRow: 20,
  dataRow: 21,
  autoCommitOnImport: true,
  runImport,
};
