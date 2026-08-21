// backend/src/controllers/spreadsheetsController.ts — Diff, aprovação e envio

import type { Request, Response } from "express";
import { prisma } from "../lib/prisma.js";
import { paramId } from "../utils/params.js";
import {
  computeDiffForSpreadsheet,
  getMustSendRows,
  getMustSendRowsByIndices,
  getMustUpdateRows,
  parseRawData,
} from "../services/diffService.js";
import {
  clearTableRows,
  getAppDbSettings,
  insertRows,
  countTableRows,
  listColumns,
  normalizeCellForInsert,
  updateRowsByPrincipal,
} from "../services/externalDbService.js";
import { normalizeCell } from "../utils/hash.js";

export type SendReport = {
  spreadsheetRows: number;
  insertedCount: number;
  updatedCount: number;
  mustSendRemaining: number;
  mustUpdateRemaining: number;
  alreadyInDb: number;
  skippedColumns: string[];
  dbTableRowCount: number | null;
  completed: boolean;
};

async function loadSpreadsheetContext(id: string) {
  const spreadsheet = await prisma.spreadsheet.findUnique({
    where: { id },
    include: { company: true },
  });
  if (!spreadsheet) return null;

  const current = parseRawData(spreadsheet.rawData);
  let previous = null;

  if (spreadsheet.previousSpreadsheetId) {
    const prev = await prisma.spreadsheet.findUnique({
      where: { id: spreadsheet.previousSpreadsheetId },
    });
    if (prev) previous = parseRawData(prev.rawData);
  } else {
    const prev = await prisma.spreadsheet.findFirst({
      where: {
        companyId: spreadsheet.companyId,
        detectedAt: { lt: spreadsheet.detectedAt },
      },
      orderBy: { detectedAt: "desc" },
    });
    if (prev) previous = parseRawData(prev.rawData);
  }

  const diff = await computeDiffForSpreadsheet(current, previous, spreadsheet.company);
  return { spreadsheet, current, diff };
}

/** Marca como enviada quando não há mais linhas pendentes (diff ou envio em lote). */
export async function syncSpreadsheetStatusIfFullySent(
  spreadsheetId: string,
  userEmail?: string,
): Promise<boolean> {
  const spreadsheet = await prisma.spreadsheet.findUnique({
    where: { id: spreadsheetId },
    select: { id: true, status: true, sentAt: true },
  });
  if (
    !spreadsheet ||
    spreadsheet.status === "sent" ||
    spreadsheet.status === "error" ||
    spreadsheet.status === "no_new_items"
  ) {
    return false;
  }

  const ctx = await loadSpreadsheetContext(spreadsheetId);
  if (!ctx || ctx.diff.summary.mustSend > 0 || ctx.diff.summary.mustUpdate > 0) return false;

  await prisma.spreadsheet.update({
    where: { id: spreadsheetId },
    data: {
      status: "sent",
      sentAt: spreadsheet.sentAt ?? new Date(),
      sentBy: userEmail,
    },
  });
  return true;
}

function mapHeadersForDb(
  headers: string[],
  mapping: Record<string, string> | null | undefined,
): string[] {
  if (!mapping) return headers;
  return headers.map((h) => mapping[h] ?? h).filter((h, i, arr) => {
    const sourceHeader = headers[i];
    return mapping[sourceHeader] !== undefined || !Object.values(mapping).includes(h);
  });
}

function mapRowsForDb(
  headers: string[],
  rows: string[][],
  mapping: Record<string, string> | null | undefined,
): { headers: string[]; rows: string[][] } {
  if (!mapping) return { headers, rows };

  const mappedHeaders: string[] = [];
  const indices: number[] = [];
  const usedTargets = new Set<string>();

  headers.forEach((h, i) => {
    const target = mapping[h];
    if (!target) return;
    const key = target.toLowerCase().trim();
    if (usedTargets.has(key)) return; // evita destino duplicado (ex.: Nome 2x)
    usedTargets.add(key);
    mappedHeaders.push(target);
    indices.push(i);
  });

  if (mappedHeaders.length === 0) return { headers, rows };

  const mappedRows = rows.map((row) => indices.map((i) => row[i] ?? ""));
  return { headers: mappedHeaders, rows: mappedRows };
}

