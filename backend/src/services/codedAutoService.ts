// backend/src/services/codedAutoService.ts
// Automação de soluções codadas: enfileira arquivo mais novo não enviado + auto-commit.
// Fila global = importJobRunner (1 por vez). Commit roda após o worker, antes do próximo.

import { prisma } from "../lib/prisma.js";
import { companyUsesCodedSolution } from "../solucoesAvinor/index.js";
import { getAppDbSettings } from "./externalDbService.js";
import { getDriveClientForImport } from "./googleDriveService.js";
import { getImportJobStatus } from "./importJobRunner.js";
import { listDriveFilesForCompany, selectDriveFileForImport } from "./googleDriveService.js";

export type QueueItemView = {
  spreadsheetId: string;
  companyId: string;
  companyName: string;
  fileName: string;
  status: string;
  processMessage: string | null;
  phase: "queued" | "reading" | "sending";
  progressPct: number;
  totalRows: number;
  processedRows: number;
};

export type RecentCompletion = {
  spreadsheetId: string;
  companyId: string;
  companyName: string;
  fileName: string;
  at: string;
  durationMs: number | null;
  ok: boolean;
  message: string;
};

/** Completions recentes (pra o frontend virar notificação do sino). */
const recentCompletions: RecentCompletion[] = [];
const MAX_RECENT = 20;

function pushCompletion(c: RecentCompletion) {
  recentCompletions.unshift(c);
  if (recentCompletions.length > MAX_RECENT) recentCompletions.length = MAX_RECENT;
}

export function takeRecentCompletions(sinceIso?: string): RecentCompletion[] {
  if (!sinceIso) return [...recentCompletions];
  const since = new Date(sinceIso).getTime();
  return recentCompletions.filter((c) => new Date(c.at).getTime() > since);
}

/** Ordena pelo horário do nome (DD-MM-YYYY_HH-MM); fallback modifiedTime. */
export function driveFileRecencyScore(name: string, modifiedTime: string | null): number {
  const m = name.match(/(\d{2})-(\d{2})-(\d{4})_(\d{1,2})-(\d{2})/);
  if (m) {
    const dd = Number(m[1]);
    const mm = Number(m[2]);
    const yyyy = Number(m[3]);
    const hh = Number(m[4]);
    const mi = Number(m[5]);
    return new Date(yyyy, mm - 1, dd, hh, mi).getTime();
  }
  return modifiedTime ? new Date(modifiedTime).getTime() : 0;
}

function isBusyStatus(status: string | null | undefined): boolean {
  return status === "queued" || status === "processing";
}

