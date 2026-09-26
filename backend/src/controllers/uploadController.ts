// backend/src/controllers/uploadController.ts

import type { Request, Response } from "express";
import { unlink } from "fs/promises";
import path from "path";
import { listCodedSolutions } from "../solucoesAvinor/index.js";
import { listManualUploadTables } from "../services/manualUploadService.js";
import { runManualPedidosUploadIsolated } from "../services/manualUploadRunner.js";

const UPLOAD_SOLUTION_IDS = new Set(["avinor_pedidos"]);

/** Multipart (multer disk) — tipagem explícita para build sem augment global. */
type UploadSpreadsheetRequest = Request & {
  file?: Express.Multer.File;
};

export async function getUploadOptions(_req: Request, res: Response): Promise<void> {
  const solutions = listCodedSolutions().filter((s) => UPLOAD_SOLUTION_IDS.has(s.id));
  res.json({
    success: true,
    tables: listManualUploadTables(),
    solutions,
  });
}

export async function postUploadSpreadsheet(
  req: UploadSpreadsheetRequest,
  res: Response,
): Promise<void> {
  const file = req.file;
  const targetTable = String(req.body?.targetTable ?? "").trim();
  const codedSolutionId = String(req.body?.codedSolutionId ?? "").trim();

  if (!file?.path) {
    res.status(400).json({ success: false, error: "Envie um arquivo .xlsx" });
    return;
  }
  if (!targetTable || !codedSolutionId) {
    res.status(400).json({
      success: false,
      error: "Informe targetTable e codedSolutionId",
    });
    return;
  }

  const safeName = path.basename(file.originalname || "planilha.xlsx");
  const filePath = file.path;

  try {
    const result = await runManualPedidosUploadIsolated({
      filePath,
      fileName: safeName,
      targetTable,
      codedSolutionId,
    });

    if (!result.success) {
      res.status(500).json(result);
      return;
    }

    res.json(result);
  } finally {
    await unlink(filePath).catch(() => undefined);
  }
}
