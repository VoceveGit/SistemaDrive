// backend/src/workers/importWorker.ts
// Processo filho: download + parse + staging/preview. Se OOM, só este processo morre.

import dotenv from "dotenv";
dotenv.config({ override: true });

import { runChunkedImportById } from "../services/chunkedImportService.js";

const spreadsheetId = process.argv[2];

if (!spreadsheetId) {
  console.error("[importWorker] usage: importWorker <spreadsheetId>");
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
