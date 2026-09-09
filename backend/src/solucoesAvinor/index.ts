// backend/src/solucoesAvinor/index.ts
export {
  listCodedSolutions,
  getCodedSolution,
  companyUsesCodedSolution,
} from "./registry.js";
export { AVINOR_CLIENTES, AVINOR_CLIENTES_HEADERS } from "./avinorClientes.js";
export { AVINOR_PEDIDOS } from "./avinorPedidos.js";
export { AVINOR_FATURAMENTO } from "./avinorFaturamento.js";
export { AVINOR_ESTOQUE } from "./avinorEstoque.js";
export {
  ESTOQUE_SHEET_TITLES,
  FATURAMENTO_SHEET_TITLES,
} from "./headerTitles.js";
export type {
  CodedSolution,
  SnapshotSummary,
  PedidosSummary,
  FaturamentoSummary,
  CodedImportSummary,
  CodedSolutionRunResult,
} from "./types.js";
export {
  dedupeHeadersPandasStyle,
  mapRowsToDbColumnOrder,
  ffillAllColumns,
} from "./columnMap.js";
