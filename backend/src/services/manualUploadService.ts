// Upload manual: planilha local → mesma lógica Pedidos Avinor (staging + DELETE janela + INSERT).

import { randomUUID } from "crypto";
import { unlink } from "fs/promises";
import { getCodedSolution } from "../solucoesAvinor/index.js";
import { AVINOR_PEDIDOS } from "../solucoesAvinor/avinorPedidos.js";
import { parsePedidosSpreadsheetFromPath } from "../solucoesAvinor/parsePedidos.js";
import { findColumnIndex } from "../solucoesAvinor/columnMap.js";
import { listMysqlColumnsOrdered } from "../solucoesAvinor/snapshotMysql.js";
import { deleteByDateWindow, insertBatchDirect } from "../solucoesAvinor/mysqlDirect.js";
import {
  clearStagingJob,
  ensureStagingTable,
  forEachStagingBatch,
  insertStagingBatch,
} from "./stagingService.js";
import { getAppDbSettings } from "./externalDbService.js";

const BATCH = 400;
const STAGING_WRITE = 200;

const ALLOWED_TABLES = new Set([
  "pedidos_emissao_avinor",
  "base_pedidos_avinor",
]);

const PEDIDOS_DT_DB = [
  "Dt.Entrega",
  "Dt Entrega",
  "Dt.Emissão",
  "Dt.Emissao",
  "Dt_Entrega",
  "Dt_Emissao",
];

export function listManualUploadTables(): string[] {
  return [...ALLOWED_TABLES];
}

export type ManualUploadResult = {
  success: boolean;
  fileName: string;
  targetTable: string;
  codedSolutionId: string;
  insertedRowCount?: number;
  deletedRows?: number;
  monthFrom?: string;
  monthToExclusive?: string;
  note?: string;
  error?: string;
};

export async function runManualPedidosUpload(params: {
  filePath: string;
  fileName: string;
  targetTable: string;
  codedSolutionId: string;
  onProgress?: (message: string, pct?: number) => void;
}): Promise<ManualUploadResult> {
  const { filePath, fileName, targetTable, codedSolutionId, onProgress } = params;

  if (!ALLOWED_TABLES.has(targetTable)) {
    return {
      success: false,
      fileName,
      targetTable,
      codedSolutionId,
      error: `Tabela não permitida: ${targetTable}`,
    };
  }

  const coded = getCodedSolution(codedSolutionId);
  if (!coded || coded.id !== AVINOR_PEDIDOS.id) {
    return {
      success: false,
      fileName,
      targetTable,
      codedSolutionId,
      error: "Solução codada inválida (use Pedidos Avinor).",
    };
  }

  const dbSettings = await getAppDbSettings();
  if (!dbSettings) {
    return {
      success: false,
      fileName,
      targetTable,
      codedSolutionId,
      error: "Banco EXTRACTOR não configurado nas Configurações.",
    };
  }

  const jobId = `upload-${randomUUID()}`;
  const companyId = "manual-upload";

  try {
    onProgress?.("Lendo colunas do MySQL...", 5);
    const columns = await listMysqlColumnsOrdered(dbSettings, targetTable);
    if (columns.length !== 23) {
      return {
        success: false,
        fileName,
        targetTable,
        codedSolutionId,
        error: `Tabela ${targetTable} tem ${columns.length} colunas; esperado 23 (igual base_pedidos_avinor).`,
      };
    }

    onProgress?.("Processando planilha (TOTAL → ffill)...", 15);
    const parsed = await parsePedidosSpreadsheetFromPath({
      filePath,
      dbColumns: columns,
      headerRow: AVINOR_PEDIDOS.headerRow,
      dataRow: AVINOR_PEDIDOS.dataRow,
      onProgress: async (msg) => onProgress?.(msg),
    });

    onProgress?.(`Staging: ${parsed.validRows.length} linhas...`, 40);
    await ensureStagingTable(dbSettings);
    await clearStagingJob(dbSettings, jobId);

    for (let i = 0; i < parsed.validRows.length; i += STAGING_WRITE) {
      const chunk = parsed.validRows.slice(i, i + STAGING_WRITE);
      await insertStagingBatch({
        settings: dbSettings,
        jobId,
        companyId,
        startRowNum: i,
        rows: chunk,
      });
    }

    const dtIdx = findColumnIndex(columns.map((c) => c.name), ...PEDIDOS_DT_DB);
    const dtCol = dtIdx >= 0 ? columns[dtIdx]!.name : "Dt.Entrega";

    onProgress?.(
      `Apagando janela ${parsed.monthFrom} ≤ data < ${parsed.monthToExclusive}...`,
      55,
    );
    const deletedRows = await deleteByDateWindow({
      settings: dbSettings,
      table: targetTable,
      dtCol,
      dateFrom: parsed.monthFrom,
      dateToExclusive: parsed.monthToExclusive,
    });

    onProgress?.("Inserindo no MySQL...", 70);
    let insertedRowCount = 0;
    const total = parsed.validRows.length;
    await forEachStagingBatch(dbSettings, jobId, BATCH, async (rows) => {
      insertedRowCount += await insertBatchDirect({
        settings: dbSettings,
        table: targetTable,
        columns,
        sheetRows: rows,
      });
      const pct = 70 + Math.min(25, Math.round((insertedRowCount / total) * 25));
      onProgress?.(`Inseridas ${insertedRowCount}/${total}...`, pct);
    });

    await clearStagingJob(dbSettings, jobId);

    const note =
      `Upload OK: janela ${parsed.monthFrom} → ${parsed.monthToExclusive} ` +
      `(apagou ${deletedRows}, inseriu ${insertedRowCount}). ` +
      `Datas ${parsed.dateMin} … ${parsed.dateMax}.`;

    onProgress?.("Concluído.", 100);

    return {
      success: true,
      fileName,
      targetTable,
      codedSolutionId,
      insertedRowCount,
      deletedRows,
      monthFrom: parsed.monthFrom,
      monthToExclusive: parsed.monthToExclusive,
      note,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      success: false,
      fileName,
      targetTable,
      codedSolutionId,
      error: message,
    };
  } finally {
    await unlink(filePath).catch(() => undefined);
  }
}
