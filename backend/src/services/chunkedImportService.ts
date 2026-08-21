// backend/src/services/chunkedImportService.ts — Streaming (disco + ExcelJS) + insert em lotes

import type { drive_v3 } from "googleapis";
import type { Company } from "../../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { parseOptionsFromCompany } from "./sheetParseService.js";
import {
  clearTableRows,
  fetchDistinctColumnValues,
  getAppDbSettings,
  insertRows,
  type DbSettings,
} from "./externalDbService.js";
import { normalizeCell } from "../utils/hash.js";
import {
  downloadDriveFileToTemp,
  safeUnlink,
  streamSheetFileInBatches,
} from "./streamSheetService.js";

const BATCH_SIZE = 500;
const MAX_RAWDATA_ROWS = 4000;
const PREVIEW_ROWS = 300;

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
    sentAt?: Date | null;
    sentBy?: string | null;
  },
): Promise<void> {
  await prisma.spreadsheet.update({ where: { id: spreadsheetId }, data });
}

function mapRows(
  headers: string[],
  rows: string[][],
  mapping: Record<string, string> | null,
): { headers: string[]; rows: string[][] } {
  if (!mapping) return { headers, rows };
  const mappedHeaders: string[] = [];
  const indices: number[] = [];
  headers.forEach((h, i) => {
    const target = mapping[h];
    if (target) {
      mappedHeaders.push(target);
      indices.push(i);
    }
  });
  if (mappedHeaders.length === 0) return { headers, rows };
  return {
    headers: mappedHeaders,
    rows: rows.map((row) => indices.map((i) => row[i] ?? "")),
  };
}

