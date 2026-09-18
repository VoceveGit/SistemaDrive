// backend/src/services/autoPollKick.ts
// Evita o Render Free dormir sem varrer o Drive: health/cron compartilham o mesmo kick.

import { pollAllCompanies } from "./googleDriveService.js";

let lastPollAt = 0;
let running = false;

/** Intervalo mínimo entre varreduras disparadas pelo /health (ms). Cron já roda a cada 1 min. */
const MIN_GAP_MS = 2 * 60_000;

export function markPollRan(): void {
  lastPollAt = Date.now();
}

/**
 * Se faz tempo que não roda poll, dispara em background (não bloqueia a resposta HTTP).
 * Usado pelo keep-alive do GitHub Actions em /api/health.
 */
export function maybeKickAutoPoll(reason: string): void {
  const now = Date.now();
  if (running) return;
  if (lastPollAt > 0 && now - lastPollAt < MIN_GAP_MS) return;

  running = true;
  lastPollAt = now;
  console.log(`[autoPoll] kick (${reason})`);
  pollAllCompanies()
    .catch((err) => console.error(`[autoPoll] kick falhou (${reason}):`, err))
    .finally(() => {
      running = false;
      markPollRan();
    });
}
