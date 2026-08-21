// backend/src/services/googleDriveService.ts — Google Drive via Service Account ou OAuth

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { google, type drive_v3 } from "googleapis";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import type { Server as SocketServer } from "socket.io";
import { enqueueImportJob } from "./importJobRunner.js";

const SPREADSHEET_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/csv",
  "application/vnd.google-apps.spreadsheet",
]);

type GoogleTokens = {
  access_token?: string;
  refresh_token?: string;
  expiry_date?: number;
  email?: string;
};

let ioRef: SocketServer | null = null;
let serviceAccountDrive: drive_v3.Drive | null = null;
let serviceAccountEmail: string | null = null;

export function setSocketServer(io: SocketServer): void {
  ioRef = io;
}

function resolveCredentialsPath(): string | null {
  const fromEnv = env.googleApplicationCredentials;
  if (fromEnv) {
    return path.isAbsolute(fromEnv) ? fromEnv : path.resolve(process.cwd(), fromEnv);
  }
  const defaultPath = path.resolve(process.cwd(), "config", "drive-credentials.json");
  return existsSync(defaultPath) ? defaultPath : null;
}

async function getServiceAccountDrive(): Promise<drive_v3.Drive | null> {
  if (serviceAccountDrive) return serviceAccountDrive;

  const credentialsPath = resolveCredentialsPath();
  if (!credentialsPath || !existsSync(credentialsPath)) return null;

  const raw = await readFile(credentialsPath, "utf8");
  const credentials = JSON.parse(raw) as { client_email?: string };

  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(raw),
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });

  serviceAccountEmail = credentials.client_email ?? "service-account";
  serviceAccountDrive = google.drive({ version: "v3", auth });
  console.log(`[Drive] Service Account ativa: ${serviceAccountEmail}`);
  return serviceAccountDrive;
}

function getOAuthClient() {
  return new google.auth.OAuth2(env.googleClientId, env.googleClientSecret, env.googleRedirectUri);
}

async function loadOAuthTokens(): Promise<GoogleTokens | null> {
  const settings = await prisma.appSettings.findUnique({ where: { id: 1 } });
  if (!settings?.googleCredentials) return null;
  return JSON.parse(settings.googleCredentials) as GoogleTokens;
}

async function saveOAuthTokens(tokens: GoogleTokens): Promise<void> {
  await prisma.appSettings.upsert({
    where: { id: 1 },
    create: { id: 1, googleCredentials: JSON.stringify(tokens) },
    update: { googleCredentials: JSON.stringify(tokens) },
  });
}

export function getGoogleAuthUrl(): string {
  const client = getOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
  });
}

export async function handleGoogleCallback(code: string): Promise<{ email: string }> {
  const client = getOAuthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  const oauth2 = google.oauth2({ version: "v2", auth: client });
  const userInfo = await oauth2.userinfo.get();
  const email = userInfo.data.email ?? "conta-google";

  await saveOAuthTokens({
    access_token: tokens.access_token ?? undefined,
    refresh_token: tokens.refresh_token ?? undefined,
    expiry_date: tokens.expiry_date ?? undefined,
    email,
  });

  return { email };
}

export async function getGoogleStatus(): Promise<{
  connected: boolean;
  email?: string;
  mode?: "service_account" | "oauth";
}> {
  const saDrive = await getServiceAccountDrive();
  if (saDrive) {
    return { connected: true, email: serviceAccountEmail ?? undefined, mode: "service_account" };
  }

  const creds = await loadOAuthTokens();
  if (!creds?.refresh_token && !creds?.access_token) {
    return { connected: false };
  }
  return { connected: true, email: creds.email, mode: "oauth" };
}

export async function disconnectGoogle(): Promise<void> {
  const settings = await prisma.appSettings.findUnique({ where: { id: 1 } });
  if (settings) {
    await prisma.appSettings.update({
      where: { id: 1 },
      data: { googleCredentials: null },
    });
  }
}

async function getOAuthDrive(): Promise<drive_v3.Drive | null> {
  const creds = await loadOAuthTokens();
  if (!creds?.refresh_token && !creds?.access_token) return null;

  const client = getOAuthClient();
  client.setCredentials({
    access_token: creds.access_token,
    refresh_token: creds.refresh_token,
    expiry_date: creds.expiry_date,
  });

  client.on("tokens", async (tokens) => {
    const current = (await loadOAuthTokens()) ?? {};
    await saveOAuthTokens({
      ...current,
      access_token: tokens.access_token ?? undefined,
      refresh_token: tokens.refresh_token ?? undefined,
      expiry_date: tokens.expiry_date ?? undefined,
    });
  });

  return google.drive({ version: "v3", auth: client });
}

async function getDriveClient(): Promise<drive_v3.Drive | null> {
  const sa = await getServiceAccountDrive();
  if (sa) return sa;
  return getOAuthDrive();
}

/** Cliente Drive para reprocessar/enviar a partir do arquivo original. */
export async function getDriveClientForImport(): Promise<drive_v3.Drive | null> {
  return getDriveClient();
}

/** Lista planilhas da pasta (só metadados — sem download). */
export async function listDriveFilesForCompany(companyId: string): Promise<
  {
    id: string;
    name: string;
    mimeType: string | null;
    modifiedTime: string | null;
    size: string | null;
    spreadsheetId: string | null;
    spreadsheetStatus: string | null;
  }[]
