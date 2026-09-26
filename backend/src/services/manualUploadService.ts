// Upload manual: mesma solução Pedidos Avinor do Drive (runImport no worker → runCommit na API).

import { randomUUID } from "crypto";
import type { Company } from "../../generated/prisma/client.js";
import type { drive_v3 } from "googleapis";
import { getCodedSolution } from "../solucoesAvinor/index.js";
import { AVINOR_PEDIDOS } from "../solucoesAvinor/avinorPedidos.js";
import type { PedidosSummary } from "../solucoesAvinor/types.js";
import { getAppDbSettings } from "./externalDbService.js";

const ALLOWED_TABLES = new Set([
  "pedidos_emissao_avinor",
  "base_pedidos_avinor",
]);

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

/** Resultado IPC do importWorker (--manual): só fase Processar. */
export type ManualWorkerImportResult = {
  ok: boolean;
  jobId?: string;
  fileName: string;
  targetTable: string;
  codedSolutionId: string;
  importSummary?: PedidosSummary;
  error?: string;
};

function stubCompany(targetTable: string): Company {
  return {
    id: "manual-upload",
    targetTable,
    headerRow: AVINOR_PEDIDOS.headerRow,
    dataRow: AVINOR_PEDIDOS.dataRow,
  } as Company;
}

function validateManualJob(params: {
  targetTable: string;
  codedSolutionId: string;
  fileName: string;
}): { error?: string } {
  if (!ALLOWED_TABLES.has(params.targetTable)) {
    return { error: `Tabela não permitida: ${params.targetTable}` };
  }
  const coded = getCodedSolution(params.codedSolutionId);
  if (!coded || coded.id !== AVINOR_PEDIDOS.id) {
    return { error: "Solução codada inválida (use Pedidos Avinor)." };
  }
  return {};
}

/** Fase 1 — roda no importWorker (igual Processar do Drive). */
export async function runManualPedidosImportWorker(params: {
  filePath: string;
  fileName: string;
  targetTable: string;
  codedSolutionId: string;
}): Promise<ManualWorkerImportResult> {
  const { filePath, fileName, targetTable, codedSolutionId } = params;
  const bad = validateManualJob({ targetTable, codedSolutionId, fileName });
  if (bad.error) {
    return { ok: false, fileName, targetTable, codedSolutionId, error: bad.error };
  }

  const dbSettings = await getAppDbSettings();
  if (!dbSettings) {
    return {
      ok: false,
      fileName,
      targetTable,
      codedSolutionId,
      error: "Banco EXTRACTOR não configurado nas Configurações.",
    };
  }

  const jobId = `upload-${randomUUID()}`;
  const company = stubCompany(targetTable);
  const drive = {} as drive_v3.Drive;
  const file = { name: fileName } as drive_v3.Schema$File;

  try {
    const result = await AVINOR_PEDIDOS.runImport!({
      spreadsheetId: jobId,
      company,
      drive,
      file,
      dbSettings,
      localFilePath: filePath,
      onProgress: async (message) => {
        console.log(`[manualUpload] ${message}`);
      },
    });

    const importSummary = result.importSummary;
    if (!importSummary || importSummary.mode !== "pedidos") {
      return {
        ok: false,
        fileName,
        targetTable,
        codedSolutionId,
        error: "Import não retornou resumo de pedidos.",
      };
    }

    return {
      ok: true,
      jobId,
      fileName,
      targetTable,
      codedSolutionId,
      importSummary,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, fileName, targetTable, codedSolutionId, error: message };
  }
}

/** Fase 2 — na API (igual Enviar / auto-commit do Drive). */
export async function runManualPedidosCommit(params: {
  jobId: string;
  fileName: string;
  targetTable: string;
  codedSolutionId: string;
  importSummary: PedidosSummary;
}): Promise<ManualUploadResult> {
  const { jobId, fileName, targetTable, codedSolutionId, importSummary } = params;

  const dbSettings = await getAppDbSettings();
  if (!dbSettings) {
    return {
      success: false,
      fileName,
      targetTable,
      codedSolutionId,
      error: "Banco EXTRACTOR não configurado.",
    };
  }

  const company = stubCompany(targetTable);
  const drive = {} as drive_v3.Drive;
  const file = { name: fileName } as drive_v3.Schema$File;

  try {
    const commit = await AVINOR_PEDIDOS.runCommit!({
      spreadsheetId: jobId,
      company,
      drive,
      file,
      dbSettings,
      previousSummary: importSummary,
      onProgress: async (message) => {
        console.log(`[manualUpload] ${message}`);
      },
    });

    const summary = commit.summary;
    const note = summary.note;
    const inserted = summary.insertedRowCount;

    const deletedMatch = note.match(/apagou (\d+)/i);
    const deletedRows = deletedMatch ? Number(deletedMatch[1]) : undefined;

    return {
      success: true,
      fileName,
      targetTable,
      codedSolutionId,
      insertedRowCount: inserted,
      deletedRows,
      monthFrom: importSummary.monthFrom,
      monthToExclusive: importSummary.monthToExclusive,
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
  }
}
