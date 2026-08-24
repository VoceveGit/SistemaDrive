// frontend/src/lib/api.ts — Cliente HTTP da API

const API_BASE = import.meta.env.VITE_API_URL ?? "/api";

function getToken(): string | null {
  return localStorage.getItem("token");
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getToken();
  const headers: HeadersInit = {
    "Content-Type": "application/json",
    ...(options.headers ?? {}),
  };
  if (token) {
    (headers as Record<string, string>)["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (res.status === 429) {
    throw new Error(
      "Muitas requisições (429). O Render Free limitou o acesso — espere 1–2 minutos e atualize a página.",
    );
  }

  const text = await res.text();
  let data: T & { success?: boolean; error?: string; message?: string };
  try {
    data = text
      ? (JSON.parse(text) as T & { success?: boolean; error?: string; message?: string })
      : ({} as T & { success?: boolean; error?: string; message?: string });
  } catch {
    throw new Error(
      res.ok
        ? "Resposta inválida do servidor"
        : `Servidor indisponível (HTTP ${res.status}). Tente de novo em instantes.`,
    );
  }

  if (res.status === 401 && path !== "/auth/login") {
    localStorage.removeItem("token");
    localStorage.removeItem("auth-storage");
    window.location.href = "/login";
    throw new Error("Sessão expirada. Faça login novamente.");
  }

  if (!res.ok) {
    const err = data as { error?: string; message?: string };
    throw new Error(err.error ?? err.message ?? `Erro HTTP ${res.status}`);
  }

  return data;
}

export type User = { id: string; email: string; name: string };

export type Company = {
  id: string;
  name: string;
  slug: string;
  color: string;
  googleFolderId: string;
  targetTable: string | null;
  dateColumn: string | null;
  compareColumn: string | null;
  primaryKeyColumn: string | null;
  columnMapping: Record<string, string> | null;
  active: boolean;
  autoSend?: boolean;
  headerRow?: number;
  dataRow?: number | null;
  sheetName?: string | null;
  autofillEmpty?: boolean;
  skipEmptyRows?: boolean;
  ignoreRules?: { column: string; values: string[] } | null;
  fileMode?: string;
  exactFileName?: string | null;
  syncMode?: string;
  useDateFilter?: boolean;
  useStagingTable?: boolean;
  useCodedSolution?: boolean;
  codedSolutionId?: string | null;
  totalSpreadsheets: number;
  pendingSpreadsheets: number;
  todaySpreadsheets: number;
  todayNewRows: number;
  lastActivity?: string | null;
};

export type Spreadsheet = {
  id: string;
  fileName: string;
  detectedAt: string;
  totalRows: number;
  processedRows?: number;
  newRows: number;
  updatedRows?: number;
  status: "queued" | "processing" | "pending" | "approved" | "sent" | "error" | "no_new_items";
  processMessage?: string | null;
  sentAt?: string | null;
};

export type FieldChange = {
  column: string;
  from: string;
  to: string;
};

export type DiffRow = {
  isNew: boolean;
  isNewInDb: boolean;
  mustSend: boolean;
  isUpdated?: boolean;
  mustUpdate?: boolean;
  changes?: FieldChange[];
  data: string[];
};

export type DiffResult = {
  headers: string[];
  rows: DiffRow[];
  summary: {
    totalRows: number;
    newRows: number;
    previousRows: number;
    alreadyInDb: number;
    mustSend: number;
    mustUpdate?: number;
    jobTotalRows?: number;
  };
  dbWindowDays: number;
  dateColumnUsed: string | null;
  compareColumnUsed: string | null;
  dbCompareLimit: number | null;
  dbCompareMode: "date" | "month" | "last_records" | "principal" | "snapshot" | "skipped";
  dbCheckSkipped: boolean;
  skippedColumns: string[];
  dbRowsLoaded: number;
  syncMode?: string;
  truncated?: boolean;
  note?: string;
  staging?: boolean;
  codedSolution?: boolean;
  snapshot?: {
    mode: string;
    previousRowCount: number;
    insertedRowCount: number;
    finalRowCount: number;
    targetTable: string;
    note: string;
    codedSolutionId: string;
  };
  codedSummary?: {
    mode: "pedidos" | "faturamento";
    codedSolutionId: string;
    targetTable: string;
    note: string;
    validRows: number;
    linesRead: number;
    ignoredRows: number;
    rowsToInsert?: number;
    pedidosInFile?: number;
    pedidosChanged?: number;
    pedidosUnchanged?: number;
    ignoredTotal?: number;
    numerosNovos?: number;
    numerosExistentes?: number;
    ignoredResumo?: number;
    ignoredNoNumero?: number;
    insertedRowCount?: number;
    monthFrom?: string;
    monthToExclusive?: string;
    dateMin?: string;
    dateMax?: string;
    sampleDates?: string[];
    headerRowsSkipped?: number;
    skippedNoNumero?: number;
    skippedFooter?: number;
  };
  codedError?: string;
  processMessage?: string | null;
  pagination?: {
    offset: number;
    limit: number;
    loaded: number;
    total: number;
    hasMore: boolean;
    nextOffset: number | null;
  };
};

export type SendReport = {
  spreadsheetRows: number;
  insertedCount: number;
  updatedCount?: number;
  mustSendRemaining: number;
  mustUpdateRemaining?: number;
  alreadyInDb: number;
  skippedColumns: string[];
  dbTableRowCount: number | null;
  completed: boolean;
};

export type DashboardStats = {
  pendingTotal: number;
  sentToday: number;
  updatesToday: number;
  newRowsToday: number;
};

export type AppSettings = {
  dbType: string;
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  hasPassword: boolean;
  googleConnected: boolean;
  googleEmail?: string;
};

export type ColumnInfo = {
  column_name: string;
  data_type: string;
  isDateType: boolean;
};
