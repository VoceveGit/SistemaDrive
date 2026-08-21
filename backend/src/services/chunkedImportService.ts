// backend/src/services/chunkedImportService.ts
// Streaming: preview no Neon OU staging no EXTRACTOR (useStagingTable).
// Nunca grava na tabela destino aqui — só no botão Enviar.

import type { drive_v3 } from "googleapis";
import type { Company } from "../../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { parseOptionsFromCompany } from "./sheetParseService.js";
import { getAppDbSettings } from "./externalDbService.js";
import {
  clearStagingJob,
  ensureStagingTable,
  insertStagingBatch,
} from "./stagingService.js";
import {
  downloadDriveFileToTemp,
  safeUnlink,
  streamSheetFileInBatches,
} from "./streamSheetService.js";

const BATCH_SIZE = 500;
const MAX_PREVIEW_ROWS = 300;
const MAX_STORE_ROWS = 4000;

type EmitFn = (event: string, payload: unknown) => void;

async function setProgress(
  spreadsheetId: string,
  data: {
    processedRows?: number;
    totalRows?: number;
    newRows?: number;
    updatedRows?: number;
    status?: string;
    processMessage?: string | null;
    rawData?: string;
  },
): Promise<void> {
  await prisma.spreadsheet.update({ where: { id: spreadsheetId }, data });
}

/**
 * Job: download → streaming.
 * - useStagingTable: linhas vão pra zz_import_staging (job_id); preview curto no Neon
 * - senão: preview/rawData no Neon (até MAX_STORE_ROWS)
 * Em ambos: status pending — sem INSERT na tabela destino.
 */
