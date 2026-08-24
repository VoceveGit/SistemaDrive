// backend/src/solucoesAvinor/avinorClientes.ts
// Snapshot por nome (pandas dedup) → base_clientes_avinor (espelho + transação).

import {
  downloadDriveFileToTemp,
  safeUnlink,
  streamSheetFileInBatches,
} from "../services/streamSheetService.js";
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
  mapRowsToDbColumnOrder,
} from "./columnMap.js";
import { padRow } from "./rowFilters.js";

const BATCH = 400;

/** Lista de referência (script antigo) — validação leve após dedup. */
export const AVINOR_CLIENTES_HEADERS = [
  "Emp",
  "Unidades",
  "Cliente",
  "Razão Social",
  "Nome Fantasia",
  "Endereço",
  "Complemento",
  "Numero",
  "Bairro",
  "Cidade",
  "UF",
  "CEP",
  "Pt. Referênci",
  "Telefone",
  "Telefone.1",
  "Pessoa",
  "CPF/CGC",
  "Limite Crédito",
  "Limite Crédito Utilizado",
  "Saldo Limite Crédito",
  "Ins.Estadual",
  "Situação",
  "Latitude",
  "Longitude",
  "Data Cadastro",
  "Indicação",
  "Indicador",
  "Vendedor",
  "Nome",
  "Email",
  "Rede",
  "Nome.1",
  "%Desconto Comercial",
  "%Desconto Financeiro",
  "Clas. ABC",
  "Ramo Atividade",
  "Tp.Cliente",
  "Supervisor",
  "Nome.2",
  "Lista",
  "Nome.3",
  "Ocorrência",
  "Descrição",
  "EAN Cliente",
  "Checkout",
  "Nr dias entrega",
  "Ult Pedido",
] as const;

async function runImport(ctx: CodedSolutionContext): Promise<CodedSolutionRunResult> {
  const targetTable =
    ctx.company.targetTable?.trim() || AVINOR_CLIENTES.defaultTargetTable;

  if (ctx.dbSettings.dbType !== "mysql") {
    throw new Error("Avinor Clientes exige MySQL (EXTRACTOR)");
  }

  await ctx.onProgress?.("Avinor Clientes: lendo colunas do MySQL...");
  const columns = await listMysqlColumnsOrdered(ctx.dbSettings, targetTable);
  if (columns.length !== AVINOR_CLIENTES_HEADERS.length) {
    throw new Error(
      `Tabela ${targetTable} tem ${columns.length} colunas; esperado ${AVINOR_CLIENTES_HEADERS.length}.`,
    );
  }

  const previousRowCount = await countRows(ctx.dbSettings, targetTable);
  await ctx.onProgress?.(
    `Avinor Clientes: tabela atual tem ${previousRowCount} linhas — preparando espelho...`,
  );
  const mirrorTable = await prepareMirrorTable(ctx.dbSettings, targetTable);

  let tmpPath: string | null = null;
  let insertedRowCount = 0;
  let headers: string[] = [];
  let sheetHeaders: string[] = [];

  try {
    await ctx.onProgress?.("Avinor Clientes: baixando arquivo...");
    tmpPath = await downloadDriveFileToTemp(ctx.drive, ctx.file);

    await ctx.onProgress?.("Avinor Clientes: streaming → espelho (por nome)...");
    const streamed = await streamSheetFileInBatches(
      tmpPath,
      {
        headerRow: AVINOR_CLIENTES.headerRow,
        dataRow: AVINOR_CLIENTES.dataRow,
        skipEmptyRows: true,
        autofillEmpty: false,
      },
      BATCH,
      {
        onHeaders: async (h) => {
          sheetHeaders = dedupeHeadersPandasStyle(h);
          // Valida casando com MySQL (lança se faltar coluna)
          mapRowsToDbColumnOrder({
            sheetHeaders,
            sheetRows: [],
            dbColumns: columns,
          });
          headers = columns.map((c) => c.name);
          await ctx.onProgress?.(`Cabeçalho OK (${sheetHeaders.length} cols, map por nome)`);
        },
        onBatch: async (batch) => {
          const padded = batch.map((r) => padRow(r, sheetHeaders.length));
          const mapped = mapRowsToDbColumnOrder({
            sheetHeaders,
            sheetRows: padded,
            dbColumns: columns,
          });
          insertedRowCount += await insertBatchIntoMirror({
            settings: ctx.dbSettings,
            mirrorTable,
            columns,
            sheetRows: mapped.rows,
          });
        },
        onProgress: async (n) => {
          await ctx.onProgress?.(`Espelho: ${n} linhas...`, n);
        },
      },
    );

    if (!headers.length) {
      sheetHeaders = dedupeHeadersPandasStyle(streamed.headers);
      mapRowsToDbColumnOrder({
        sheetHeaders,
        sheetRows: [],
        dbColumns: columns,
      });
      headers = columns.map((c) => c.name);
    }

    if (insertedRowCount === 0) {
      throw new Error(
        "Nenhuma linha de dados. Verifique linha 4 (títulos) e dados a partir da linha 5.",
      );
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

    return {
      headers,
      summary: {
        mode: "snapshot",
        codedSolutionId: AVINOR_CLIENTES.id,
        targetTable,
        previousRowCount,
        insertedRowCount,
        finalRowCount,
        fileName: ctx.file.name ?? "planilha",
        note: `Snapshot OK: havia ${previousRowCount}, inseriu ${insertedRowCount}, tabela ficou com ${finalRowCount}.`,
      },
    };
  } catch (err) {
    await truncateMirror(ctx.dbSettings, mirrorTable).catch(() => undefined);
    throw err;
  } finally {
    await safeUnlink(tmpPath);
  }
}

export const AVINOR_CLIENTES: CodedSolution = {
  id: "avinor_clientes",
  label: "Clientes Avinor",
  description:
    "Snapshot por nome (dedup pandas). Linha 4 = títulos, dados na 5+. Espelho + transação (sem DROP).",
  defaultTargetTable: "base_clientes_avinor",
  headerRow: 4,
  dataRow: 5,
  autoCommitOnImport: true,
  runImport,
};
