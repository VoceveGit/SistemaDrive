// backend/src/solucoesAvinor/columnMap.ts
// Mapeamento por nome estilo pandas (dedup Nome → Nome.1, Nome.2).

import { sanitizeExcelText } from "../services/sheetParseService.js";
import type { MysqlColMeta } from "./conversoes.js";

/** Chave estável pra casar planilha × MySQL (ignora _x000d_, acento, case). */
export function headerMatchKey(name: string): string {
  return sanitizeExcelText(name)
    .replace(/_x000[dDaA]_/gi, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9%.]+/g, "");
}

/**
 * Deduplica cabeçalhos como o pandas: Nome, Nome, Nome → Nome, Nome.1, Nome.2
 */
export function dedupeHeadersPandasStyle(headers: string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((raw) => {
    const base = sanitizeExcelText(raw) || "Unnamed";
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}.${n}`;
  });
}

export function findColumnIndex(headers: string[], ...candidates: string[]): number {
  const keys = candidates.map(headerMatchKey);
  for (let i = 0; i < headers.length; i++) {
    const k = headerMatchKey(headers[i] ?? "");
    if (keys.includes(k)) return i;
  }
  return -1;
}

/**
 * Reordena linhas da planilha para a ordem das colunas do MySQL, casando por nome.
 */
export function mapRowsToDbColumnOrder(params: {
  sheetHeaders: string[];
  sheetRows: string[][];
  dbColumns: MysqlColMeta[];
}): { headers: string[]; rows: string[][] } {
  const { sheetHeaders, sheetRows, dbColumns } = params;
  const deduped = dedupeHeadersPandasStyle(sheetHeaders);

  const sheetByKey = new Map<string, number>();
  for (let i = 0; i < deduped.length; i++) {
    const key = headerMatchKey(deduped[i] ?? "");
    if (key && !sheetByKey.has(key)) sheetByKey.set(key, i);
  }

  const missing: string[] = [];
  const indices = dbColumns.map((col) => {
    const idx = sheetByKey.get(headerMatchKey(col.name));
    if (idx == null) {
      missing.push(col.name);
      return -1;
    }
    return idx;
  });

  if (missing.length > 0) {
    throw new Error(
      `Colunas da planilha não casam com o MySQL (${missing.length} faltando). ` +
        `Exemplos: ${missing.slice(0, 5).join(", ")}`,
    );
  }

  const rows = sheetRows.map((row) =>
    indices.map((i) => String(row[i] ?? "").trim()),
  );

  return {
    headers: dbColumns.map((c) => c.name),
    rows,
  };
}

/** Fill-down em todas as colunas (equivalente a pandas .ffill()). */
export function ffillAllColumns(rows: string[][]): string[][] {
  if (rows.length === 0) return rows;
  const colCount = Math.max(...rows.map((r) => r.length));
  const last: string[] = Array(colCount).fill("");
  return rows.map((row) => {
    const out: string[] = [];
    for (let i = 0; i < colCount; i++) {
      const v = String(row[i] ?? "").trim();
      if (v !== "") {
        last[i] = v;
        out.push(v);
      } else {
        out.push(last[i] ?? "");
      }
    }
    return out;
  });
}
