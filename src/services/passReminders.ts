import type { Pass } from '../core/orbital/types';
import { compassName, formatDuration } from '../core/format';

export interface PlannedReminder {
  id: string;
  fireAt: Date;
  noradId: number;
  satelliteName: string;
  pass: Pass;
  minutesBefore: number;
}

export const REMINDER_PREFIX = 'pass:';

/** Id estable por satélite + AOS (al segundo). El prefijo permite cancelar todos los de un satélite. */
export const reminderId = (noradId: number, aosMs: number) =>
  `${REMINDER_PREFIX}${noradId}:${Math.round(aosMs / 1000)}`;

export const reminderPrefixFor = (noradId: number) => `${REMINDER_PREFIX}${noradId}:`;

/**
 * Qué recordatorios agendar: uno por pase, `minutesBefore` antes del AOS. Se omiten los pases
 * cuyo aviso ya pasó. `maxCount` acota la cantidad (iOS admite 64 notificaciones locales
 * pendientes en total).
 */
export function planReminders(
  passes: readonly Pass[],
  opts: { noradId: number; satelliteName: string; minutesBefore: number; now: number; maxCount: number }
): PlannedReminder[] {
  return passes
    .map((pass) => ({
      id: reminderId(opts.noradId, pass.aos.getTime()),
      fireAt: new Date(pass.aos.getTime() - opts.minutesBefore * 60_000),
      noradId: opts.noradId,
      satelliteName: opts.satelliteName,
      pass,
      minutesBefore: opts.minutesBefore,
    }))
    .filter((r) => r.fireAt.getTime() > opts.now + 5_000)
    .sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime())
    .slice(0, opts.maxCount);
}

export function reminderContent(r: PlannedReminder): { title: string; body: string } {
  return {
    title: `${r.satelliteName}: pase en ${r.minutesBefore} min`,
    body:
      `Aparece por el ${compassName(r.pass.aosAzimuth)}, elevación máxima ${Math.round(r.pass.maxElevation)}°, ` +
      `dura ${formatDuration(r.pass.durationSec)}.`,
  };
}
