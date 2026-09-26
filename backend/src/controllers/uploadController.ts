// backend/src/controllers/uploadController.ts

import type { Request, Response } from "express";
import { writeFile, mkdtemp } from "fs/promises";
import path from "path";
import { tmpdir } from "os";
import { listCodedSolutions } from "../solucoesAvinor/index.js";
import {
  listManualUploadTables,
  runManualPedidosUpload,
} from "../services/manualUploadService.js";

const UPLOAD_SOLUTION_IDS = new Set(["avinor_pedidos"]);

export async function getUploadOptions(_req: Request, res: Response): Promise<void> {
  const solutions = listCodedSolutions().filter((s) => UPLOAD_SOLUTION_IDS.has(s.id));
  res.json({
    success: true,
    tables: listManualUploadTables(),
    solutions,
  });
}

export async function postUploadSpreadsheet(req: Request, res: Response): Promise<void> {
  const file = req.file;
  const targetTable = String(req.body?.targetTable ?? "").trim();
  const codedSolutionId = String(req.body?.codedSolutionId ?? "").trim();

  if (!file?.buffer?.length) {
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
  const dir = await mkdtemp(path.join(tmpdir(), "despacho-upload-"));
  const filePath = path.join(dir, safeName);
  await writeFile(filePath, file.buffer);

  const result = await runManualPedidosUpload({
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
}