function startOfTodayLocal(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Data do nome (DD-MM-YYYY) — null se não bater o padrão. */
function fileNameCalendarDay(name: string): string | null {
  const m = name.match(/(\d{2})-(\d{2})-(\d{4})_(\d{1,2})-(\d{2})/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`; // YYYY-MM-DD
}

function todayYmdLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Para uma empresa com autoSend + solução codada:
 * pega SOMENTE o arquivo mais novo do Drive (preferência: do dia de hoje).
 * Não reprocessa histórico pending antigo.
 */
export async function enqueueNewestUnsentForCompany(
  companyId: string,
): Promise<{ enqueued: boolean; spreadsheetId?: string; fileName?: string; reason?: string }> {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company?.active) return { enqueued: false, reason: "empresa inativa" };
  if (!company.autoSend) return { enqueued: false, reason: "autoSend off" };
  if (!company.useCodedSolution || !companyUsesCodedSolution(company)) {
    return { enqueued: false, reason: "sem solução codada" };
  }

  // Job real em andamento (queued/processing) nesta empresa
  const busy = await prisma.spreadsheet.findFirst({
    where: {
      companyId,
      status: { in: ["queued", "processing"] },
    },
    orderBy: { detectedAt: "desc" },
  });
  if (busy) {
    return {
      enqueued: false,
      spreadsheetId: busy.id,
      fileName: busy.fileName,
      reason: "já processando",
    };
  }

  let files: Awaited<ReturnType<typeof listDriveFilesForCompany>>;
  try {
    files = await listDriveFilesForCompany(companyId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[codedAuto] list Drive ${company.name}: ${msg}`);
    return { enqueued: false, reason: msg };
  }

  if (!files.length) return { enqueued: false, reason: "pasta vazia" };

  const today = todayYmdLocal();
  const sorted = [...files].sort(
    (a, b) =>
      driveFileRecencyScore(b.name, b.modifiedTime) -
      driveFileRecencyScore(a.name, a.modifiedTime),
  );

  // Preferência: mais novo DENTRE os do dia de hoje; senão o mais novo absoluto
  const ofToday = sorted.filter((f) => fileNameCalendarDay(f.name) === today);
  const newest = (ofToday[0] ?? sorted[0])!;

  if (newest.spreadsheetStatus === "sent") {
    return {
      enqueued: false,
      fileName: newest.name,
      reason: "mais novo já enviado",
    };
  }
  if (isBusyStatus(newest.spreadsheetStatus)) {
    return {
      enqueued: false,
      spreadsheetId: newest.spreadsheetId ?? undefined,
      fileName: newest.name,
      reason: "mais novo já na fila/processo",
    };
  }

  // Pending antigo do MESMO arquivo (ainda não enviado) → só commit, sem reler
  if (
    newest.spreadsheetStatus === "pending" &&
    newest.spreadsheetId
  ) {
    const pending = await prisma.spreadsheet.findUnique({
      where: { id: newest.spreadsheetId },
    });
    if (pending) {
      try {
        const raw = JSON.parse(pending.rawData) as {
          codedSolution?: boolean;
          codedSummary?: unknown;
        };
        if (raw.codedSolution && raw.codedSummary) {
          await autoCommitCodedSpreadsheet(pending.id);
          return {
            enqueued: false,
            spreadsheetId: pending.id,
            fileName: pending.fileName,
            reason: "commit do pending (mesmo arquivo)",
          };
        }
      } catch {
        /* cai no reprocessar */
      }
    }
  }

  const result = await selectDriveFileForImport({
    companyId,
    googleFileId: newest.id,
  });

  console.log(
    `[codedAuto] enfileirado ${newest.name} (${company.name}) → ${result.spreadsheetId}`,
  );

  return {
    enqueued: true,
    spreadsheetId: result.spreadsheetId,
    fileName: newest.name,
  };
}

/** Varre todas as empresas com automação codada (poll / cron). */
export async function scanCodedAutoCompanies(): Promise<void> {
  // Garante que histórico antigo não fique na fila de memória
  const { clearPendingImportQueue } = await import("./importJobRunner.js");
  await clearPendingImportQueue();

  const companies = await prisma.company.findMany({
    where: {
      active: true,
      autoSend: true,
      useCodedSolution: true,
      codedSolutionId: { not: null },
    },
    select: { id: true, name: true },
  });

  for (const c of companies) {
    try {
      const r = await enqueueNewestUnsentForCompany(c.id);
      if (r.enqueued) {
        console.log(`[codedAuto] ${c.name}: ${r.fileName}`);
      }
    } catch (e) {
      console.warn(`[codedAuto] ${c.name}:`, e);
    }
  }
}

/**
 * Após o worker de import: se autoSend + coded e ficou pending → runCommit.
 * Se já sent (clientes) → só registra completion.
 */
