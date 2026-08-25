// backend/src/controllers/dashboardController.ts — Estatísticas do dashboard

import type { Request, Response } from "express";
import { prisma } from "../lib/prisma.js";
import { startOfToday } from "../utils/dates.js";
import { getAppDbSettings, testConnection } from "../services/externalDbService.js";

export async function getStats(_req: Request, res: Response): Promise<void> {
  try {
    const today = startOfToday();

    const [pendingTotal, sentToday, updatesToday, newRowsAgg] = await Promise.all([
      prisma.spreadsheet.count({ where: { status: "pending" } }),
      prisma.spreadsheet.count({
        where: { status: "sent", sentAt: { gte: today } },
      }),
      prisma.spreadsheet.count({ where: { detectedAt: { gte: today } } }),
      prisma.spreadsheet.aggregate({
        where: { detectedAt: { gte: today } },
        _sum: { newRows: true },
      }),
    ]);

    res.json({
      success: true,
      pendingTotal,
      sentToday,
      updatesToday,
      newRowsToday: newRowsAgg._sum.newRows ?? 0,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Erro ao ler stats";
    console.error("[getStats]", message);
    res.status(500).json({ success: false, error: message });
  }
}

export async function getConnectionStatus(_req: Request, res: Response): Promise<void> {
  try {
    const settings = await getAppDbSettings();
    if (!settings?.dbHost) {
      res.json({ success: true, connected: false, message: "Banco não configurado" });
      return;
    }
    const result = await testConnection(settings);
    res.json({ success: true, connected: result.success, message: result.message });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Erro ao testar conexão";
    res.json({ success: true, connected: false, message });
  }
}
