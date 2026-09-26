// Upload manual em child_process (heap isolado — planilhas ~60k linhas).

import { fork, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { ManualUploadResult } from "./manualUploadService.js";
import { waitForImportJobIdle } from "./importJobRunner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let activeChild: ChildProcess | null = null;

function resolveManualUploadWorker(): { modulePath: string; execArgv: string[] } {
  const js = path.join(__dirname, "../workers/manualUploadWorker.js");
  const ts = path.join(__dirname, "../workers/manualUploadWorker.ts");
  // Mesmo teto do importWorker — 420MB filho + API estourava RAM do Starter.
  const heap = ["--max-old-space-size=300"];
  if (existsSync(js)) {
    return { modulePath: js, execArgv: heap };
  }
  return {
    modulePath: ts,
    execArgv: ["--import", "tsx", ...heap],
  };
}

export type ManualUploadJobParams = {
  filePath: string;
  fileName: string;
  targetTable: string;
  codedSolutionId: string;
};

export function isManualUploadBusy(): boolean {
  return activeChild !== null;
}

/** Roda upload no worker; API permanece leve para /health e estáticos. */
export async function runManualPedidosUploadIsolated(
  params: ManualUploadJobParams,
): Promise<ManualUploadResult> {
  if (activeChild) {
    return Promise.resolve({
      success: false,
      fileName: params.fileName,
      targetTable: params.targetTable,
      codedSolutionId: params.codedSolutionId,
      error: "Outro upload em andamento. Aguarde terminar (um arquivo por vez).",
    });
  }

  const idle = await waitForImportJobIdle();
  if (!idle) {
    return {
      success: false,
      fileName: params.fileName,
      targetTable: params.targetTable,
      codedSolutionId: params.codedSolutionId,
      error:
        "O processamento automático do Drive ainda está rodando. Espere 2–5 min (fila vazia) e envie de novo — um arquivo por vez.",
    };
  }

  const { modulePath, execArgv } = resolveManualUploadWorker();
  const payload = JSON.stringify(params);

  return new Promise((resolve) => {
    const child = fork(modulePath, [payload], {
      execArgv,
      env: { ...process.env },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    activeChild = child;

    let settled = false;
    const finish = (result: ManualUploadResult) => {
      if (settled) return;
      settled = true;
      activeChild = null;
      resolve(result);
    };

    child.on("message", (msg: ManualUploadResult) => {
      finish(msg);
    });

    child.on("exit", (code, signal) => {
      if (settled) return;
      const oom = signal === "SIGABRT" || code === 134;
      finish({
        success: false,
        fileName: params.fileName,
        targetTable: params.targetTable,
        codedSolutionId: params.codedSolutionId,
        error: oom
          ? "Memória insuficiente ao processar a planilha. Tente de novo com um arquivo por vez."
          : `Processamento interrompido (código ${code ?? "?"}${signal ? ` ${signal}` : ""}).`,
      });
    });

    child.on("error", (err) => {
      finish({
        success: false,
        fileName: params.fileName,
        targetTable: params.targetTable,
        codedSolutionId: params.codedSolutionId,
        error: err.message,
      });
    });
  });
}
