// backend/src/controllers/settingsController.ts — Configurações globais

import type { Request, Response } from "express";
import { prisma } from "../lib/prisma.js";
import { testConnection } from "../services/externalDbService.js";
import {
  disconnectGoogle,
  getGoogleAuthUrl,
  getGoogleStatus,
  handleGoogleCallback,
} from "../services/googleDriveService.js";

export async function getSettings(_req: Request, res: Response): Promise<void> {
  const settings = await prisma.appSettings.findUnique({ where: { id: 1 } });
  const google = await getGoogleStatus();

  res.json({
    success: true,
    settings: settings
      ? {
          dbType: settings.dbType,
          dbHost: settings.dbHost,
          dbPort: settings.dbPort,
          dbName: settings.dbName,
          dbUser: settings.dbUser,
          hasPassword: Boolean(settings.dbPassword),
          googleConnected: google.connected,
          googleEmail: google.email,
        }
      : null,
  });
}

export async function saveSettings(req: Request, res: Response): Promise<void> {
  try {
    const { dbType, dbHost, dbPort, dbName, dbUser, dbPassword } = req.body as {
      dbType?: string;
      dbHost?: string;
      dbPort?: number;
      dbName?: string;
      dbUser?: string;
      dbPassword?: string;
    };

    const existing = await prisma.appSettings.findUnique({ where: { id: 1 } });

    await prisma.appSettings.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        dbType: dbType ?? "postgresql",
        dbHost: dbHost ?? "",
        dbPort: dbPort ?? 5432,
        dbName: dbName ?? "",
        dbUser: dbUser ?? "",
        dbPassword: dbPassword ?? "",
      },
      update: {
        ...(dbType !== undefined && { dbType }),
        ...(dbHost !== undefined && { dbHost }),
        ...(dbPort !== undefined && { dbPort }),
        ...(dbName !== undefined && { dbName }),
        ...(dbUser !== undefined && { dbUser }),
        ...(dbPassword !== undefined && dbPassword !== "" && { dbPassword }),
      },
    });

    res.json({ success: true, message: "Configurações salvas" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro ao salvar";
    res.status(500).json({ success: false, error: message });
  }
}

export async function testDbConnection(_req: Request, res: Response): Promise<void> {
  const settings = await prisma.appSettings.findUnique({ where: { id: 1 } });
  if (!settings?.dbHost) {
    res.status(400).json({ success: false, message: "Configure o banco de dados primeiro" });
    return;
  }
  const result = await testConnection(settings);
  res.json(result);
}

export async function googleAuth(_req: Request, res: Response): Promise<void> {
  const url = getGoogleAuthUrl();
  res.redirect(url);
}

export async function googleCallback(req: Request, res: Response): Promise<void> {
  try {
    const code = req.query.code as string;
    if (!code) {
      res.status(400).send("Código OAuth ausente");
      return;
    }
    const { email } = await handleGoogleCallback(code);
    const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:5173";
    res.redirect(`${frontendUrl}/settings?google=connected&email=${encodeURIComponent(email)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro OAuth";
    res.status(500).send(message);
  }
}

export async function googleDisconnect(_req: Request, res: Response): Promise<void> {
  await disconnectGoogle();
  res.json({ success: true, message: "Google desconectado" });
}

export async function googleStatus(_req: Request, res: Response): Promise<void> {
  const status = await getGoogleStatus();
  res.json({ success: true, ...status });
}
