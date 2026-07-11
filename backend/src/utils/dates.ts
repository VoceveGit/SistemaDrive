// backend/src/utils/dates.ts — Utilitários de data para métricas

export function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