export async function getDiff(req: Request, res: Response): Promise<void> {
  try {
    const id = paramId(req.params.id);
    const ctx = await loadSpreadsheetContext(id);
    if (!ctx) {
      res.status(404).json({ success: false, error: "Planilha não encontrada" });
      return;
    }
    let truncated = false;
    let note: string | undefined;
    let staging = false;
    try {
      const raw = JSON.parse(ctx.spreadsheet.rawData) as {
        truncated?: boolean;
        note?: string;
        staging?: boolean;
      };
      truncated = Boolean(raw.truncated);
      note = raw.note;
      staging = Boolean(raw.staging);
    } catch {
      /* ignore */
    }
    res.json({
      success: true,
      ...ctx.diff,
      truncated,
      note,
      staging,
      processMessage: ctx.spreadsheet.processMessage,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro ao calcular diff";
    res.status(500).json({ success: false, error: message });
  }
}

export async function approveSpreadsheet(req: Request, res: Response): Promise<void> {
  try {
    const id = paramId(req.params.id);
    const spreadsheet = await prisma.spreadsheet.update({
      where: { id },
      data: {
        status: "approved",
        approvedBy: req.user?.email,
      },
    });
    res.json({ success: true, spreadsheet });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro ao aprovar";
    res.status(500).json({ success: false, error: message });
  }
}

export async function sendRows(
  spreadsheetId: string,
  rowsToSend: string[][],
  userEmail?: string,
  options?: { applyUpdates?: boolean; isSnapshot?: boolean },
): Promise<{
  insertedCount: number;
  updatedCount: number;
  rows: string[][];
  completed: boolean;
  report: SendReport;
}> {
  const ctx = await loadSpreadsheetContext(spreadsheetId);
  if (!ctx) throw new Error("Planilha não encontrada");

  const { spreadsheet, current, diff } = ctx;
  const company = spreadsheet.company;
  const applyUpdates = options?.applyUpdates !== false;
  const syncMode = company.syncMode || "incremental";

  if (!company.targetTable) {
    throw new Error("Tabela destino não configurada para esta empresa");
  }

  const dbSettings = await getAppDbSettings();
  if (!dbSettings) {
    throw new Error("Banco de destino não configurado");
  }

  const mapping = company.columnMapping as Record<string, string> | null;

  if (syncMode === "snapshot" || options?.isSnapshot) {
    await clearTableRows(dbSettings, company.targetTable);
    const { headers, rows } = mapRowsForDb(current.headers, current.rows, mapping);
    const { insertedCount, skippedColumns: insertSkipped } = await insertRows(
      dbSettings,
      company.targetTable,
      headers,
      rows,
      null,
    );
    await prisma.spreadsheet.update({
      where: { id: spreadsheetId },
      data: { status: "sent", sentAt: new Date(), sentBy: userEmail, newRows: insertedCount, updatedRows: 0 },
    });
    const dbTableRowCount = await countTableRows(dbSettings, company.targetTable);
    return {
      insertedCount,
      updatedCount: 0,
      rows: current.rows,
      completed: true,
      report: {
        spreadsheetRows: current.rows.length,
        insertedCount,
        updatedCount: 0,
        mustSendRemaining: 0,
        mustUpdateRemaining: 0,
        alreadyInDb: 0,
        skippedColumns: [...new Set([...insertSkipped, ...diff.skippedColumns])],
        dbTableRowCount,
        completed: true,
      },
    };
  }

  const pendingRows = getMustSendRows(diff);
  const pendingKey = (row: string[]) => JSON.stringify(row);
  const pendingSet = new Set(pendingRows.map(pendingKey));
  const safeRows = rowsToSend.filter((row) => pendingSet.has(pendingKey(row)));

  let insertedCount = 0;
  let insertSkipped: string[] = [];

  if (safeRows.length > 0) {
    const { headers, rows } = mapRowsForDb(current.headers, safeRows, mapping);
    const result = await insertRows(
      dbSettings,
      company.targetTable,
      headers,
      rows,
      company.primaryKeyColumn,
    );
    insertedCount = result.insertedCount;
    insertSkipped = result.skippedColumns;
  }

  let updatedCount = 0;
  if (applyUpdates && syncMode === "incremental_update" && company.compareColumn) {
    const updateRows = getMustUpdateRows(diff);
    const tableColumns = await listColumns(dbSettings, company.targetTable);
    const columnByLower = new Map(tableColumns.map((c) => [c.column_name.toLowerCase(), c]));

    const mappedPrincipal =
      (mapping && mapping[company.compareColumn]) || company.compareColumn;
    const principalHeader = current.headers.find(
      (h) =>
        h.toLowerCase() === company.compareColumn!.toLowerCase() ||
        (mapping?.[h] ?? h).toLowerCase() === mappedPrincipal.toLowerCase(),
    );

    // Uma atualização por valor de chave principal (cascata)
    const doneKeys = new Set<string>();
    for (const row of updateRows) {
      if (!principalHeader || row.changes.length === 0) continue;
      const pIdx = current.headers.findIndex((h) => h === principalHeader);
      const pVal = normalizeCell(row.data[pIdx] ?? "");
      if (!pVal || doneKeys.has(pVal)) continue;
      doneKeys.add(pVal);

      const setColumns: string[] = [];
      const setValues: unknown[] = [];
      for (const ch of row.changes) {
        const sheetCol = ch.column;
        const dbColName =
          mapping?.[sheetCol] ??
          columnByLower.get(sheetCol.toLowerCase())?.column_name ??
          sheetCol;
        const colInfo = columnByLower.get(dbColName.toLowerCase());
        if (!colInfo) continue;
        if (colInfo.column_name.toLowerCase() === mappedPrincipal.toLowerCase()) continue;
        setColumns.push(colInfo.column_name);
        setValues.push(normalizeCellForInsert(ch.to, colInfo));
      }
      if (setColumns.length === 0) continue;
      updatedCount += await updateRowsByPrincipal(
        dbSettings,
        company.targetTable,
        columnByLower.get(mappedPrincipal.toLowerCase())?.column_name ?? mappedPrincipal,
        pVal,
        setColumns,
        setValues,
      );
    }
  }

  const afterCtx = await loadSpreadsheetContext(spreadsheetId);
  if (!afterCtx) throw new Error("Erro ao verificar status da planilha");

  const remainingSend = afterCtx.diff.summary.mustSend;
  const remainingUpdate = afterCtx.diff.summary.mustUpdate;
  const completed = remainingSend === 0 && remainingUpdate === 0;

  if (completed) {
    await prisma.spreadsheet.update({
      where: { id: spreadsheetId },
      data: {
        status: "sent",
        sentAt: new Date(),
        sentBy: userEmail,
      },
    });
  }

  const dbTableRowCount = await countTableRows(dbSettings, company.targetTable);
  const skippedColumns = [
    ...new Set([...insertSkipped, ...afterCtx.diff.skippedColumns]),
  ];

  const report: SendReport = {
    spreadsheetRows: current.rows.length,
    insertedCount,
    updatedCount,
    mustSendRemaining: remainingSend,
    mustUpdateRemaining: remainingUpdate,
    alreadyInDb: afterCtx.diff.summary.alreadyInDb,
    skippedColumns,
    dbTableRowCount,
    completed,
  };

  return { insertedCount, updatedCount, rows: safeRows, completed, report };
}

export async function sendSpreadsheet(req: Request, res: Response): Promise<void> {
  try {
    const id = paramId(req.params.id);
    const ctx = await loadSpreadsheetContext(id);
    if (!ctx) {
      res.status(404).json({ success: false, error: "Planilha não encontrada" });
      return;
    }

    let truncated = false;
    let staging = false;
    try {
      const raw = JSON.parse(ctx.spreadsheet.rawData) as {
        truncated?: boolean;
        staging?: boolean;
      };
      truncated = Boolean(raw.truncated);
      staging = Boolean(raw.staging);
    } catch {
      /* ignore */
    }

    // Staging ou preview truncado: envio completo sob demanda (após validação)
    if (
      truncated ||
      staging ||
      ctx.spreadsheet.totalRows > 4000 ||
      ctx.spreadsheet.company.useStagingTable
    ) {
      const { streamSendFromDrive } = await import("../services/streamSendService.js");
      const result = await streamSendFromDrive({
        spreadsheetId: id,
        userEmail: req.user?.email,
      });
      res.json({
        success: true,
        insertedCount: result.insertedCount,
        updatedCount: 0,
        completed: true,
        report: {
          spreadsheetRows: result.totalRows,
          insertedCount: result.insertedCount,
          updatedCount: 0,
          mustSendRemaining: 0,
          mustUpdateRemaining: 0,
          alreadyInDb: 0,
          skippedColumns: [],
          dbTableRowCount: null,
          completed: true,
        },
      });
      return;
    }

    const rowsToSend = getMustSendRows(ctx.diff);
    const result = await sendRows(id, rowsToSend, req.user?.email, { applyUpdates: true });
    res.json({ success: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro ao enviar";
    await prisma.spreadsheet.update({
      where: { id: paramId(req.params.id) },
      data: { status: "error" },
    }).catch(() => undefined);
    res.status(500).json({ success: false, error: message });
  }
}

/**
 * Processa envio automático de uma planilha recém-detectada.
 * - 0 novos → status no_new_items
 * - com novos → envia tudo e marca sent
 * - erro → status error + desliga autoSend da empresa
 */
export async function processAutoSend(params: {
  spreadsheetId: string;
  companyId: string;
  companyName: string;
  fileName: string;
  emit?: (event: string, payload: unknown) => void;
}): Promise<"sent" | "no_new_items" | "error" | "skipped"> {
  const { spreadsheetId, companyId, companyName, fileName, emit } = params;

  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company?.autoSend) return "skipped";

  try {
    const ctx = await loadSpreadsheetContext(spreadsheetId);
    if (!ctx) throw new Error("Planilha não encontrada");

    if (ctx.diff.summary.mustSend === 0 && ctx.diff.summary.mustUpdate === 0) {
      await prisma.spreadsheet.update({
        where: { id: spreadsheetId },
        data: { status: "no_new_items", newRows: 0, updatedRows: 0 },
      });
      emit?.("spreadsheet_auto_processed", {
        companyId,
        companyName,
        fileName,
        spreadsheetId,
        status: "no_new_items",
        message: "Nenhum item novo para enviar",
      });
      return "no_new_items";
    }

    const rowsToSend = getMustSendRows(ctx.diff);
    const result = await sendRows(spreadsheetId, rowsToSend, "sistema-automatico", {
      applyUpdates: true,
    });

    if (!result.completed) {
      throw new Error(
        `Envio automático incompleto: restaram ${result.report.mustSendRemaining} nova(s) e ${result.report.mustUpdateRemaining} atualização(ões)`,
      );
    }

    emit?.("spreadsheet_auto_processed", {
      companyId,
      companyName,
      fileName,
      spreadsheetId,
      status: "sent",
      insertedCount: result.insertedCount,
      message: `${result.insertedCount} inserida(s), ${result.updatedCount} atualizada(s)`,
    });
    return "sent";
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro no envio automático";

    await prisma.spreadsheet
      .update({ where: { id: spreadsheetId }, data: { status: "error" } })
      .catch(() => undefined);

    await prisma.company
      .update({ where: { id: companyId }, data: { autoSend: false } })
      .catch(() => undefined);

    emit?.("spreadsheet_auto_processed", {
      companyId,
      companyName,
      fileName,
      spreadsheetId,
      status: "error",
      autoSendDisabled: true,
      message,
    });
    return "error";
  }
}

export async function sendTestSpreadsheet(req: Request, res: Response): Promise<void> {
  try {
    const { mode, rowIndex, selectedRows } = req.body as {
      mode?: "single" | "pick";
      rowIndex?: number;
      selectedRows?: number[];
    };

    const id = paramId(req.params.id);
    const ctx = await loadSpreadsheetContext(id);
    if (!ctx) {
      res.status(404).json({ success: false, error: "Planilha não encontrada" });
      return;
    }

    let rowsToSend: string[][] = [];
    if (mode === "single") {
      rowsToSend = getMustSendRowsByIndices(ctx.diff, [0]);
    } else if (mode === "pick" && selectedRows?.length) {
      rowsToSend = getMustSendRowsByIndices(ctx.diff, selectedRows);
    } else {
      res.status(400).json({ success: false, error: "Selecione ao menos uma linha para enviar" });
      return;
    }

    if (rowsToSend.length === 0) {
      res.status(400).json({ success: false, error: "Nenhuma linha válida selecionada para envio" });
      return;
    }

    const result = await sendRows(id, rowsToSend, req.user?.email);
    res.json({ success: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro no envio teste";
    res.status(500).json({ success: false, error: message });
  }
}

/** Dispara o worker isolado sob demanda (poll só detecta e deixa queued). */
export async function processSpreadsheet(req: Request, res: Response): Promise<void> {
  try {
    const id = paramId(req.params.id);
    const sheet = await prisma.spreadsheet.findUnique({ where: { id } });
    if (!sheet) {
      res.status(404).json({ success: false, error: "Planilha não encontrada" });
      return;
    }
    if (sheet.status === "processing") {
      res.json({ success: true, message: "Já está processando" });
      return;
    }
    if (sheet.status === "sent") {
      res.status(400).json({ success: false, error: "Planilha já enviada" });
      return;
    }

    await prisma.spreadsheet.update({
      where: { id },
      data: {
        status: "processing",
        processMessage: "Na fila do worker...",
      },
    });

    const { enqueueImportJob } = await import("../services/importJobRunner.js");
    enqueueImportJob(id);

    res.json({ success: true, message: "Processamento enfileirado no worker" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro ao processar";
    res.status(500).json({ success: false, error: message });
  }
}
