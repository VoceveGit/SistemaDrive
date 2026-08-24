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
import { mapRowsWithColumnMapping } from "../utils/columnMapping.js";
import { companyUsesCodedSolution } from "../solucoesAvinor/index.js";
import { getDriveClientForImport } from "../services/googleDriveService.js";

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
  return mapRowsWithColumnMapping(headers, [], mapping).headers;
}

function mapRowsForDb(
  headers: string[],
  rows: string[][],
  mapping: Record<string, string> | null | undefined,
): { headers: string[]; rows: string[][] } {
  return mapRowsWithColumnMapping(headers, rows, mapping);
}

export async function getDiff(req: Request, res: Response): Promise<void> {
  try {
    const id = paramId(req.params.id);
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 300));

    const spreadsheet = await prisma.spreadsheet.findUnique({
      where: { id },
      include: { company: true },
    });
    if (!spreadsheet) {
      res.status(404).json({ success: false, error: "Planilha não encontrada" });
      return;
    }

    // Solução codada — snapshot (clientes): só resumo
    try {
      const rawSnap = JSON.parse(spreadsheet.rawData) as {
        codedSolution?: boolean;
        snapshot?: {
          mode: string;
          previousRowCount: number;
          insertedRowCount: number;
          finalRowCount: number;
          targetTable: string;
          note: string;
          codedSolutionId: string;
        };
        codedSummary?: {
          mode: string;
          codedSolutionId: string;
          targetTable: string;
          note: string;
          validRows: number;
          linesRead?: number;
          ignoredRows?: number;
          rowsToInsert?: number;
          pedidosInFile?: number;
          pedidosChanged?: number;
          pedidosUnchanged?: number;
          numerosNovos?: number;
          numerosExistentes?: number;
          ignoredTotal?: number;
          ignoredResumo?: number;
          ignoredNoNumero?: number;
          monthFrom?: string;
          monthToExclusive?: string;
          dateMin?: string;
          dateMax?: string;
          sampleDates?: string[];
        };
        note?: string;
        headers?: string[];
        rows?: string[][];
        truncated?: boolean;
      };
      if (rawSnap.codedSolution && rawSnap.snapshot) {
        const s = rawSnap.snapshot;
        res.json({
          success: true,
          headers: rawSnap.headers ?? [],
          rows: [],
          summary: {
            totalRows: s.insertedRowCount,
            newRows: s.insertedRowCount,
            previousRows: s.previousRowCount,
            alreadyInDb: 0,
            mustSend: 0,
            mustUpdate: 0,
            jobTotalRows: s.insertedRowCount,
          },
          dbWindowDays: 0,
          dateColumnUsed: null,
          compareColumnUsed: null,
          dbCompareLimit: null,
          dbCompareMode: "snapshot",
          dbCheckSkipped: false,
          skippedColumns: [],
          dbRowsLoaded: s.previousRowCount,
          syncMode: "snapshot",
          truncated: false,
          note: s.note,
          staging: false,
          codedSolution: true,
          snapshot: s,
          processMessage: spreadsheet.processMessage,
          pagination: {
            offset: 0,
            limit: 0,
            loaded: 0,
            total: s.insertedRowCount,
            hasMore: false,
            nextOffset: null,
          },
        });
        return;
      }

      // Solução codada — resumo leve (sem tabela / sem Neon pesado)
      if (rawSnap.codedSolution && rawSnap.codedSummary) {
        const s = rawSnap.codedSummary;
        const mustSend =
          s.mode === "faturamento"
            ? (s.numerosNovos ?? 0)
            : (s.rowsToInsert ?? 0);
        const totalRows = spreadsheet.totalRows || s.validRows;

        res.json({
          success: true,
          headers: [],
          rows: [],
          summary: {
            totalRows: 0,
            newRows: mustSend,
            previousRows: 0,
            alreadyInDb:
              s.mode === "faturamento" ? (s.numerosExistentes ?? 0) : 0,
            mustSend,
            mustUpdate: 0,
            jobTotalRows: totalRows,
          },
          dbWindowDays: 0,
          dateColumnUsed: null,
          compareColumnUsed: null,
          dbCompareLimit: null,
          dbCompareMode: "skipped",
          dbCheckSkipped: true,
          skippedColumns: [],
          dbRowsLoaded: 0,
          syncMode: s.mode,
          truncated: true,
          note: rawSnap.note ?? s.note,
          staging: false,
          codedSolution: true,
          codedSummary: s,
          processMessage: spreadsheet.processMessage,
          pagination: {
            offset: 0,
            limit: 0,
            loaded: 0,
            total: totalRows,
            hasMore: false,
            nextOffset: null,
          },
        });
        return;
      }
    } catch {
      /* segue fluxo normal */
    }

    let truncated = false;
    let note: string | undefined;
    let staging = false;
    let headers: string[] = [];
    let storedRows: string[][] = [];
    try {
      const raw = JSON.parse(spreadsheet.rawData) as {
        headers?: string[];
        rows?: string[][];
        truncated?: boolean;
        note?: string;
        staging?: boolean;
      };
      truncated = Boolean(raw.truncated);
      note = raw.note;
      staging = Boolean(raw.staging);
      headers = Array.isArray(raw.headers) ? raw.headers : [];
      storedRows = Array.isArray(raw.rows) ? raw.rows : [];
    } catch {
      /* ignore */
    }

    let pageRows: string[][] = [];
    let totalRows = spreadsheet.totalRows || storedRows.length;
    let hasMore = false;

    if (staging || spreadsheet.company.useStagingTable) {
      const dbSettings = await getAppDbSettings();
      if (!dbSettings) {
        res.status(500).json({ success: false, error: "Banco de destino não configurado" });
        return;
      }
      const { fetchStagingPage, countStagingRows } = await import(
        "../services/stagingService.js"
      );
      const stagedCount = await countStagingRows(dbSettings, id);
      if (stagedCount > 0) totalRows = stagedCount;
      pageRows = await fetchStagingPage(dbSettings, id, offset, limit);
      hasMore = offset + pageRows.length < totalRows;
      truncated = hasMore || totalRows > pageRows.length;
      note =
        note ??
        `Lote ${offset + 1}–${offset + pageRows.length} de ${totalRows} (staging).`;
    } else {
      pageRows = storedRows.slice(offset, offset + limit);
      totalRows = spreadsheet.totalRows || storedRows.length;
      hasMore = offset + pageRows.length < Math.min(totalRows, storedRows.length);
      // Sem staging, só o que está no Neon (até MAX_STORE_ROWS)
      if (offset + limit >= storedRows.length && totalRows > storedRows.length) {
        hasMore = false;
        truncated = true;
        note =
          note ??
          `Preview limitado a ${storedRows.length} de ${totalRows} linhas. Ative "Usar tabela job" para ver tudo.`;
      }
    }

    let previous = null;
    if (spreadsheet.previousSpreadsheetId) {
      const prev = await prisma.spreadsheet.findUnique({
        where: { id: spreadsheet.previousSpreadsheetId },
      });
      if (prev) previous = parseRawData(prev.rawData);
    }

    const current = { headers, rows: pageRows };
    const diff = await computeDiffForSpreadsheet(current, previous, spreadsheet.company);

    res.json({
      success: true,
      ...diff,
      // summary desta página; o front soma ao carregar em cadeia
      summary: {
        ...diff.summary,
        totalRows: pageRows.length,
        jobTotalRows: totalRows,
      },
      truncated,
      note,
      staging,
      processMessage: spreadsheet.processMessage,
      pagination: {
        offset,
        limit,
        loaded: pageRows.length,
        total: totalRows,
        hasMore,
        nextOffset: hasMore ? offset + pageRows.length : null,
      },
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
  options?: {
    applyUpdates?: boolean;
    isSnapshot?: boolean;
    /** Linhas vindas da UI (paginação/staging) — não filtrar pelo preview do Neon. */
    trustProvidedRows?: boolean;
  },
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
  const trustProvidedRows = Boolean(options?.trustProvidedRows);

  let stagingMeta = false;
  try {
    stagingMeta = Boolean(
      (JSON.parse(spreadsheet.rawData) as { staging?: boolean }).staging,
    );
  } catch {
    /* ignore */
  }
  const usesStaging = stagingMeta || Boolean(company.useStagingTable);

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
      data: {
        status: "sent",
        sentAt: new Date(),
        sentBy: userEmail,
        newRows: insertedCount,
        updatedRows: 0,
      },
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

  // Preview no Neon só tem ~300 linhas. Envio 1/selecionados da UI traz a linha real —
  // NÃO filtrar pelo diff do preview (senão safeRows fica vazio e o MySQL não recebe nada).
  let safeRows: string[][];
  if (trustProvidedRows) {
    safeRows = rowsToSend.filter((r) => Array.isArray(r) && r.length > 0);
  } else {
    const pendingRows = getMustSendRows(diff);
    const pendingKey = (row: string[]) => JSON.stringify(row);
    const pendingSet = new Set(pendingRows.map(pendingKey));
    safeRows = rowsToSend.filter((row) => pendingSet.has(pendingKey(row)));
  }

  if (safeRows.length === 0) {
    throw new Error(
      "Nenhuma linha válida para inserir. Recarregue o comparativo e tente de novo.",
    );
  }

  let insertedCount = 0;
  let insertSkipped: string[] = [];

  const { headers, rows } = mapRowsForDb(current.headers, safeRows, mapping);
  console.log(
    `[send] ${spreadsheetId} inserindo ${rows.length} linha(s) em ${company.targetTable} (trust=${trustProvidedRows})`,
  );
  const result = await insertRows(
    dbSettings,
    company.targetTable,
    headers,
    rows,
    company.primaryKeyColumn,
  );
  insertedCount = result.insertedCount;
  insertSkipped = result.skippedColumns;
  console.log(`[send] ${spreadsheetId} insert OK: ${insertedCount} linha(s)`);

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

  // Com staging/preview truncado, o diff do Neon NÃO representa o job inteiro.
  // Envio parcial nunca deve marcar a planilha como "sent" / completed.
  let completed = false;
  let mustSendRemaining = 0;
  let mustUpdateRemaining = 0;
  let alreadyInDb = 0;

  if (usesStaging || trustProvidedRows) {
    completed = false;
    mustSendRemaining = Math.max(0, (spreadsheet.totalRows || 0) - insertedCount);
    console.log(
      `[send] ${spreadsheetId} parcial: inserted=${insertedCount} (não marca sent — job staging/parcial)`,
    );
  } else {
    const afterCtx = await loadSpreadsheetContext(spreadsheetId);
    if (!afterCtx) throw new Error("Erro ao verificar status da planilha");
    mustSendRemaining = afterCtx.diff.summary.mustSend;
    mustUpdateRemaining = afterCtx.diff.summary.mustUpdate ?? 0;
    alreadyInDb = afterCtx.diff.summary.alreadyInDb;
    completed = mustSendRemaining === 0 && mustUpdateRemaining === 0;

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
  }

  const dbTableRowCount = await countTableRows(dbSettings, company.targetTable);
  const skippedColumns = [...new Set([...insertSkipped, ...diff.skippedColumns])];

  const report: SendReport = {
    spreadsheetRows: usesStaging ? spreadsheet.totalRows : current.rows.length,
    insertedCount,
    updatedCount,
    mustSendRemaining,
    mustUpdateRemaining,
    alreadyInDb,
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

    // Solução codada com preview (pedidos / faturamento): Enviar usa staging + resumo Neon
    const coded = companyUsesCodedSolution(ctx.spreadsheet.company);
    if (coded?.runCommit && !coded.autoCommitOnImport) {
      let rawCoded: { codedSolution?: boolean; codedSummary?: unknown } = {};
      try {
        rawCoded = JSON.parse(ctx.spreadsheet.rawData) as typeof rawCoded;
      } catch {
        /* ignore */
      }
      if (rawCoded.codedSolution) {
        const dbSettings = await getAppDbSettings();
        if (!dbSettings) {
          res.status(500).json({ success: false, error: "Banco de destino não configurado" });
          return;
        }
        const drive = await getDriveClientForImport();
        if (!drive) {
          res.status(500).json({ success: false, error: "Google Drive não conectado" });
          return;
        }
        const commit = await coded.runCommit({
          spreadsheetId: id,
          company: ctx.spreadsheet.company,
          drive,
          file: {
            id: ctx.spreadsheet.googleFileId,
            name: ctx.spreadsheet.fileName,
          },
          dbSettings,
          previousSummary: rawCoded.codedSummary as
            | import("../solucoesAvinor/types.js").CodedImportSummary
            | undefined,
        });
        const s = commit.summary;
        await prisma.spreadsheet.update({
          where: { id },
          data: {
            status: "sent",
            sentAt: new Date(),
            sentBy: req.user?.email,
            processMessage: s.note,
            rawData: JSON.stringify({
              ...rawCoded,
              codedSummary: s,
              note: s.note,
            }),
          },
        });
        const dbTableRowCount = await countTableRows(
          dbSettings,
          ctx.spreadsheet.company.targetTable ?? s.targetTable,
        );
        res.json({
          success: true,
          insertedCount: s.insertedRowCount,
          updatedCount: 0,
          completed: true,
          report: {
            spreadsheetRows: s.validRows,
            insertedCount: s.insertedRowCount,
            updatedCount: 0,
            mustSendRemaining: 0,
            mustUpdateRemaining: 0,
            alreadyInDb:
              s.mode === "faturamento" ? s.numerosExistentes : s.pedidosUnchanged,
            skippedColumns: [],
            dbTableRowCount,
            completed: true,
          },
        });
        return;
      }
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
    const { mode, selectedRows, selectedData } = req.body as {
      mode?: "single" | "pick";
      selectedRows?: number[];
      /** Linhas já resolvidas no front (obrigatório após preview paginado). */
      selectedData?: string[][];
    };

    const id = paramId(req.params.id);
    const ctx = await loadSpreadsheetContext(id);
    if (!ctx) {
      res.status(404).json({ success: false, error: "Planilha não encontrada" });
      return;
    }

    let rowsToSend: string[][] = [];

    // Preferência: dados enviados pelo front (linha PRÓXIMO/NOVO da tela)
    if (Array.isArray(selectedData) && selectedData.length > 0) {
      rowsToSend = selectedData.filter((r) => Array.isArray(r) && r.length > 0);
    } else if (mode === "single") {
      rowsToSend = getMustSendRowsByIndices(ctx.diff, [0]);
      if (rowsToSend.length === 0) {
        rowsToSend = await findFirstMustSendFromStaging(id, ctx);
      }
    } else if (mode === "pick" && selectedRows?.length) {
      rowsToSend = getMustSendRowsByIndices(ctx.diff, selectedRows);
    } else {
      res.status(400).json({
        success: false,
        error: "Selecione ao menos uma linha NOVA (checkbox) para enviar",
      });
      return;
    }

    if (rowsToSend.length === 0) {
      res.status(400).json({
        success: false,
        error:
          "Nenhuma linha NOVA encontrada para envio. Confira o comparativo (status PRÓXIMO/NOVO).",
      });
      return;
    }

    const result = await sendRows(id, rowsToSend, req.user?.email, {
      trustProvidedRows: true,
    });
    res.json({ success: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro no envio teste";
    console.error(`[send-test] ${paramId(req.params.id)}:`, message);
    res.status(500).json({ success: false, error: message });
  }
}

/** Varre o staging em lotes até achar a 1ª linha que deve ser enviada. */
async function findFirstMustSendFromStaging(
  spreadsheetId: string,
  ctx: NonNullable<Awaited<ReturnType<typeof loadSpreadsheetContext>>>,
): Promise<string[][]> {
  const useStaging =
    ctx.spreadsheet.company.useStagingTable ||
    (() => {
      try {
        return Boolean((JSON.parse(ctx.spreadsheet.rawData) as { staging?: boolean }).staging);
      } catch {
        return false;
      }
    })();
  if (!useStaging) return [];

  const dbSettings = await getAppDbSettings();
  if (!dbSettings) return [];

  const { fetchStagingPage, countStagingRows } = await import("../services/stagingService.js");
  const total = await countStagingRows(dbSettings, spreadsheetId);
  const pageSize = 300;
  for (let offset = 0; offset < total; offset += pageSize) {
    const page = await fetchStagingPage(dbSettings, spreadsheetId, offset, pageSize);
    if (!page.length) break;
    const pageDiff = await computeDiffForSpreadsheet(
      { headers: ctx.current.headers, rows: page },
      null,
      ctx.spreadsheet.company,
    );
    const found = getMustSendRowsByIndices(pageDiff, [0]);
    if (found.length) return found;
  }
  return [];
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
