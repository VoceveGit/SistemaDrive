// backend/src/solucoesAvinor/columnMap.ts
// Mapeamento por nome estilo pandas (dedup + aliases Excel → MySQL).

import { sanitizeExcelText } from "../services/sheetParseService.js";
import type { MysqlColMeta } from "./conversoes.js";

/** Chave estável pra casar planilha × MySQL (ignora _x000d_, acento, pontuação, case). */
export function headerMatchKey(name: string): string {
  return sanitizeExcelText(name)
    .replace(/_x000[dDaA]_/gi, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9%]+/g, "");
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
 * Sinônimos planilha → coluna MySQL (faturamento_avinor em snake_case).
 * Igual ao espírito do upload_avinor: casar por nome, não por posição.
 */
const FATURAMENTO_ALIASES: Record<string, string[]> = {
  vendedor: ["Vendedor"],
  nome: ["Nome"],
  data: ["Data"],
  mes: ["Mês", "Mes"],
  meio_venda: ["Meio Venda", "Meio_Venda", "Meio de Venda"],
  devolucao: ["Devolução", "Devolucao"],
  uni: ["Uni", "Unidade"],
  serie: ["Série", "Serie"],
  numero: ["Número", "Numero", "Nro", "Nº"],
  pedido: ["Pedido"],
  romaneio: ["Romaneio"],
  frete: ["Frete"],
  cliente: ["Cliente"],
  rede: ["Rede"],
  razao_social: ["Razão Social", "Razao Social"],
  tipo_de_cliente: ["Tipo de Cliente", "Tipo Cliente", "Tp.Cliente", "Tp Cliente"],
  nome_fantasia: ["Nome Fantasia"],
  rota_cliente: ["Rota Cliente", "Rota Cad. Cliente", "Rota Cad Cliente"],
  rota_pedido: ["Rota Pedido", "Rota Grav. Pedido", "Rota Grav Pedido"],
  cidade: ["Cidade"],
  uf: ["UF"],
  ramo_ativ: ["Ramo Ativ", "Ramo Atividade", "Ramo_Ativ", "Ramo Ativ."],
  produto: ["Produto"],
  descricao: ["Descrição", "Descricao"],
  um: ["UM"],
  familia: ["Família", "Familia"],
  cfop: ["CFOP"],
  descricao_1: ["Descrição.1", "Descricao.1", "Descrição 1", "Descricao CFOP"],
  volumes: ["Volumes", "Volume"],
  peso: ["Peso"],
  lista: ["Lista"],
  ocorr: ["Ocorr", "Ocorrência", "Ocorrencia", "Ocorr."],
  pre_base: [
    "Pre Base",
    "Pré Base",
    "Preço Base",
    "Preco Base",
    "Pre_Base",
    "Pré-Base",
    "Pre. Base",
    "P. Base",
    "Vl Base",
    "Valor Base",
  ],
  preco_praticado: ["Preço Praticado", "Preco Praticado", "Preço Pratic.", "Preco Pratic"],
  valor_produto: ["Valor Produto", "Valor do Produto"],
  desconto_comercial: [
    "Desconto Comercial",
    "%Desc Comercial",
    "%Desconto Comercial",
    "Desc Comercial",
  ],
  valor_total_faturado: [
    "Valor Total Faturado",
    "Valor Total",
    "Valor_Total_Faturado",
  ],
  desc_finan: [
    "Desc Finan",
    "Desc. Finan",
    "Desc_Finan",
    "Desconto Financeiro",
    "%Desc Finan",
    "%Desconto Financeiro",
    "% Desc Finan",
    "Desc.Finan",
    "Desc Finan.",
    "%Desc.Finan",
    "%Desc. Finan",
  ],
  nota_refaturada: ["Nota Refaturada", "Nota_Refaturada"],
  romaneio_refaturada: ["Romaneio Refaturada", "Romaneio_Refaturada"],
  nota_devolucao: ["Nota Devolução", "Nota Devolucao", "Nota_Devolucao"],
  cliente_original: ["Cliente Original", "Cliente_Original"],
  cond_pag_cliente: [
    "Cond Pag Cliente",
    "Cond. Pag. Cliente",
    "Cond Pagto Cliente",
    "Cond. Pagto Cliente",
    "Cond_Pag_Cliente",
  ],
  cond_pag_nota: [
    "Cond Pag Nota",
    "Cond. Pag. Nota",
    "Cond Pagto Nota",
    "Cond. Pagto Nota",
    "Cond_Pag_Nota",
  ],
};

