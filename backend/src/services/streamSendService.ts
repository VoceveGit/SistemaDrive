// backend/src/services/streamSendService.ts
// Envio sob demanda: staging (tabela job) OU rebaixa do Drive.

import { prisma } from "../lib/prisma.js";
import { parseOptionsFromCompany } from "./sheetParseService.js";
import {
  clearTableRows,
  fetchDistinctColumnValues,
  getAppDbSettings,
  insertRows,
} from "./externalDbService.js";
import { normalizeCell } from "../utils/hash.js";
import {
  downloadDriveFileToTemp,
  safeUnlink,
  streamSheetFileInBatches,
} from "./streamSheetService.js";
import { getDriveClientForImport } from "./googleDriveService.js";
import {
  clearStagingJob,
  forEachStagingBatch,
} from "./stagingService.js";

const BATCH_SIZE = 500;

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

type RawMeta = {
  headers?: string[];
  staging?: boolean;
  truncated?: boolean;
};

function parseMeta(rawData: string): RawMeta {
  try {
    return JSON.parse(rawData) as RawMeta;
  } catch {
    return {};
  }
}

/**
 * Envia planilha ao destino. Preferência:
 * 1) se rawData.staging → lê zz_import_staging por job_id
 * 2) senão rebaixa do Drive e faz streaming
 */
export async function streamSendFromDrive(params: {
  spreadsheetId: string;
  userEmail?: string;
}): Promise<{ insertedCount: number; totalRows: number; completed: true }> {
  const spreadsheet = await prisma.spreadsheet.findUnique({
    where: { id: params.spreadsheetId },
    include: { company: true },
  });
  if (!spreadsheet) throw new Error("Planilha não encontrada");

  const meta = parseMeta(spreadsheet.rawData);
  if (meta.staging || spreadsheet.company.useStagingTable) {
    return sendFromStaging({
      spreadsheetId: params.spreadsheetId,
      userEmail: params.userEmail,
      headers: meta.headers ?? [],
    });
  }

  return sendFromDriveRescan(params);
}

async function sendFromStaging(params: {
  spreadsheetId: string;
  userEmail?: string;
  headers: string[];
}): Promise<{ insertedCount: number; totalRows: number; completed: true }> {
  const spreadsheet = await prisma.spreadsheet.findUnique({
    where: { id: params.spreadsheetId },
    include: { company: true },
  });
  if (!spreadsheet) throw new Error("Planilha não encontrada");

  const company = spreadsheet.company;
  if (!company.targetTable) throw new Error("Tabela destino não configurada");

  const dbSettings = await getAppDbSettings();
  if (!dbSettings) throw new Error("Banco de destino não configurado");

  let headers = params.headers;
  if (!headers.length) {
    try {
      headers = (JSON.parse(spreadsheet.rawData) as { headers?: string[] }).headers ?? [];
    } catch {
      headers = [];
    }
  }
  if (!headers.length) {
    throw new Error("Cabeçalhos não encontrados no job — reimporte a planilha");
  }

  const mapping = company.columnMapping as Record<string, string> | null;
  const syncMode = company.syncMode || "incremental";

  await prisma.spreadsheet.update({
    where: { id: spreadsheet.id },
    data: {
      status: "processing",
      processMessage: "Enviando da tabela job para o destino...",
    },
  });

  let inserted = 0;
  let existingKeys: Set<string> | null = null;
  let pIdx = -1;

  try {
    if (syncMode === "snapshot") {
      await clearTableRows(dbSettings, company.targetTable);
    }

    if (
      syncMode !== "snapshot" &&
      company.compareColumn &&
      (syncMode === "principal_only" || Boolean(company.compareColumn))
    ) {
      const mappedPrincipal =
        mapping?.[company.compareColumn] ?? company.compareColumn;
      existingKeys = await fetchDistinctColumnValues(
        dbSettings,
        company.targetTable,
        mappedPrincipal,
      );
      pIdx = headers.findIndex(
        (col) =>
          col.toLowerCase() === company.compareColumn!.toLowerCase() ||
          (mapping?.[col] ?? col).toLowerCase() === mappedPrincipal.toLowerCase(),
      );
    }

    const total = await forEachStagingBatch(
      dbSettings,
      spreadsheet.id,
      BATCH_SIZE,
      async (batch) => {
        let toInsert = batch;
        if (existingKeys && pIdx >= 0) {
          toInsert = batch.filter((row) => {
            const key = normalizeCell(row[pIdx] ?? "");
            if (!key || existingKeys!.has(key)) return false;
            existingKeys!.add(key);
            return true;
          });
        }
        if (toInsert.length === 0) return;

        const mapped = mapRows(headers, toInsert, mapping);
        const res = await insertRows(
          dbSettings,
          company.targetTable!,
          mapped.headers,
          mapped.rows,
          syncMode === "snapshot" || existingKeys ? null : company.primaryKeyColumn,
        );
        inserted += res.insertedCount;

        await prisma.spreadsheet.update({
          where: { id: spreadsheet.id },
          data: {
            newRows: inserted,
            processMessage: `${inserted} linhas gravadas no destino...`,
          },
        });
      },
    );

    await clearStagingJob(dbSettings, spreadsheet.id);

    const status = inserted === 0 && existingKeys ? "no_new_items" : "sent";
    await prisma.spreadsheet.update({
      where: { id: spreadsheet.id },
      data: {
        status,
        totalRows: total,
        processedRows: total,
        newRows: inserted,
        sentAt: status === "sent" ? new Date() : null,
        sentBy: status === "sent" ? params.userEmail ?? null : null,
        processMessage:
          status === "no_new_items"
            ? "Nenhum item novo"
            : `Enviado: ${inserted} de ${total} (tabela job limpa)`,
        rawData: JSON.stringify({
          headers,
          rows: [],
          staging: false,
          truncated: false,
          note: "Job concluído — dados do staging removidos.",
        }),
      },
    });

    return { insertedCount: inserted, totalRows: total, completed: true };
  } catch (error) {
    await prisma.spreadsheet
      .update({
        where: { id: spreadsheet.id },
        data: {
          status: "error",
          processMessage: error instanceof Error ? error.message : "Erro no envio",
        },
      })
      .catch(() => undefined);
    throw error;
  }
}

