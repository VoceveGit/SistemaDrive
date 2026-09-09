// backend/src/solucoesAvinor/headerTitles.ts
// Listas oficiais de títulos + busca linha a linha (sem janela fixa).

import { headerMatchKey } from "./columnMap.js";

/** Títulos Estoque Avinor (ordem da planilha). */
export const ESTOQUE_SHEET_TITLES = [
  "Código",
  "Descrição Produto",
  "Ultima saida",
  "Peso Unit.",
  "Saldo Anterior",
  "Produção",
  "Entradas",
  "Saídas",
  "Saldo Atual",
  "Volumes",
  "Estoque + Túneis",
  "Volumes Estoque + Túneis",
] as const;

/** Títulos Faturamento Avinor (ordem da planilha). */
export const FATURAMENTO_SHEET_TITLES = [
  "Vendedor",
  "Nome",
  "Data",
  "Mês",
  "Meio Venda",
  "Devolução",
  "Uni",
  "Série",
  "Número",
  "Pedido",
  "Romaneio",
  "Frete",
  "Cliente",
  "Rede",
  "Razão Social",
  "Tipo de Cliente",
  "Nome Fantasia",
  "Rota Cliente",
  "Rota Pedido",
  "Cidade",
  "UF",
  "Ramo Ativ.",
  "Produto",
  "Descrição",
  "UM",
  "Família",
  "CFOP",
  "Descrição",
  "Volumes",
  "Peso",
  "Lista",
  "Ocorr",
  "Pre.Base",
  "Preço Praticado",
  "Valor Produto",
  "Desconto Comercial",
  "Valor Total Faturado",
  "Desc. Finan.",
  "Nota Refaturada",
  "Romaneio Refaturada",
  "Nota Devolução",
  "Cliente Original",
  "Cond. Pag. Cliente",
  "Cond. Pag. Nota",
] as const;

/** Sinônimos leves título esperado ↔ célula (além do headerMatchKey). */
const TITLE_EQUIV: Record<string, string[]> = {
  tipodecliente: ["tipocliente", "tpcliente"],
  rotacliente: ["rotacadcliente"],
  rotapedido: ["rotagravpedido"],
  ramoativ: ["ramoatividade", "ramoativ"],
  prebase: ["precobase", "pbase", "vlbase", "valorbase", "preco base"],
  precopraticado: ["precopratic"],
  descontocomercial: ["desccomercial", "percentdesccomercial"],
  valortotalfaturado: ["valortotal"],
  descfinan: ["descontofinanceiro", "percentdescfinan", "percentdescontofinanceiro"],
  condpagcliente: ["condpagtocliente"],
  condpagnota: ["condpagtonota"],
  estoquetuneis: ["estoquetuneis", "estoquetunel"],
  volumesestoquetuneis: ["volestoquetuneis", "volumesestoquetuneis"],
  pesounit: ["pesounitario", "peso"],
  ultimasaida: ["ultimasaida"],
  saldoatual: ["saldo"],
  saldoanterior: ["saldoant"],
  numero: ["nro", "num"],
  serie: ["serie"],
  devolucao: ["devolucao"],
  familia: ["familia"],
  ocorr: ["ocorrencia"],
};

function titlesEquivalent(expectedKey: string, cellKey: string): boolean {
  if (!expectedKey || !cellKey) return false;
  if (expectedKey === cellKey) return true;
  const alts = TITLE_EQUIV[expectedKey] ?? [];
  if (alts.includes(cellKey)) return true;
  // Célula mais curta mas cobre o esperado (ex.: "Descricao" vs "DescricaoProduto" não)
  if (expectedKey.length >= 5 && cellKey.length >= 5) {
    if (expectedKey.startsWith(cellKey) || cellKey.startsWith(expectedKey)) {
      const longer = Math.max(expectedKey.length, cellKey.length);
      const shorter = Math.min(expectedKey.length, cellKey.length);
      if (shorter / longer >= 0.75) return true;
    }
  }
  return false;
}

export type HeaderListMatch = {
  matched: number;
  expected: number;
  ratio: number;
  /** true se a sequência começou e quebrou cedo (ex.: 2 ok, 3ª errada) */
  brokeEarly: boolean;
};

/**
 * Compara a linha com a lista de títulos em ordem.
 * Células vazias no meio (merge) são puladas na planilha.
 * Se já começou a casar e a próxima célula preenchida não bate → brokeEarly.
 */
export function scoreHeaderRowAgainstTitles(
  rowCells: string[],
  expectedTitles: readonly string[],
): HeaderListMatch {
  const expectedKeys = expectedTitles.map((t) => headerMatchKey(t));
  let ei = 0;
  let matched = 0;
  let started = false;
  let brokeEarly = false;

  for (const raw of rowCells) {
    const cellKey = headerMatchKey(raw ?? "");
    if (!cellKey) continue;

    const want = expectedKeys[ei];
    if (!want) break;

    if (titlesEquivalent(want, cellKey)) {
      matched += 1;
      ei += 1;
      started = true;
      if (ei >= expectedKeys.length) break;
    } else if (started) {
      brokeEarly = true;
      break;
    }
    // ainda não começou: segue procurando o 1º título nesta linha
  }

  const expected = expectedTitles.length;
  return {
    matched,
    expected,
    ratio: expected ? matched / expected : 0,
    brokeEarly,
  };
}

export function isGoodHeaderListMatch(m: HeaderListMatch): boolean {
  if (m.matched < 3) return false;
  // Quase a lista toda, ou boa parte sem quebrar cedo demais
  if (m.ratio >= 0.7) return true;
  if (m.matched >= 8 && m.ratio >= 0.55 && !m.brokeEarly) return true;
  // Estoque curto (12 cols): 8+ ok
  if (m.expected <= 14 && m.matched >= Math.ceil(m.expected * 0.65)) return true;
  return false;
}