export async function maybeAutoCommitAfterImport(spreadsheetId: string): Promise<void> {
  const sheet = await prisma.spreadsheet.findUnique({
    where: { id: spreadsheetId },
    include: { company: true },
  });
  if (!sheet) return;

  const company = sheet.company;
  if (!company.autoSend) return;
  const coded = companyUsesCodedSolution(company);
  if (!coded) return;

  const startedAt = sheet.detectedAt?.getTime() ?? Date.now();

  if (sheet.status === "sent") {
    const durationMs = Date.now() - startedAt;
    const note =
      sheet.processMessage && !sheet.processMessage.includes("duração")
        ? `${sheet.processMessage} · ${formatDuration(durationMs)}`
        : sheet.processMessage;
    if (note && note !== sheet.processMessage) {
      await prisma.spreadsheet
        .update({ where: { id: spreadsheetId }, data: { processMessage: note } })
        .catch(() => undefined);
    }
    pushCompletion({
      spreadsheetId,
      companyId: company.id,
      companyName: company.name,
      fileName: sheet.fileName,
      at: new Date().toISOString(),
      durationMs,
      ok: true,
      message: `Planilha ${sheet.fileName} enviada com sucesso`,
    });
    return;
  }

  if (sheet.status !== "pending") return;

  let raw: { codedSolution?: boolean; codedSummary?: unknown } = {};
  try {
    raw = JSON.parse(sheet.rawData) as typeof raw;
  } catch {
    return;
  }
  if (!raw.codedSolution || !coded.runCommit) return;

  await autoCommitCodedSpreadsheet(spreadsheetId);
}

export async function autoCommitCodedSpreadsheet(spreadsheetId: string): Promise<void> {
  const sheet = await prisma.spreadsheet.findUnique({
    where: { id: spreadsheetId },
    include: { company: true },
  });
  if (!sheet) return;

  const company = sheet.company;
  const coded = companyUsesCodedSolution(company);
  if (!coded?.runCommit) return;

  let rawCoded: { codedSolution?: boolean; codedSummary?: unknown } = {};
  try {
    rawCoded = JSON.parse(sheet.rawData) as typeof rawCoded;
  } catch {
    /* ignore */
  }
  if (!rawCoded.codedSolution) return;

  const startedAt = sheet.detectedAt?.getTime() ?? Date.now();

  await prisma.spreadsheet.update({
    where: { id: spreadsheetId },
    data: {
      status: "processing",
      processMessage: "Enviando ao MySQL (automático)...",
    },
  });

  try {
    const dbSettings = await getAppDbSettings();
    if (!dbSettings) throw new Error("Banco de destino não configurado");
    const drive = await getDriveClientForImport();
    if (!drive) throw new Error("Google Drive não conectado");

    const commit = await coded.runCommit({
      spreadsheetId,
      company,
      drive,
      file: { id: sheet.googleFileId, name: sheet.fileName },
      dbSettings,
      previousSummary: rawCoded.codedSummary as
        | import("../solucoesAvinor/types.js").CodedImportSummary
        | undefined,
    });

    const s = commit.summary;
    const durationMs = Date.now() - startedAt;
    const note = `${s.note} · duração ${formatDuration(durationMs)}`;

    await prisma.spreadsheet.update({
      where: { id: spreadsheetId },
      data: {
        status: "sent",
        sentAt: new Date(),
        sentBy: "auto",
        processMessage: note,
        rawData: JSON.stringify({
          ...rawCoded,
          codedSummary: s,
          note,
          durationMs,
        }),
      },
    });

    pushCompletion({
      spreadsheetId,
      companyId: company.id,
      companyName: company.name,
      fileName: sheet.fileName,
      at: new Date().toISOString(),
      durationMs,
      ok: true,
      message: `Planilha ${sheet.fileName} enviada com sucesso`,
    });

    console.log(`[codedAuto] commit OK ${sheet.fileName} (${formatDuration(durationMs)})`);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Erro no envio automático";
    console.error(`[codedAuto] commit falhou ${sheet.fileName}:`, e);
    await prisma.spreadsheet
      .update({
        where: { id: spreadsheetId },
        data: { status: "error", processMessage: message },
      })
      .catch(() => undefined);

    // Desliga auto nesta empresa (mesmo espírito do processAutoSend legado)
    await prisma.company
      .update({ where: { id: company.id }, data: { autoSend: false } })
      .catch(() => undefined);

    pushCompletion({
      spreadsheetId,
      companyId: company.id,
      companyName: company.name,
      fileName: sheet.fileName,
      at: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      ok: false,
      message: `Falha no envio: ${message}`,
    });
  }
}

