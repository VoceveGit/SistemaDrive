// backend/src/services/googleDriveService.ts — Google Drive via Service Account ou OAuth

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { google, type drive_v3 } from "googleapis";
import * as XLSX from "xlsx";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import type { ParsedSpreadsheet } from "./diffService.js";
import {
  computeDiffForSpreadsheet,
  parseRawData,
} from "./diffService.js";
import { processAutoSend } from "../controllers/spreadsheetsController.js";
import type { Server as SocketServer } from "socket.io";

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

function parseWorkbook(buffer: Buffer): ParsedSpreadsheet {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const json = XLSX.utils.sheet_to_json<(string | number | boolean | Date | null)[]>(sheet, {
    header: 1,
    defval: "",
    raw: false,
  });

  if (json.length === 0) {
    return { headers: [], rows: [] };
  }

  const headers = (json[0] ?? []).map(String);
  const rows = json.slice(1).map((row) =>
    headers.map((_, i) => String(row[i] ?? "")),
  );
  return { headers, rows };
}

async function downloadAndParse(
  drive: drive_v3.Drive,
  file: drive_v3.Schema$File,
): Promise<ParsedSpreadsheet> {
  const mime = file.mimeType ?? "";
  let buffer: Buffer;

  if (mime === "application/vnd.google-apps.spreadsheet") {
    const res = await drive.files.export(
      { fileId: file.id!, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      { responseType: "arraybuffer" },
    );
    buffer = Buffer.from(res.data as ArrayBuffer);
  } else {
    const res = await drive.files.get(
      { fileId: file.id!, alt: "media" },
      { responseType: "arraybuffer" },
    );
    buffer = Buffer.from(res.data as ArrayBuffer);
  }

  return parseWorkbook(buffer);
}

export async function pollAllCompanies(): Promise<void> {
  const drive = await getDriveClient();
  if (!drive) {
    console.warn(
      "[Drive] Polling ignorado — configure GOOGLE_APPLICATION_CREDENTIALS no .env ou conecte OAuth.",
    );
    return;
  }

  const companies = await prisma.company.findMany({ where: { active: true } });

  for (const company of companies) {
    try {
      await pollCompanyFolder(drive, company.id, company.googleFolderId, company.name);
    } catch (error) {
      console.error(`Erro ao monitorar pasta de ${company.name}:`, error);
    }
  }
}

async function pollCompanyFolder(
  drive: drive_v3.Drive,
  companyId: string,
  folderId: string,
  companyName: string,
): Promise<void> {
  const response = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: "files(id, name, mimeType, modifiedTime)",
    pageSize: 100,
  });

  const files = (response.data.files ?? []).filter(
    (f) => f.mimeType && SPREADSHEET_MIMES.has(f.mimeType),
  );

  for (const file of files) {
    if (!file.id || !file.name) continue;

    const modifiedTime = file.modifiedTime ? new Date(file.modifiedTime) : new Date();

    const existing = await prisma.spreadsheet.findFirst({
      where: { companyId, googleFileId: file.id },
      orderBy: { detectedAt: "desc" },
    });

    if (existing) {
      const lastModified = existing.googleModifiedTime?.getTime() ?? 0;
      if (modifiedTime.getTime() <= lastModified) continue;
    }

    const parsed = await downloadAndParse(drive, file);

    let previousData: ParsedSpreadsheet | null = null;
    if (existing) {
      previousData = parseRawData(existing.rawData);
    } else {
      const prevSpreadsheet = await prisma.spreadsheet.findFirst({
        where: { companyId },
        orderBy: { detectedAt: "desc" },
      });
      if (prevSpreadsheet) {
        previousData = parseRawData(prevSpreadsheet.rawData);
      }
    }

    const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    const diff = await computeDiffForSpreadsheet(parsed, previousData, company);

    const previousSpreadsheetId = existing?.id ?? null;

    const spreadsheet = await prisma.spreadsheet.create({
      data: {
        companyId,
        googleFileId: file.id,
        googleModifiedTime: modifiedTime,
        fileName: file.name,
        totalRows: parsed.rows.length,
        newRows: diff.summary.mustSend,
        status: "pending",
        rawData: JSON.stringify(parsed),
        previousSpreadsheetId,
      },
    });

    if (ioRef) {
      ioRef.emit("new_spreadsheet", {
        companyId,
        companyName,
        fileName: file.name,
        spreadsheetId: spreadsheet.id,
      });
    }

    if (company.autoSend) {
      await processAutoSend({
        spreadsheetId: spreadsheet.id,
        companyId,
        companyName,
        fileName: file.name,
        emit: (event, payload) => ioRef?.emit(event, payload),
      });
    }
  }
}
