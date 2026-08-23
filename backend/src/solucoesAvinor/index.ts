// backend/src/solucoesAvinor/index.ts
export {
  listCodedSolutions,
  getCodedSolution,
  companyUsesCodedSolution,
} from "./registry.js";
export { AVINOR_CLIENTES, AVINOR_CLIENTES_HEADERS } from "./avinorClientes.js";
export type {
  CodedSolution,
  SnapshotSummary,
  CodedSolutionRunResult,
} from "./types.js";
