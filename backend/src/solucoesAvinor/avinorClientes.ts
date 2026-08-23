// backend/src/solucoesAvinor/avinorClientes.ts
// Snapshot posicional → base_clientes_avinor (espelho + DELETE/INSERT em transação).

import { sanitizeExcelText } from "../services/sheetParseService.js";
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

/** Títulos esperados na linha 4 (ordem = colunas do MySQL). */
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
  "Telefone",
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
  "Nome",
  "%Desconto Comercial",
  "%Desconto Financeiro",
  "Clas. ABC",
  "Ramo Atividade",
  "Tp.Cliente",
  "Supervisor",
  "Nome",
  "Lista",
  "Nome",
  "Ocorrência",
  "Descrição",
  "EAN Cliente",
  "Checkout",
  "Nr dias entrega",
  "Ult Pedido",
] as const;

const BATCH = 400;

function norm(h: string): string {
  return sanitizeExcelText(h)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, "")
    .trim();
}

function assertHeaders(actual: string[]): void {
  if (actual.length < AVINOR_CLIENTES_HEADERS.length) {
    throw new Error(
      `Cabeçalho: esperava ${AVINOR_CLIENTES_HEADERS.length} colunas, veio ${actual.length}. ` +
        `Confirme que a linha 4 tem os títulos.`,
    );
  }
  const bad: string[] = [];
  for (let i = 0; i < AVINOR_CLIENTES_HEADERS.length; i++) {
    const exp = norm(AVINOR_CLIENTES_HEADERS[i]);
    const got = norm(actual[i] ?? "");
    if (!got) {
      bad.push(`#${i + 1} vazio (esperado ${AVINOR_CLIENTES_HEADERS[i]})`);
      continue;
    }
    if (
      exp &&
      got &&
      exp.slice(0, 4) !== got.slice(0, 4) &&
      !got.includes(exp.slice(0, 5))
    ) {
      bad.push(`#${i + 1} "${actual[i]}" ≠ "${AVINOR_CLIENTES_HEADERS[i]}"`);
    }
  }
  if (bad.length > 8) {
    throw new Error(
      `Cabeçalho não confere com Avinor Clientes (${bad.length} divergências). ` +
        `Nada foi gravado. Exemplos: ${bad.slice(0, 4).join("; ")}`,
    );
  }
}

function padRow(row: string[], len: number): string[] {
  const out = row.slice(0, len);
  while (out.length < len) out.push("");
  return out;
}

async function runSnapshot(ctx: CodedSolutionContext): Promise<CodedSolutionRunResult> {
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

  try {
    await ctx.onProgress?.("Avinor Clientes: baixando arquivo...");
    tmpPath = await downloadDriveFileToTemp(ctx.drive, ctx.file);

    await ctx.onProgress?.("Avinor Clientes: streaming → espelho...");
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
          headers = h.slice(0, columns.length);
          assertHeaders(headers);
          await ctx.onProgress?.(`Cabeçalho OK (${headers.length} cols)`);
        },
        onBatch: async (batch) => {
          const rows = batch.map((r) => padRow(r, columns.length));
          insertedRowCount += await insertBatchIntoMirror({
            settings: ctx.dbSettings,
            mirrorTable,
            columns,
            sheetRows: rows,
          });
        },
        onProgress: async (n) => {
          await ctx.onProgress?.(`Espelho: ${n} linhas...`, n);
        },
      },
    );

    if (!headers.length) {
      headers = streamed.headers.slice(0, columns.length);
      assertHeaders(headers);
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
    "Snapshot 47 colunas por posição. Linha 4 = títulos, dados na 5+. Substitui base_clientes_avinor com espelho + transação.",
  defaultTargetTable: "base_clientes_avinor",
  headerRow: 4,
  dataRow: 5,
  runSnapshot,
};