function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

function progressPct(total: number, processed: number, phase: QueueItemView["phase"]): number {
  if (phase === "queued") return 0;
  if (phase === "sending") {
    if (total <= 0) return 85;
    return Math.min(99, 50 + Math.round((processed / total) * 50));
  }
  if (total <= 0) return 15;
  return Math.min(90, Math.round((processed / Math.max(total, 1)) * 90));
}

/** Snapshot da fila pra UI — só jobs REAIS do runner (+ processing ativo). */
export async function getCodedAutoQueueView(): Promise<{
  active: QueueItemView | null;
  queue: QueueItemView[];
  statusLabel: "Baixando" | "Enviando" | null;
  recent: RecentCompletion[];
  jobRunner: { activeId: string | null; queueIds: string[]; queueLength: number };
}> {
  const runner = getImportJobStatus();
  const ids = [
    ...(runner.activeId ? [runner.activeId] : []),
    ...runner.queueIds,
  ];

  // Também inclui "processing" recente de auto (fase enviando no processo pai)
  const sendingSheets = await prisma.spreadsheet.findMany({
    where: {
      status: "processing",
      company: { autoSend: true, useCodedSolution: true },
      processMessage: { contains: "Enviando" },
      detectedAt: { gte: startOfTodayLocal() },
    },
    select: { id: true },
    take: 5,
  });
  for (const s of sendingSheets) {
    if (!ids.includes(s.id)) ids.push(s.id);
  }

  if (ids.length === 0) {
    return {
      active: null,
      queue: [],
      statusLabel: null,
      recent: [...recentCompletions].slice(0, 10),
      jobRunner: runner,
    };
  }

  const sheets = await prisma.spreadsheet.findMany({
    where: { id: { in: ids } },
    include: { company: { select: { id: true, name: true } } },
  });
  const byId = new Map(sheets.map((s) => [s.id, s]));

  const toView = (id: string): QueueItemView | null => {
    const s = byId.get(id);
    if (!s) return null;
    const msg = (s.processMessage ?? "").toLowerCase();
    const sending =
      s.status === "processing" &&
      (msg.includes("enviando") || msg.includes("inserindo") || msg.includes("apagando"));
    const phase: QueueItemView["phase"] =
      runner.activeId === id
        ? sending
          ? "sending"
          : "reading"
        : sending
          ? "sending"
          : "queued";
    return {
      spreadsheetId: s.id,
      companyId: s.company.id,
      companyName: s.company.name,
      fileName: s.fileName,
      status: s.status,
      processMessage: s.processMessage,
      phase,
      progressPct: progressPct(s.totalRows, s.processedRows, phase),
      totalRows: s.totalRows,
      processedRows: s.processedRows,
    };
  };

  const active = runner.activeId ? toView(runner.activeId) : null;
  const queue = runner.queueIds
    .map((id) => toView(id))
    .filter((x): x is QueueItemView => Boolean(x));

  // Se só tem "enviando" sem estar no runner (commit no processo pai)
  let activeOut = active;
  if (!activeOut) {
    for (const id of ids) {
      const v = toView(id);
      if (v?.phase === "sending") {
        activeOut = v;
        break;
      }
    }
  }

  let statusLabel: "Baixando" | "Enviando" | null = null;
  if (activeOut?.phase === "sending") statusLabel = "Enviando";
  else if (activeOut?.phase === "reading") statusLabel = "Baixando";
  else if (queue.length > 0) statusLabel = "Baixando";

  return {
    active: activeOut,
    queue: queue.filter((q) => q.spreadsheetId !== activeOut?.spreadsheetId),
    statusLabel,
    recent: [...recentCompletions].slice(0, 10),
    jobRunner: runner,
  };
}
