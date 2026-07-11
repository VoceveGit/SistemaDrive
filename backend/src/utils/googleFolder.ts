// backend/src/utils/googleFolder.ts — Extrai ID de pasta do Google Drive

export function normalizeGoogleFolderId(input: string): string {
  const trimmed = input.trim();

  const folderMatch = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (folderMatch) return folderMatch[1];

  const idParamMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (idParamMatch) return idParamMatch[1];

  return trimmed;
}
