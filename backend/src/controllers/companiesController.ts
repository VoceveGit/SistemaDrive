// backend/src/controllers/companiesController.ts — CRUD de empresas

import type { Request, Response } from "express";
import { prisma } from "../lib/prisma.js";
import { slugify } from "../utils/slug.js";
import { normalizeGoogleFolderId } from "../utils/googleFolder.js";
import { startOfToday } from "../utils/dates.js";
import { paramId } from "../utils/params.js";
import { syncSpreadsheetStatusIfFullySent } from "./spreadsheetsController.js";
import { getAppDbSettings, listColumns, listTables } from "../services/externalDbService.js";
import type { Company } from "../../generated/prisma/client.js";

async function companyStats(companyId: string) {
  const today = startOfToday();
  const [total, pending, todaySheets, todayNewRowsAgg, lastSheet] = await Promise.all([
    prisma.spreadsheet.count({ where: { companyId } }),
    prisma.spreadsheet.count({ where: { companyId, status: "pending" } }),
    prisma.spreadsheet.count({ where: { companyId, detectedAt: { gte: today } } }),
    prisma.spreadsheet.aggregate({
      where: { companyId, detectedAt: { gte: today } },
      _sum: { newRows: true },
    }),
    prisma.spreadsheet.findFirst({
      where: { companyId },
      orderBy: { detectedAt: "desc" },
      select: { detectedAt: true },
    }),
  ]);

  return {
    totalSpreadsheets: total,
    pendingSpreadsheets: pending,
    todaySpreadsheets: todaySheets,
    todayNewRows: todayNewRowsAgg._sum.newRows ?? 0,
    lastActivity: lastSheet?.detectedAt ?? null,
  };
}

export async function listCompanies(_req: Request, res: Response): Promise<void> {
  const companies = await prisma.company.findMany({
    where: { active: true },
    orderBy: { name: "asc" },
  });

  const withStats = await Promise.all(
    companies.map(async (c: Company) => ({
      ...c,
      ...(await companyStats(c.id)),
    })),
  );

  res.json({ success: true, companies: withStats });
}

export async function listAllCompanies(_req: Request, res: Response): Promise<void> {
  const companies = await prisma.company.findMany({ orderBy: { name: "asc" } });
  const withStats = await Promise.all(
    companies.map(async (c: Company) => ({
      ...c,
      ...(await companyStats(c.id)),
    })),
  );
  res.json({ success: true, companies: withStats });
}

export async function createCompany(req: Request, res: Response): Promise<void> {
  try {
    const { name, color, googleFolderId, targetTable, dateColumn, compareColumn, primaryKeyColumn } =
      req.body as {
      name?: string;
      color?: string;
      googleFolderId?: string;
      targetTable?: string;
      dateColumn?: string;
      compareColumn?: string;
      primaryKeyColumn?: string;
    };

    if (!name || !googleFolderId) {
      res.status(400).json({ success: false, error: "Nome e pasta do Drive são obrigatórios" });
      return;
    }

    let slug = slugify(name);
    const existingSlug = await prisma.company.findUnique({ where: { slug } });
    if (existingSlug) slug = `${slug}-${Date.now()}`;

    const company = await prisma.company.create({
      data: {
        name,
        slug,
        color: color ?? "#4F8EF7",
        googleFolderId: normalizeGoogleFolderId(googleFolderId),
        targetTable: targetTable || null,
        dateColumn: dateColumn || null,
        compareColumn: compareColumn || null,
        primaryKeyColumn: primaryKeyColumn || null,
      },
    });

    res.status(201).json({ success: true, company });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro ao criar empresa";
    res.status(500).json({ success: false, error: message });
  }
}

