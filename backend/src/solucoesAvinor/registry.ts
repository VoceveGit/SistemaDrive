// backend/src/solucoesAvinor/registry.ts

import { AVINOR_CLIENTES } from "./avinorClientes.js";
import { AVINOR_PEDIDOS } from "./avinorPedidos.js";
import { AVINOR_FATURAMENTO } from "./avinorFaturamento.js";
import type { CodedSolution } from "./types.js";

const REGISTRY: Record<string, CodedSolution> = {
  [AVINOR_CLIENTES.id]: AVINOR_CLIENTES,
  [AVINOR_PEDIDOS.id]: AVINOR_PEDIDOS,
  [AVINOR_FATURAMENTO.id]: AVINOR_FATURAMENTO,
};

export function listCodedSolutions(): Array<{
  id: string;
  label: string;
  description: string;
  defaultTargetTable: string;
}> {
  return Object.values(REGISTRY).map((s) => ({
    id: s.id,
    label: s.label,
    description: s.description,
    defaultTargetTable: s.defaultTargetTable,
  }));
}

export function getCodedSolution(id: string | null | undefined): CodedSolution | null {
  if (!id) return null;
  return REGISTRY[id] ?? null;
}

export function companyUsesCodedSolution(company: {
  useCodedSolution?: boolean | null;
  codedSolutionId?: string | null;
}): CodedSolution | null {
  if (!company.useCodedSolution) return null;
  return getCodedSolution(company.codedSolutionId);
}