> {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company?.active) throw new Error("Empresa não encontrada");

  const drive = await getDriveClient();
  if (!drive) throw new Error("Google Drive não conectado");

  const response = await drive.files.list({
    q: `'${company.googleFolderId}' in parents and trashed = false`,
    fields: "files(id, name, mimeType, modifiedTime, size)",
    pageSize: 100,
    orderBy: "modifiedTime desc",
  });

  let files = (response.data.files ?? []).filter(
    (f) => f.mimeType && SPREADSHEET_MIMES.has(f.mimeType),
  );

  files.sort((a, b) => {
    const ta = a.modifiedTime ? new Date(a.modifiedTime).getTime() : 0;
    const tb = b.modifiedTime ? new Date(b.modifiedTime).getTime() : 0;
    return tb - ta;
  });

  const fileIds = files.map((f) => f.id!).filter(Boolean);
  const existing = fileIds.length
    ? await prisma.spreadsheet.findMany({
        where: { companyId, googleFileId: { in: fileIds } },
        orderBy: { detectedAt: "desc" },
        select: {
          id: true,
          googleFileId: true,
          status: true,
          detectedAt: true,
        },
      })
    : [];

  const latestByFile = new Map<string, { id: string; status: string }>();
  for (const s of existing) {
    if (!latestByFile.has(s.googleFileId)) {
      latestByFile.set(s.googleFileId, { id: s.id, status: s.status });
    }
  }

  return files
    .filter((f) => f.id && f.name)
    .map((f) => {
      const link = latestByFile.get(f.id!);
      return {
        id: f.id!,
        name: f.name!,
        mimeType: f.mimeType ?? null,
        modifiedTime: f.modifiedTime ?? null,
        size: f.size ?? null,
        spreadsheetId: link?.id ?? null,
        spreadsheetStatus: link?.status ?? null,
      };
    });
}

/**
 * Usuário escolheu um arquivo no Drive: cria registro (se preciso) e processa.
 * Não baixa no processo da API — só enfileira o worker.
 */
export async function selectDriveFileForImport(params: {
  companyId: string;
  googleFileId: string;
}): Promise<{ spreadsheetId: string; created: boolean }> {
  const company = await prisma.company.findUnique({ where: { id: params.companyId } });
  if (!company?.active) throw new Error("Empresa não encontrada");

  const drive = await getDriveClient();
  if (!drive) throw new Error("Google Drive não conectado");

  const meta = await drive.files.get({
    fileId: params.googleFileId,
    fields: "id, name, mimeType, modifiedTime, size, parents, trashed",
  });

  const file = meta.data;
  if (!file.id || !file.name || file.trashed) {
    throw new Error("Arquivo não encontrado no Drive");
  }
  if (!file.mimeType || !SPREADSHEET_MIMES.has(file.mimeType)) {
    throw new Error("Arquivo não é uma planilha suportada");
  }
  const parents = file.parents ?? [];
  if (!parents.includes(company.googleFolderId)) {
    throw new Error("Arquivo não pertence à pasta desta empresa");
  }

  const modifiedTime = file.modifiedTime ? new Date(file.modifiedTime) : new Date();

  const existing = await prisma.spreadsheet.findFirst({
    where: { companyId: company.id, googleFileId: file.id },
    orderBy: { detectedAt: "desc" },
  });

  // Se já existe e está pending/processing, só reprocessa o mesmo
  if (
    existing &&
    (existing.status === "pending" ||
      existing.status === "processing" ||
      existing.status === "queued" ||
      existing.status === "approved")
  ) {
    await prisma.spreadsheet.update({
      where: { id: existing.id },
      data: {
        status: "processing",
        processMessage: "Na fila do worker (arquivo selecionado)...",
        googleModifiedTime: modifiedTime,
        fileName: file.name,
      },
    });
    enqueueImportJob(existing.id);
    return { spreadsheetId: existing.id, created: false };
  }

  const spreadsheet = await prisma.spreadsheet.create({
    data: {
      companyId: company.id,
      googleFileId: file.id,
      googleModifiedTime: modifiedTime,
      fileName: file.name,
      totalRows: 0,
      processedRows: 0,
      newRows: 0,
      updatedRows: 0,
      status: "processing",
      processMessage: "Arquivo selecionado — processando...",
      rawData: JSON.stringify({ headers: [], rows: [] }),
      previousSpreadsheetId: existing?.id ?? null,
    },
  });

  enqueueImportJob(spreadsheet.id);

  if (ioRef) {
    ioRef.emit("new_spreadsheet", {
      companyId: company.id,
      companyName: company.name,
      fileName: file.name,
      spreadsheetId: spreadsheet.id,
    });
  }

  return { spreadsheetId: spreadsheet.id, created: true };
}

export async function pollAllCompanies(): Promise<void> {
  // Poll não cria/baixa mais — a UI lista o Drive e o usuário escolhe o arquivo.
  // Mantido o cron só para aquecer/validar conexão ocasionalmente.
  const drive = await getDriveClient();
  if (!drive) {
    console.warn(
      "[Drive] Polling ignorado — configure GOOGLE_APPLICATION_CREDENTIALS no .env ou conecte OAuth.",
    );
    return;
  }
  console.log("[Drive] Poll OK (lista sob demanda na UI; sem auto-import)");
}
