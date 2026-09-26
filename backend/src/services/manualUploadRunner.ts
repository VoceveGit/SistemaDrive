// Upload manual: mesmo importWorker do Drive (runImport) + runCommit na API.

import { fork, type ChildProcess } from "child_process";
import { resolveImportWorkerModule } from "./importJobRunner.js";
import {
  runManualPedidosCommit,
  type ManualUploadResult,
  type ManualWorkerImportResult,
} from "./manualUploadService.js";
import { waitForImportJobIdle } from "./importJobRunner.js";

let activeChild: ChildProcess | null = null;

export type ManualUploadJobParams = {
  filePath: string;
  fileName: string;
  targetTable: string;
  codedSolutionId: string;
};

export function isManualUploadBusy(): boolean {
  return activeChild !== null;
}

export async function runManualPedidosUploadIsolated(
  params: ManualUploadJobParams,
): Promise<ManualUploadResult> {
  if (activeChild) {
    return {
      success: false,
      fileName: params.fileName,
      targetTable: params.targetTable,
      codedSolutionId: params.codedSolutionId,
      error: "Outro upload em andamento. Aguarde terminar (um arquivo por vez).",
    };
  }

  const idle = await waitForImportJobIdle();
  if (!idle) {
    return {
      success: false,
      fileName: params.fileName,
      targetTable: params.targetTable,
      codedSolutionId: params.codedSolutionId,
      error:
        "O processamento automático do Drive ainda está rodando. Espere 2–5 min e envie de novo — um arquivo por vez.",
    };
  }

  const { modulePath, execArgv } = resolveImportWorkerModule();
  const payload = JSON.stringify(params);

  const importResult = await new Promise<ManualWorkerImportResult>((resolve) => {
    const child = fork(modulePath, ["--manual", payload], {
      execArgv,
      env: { ...process.env },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    activeChild = child;

    let settled = false;
    const finish = (result: ManualWorkerImportResult) => {
      if (settled) return;
      settled = true;
      activeChild = null;
      resolve(result);
    };

    child.on("message", (msg: ManualWorkerImportResult) => {
      finish(msg);
    });

    child.on("exit", (code, signal) => {
      if (settled) return;
      const oom = signal === "SIGABRT" || code === 134;
      finish({
        ok: false,
        fileName: params.fileName,
        targetTable: params.targetTable,
        codedSolutionId: params.codedSolutionId,
        error: oom
          ? "Memória insuficiente ao processar a planilha (mesmo limite do import do Drive)."
          : `Processamento interrompido (código ${code ?? "?"}${signal ? ` ${signal}` : ""}).`,
      });
    });

    child.on("error", (err) => {
      finish({
        ok: false,
        fileName: params.fileName,
        targetTable: params.targetTable,
        codedSolutionId: params.codedSolutionId,
        error: err.message,
      });
    });
  });

  if (!importResult.ok || !importResult.jobId || !importResult.importSummary) {
    return {
      success: false,
      fileName: params.fileName,
      targetTable: params.targetTable,
      codedSolutionId: params.codedSolutionId,
      error: importResult.error ?? "Falha ao processar planilha no worker.",
    };
  }

  return runManualPedidosCommit({
    jobId: importResult.jobId,
    fileName: params.fileName,
    targetTable: params.targetTable,
    codedSolutionId: params.codedSolutionId,
    importSummary: importResult.importSummary,
  });
}