/**
 * Job: download em disco → ExcelJS streaming → INSERT em lotes.
 * Não materializa a planilha inteira na RAM.
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
      processMessage: "Baixando arquivo do Drive (disco)...",
    });
    tmpPath = await downloadDriveFileToTemp(drive, file);

    await setProgress(spreadsheetId, {
      processMessage: "Lendo planilha em streaming...",
    });

    const options = parseOptionsFromCompany(company);
    const mapping = company.columnMapping as Record<string, string> | null;
    const syncMode = company.syncMode || "incremental";

    if (!company.targetTable) {
      await collectPreviewOnly({
        spreadsheetId,
        tmpPath,
        options,
        message: "Sem tabela destino — configure e envie manualmente",
      });
      return;
    }

    const dbSettings = await getAppDbSettings();
    if (!dbSettings) {
      throw new Error("Banco de destino não configurado");
    }

    if (syncMode === "snapshot") {
      await streamImportToDb({
        spreadsheetId,
        company,
        tmpPath,
        options,
        mapping,
        dbSettings,
        companyName,
        fileName,
        emit,
        mode: "snapshot",
      });
      return;
    }

    if (company.compareColumn && (syncMode === "principal_only" || company.autoSend)) {
      await streamImportToDb({
        spreadsheetId,
        company,
        tmpPath,
        options,
        mapping,
        dbSettings,
        companyName,
        fileName,
        emit,
        mode: "principal",
      });
      return;
    }

    if (company.autoSend || syncMode === "incremental" || syncMode === "incremental_update") {
      await streamImportToDb({
        spreadsheetId,
        company,
        tmpPath,
        options,
        mapping,
        dbSettings,
        companyName,
        fileName,
        emit,
        mode: "insert",
      });
      return;
    }

    await collectPreviewOnly({
      spreadsheetId,
      tmpPath,
      options,
      message: "Pronto para análise",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro no processamento";
    console.error(`[chunkedImport] ${fileName}:`, error);
    await setProgress(spreadsheetId, {
      status: "error",
      processMessage: message,
    }).catch(() => undefined);

    if (company.autoSend) {
      await prisma.company
        .update({ where: { id: company.id }, data: { autoSend: false } })
        .catch(() => undefined);
    }

    emit?.("spreadsheet_auto_processed", {
      companyId: company.id,
      companyName,
      fileName,
      spreadsheetId,
      status: "error",
      autoSendDisabled: Boolean(company.autoSend),
      message,
    });
  } finally {
    await safeUnlink(tmpPath);
  }
}

async function collectPreviewOnly(params: {
  spreadsheetId: string;
  tmpPath: string;
  options: ReturnType<typeof parseOptionsFromCompany>;
  message: string;
}): Promise<void> {
  const { spreadsheetId, tmpPath, options, message } = params;
  const collected: string[][] = [];
  let headers: string[] = [];

  const result = await streamSheetFileInBatches(tmpPath, options, BATCH_SIZE, {
    onHeaders: (h) => {
      headers = h;
    },
    onBatch: async (batch) => {
      if (collected.length >= MAX_RAWDATA_ROWS) return;
      collected.push(...batch.slice(0, MAX_RAWDATA_ROWS - collected.length));
    },
    onProgress: async (n) => {
      await setProgress(spreadsheetId, {
        processedRows: n,
        processMessage: `${n} linhas lidas...`,
      });
    },
  });

  const truncated = result.totalRows > MAX_RAWDATA_ROWS;
  await setProgress(spreadsheetId, {
    status: "pending",
    totalRows: result.totalRows,
    processedRows: result.totalRows,
    newRows: result.totalRows,
    rawData: JSON.stringify({
      headers: headers.length ? headers : result.headers,
      rows: truncated ? collected : collected.length ? collected : result.previewRows,
      truncated,
      note: truncated
        ? `Arquivo grande (${result.totalRows} linhas): preview parcial.`
        : undefined,
    }),
    processMessage: message,
  });
}

async function streamImportToDb(params: {
  spreadsheetId: string;
  company: Company;
  tmpPath: string;
  options: ReturnType<typeof parseOptionsFromCompany>;
  mapping: Record<string, string> | null;
  dbSettings: DbSettings;
  companyName: string;
  fileName: string;
  emit?: EmitFn;
  mode: "snapshot" | "principal" | "insert";
}): Promise<void> {
  const {
    spreadsheetId,
    company,
    tmpPath,
    options,
    mapping,
    dbSettings,
    companyName,
    fileName,
    emit,
    mode,
  } = params;

  let inserted = 0;
  let headers: string[] = [];
  let existingKeys: Set<string> | null = null;
  let pIdx = -1;
  let lastProgressAt = 0;
  const previewRows: string[][] = [];

  if (mode === "snapshot") {
    await setProgress(spreadsheetId, { processMessage: "Limpando tabela destino..." });
    await clearTableRows(dbSettings, company.targetTable!);
  }

  if (mode === "principal" && company.compareColumn) {
    const mappedPrincipal =
      mapping?.[company.compareColumn] ?? company.compareColumn;
    existingKeys = await fetchDistinctColumnValues(
      dbSettings,
      company.targetTable!,
      mappedPrincipal,
    );
    await setProgress(spreadsheetId, {
      processMessage: "Comparando chaves e inserindo em lotes...",
    });
  }

  const result = await streamSheetFileInBatches(tmpPath, options, BATCH_SIZE, {
    onHeaders: async (h) => {
      headers = h;
      if (mode === "principal" && company.compareColumn) {
        const mappedPrincipal =
          mapping?.[company.compareColumn] ?? company.compareColumn;
        pIdx = headers.findIndex(
          (col) =>
            col.toLowerCase() === company.compareColumn!.toLowerCase() ||
            (mapping?.[col] ?? col).toLowerCase() === mappedPrincipal.toLowerCase(),
        );
      }
      await setProgress(spreadsheetId, {
        rawData: JSON.stringify({
          headers,
          rows: [],
          truncated: true,
          note: "Preview parcial — importação em streaming.",
        }),
        processMessage: "Cabeçalho lido — processando linhas...",
      });
    },
    onBatch: async (batch) => {
      if (!headers.length) return;

      let toInsert = batch;
      if (mode === "principal" && existingKeys) {
        toInsert =
          pIdx >= 0
            ? batch.filter((row) => {
                const key = normalizeCell(row[pIdx] ?? "");
                if (!key || existingKeys!.has(key)) return false;
                existingKeys!.add(key);
                return true;
              })
            : batch;
      }

      if (toInsert.length === 0) return;

      const mapped = mapRows(headers, toInsert, mapping);
      const res = await insertRows(
        dbSettings,
        company.targetTable!,
        mapped.headers,
        mapped.rows,
        mode === "insert" ? company.primaryKeyColumn : null,
      );
      inserted += res.insertedCount;

      if (previewRows.length < PREVIEW_ROWS) {
        previewRows.push(...toInsert.slice(0, PREVIEW_ROWS - previewRows.length));
      }
    },
    onProgress: async (n) => {
      if (n - lastProgressAt < Math.floor(BATCH_SIZE / 2)) return;
      lastProgressAt = n;
      await setProgress(spreadsheetId, {
        processedRows: n,
        totalRows: n,
        newRows: inserted,
        processMessage: `${n} processadas · ${inserted} inseridas`,
      });
    },
  });

  const finalHeaders = headers.length ? headers : result.headers;
  const truncated = result.totalRows > MAX_RAWDATA_ROWS;

  if (mode === "principal") {
    await setProgress(spreadsheetId, {
      status: inserted === 0 ? "no_new_items" : "sent",
      totalRows: result.totalRows,
      processedRows: result.totalRows,
      newRows: inserted,
      sentAt: inserted > 0 ? new Date() : null,
      sentBy: inserted > 0 ? "sistema-stream" : null,
      rawData: JSON.stringify({
        headers: finalHeaders,
        rows: previewRows,
        truncated,
        note: truncated
          ? `Arquivo grande (${result.totalRows} linhas): preview parcial.`
          : undefined,
      }),
      processMessage:
        inserted === 0 ? "Nenhum item novo" : `Concluído: ${inserted} novas`,
    });

    emit?.("spreadsheet_auto_processed", {
      companyId: company.id,
      companyName,
      fileName,
      spreadsheetId,
      status: inserted === 0 ? "no_new_items" : "sent",
      message: inserted === 0 ? "Nenhum item novo" : `${inserted} linhas`,
    });
    return;
  }

  await setProgress(spreadsheetId, {
    status: "sent",
    totalRows: result.totalRows,
    processedRows: result.totalRows,
    newRows: inserted,
    sentAt: new Date(),
    sentBy: "sistema-stream",
    rawData: JSON.stringify({
      headers: finalHeaders,
      rows: previewRows,
      truncated,
      note: truncated
        ? `Arquivo grande (${result.totalRows} linhas): preview parcial.`
        : undefined,
    }),
    processMessage:
      mode === "snapshot"
        ? `Snapshot concluído: ${inserted} linhas`
        : `Concluído em streaming: ${inserted} inserções`,
  });

  emit?.("spreadsheet_auto_processed", {
    companyId: company.id,
    companyName,
    fileName,
    spreadsheetId,
    status: "sent",
    message:
      mode === "snapshot"
        ? `Snapshot: ${inserted} linhas`
        : `${inserted} linhas em streaming`,
  });
}
