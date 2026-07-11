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
  const text = await res.text();
  let data: T & { success?: boolean; error?: string };
  try {
    data = text ? (JSON.parse(text) as T & { success?: boolean; error?: string }) : ({} as T & { success?: boolean; error?: string });
  } catch {
    throw new Error(
      res.ok
        ? "Resposta inválida do servidor"
        : "Backend offline ou sem resposta. Verifique se a API está rodando na porta 3001.",
    );
  }

  if (res.status === 401 && path !== "/auth/login") {
    localStorage.removeItem("token");
    localStorage.removeItem("auth-storage");
    window.location.href = "/login";
    throw new Error("Sessão expirada. Faça login novamente.");
  }

  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `Erro HTTP ${res.status}`);
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
  newRows: number;
  status: "pending" | "approved" | "sent" | "error";
  sentAt?: string | null;
};

export type DiffRow = {
  isNew: boolean;
  isNewInDb: boolean;
  mustSend: boolean;
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
  };
  dbWindowDays: number;
  dateColumnUsed: string | null;
  compareColumnUsed: string | null;
  dbCompareLimit: number | null;
  dbCompareMode: "date" | "last_records" | "skipped";
  dbCheckSkipped: boolean;
  skippedColumns: string[];
  dbRowsLoaded: number;
};

export type SendReport = {
  spreadsheetRows: number;
  insertedCount: number;
  mustSendRemaining: number;
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