async function sendFromDriveRescan(params: {
  spreadsheetId: string;
  userEmail?: string;
}): Promise<{ insertedCount: number; totalRows: number; completed: true }> {
  const spreadsheet = await prisma.spreadsheet.findUnique({
    where: { id: params.spreadsheetId },
    include: { company: true },
  });
  if (!spreadsheet) throw new Error("Planilha não encontrada");

  const company = spreadsheet.company;
  if (!company.targetTable) throw new Error("Tabela destino não configurada");
  if (!spreadsheet.googleFileId) {
    throw new Error("Arquivo do Drive não vinculado a esta planilha");
  }

  const dbSettings = await getAppDbSettings();
  if (!dbSettings) throw new Error("Banco de destino não configurado");

  const drive = await getDriveClientForImport();
  if (!drive) throw new Error("Google Drive não conectado");

  const mapping = company.columnMapping as Record<string, string> | null;
  const syncMode = company.syncMode || "incremental";
  const options = parseOptionsFromCompany(company);

  let tmpPath: string | null = null;
  let inserted = 0;
  let headers: string[] = [];
  let existingKeys: Set<string> | null = null;
  let pIdx = -1;

  try {
    await prisma.spreadsheet.update({
      where: { id: spreadsheet.id },
      data: {
        status: "processing",
        processMessage: "Enviando ao banco (streaming do Drive)...",
      },
    });

    tmpPath = await downloadDriveFileToTemp(drive, {
      id: spreadsheet.googleFileId,
      name: spreadsheet.fileName,
      mimeType: spreadsheet.fileName.toLowerCase().endsWith(".csv")
        ? "text/csv"
        : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    if (syncMode === "snapshot") {
      await clearTableRows(dbSettings, company.targetTable);
    }

    if (
      syncMode !== "snapshot" &&
      company.compareColumn &&
      (syncMode === "principal_only" || Boolean(company.compareColumn))
    ) {
      const mappedPrincipal =
        mapping?.[company.compareColumn] ?? company.compareColumn;
      existingKeys = await fetchDistinctColumnValues(
        dbSettings,
        company.targetTable,
        mappedPrincipal,
      );
    }

    const result = await streamSheetFileInBatches(tmpPath, options, BATCH_SIZE, {
      onHeaders: (h) => {
        headers = h;
        if (company.compareColumn && existingKeys) {
          const mappedPrincipal =
            mapping?.[company.compareColumn] ?? company.compareColumn;
          pIdx = headers.findIndex(
            (col) =>
              col.toLowerCase() === company.compareColumn!.toLowerCase() ||
              (mapping?.[col] ?? col).toLowerCase() === mappedPrincipal.toLowerCase(),
          );
        }
      },
      onBatch: async (batch) => {
        if (!headers.length) return;
        let toInsert = batch;
        if (existingKeys && pIdx >= 0) {
          toInsert = batch.filter((row) => {
            const key = normalizeCell(row[pIdx] ?? "");
            if (!key || existingKeys!.has(key)) return false;
            existingKeys!.add(key);
            return true;
          });
        }
        if (toInsert.length === 0) return;
        const mapped = mapRows(headers, toInsert, mapping);
        const res = await insertRows(
          dbSettings,
          company.targetTable!,
          mapped.headers,
          mapped.rows,
          syncMode === "snapshot" || existingKeys ? null : company.primaryKeyColumn,
        );
        inserted += res.insertedCount;
      },
    });

    const status = inserted === 0 && existingKeys ? "no_new_items" : "sent";
    await prisma.spreadsheet.update({
      where: { id: spreadsheet.id },
      data: {
        status,
        totalRows: result.totalRows,
        processedRows: result.totalRows,
        newRows: inserted,
        sentAt: status === "sent" ? new Date() : null,
        sentBy: status === "sent" ? params.userEmail ?? null : null,
        processMessage:
          status === "no_new_items"
            ? "Nenhum item novo"
            : `Enviado: ${inserted} de ${result.totalRows} linhas`,
      },
    });

    return { insertedCount: inserted, totalRows: result.totalRows, completed: true };
  } catch (error) {
    await prisma.spreadsheet
      .update({
        where: { id: spreadsheet.id },
        data: {
          status: "error",
          processMessage: error instanceof Error ? error.message : "Erro no envio",
        },
      })
      .catch(() => undefined);
    throw error;
  } finally {
    await safeUnlink(tmpPath);
  }
}
