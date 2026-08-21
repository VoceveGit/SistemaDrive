// backend/src/utils/columnMapping.ts
// Mapeamento planilha → banco: por nome OU por letra Excel (A, B, …, AF).

/**
 * "A"→0, "Z"→25, "AA"→26, "AF"→31, …
 * Retorna null se não for letra Excel pura.
 */
export function excelLetterToIndex(raw: string): number | null {
  const s = raw.trim().toUpperCase();
  if (!/^[A-Z]+$/.test(s)) return null;
  let n = 0;
  for (const ch of s) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

/** 0→"A", 31→"AF" */
export function indexToExcelLetter(index: number): string {
  if (index < 0) return "";
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/**
 * Aplica mapeamento renomeando headers (mantém todas as colunas).
 * Chave do mapping:
 * - letra Excel: "AF" → renomeia a coluna na posição AF
 * - nome: "Quant. Pedida" → primeira ocorrência desse nome
 */
export function applyColumnMapping(
  headers: string[],
  mapping?: Record<string, string> | null,
): string[] {
  if (!mapping || Object.keys(mapping).length === 0) return headers;

  const result = [...headers];
  const renamedByIndex = new Set<number>();

  for (const [key, dbCol] of Object.entries(mapping)) {
    const target = String(dbCol ?? "").trim();
    if (!target) continue;
    const sheetKey = String(key ?? "").trim();
    if (!sheetKey) continue;

    const letterIdx = excelLetterToIndex(sheetKey);
    if (letterIdx != null) {
      if (letterIdx >= 0 && letterIdx < result.length) {
        result[letterIdx] = target;
        renamedByIndex.add(letterIdx);
      }
      continue;
    }

    // Por nome: primeira ocorrência ainda não renomeada por letra neste passo
    const idx = result.findIndex(
      (h, i) =>
        !renamedByIndex.has(i) &&
        h.trim().toLowerCase() === sheetKey.toLowerCase(),
    );
    // Prefer original headers for name match when letter already renamed same slot
    const origIdx = headers.findIndex(
      (h, i) =>
        !renamedByIndex.has(i) &&
        h.trim().toLowerCase() === sheetKey.toLowerCase(),
    );
    const useIdx = origIdx >= 0 ? origIdx : idx;
    if (useIdx >= 0) {
      result[useIdx] = target;
      renamedByIndex.add(useIdx);
    }
  }

  return result;
}

/** Aplica mapping nos headers; linhas inalteradas (só mudam os nomes das colunas). */
export function mapRowsWithColumnMapping(
  headers: string[],
  rows: string[][],
  mapping?: Record<string, string> | null,
): { headers: string[]; rows: string[][] } {
  return {
    headers: applyColumnMapping(headers, mapping),
    rows,
  };
}
