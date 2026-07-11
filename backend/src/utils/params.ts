// backend/src/utils/params.ts — Helpers para parâmetros Express

export function paramId(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}
