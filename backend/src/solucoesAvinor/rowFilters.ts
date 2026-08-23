// backend/src/solucoesAvinor/rowFilters.ts — regras de linha Avinor (sem limite fixo de linha)

import { sanitizeExcelText } from "../services/sheetParseService.js";

function normCell(raw: string): string {
  return sanitizeExcelText(raw)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

const FATURAMENTO_FOOTER_MARKERS = [
  "resumo geral faturamento",
  "resumo geral outras",
  "resumo tipo de condicao",
  "tempo inicial",
  "tempo final arq",
  "tempo final",
] as const;

const FATURAMENTO_SKIP_LABELS = new Set([
  "total",
  "faturamento",
  "devolucoes",
  "outras entradas",
  "outras saidas",
]);

/** Para na primeira linha de rodapé/resumo do relatório Avinor. */
export function isFaturamentoFooterStopRow(row: string[]): boolean {
  const joined = row.map((c) => normCell(c)).join(" ");
  for (const m of FATURAMENTO_FOOTER_MARKERS) {
    if (joined.includes(m)) return true;
  }
  if (normCell(row[0] ?? "") === "arquivo") return true;
  return false;
}

/** Linha de resumo/total — ignora valores mesmo que tenham volume/peso. */
export function isFaturamentoSkipRow(row: string[], numeroIdx: number): boolean {
  if (isFaturamentoFooterStopRow(row)) return true;

  const first = normCell(row[0] ?? "");
  if (FATURAMENTO_SKIP_LABELS.has(first)) return true;

  const nomeLike = normCell(row[1] ?? row[0] ?? "");
  if (FATURAMENTO_SKIP_LABELS.has(nomeLike)) return true;

  return !isValidFaturamentoNumero(row[numeroIdx] ?? "");
}

export function isValidFaturamentoNumero(raw: string): boolean {
  const s = sanitizeExcelText(raw).trim();
  if (!s) return false;
  const n = normCell(s);
  if (FATURAMENTO_SKIP_LABELS.has(n)) return false;
  if (n === "total" || n.startsWith("resumo")) return false;
  // Número de nota: dígitos (pode ter pontos)
  const digits = s.replace(/\./g, "").replace(/,/g, "");
  return /^\d+$/.test(digits) && digits.length >= 1;
}

/** Pedidos: ignora linhas cujo TOTAL aparece na Descrição. */
export function isPedidosSkipRow(row: string[], descricaoIdx: number): boolean {
  const desc = normCell(row[descricaoIdx] ?? "");
  return desc.includes("total");
}

export function padRow(row: string[], len: number): string[] {
  const out = row.slice(0, len);
  while (out.length < len) out.push("");
  return out;
}