export async function runChunkedImport(params: {
  spreadsheetId: string;
  company: Company;
  drive: drive_v3.Drive;
  file: drive_v3.Schema$File;
  emit?: EmitFn;
}): Promise<void> {
  const { spreadsheetId, company, drive, file, emit } = params;
  const companyName = company.name;
  const fileName = file.name ?? "planilha";
  let tmpPath: string | null = null;

  try {
    await setProgress(spreadsheetId, {
      processMessage: "Baixando arquivo do Drive...",
    });
    tmpPath = await downloadDriveFileToTemp(drive, file);

    const options = parseOptionsFromCompany(company);
    const useStaging = Boolean(company.useStagingTable);

    if (useStaging) {
      await importToStaging({
        spreadsheetId,
        company,
        tmpPath,
        options,
        fileName,
        companyName,
        emit,
      });
      return;
    }

    await setProgress(spreadsheetId, {
      processMessage: "Lendo planilha (sem enviar ao banco destino)...",
    });

    const storedRows: string[][] = [];
    let headers: string[] = [];
    let lastProgressAt = 0;

    const result = await streamSheetFileInBatches(tmpPath, options, BATCH_SIZE, {
      onHeaders: async (h) => {
        headers = h;
        await setProgress(spreadsheetId, {
          processMessage: `Cabeçalho OK (${h.length} colunas) — lendo linhas...`,
          rawData: JSON.stringify({ headers: h, rows: [], staging: false }),
        });
      },
      onBatch: async (batch) => {
        if (storedRows.length >= MAX_STORE_ROWS) return;
        storedRows.push(...batch.slice(0, MAX_STORE_ROWS - storedRows.length));
      },
      onProgress: async (n) => {
        if (n - lastProgressAt < BATCH_SIZE) return;
        lastProgressAt = n;
        await setProgress(spreadsheetId, {
          processedRows: n,
          totalRows: n,
          processMessage: `${n} linhas lidas (ainda não enviadas)`,
        });
      },
    });

    const finalHeaders = headers.length ? headers : result.headers;
    const truncated = result.totalRows > MAX_STORE_ROWS;
    const rowsForUi = truncated ? storedRows : storedRows.length ? storedRows : result.previewRows;

    await setProgress(spreadsheetId, {
      status: "pending",
      totalRows: result.totalRows,
      processedRows: result.totalRows,
      newRows: result.totalRows,
      updatedRows: 0,
      processMessage: truncated
        ? `Pronto (preview ${rowsForUi.length}/${result.totalRows}) — valide antes de enviar`
        : "Pronto — valide os dados e envie manualmente",
      rawData: JSON.stringify({
        headers: finalHeaders,
        rows: rowsForUi,
        truncated,
        staging: false,
        note: truncated
          ? `Preview limitado a ${rowsForUi.length} linhas. Ative "Usar tabela job" para planilhas grandes.`
          : undefined,
      }),
    });

    emit?.("new_spreadsheet", {
      companyId: company.id,
      companyName,
      fileName,
      spreadsheetId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro no processamento";
    console.error(`[chunkedImport] ${fileName}:`, error);
    await setProgress(spreadsheetId, {
      status: "error",
      processMessage: message,
    }).catch(() => undefined);

    emit?.("spreadsheet_auto_processed", {
      companyId: company.id,
      companyName,
      fileName,
      spreadsheetId,
      status: "error",
      message,
    });
  } finally {
    await safeUnlink(tmpPath);
  }
}

async function importToStaging(params: {
  spreadsheetId: string;
  company: Company;
  tmpPath: string;
  options: ReturnType<typeof parseOptionsFromCompany>;
  fileName: string;
  companyName: string;
  emit?: EmitFn;
}): Promise<void> {
  const { spreadsheetId, company, tmpPath, options, fileName, companyName, emit } = params;

  const dbSettings = await getAppDbSettings();
  if (!dbSettings) {
    throw new Error("Banco de destino não configurado (necessário para tabela job)");
  }

  await setProgress(spreadsheetId, {
    processMessage: "Preparando tabela job (zz_import_staging)...",
  });
  await ensureStagingTable(dbSettings);
  await clearStagingJob(dbSettings, spreadsheetId);

  const previewRows: string[][] = [];
  let headers: string[] = [];
  let rowNum = 0;
  let lastProgressAt = 0;

  await setProgress(spreadsheetId, {
    processMessage: "Lendo e gravando na tabela job (sem tocar no destino)...",
  });

  const result = await streamSheetFileInBatches(tmpPath, options, BATCH_SIZE, {
    onHeaders: async (h) => {
      headers = h;
      await setProgress(spreadsheetId, {
        rawData: JSON.stringify({
          headers: h,
          rows: [],
          staging: true,
          truncated: true,
        }),
        processMessage: `Cabeçalho OK (${h.length} cols) — gravando no staging...`,
      });
    },
    onBatch: async (batch) => {
      await insertStagingBatch({
        settings: dbSettings,
        jobId: spreadsheetId,
        companyId: company.id,
        startRowNum: rowNum + 1,
        rows: batch,
      });
      rowNum += batch.length;
      if (previewRows.length < MAX_PREVIEW_ROWS) {
        previewRows.push(...batch.slice(0, MAX_PREVIEW_ROWS - previewRows.length));
      }
    },
    onProgress: async (n) => {
      if (n - lastProgressAt < BATCH_SIZE) return;
      lastProgressAt = n;
      await setProgress(spreadsheetId, {
        processedRows: n,
        totalRows: n,
        processMessage: `${n} linhas na tabela job (ainda não no destino)`,
      });
    },
  });

  const finalHeaders = headers.length ? headers : result.headers;

  await setProgress(spreadsheetId, {
    status: "pending",
    totalRows: result.totalRows,
    processedRows: result.totalRows,
    newRows: result.totalRows,
    updatedRows: 0,
    processMessage: `Pronto — ${result.totalRows} linhas na tabela job. Valide o preview e envie.`,
    rawData: JSON.stringify({
      headers: finalHeaders,
      rows: previewRows,
      truncated: result.totalRows > previewRows.length,
      staging: true,
      note: `Dados completos estão em zz_import_staging (job ${spreadsheetId}). Preview: ${previewRows.length} linhas. Nada foi gravado na tabela destino ainda.`,
    }),
  });

  emit?.("new_spreadsheet", {
    companyId: company.id,
    companyName,
    fileName,
    spreadsheetId,
  });
}
