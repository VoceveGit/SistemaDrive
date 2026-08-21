// backend/src/services/chunkedImportService.ts
// Streaming só para LER e montar preview — NUNCA grava no MySQL aqui.
// Insert só acontece no botão Enviar (spreadsheetsController).

import type { drive_v3 } from "googleapis";
import type { Company } from "../../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { parseOptionsFromCompany } from "./sheetParseService.js";
import {
  downloadDriveFileToTemp,
  safeUnlink,
  streamSheetFileInBatches,
} from "./streamSheetService.js";

const BATCH_SIZE = 500;
/** Limite de linhas guardadas no Neon para validação na UI (anti-OOM). */
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
 * Job: download em disco → ExcelJS streaming → salva preview + status pending.
 * Não insere nada no banco destino. Você valida na UI e só então envia.
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

    await setProgress(spreadsheetId, {
      processMessage: "Lendo planilha (sem enviar ao banco)...",
    });

    const options = parseOptionsFromCompany(company);
    const storedRows: string[][] = [];
    let headers: string[] = [];
    let lastProgressAt = 0;

    const result = await streamSheetFileInBatches(tmpPath, options, BATCH_SIZE, {
      onHeaders: async (h) => {
        headers = h;
        await setProgress(spreadsheetId, {
          processMessage: `Cabeçalho OK (${h.length} colunas) — lendo linhas...`,
          rawData: JSON.stringify({ headers: h, rows: [] }),
        });
      },
      onBatch: async (batch) => {
        if (storedRows.length >= MAX_STORE_ROWS) return;
        const room = MAX_STORE_ROWS - storedRows.length;
        storedRows.push(...batch.slice(0, room));
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

    let message = "Pronto — valide os dados e envie manualmente";
    if (!company.targetTable) {
      message = "Sem tabela destino — configure e depois envie";
    } else if (truncated) {
      message = `Pronto (preview das primeiras ${rowsForUi.length} de ${result.totalRows} linhas) — valide antes de enviar`;
    }
    if (company.autoSend) {
      message += " · auto-envio não grava sozinho (validação primeiro)";
    }

    await setProgress(spreadsheetId, {
      status: "pending",
      totalRows: result.totalRows,
      processedRows: result.totalRows,
      newRows: result.totalRows,
      updatedRows: 0,
      processMessage: message,
      rawData: JSON.stringify({
        headers: finalHeaders,
        rows: rowsForUi,
        truncated,
        note: truncated
          ? `Arquivo com ${result.totalRows} linhas. Preview limitado a ${rowsForUi.length} para não estourar memória. Confira se cabeçalho/linhas estão corretos antes de enviar.`
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
