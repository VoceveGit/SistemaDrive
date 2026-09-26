// Processo filho: parse + staging + INSERT de upload manual. OOM não derruba a API.

import dotenv from "dotenv";
dotenv.config({ override: true });

import { runManualPedidosUpload } from "../services/manualUploadService.js";
import type { ManualUploadResult } from "../services/manualUploadService.js";

const raw = process.argv[2];
if (!raw) {
  console.error("[manualUploadWorker] usage: manualUploadWorker <json>");
  process.exit(1);
}

type Payload = {
  filePath: string;
  fileName: string;
  targetTable: string;
  codedSolutionId: string;
};

let payload: Payload;
try {
  payload = JSON.parse(raw) as Payload;
} catch {
  console.error("[manualUploadWorker] JSON inválido");
  process.exit(1);
}

console.log(`[manualUploadWorker] ${payload.fileName} → ${payload.targetTable}`);

runManualPedidosUpload(payload)
  .then((result: ManualUploadResult) => {
    if (process.send) process.send(result);
    process.exit(result.success ? 0 : 1);
  })
  .catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    const fail: ManualUploadResult = {
      success: false,
      fileName: payload.fileName,
      targetTable: payload.targetTable,
      codedSolutionId: payload.codedSolutionId,
      error: message,
    };
    if (process.send) process.send(fail);
    console.error("[manualUploadWorker] falhou:", err);
    process.exit(1);
  });
