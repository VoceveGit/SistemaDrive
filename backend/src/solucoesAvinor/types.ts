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

export type PedidosSummary = {
  mode: "pedidos";
  codedSolutionId: string;
  targetTable: string;
  fileName: string;
  linesRead: number;
  validRows: number;
  ignoredRows: number;
  ignoredTotal: number;
  pedidosInFile: number;
  pedidosChanged: number;
  pedidosUnchanged: number;
  rowsToInsert: number;
  insertedRowCount: number;
  /** Janela DELETE: Dt.Entrega >= monthFrom AND Dt.Entrega < monthToExclusive */
  monthFrom?: string;
  monthToExclusive?: string;
  /** Datas identificadas (pra validar sem tabela) */
  dateMin?: string;
  dateMax?: string;
  sampleDates?: string[];
  note: string;
};

export type FaturamentoSummary = {
  mode: "faturamento";
  codedSolutionId: string;
  targetTable: string;
  fileName: string;
  linesRead: number;
  validRows: number;
  ignoredRows: number;
  ignoredResumo: number;
  ignoredNoNumero: number;
  numerosNovos: number;
  numerosExistentes: number;
  insertedRowCount: number;
  note: string;
};

export type CodedImportSummary = PedidosSummary | FaturamentoSummary;

export type CodedSolutionRunResult = {
  headers: string[];
  /** Snapshot (clientes) */
  summary?: SnapshotSummary;
  /** Preview pedidos/faturamento */
  previewRows?: string[][];
  importSummary?: CodedImportSummary;
  truncated?: boolean;
};

export type CodedSolutionCommitResult = {
  summary: CodedImportSummary;
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
  /** true = grava no import (clientes). false = preview + envio manual. */
  autoCommitOnImport: boolean;
  runImport: (ctx: CodedSolutionContext) => Promise<CodedSolutionRunResult>;
  runCommit?: (ctx: CodedSolutionContext) => Promise<CodedSolutionCommitResult>;
};