/** Pedidos: MySQL tem Quant._x000D_\\nPedida — planilha vem "Quant. Pedida" etc. */
const PEDIDOS_ALIASES: Record<string, string[]> = {
  Emp: ["Emp"],
  Uni: ["Uni"],
  "Dt.Entrega": ["Dt.Entrega", "Dt Entrega", "Data Entrega"],
  Pedido: ["Pedido"],
  Status: ["Status"],
  "Cond. Pagto": ["Cond. Pagto", "Cond Pagto", "Cond. Pagamento"],
  Cliente: ["Cliente"],
  "Razão Social": ["Razão Social", "Razao Social"],
  "Vend.Padrão": ["Vend.Padrão", "Vend.Padrao", "Vend Padrão"],
  Vendedor: ["Vendedor"],
  UM: ["UM"],
  Produto: ["Produto"],
  Descrição: ["Descrição", "Descricao"],
  "Quant._x000D_\nPedida": ["Quant. Pedida", "Quant Pedida", "Quant.Pedida"],
  "Quant._x000D_\nAtendida": ["Quant. Atendida", "Quant Atendida", "Quant.Atendida"],
  "Peso_x000D_\nPedido": ["Peso Pedido", "Peso.Pedido"],
  "Peso_x000D_\nAtendido": ["Peso Atendido", "Peso.Atendido"],
  "Preço_x000D_\nUnitário": ["Preço Unitário", "Preco Unitario", "Preço Unitario"],
  "Preço_x000D_\nBase": ["Preço Base", "Preco Base"],
  "Preço_x000D_\nMedio": ["Preço Medio", "Preco Medio", "Preço Médio"],
  "Valor_x000D_\nST": ["Valor ST", "Valor.ST"],
  "Valor_x000D_\nPrevisto": ["Valor Previsto", "Valor.Previsto"],
  "%Desc.Comer.": ["%Desc.Comer.", "%Desc Comer", "%Desconto Comercial"],
};

function aliasesForDbColumn(dbName: string): string[] {
  if (FATURAMENTO_ALIASES[dbName]) return FATURAMENTO_ALIASES[dbName];
  if (PEDIDOS_ALIASES[dbName]) return PEDIDOS_ALIASES[dbName];
  // Pedidos: nome no MySQL pode ter _x000D_ com variações
  const compact = headerMatchKey(dbName);
  for (const [k, aliases] of Object.entries(PEDIDOS_ALIASES)) {
    if (headerMatchKey(k) === compact) return aliases;
  }
  return [];
}

function resolveSheetIndex(
  dbColName: string,
  sheetByKey: Map<string, number>,
): number {
  const primary = headerMatchKey(dbColName);
  if (primary && sheetByKey.has(primary)) return sheetByKey.get(primary)!;

  for (const alias of aliasesForDbColumn(dbColName)) {
    const k = headerMatchKey(alias);
    if (k && sheetByKey.has(k)) return sheetByKey.get(k)!;
  }

  // Match frouxo: chave do banco contida no header ou vice-versa (mín. 5 chars)
  if (primary.length >= 5) {
    for (const [sheetKey, idx] of sheetByKey) {
      if (sheetKey.includes(primary) || primary.includes(sheetKey)) {
        if (Math.min(sheetKey.length, primary.length) >= 5) return idx;
      }
    }
  }

  return -1;
}

/**
 * Reordena linhas da planilha para a ordem das colunas do MySQL, casando por nome
 * (+ aliases), como o to_sql do pandas no sistema antigo.
 */
export function mapRowsToDbColumnOrder(params: {
  sheetHeaders: string[];
  sheetRows: string[][];
  dbColumns: MysqlColMeta[];
}): { headers: string[]; rows: string[][]; missingColumns: string[] } {
  const { sheetHeaders, sheetRows, dbColumns } = params;
  const deduped = dedupeHeadersPandasStyle(sheetHeaders);

  const sheetByKey = new Map<string, number>();
  for (let i = 0; i < deduped.length; i++) {
    const key = headerMatchKey(deduped[i] ?? "");
    if (key && !sheetByKey.has(key)) sheetByKey.set(key, i);
  }

  // Colunas do MySQL sem par na planilha → string vazia (não bloqueia o import).
  const missing: string[] = [];
  const indices = dbColumns.map((col) => {
    const idx = resolveSheetIndex(col.name, sheetByKey);
    if (idx < 0) {
      missing.push(col.name);
      return -1;
    }
    return idx;
  });

  if (missing.length > 0) {
    console.warn(
      `[columnMap] ${missing.length} col(s) MySQL sem par na planilha → vazias: ${missing.join(", ")}`,
    );
  }

  const rows = sheetRows.map((row) =>
    indices.map((i) => (i < 0 ? "" : String(row[i] ?? "").trim())),
  );

  return {
    headers: dbColumns.map((c) => c.name),
    rows,
    missingColumns: missing,
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
