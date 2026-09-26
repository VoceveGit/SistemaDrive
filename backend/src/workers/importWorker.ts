// backend/src/workers/importWorker.ts
// Processo filho: Drive (spreadsheetId) OU upload manual (--manual + JSON). Se OOM, só este processo morre.

import dotenv from "dotenv";
dotenv.config({ override: true });

import { runChunkedImportById } from "../services/chunkedImportService.js";
import { runManualPedidosImportWorker } from "../services/manualUploadService.js";
import type { ManualWorkerImportResult } from "../services/manualUploadService.js";

const mode = process.argv[2];

if (mode === "--manual") {
  const raw = process.argv[3];
  if (!raw) {
    console.error("[importWorker] usage: importWorker --manual <json>");
    process.exit(1);
  }
  let payload: {
    filePath: string;
    fileName: string;
    targetTable: string;
    codedSolutionId: string;
  };
  try {
    payload = JSON.parse(raw) as typeof payload;
  } catch {
    console.error("[importWorker] JSON inválido (--manual)");
    process.exit(1);
  }

  console.log(`[importWorker] manual ${payload.fileName} → ${payload.targetTable}`);

  runManualPedidosImportWorker(payload)
    .then((result: ManualWorkerImportResult) => {
      if (process.send) process.send(result);
      process.exit(result.ok ? 0 : 1);
    })
    .catch((err) => {
      const fail: ManualWorkerImportResult = {
        ok: false,
        fileName: payload.fileName,
        targetTable: payload.targetTable,
        codedSolutionId: payload.codedSolutionId,
        error: err instanceof Error ? err.message : String(err),
      };
      if (process.send) process.send(fail);
      console.error("[importWorker] manual falhou:", err);
      process.exit(1);
    });
} else {
  const spreadsheetId = mode;
  if (!spreadsheetId) {
    console.error("[importWorker] usage: importWorker <spreadsheetId> | importWorker --manual <json>");
    process.exit(1);
  }

  console.log(`[importWorker] iniciando job ${spreadsheetId}`);

  runChunkedImportById(spreadsheetId)
    .then(() => {
      console.log(`[importWorker] job ${spreadsheetId} OK`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(`[importWorker] job ${spreadsheetId} falhou:`, err);
      process.exit(1);
    });
}
