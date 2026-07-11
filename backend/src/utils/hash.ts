// backend/src/utils/hash.ts — Serialização e hash unificado para diff

import { createHash } from "crypto";

export function normalizeCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  // mysql2 DECIMAL às vezes vem como objeto
  if (typeof value === "object" && value !== null && "toString" in value) {
    const asNum = Number(String(value));
    if (!Number.isNaN(asNum) && String(value).trim() !== "") {
      return String(asNum);
    }
  }
  const s = String(value).trim();
  if (!s) return "";
  // 10000, 10000.0, 10000.00 → "10000" (evita falso "NOVO")
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (!Number.isNaN(n)) return String(n);
  }
  return s;
}

export function serializeRowForHash(values: unknown[], orderedColumns?: string[]): string {
  const normalized = values.map(normalizeCell);
  if (orderedColumns && orderedColumns.length === normalized.length) {
    const pairs = orderedColumns.map((col, i) => [col, normalized[i]] as const);
    pairs.sort(([a], [b]) => a.localeCompare(b));
    return JSON.stringify(Object.fromEntries(pairs));
  }
  return JSON.stringify(normalized);
}

export function hashRow(values: unknown[], orderedColumns?: string[]): string {
  return createHash("sha256")
    .update(serializeRowForHash(values, orderedColumns))
    .digest("hex");
}

export function hashRowSet(rows: unknown[][], orderedColumns?: string[]): Set<string> {
  return new Set(rows.map((row) => hashRow(row, orderedColumns)));
}