export async function updateCompany(req: Request, res: Response): Promise<void> {
  try {
    const id = paramId(req.params.id);
    const body = req.body as {
      name?: string;
      color?: string;
      googleFolderId?: string;
      targetTable?: string;
      dateColumn?: string;
      compareColumn?: string;
      primaryKeyColumn?: string;
      columnMapping?: Record<string, string>;
      active?: boolean;
    };

    const company = await prisma.company.update({
      where: { id },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.color !== undefined && { color: body.color }),
        ...(body.googleFolderId !== undefined && {
          googleFolderId: normalizeGoogleFolderId(body.googleFolderId),
        }),
        ...(body.targetTable !== undefined && { targetTable: body.targetTable }),
        ...(body.dateColumn !== undefined && { dateColumn: body.dateColumn }),
        ...(body.compareColumn !== undefined && { compareColumn: body.compareColumn }),
        ...(body.primaryKeyColumn !== undefined && { primaryKeyColumn: body.primaryKeyColumn }),
        ...(body.columnMapping !== undefined && { columnMapping: body.columnMapping }),
        ...(body.active !== undefined && { active: body.active }),
      },
    });

    res.json({ success: true, company });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro ao atualizar";
    res.status(500).json({ success: false, error: message });
  }
}

export async function deleteCompany(req: Request, res: Response): Promise<void> {
  try {
    const id = paramId(req.params.id);
    await prisma.company.update({ where: { id }, data: { active: false } });
    res.json({ success: true, message: "Empresa desativada" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro ao desativar";
    res.status(500).json({ success: false, error: message });
  }
}

export async function getTablesPreview(_req: Request, res: Response): Promise<void> {
  return getCompanyTables(_req, res);
}

export async function getColumnsPreview(req: Request, res: Response): Promise<void> {
  return getCompanyColumns(req, res);
}

export async function getCompanyTables(req: Request, res: Response): Promise<void> {
  const settings = await getAppDbSettings();
  if (!settings) {
    res.status(400).json({ success: false, error: "Banco de destino não configurado" });
    return;
  }
  try {
    const tables = await listTables(settings);
    res.json({ success: true, tables });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro ao listar tabelas";
    res.status(500).json({ success: false, error: message });
  }
}

export async function getCompanyColumns(req: Request, res: Response): Promise<void> {
  const table = req.query.table as string;
  if (!table) {
    res.status(400).json({ success: false, error: "Parâmetro table é obrigatório" });
    return;
  }
  const settings = await getAppDbSettings();
  if (!settings) {
    res.status(400).json({ success: false, error: "Banco de destino não configurado" });
    return;
  }
  try {
    const columns = await listColumns(settings, table);
    const sorted = [
      ...columns.filter((c) => c.isDateType),
      ...columns.filter((c) => !c.isDateType),
    ];
    res.json({ success: true, columns: sorted });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro ao listar colunas";
    res.status(500).json({ success: false, error: message });
  }
}

export async function getCompanySpreadsheets(req: Request, res: Response): Promise<void> {
  const id = paramId(req.params.id);
  const spreadsheets = await prisma.spreadsheet.findMany({
    where: { companyId: id },
    orderBy: { detectedAt: "desc" },
    select: {
      id: true,
      fileName: true,
      detectedAt: true,
      totalRows: true,
      newRows: true,
      status: true,
      sentAt: true,
    },
  });

  await Promise.all(
    spreadsheets
      .filter((s) => s.status === "pending" || s.status === "approved")
      .map((s) => syncSpreadsheetStatusIfFullySent(s.id)),
  );

  const refreshed = await prisma.spreadsheet.findMany({
    where: { companyId: id },
    orderBy: { detectedAt: "desc" },
    select: {
      id: true,
      fileName: true,
      detectedAt: true,
      totalRows: true,
      newRows: true,
      status: true,
      sentAt: true,
    },
  });

  res.json({ success: true, spreadsheets: refreshed });
}

export async function getCompany(req: Request, res: Response): Promise<void> {
  const id = paramId(req.params.id);
  const company = await prisma.company.findUnique({ where: { id } });
  if (!company) {
    res.status(404).json({ success: false, error: "Empresa não encontrada" });
    return;
  }
  const stats = await companyStats(id);
  res.json({ success: true, company: { ...company, ...stats } });
}
