// backend/src/solucoesAvinor/types.ts

import type { drive_v3 } from "googleapis";
import type { Company } from "../../generated/prisma/client.js";
import type { DbSettings } from "../services/externalDbService.js";

export type SnapshotSummary = {
  mode: "snapshot";
  codedSolutionId: string;
  targetTable: string;
  previousRowCount: number;
  insertedRowCount: number;
  finalRowCount: number;
  fileName: string;
  note: string;
};

export type CodedSolutionRunResult = {
  summary: SnapshotSummary;
  headers: string[];
};

export type CodedSolutionContext = {
  spreadsheetId: string;
  company: Company;
  drive: drive_v3.Drive;
  file: drive_v3.Schema$File;
  dbSettings: DbSettings;
  onProgress?: (message: string, processed?: number) => Promise<void>;
};

export type CodedSolution = {
  id: string;
  label: string;
  description: string;
  defaultTargetTable: string;
  headerRow: number;
  dataRow: number;
  runSnapshot: (ctx: CodedSolutionContext) => Promise<CodedSolutionRunResult>;
};
