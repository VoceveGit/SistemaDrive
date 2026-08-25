// backend/src/services/importJobRunner.ts
// API só enfileira; o parse/import pesado roda em child_process (heap isolado).

import { fork, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { prisma } from "../lib/prisma.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Fila em memória no processo da API — no máximo 1 worker por vez. */
const queue: string[] = [];
let active: { spreadsheetId: string; child: ChildProcess } | null = null;

function resolveWorker(): { modulePath: string; execArgv: string[] } {
  const js = path.join(__dirname, "../workers/importWorker.js");
  const ts = path.join(__dirname, "../workers/importWorker.ts");
  // Produção (tsc) ou build local
  if (existsSync(js)) {
    return {
      modulePath: js,
      execArgv: ["--max-old-space-size=300"],
    };
  }
  // Dev com tsx: carrega o .ts via --import tsx
  return {
    modulePath: ts,
    execArgv: ["--import", "tsx", "--max-old-space-size=300"],
  };
}

/**
 * Enfileira import. Nunca roda parse no processo da API.
 * Concorrência = 1 (Render Free).
 */
export function enqueueImportJob(spreadsheetId: string): void {
  if (active?.spreadsheetId === spreadsheetId) return;
  if (queue.includes(spreadsheetId)) return;
  queue.push(spreadsheetId);
  console.log(`[importJob] enfileirado ${spreadsheetId} (fila=${queue.length})`);
  void pump();
}

async function pump(): Promise<void> {
  if (active) return;
  const spreadsheetId = queue.shift();
  if (!spreadsheetId) return;

  await prisma.spreadsheet
    .update({
      where: { id: spreadsheetId },
      data: {
        status: "processing",
        processMessage: "Worker iniciado (processo isolado)...",
      },
    })
    .catch(() => undefined);

  const { modulePath, execArgv } = resolveWorker();
  console.log(`[importJob] fork ${spreadsheetId} → ${path.basename(modulePath)}`);

  const child = fork(modulePath, [spreadsheetId], {
    execArgv,
    env: { ...process.env },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });

  active = { spreadsheetId, child };

  child.on("exit", (code, signal) => {
    const id = spreadsheetId;
    active = null;
    console.log(`[importJob] worker ${id} saiu code=${code} signal=${signal}`);

    void (async () => {
      if (code !== 0) {
        const sheet = await prisma.spreadsheet.findUnique({
          where: { id },
          select: { status: true, processMessage: true },
        });
        if (sheet?.status === "processing") {
          await prisma.spreadsheet
            .update({
              where: { id },
              data: {
                status: "error",
                processMessage:
                  signal === "SIGABRT" || code === 134
                    ? "Falha no processamento (memória / OOM no worker)"
                    : `Worker encerrou com código ${code ?? "?"}${signal ? ` (${signal})` : ""}`,
              },
            })
            .catch(() => undefined);
        }
      } else {
        // Auto-commit coded (se autoSend) — antes do próximo da fila
        try {
          const { maybeAutoCommitAfterImport } = await import("./codedAutoService.js");
          await maybeAutoCommitAfterImport(id);
        } catch (e) {
          console.warn(`[importJob] auto-commit ${id}:`, e);
        }
      }
      void pump();
    })();
  });

  child.on("error", (err) => {
    console.error(`[importJob] erro ao iniciar worker:`, err);
  });
}

export function getImportJobStatus(): {
  activeId: string | null;
  queueLength: number;
} {
  return {
    activeId: active?.spreadsheetId ?? null,
    queueLength: queue.length,
  };
}
