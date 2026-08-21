// backend/src/services/chunkedImportService.ts — Processamento em lotes (anti-OOM)

import type { drive_v3 } from "googleapis";
import type { Company } from "../../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { parseOptionsFromCompany, parseWorkbookBuffer } from "./sheetParseService.js";
import {
  clearTableRows,
  fetchDistinctColumnValues,
  getAppDbSettings,
  insertRows,
} from "./externalDbService.js";
import { normalizeCell } from "../utils/hash.js";

const BATCH_SIZE = 400;
/** Acima disso não guarda rawData completo no Neon (estoura RAM/DB). */
const MAX_RAWDATA_ROWS = 4000;

type EmitFn = (event: string, payload: unknown) => void;

async function downloadFileBuffer(
  drive: drive_v3.Drive,
  file: drive_v3.Schema$File,
): Promise<Buffer> {
  const mime = file.mimeType ?? "";
  if (mime === "application/vnd.google-apps.spreadsheet") {
    const res = await drive.files.export(
      {
        fileId: file.id!,
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
      { responseType: "arraybuffer" },
    );
    return Buffer.from(res.data as ArrayBuffer);
  }
  const res = await drive.files.get(
    { fileId: file.id!, alt: "media" },
    { responseType: "arraybuffer" },
  );
  return Buffer.from(res.data as ArrayBuffer);
}

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
 * Job em background: planilha já criada com status=processing.
 * Processa INSERT em lotes e atualiza progresso na UI.
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

  try {
    await setProgress(spreadsheetId, {
      processMessage: "Baixando arquivo do Drive...",
    });

    const buffer = await downloadFileBuffer(drive, file);
    await setProgress(spreadsheetId, {
      processMessage: "Lendo planilha...",
    });

    const parsed = parseWorkbookBuffer(buffer, parseOptionsFromCompany(company));
    const totalRows = parsed.rows.length;
    const headers = parsed.headers;
    const mapping = company.columnMapping as Record<string, string> | null;
    const syncMode = company.syncMode || "incremental";

    const storeRaw =
      totalRows <= MAX_RAWDATA_ROWS
        ? JSON.stringify(parsed)
        : JSON.stringify({
            headers,
            rows: [],
            truncated: true,
            note: `Arquivo grande (${totalRows} linhas): preview completo omitido para economizar memória.`,
          });

    await setProgress(spreadsheetId, {
      totalRows,
      processedRows: 0,
      rawData: storeRaw,
      processMessage: `0 / ${totalRows} linhas`,
    });

    if (!company.targetTable) {
      await setProgress(spreadsheetId, {
        status: "pending",
        newRows: totalRows,
        processedRows: totalRows,
        processMessage: "Sem tabela destino — configure e envie manualmente",
      });
      return;
    }

    const dbSettings = await getAppDbSettings();
    if (!dbSettings) {
      throw new Error("Banco de destino não configurado");
    }

    let inserted = 0;

    // SNAPSHOT
    if (syncMode === "snapshot") {
      await setProgress(spreadsheetId, { processMessage: "Limpando tabela destino..." });
      await clearTableRows(dbSettings, company.targetTable);

      for (let i = 0; i < totalRows; i += BATCH_SIZE) {
        const chunk = parsed.rows.slice(i, i + BATCH_SIZE);
        const mapped = mapRows(headers, chunk, mapping);
        const res = await insertRows(
          dbSettings,
          company.targetTable,
          mapped.headers,
          mapped.rows,
          null,
        );
        inserted += res.insertedCount;
        const done = Math.min(i + chunk.length, totalRows);
        await setProgress(spreadsheetId, {
          processedRows: done,
          newRows: inserted,
          processMessage: `${done} / ${totalRows} inseridas`,
        });
      }

      await setProgress(spreadsheetId, {
        status: "sent",
        processedRows: totalRows,
        newRows: inserted,
        sentAt: new Date(),
        sentBy: "sistema-lote",
        processMessage: `Snapshot concluído: ${inserted} linhas`,
      });

      emit?.("spreadsheet_auto_processed", {
        companyId: company.id,
        companyName,
        fileName,
        spreadsheetId,
        status: "sent",
        message: `Snapshot: ${inserted} linhas`,
      });
      return;
    }

    // PRINCIPAL ONLY (ou incremental grande com coluna principal)
    const usePrincipalGate =
      (syncMode === "principal_only" || totalRows > MAX_RAWDATA_ROWS) &&
      Boolean(company.compareColumn);

    if (usePrincipalGate && company.compareColumn) {
      const mappedPrincipal =
        mapping?.[company.compareColumn] ?? company.compareColumn;
      const existingKeys = await fetchDistinctColumnValues(
        dbSettings,
        company.targetTable,
        mappedPrincipal,
      );
      const pIdx = headers.findIndex(
        (h) =>
          h.toLowerCase() === company.compareColumn!.toLowerCase() ||
          (mapping?.[h] ?? h).toLowerCase() === mappedPrincipal.toLowerCase(),
      );

      for (let i = 0; i < totalRows; i += BATCH_SIZE) {
        const chunk = parsed.rows.slice(i, i + BATCH_SIZE);
        const toInsert =
          pIdx >= 0
            ? chunk.filter((row) => {
                const key = normalizeCell(row[pIdx] ?? "");
                if (!key || existingKeys.has(key)) return false;
                existingKeys.add(key);
                return true;
              })
            : chunk;

        if (toInsert.length > 0) {
          const mapped = mapRows(headers, toInsert, mapping);
          const res = await insertRows(
            dbSettings,
            company.targetTable,
            mapped.headers,
            mapped.rows,
            null,
          );
          inserted += res.insertedCount;
        }
        const done = Math.min(i + chunk.length, totalRows);
        await setProgress(spreadsheetId, {
          processedRows: done,
          newRows: inserted,
          processMessage: `${done} / ${totalRows} (novas: ${inserted})`,
        });
      }

      await setProgress(spreadsheetId, {
        status: inserted === 0 ? "no_new_items" : "sent",
        processedRows: totalRows,
        newRows: inserted,
        sentAt: inserted > 0 ? new Date() : null,
        sentBy: inserted > 0 ? "sistema-lote" : null,
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

    // Arquivo grande sem coluna principal: insert em lotes (upsert se tiver PK)
    if (totalRows > MAX_RAWDATA_ROWS || company.autoSend) {
      for (let i = 0; i < totalRows; i += BATCH_SIZE) {
        const chunk = parsed.rows.slice(i, i + BATCH_SIZE);
        const mapped = mapRows(headers, chunk, mapping);
        const res = await insertRows(
          dbSettings,
          company.targetTable,
          mapped.headers,
          mapped.rows,
          company.primaryKeyColumn,
        );
        inserted += res.insertedCount;
        const done = Math.min(i + chunk.length, totalRows);
        await setProgress(spreadsheetId, {
          processedRows: done,
          newRows: inserted,
          processMessage: `${done} / ${totalRows} (inseridas: ${inserted})`,
        });
      }

      await setProgress(spreadsheetId, {
        status: "sent",
        processedRows: totalRows,
        newRows: inserted,
        sentAt: new Date(),
        sentBy: "sistema-lote",
        processMessage: `Concluído em lotes: ${inserted} inserções`,
      });

      emit?.("spreadsheet_auto_processed", {
        companyId: company.id,
        companyName,
        fileName,
        spreadsheetId,
        status: "sent",
        message: `${inserted} linhas em lotes`,
      });
      return;
    }

    // Arquivo pequeno: deixa pending (diff manual) ou auto clássico
    await setProgress(spreadsheetId, {
      status: "pending",
      processedRows: totalRows,
      newRows: totalRows,
      processMessage: "Pronto para análise",
    });

    if (company.autoSend) {
      const { processAutoSend } = await import("../controllers/spreadsheetsController.js");
      await processAutoSend({
        spreadsheetId,
        companyId: company.id,
        companyName,
        fileName,
        emit,
      });
    }
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
  }
}
