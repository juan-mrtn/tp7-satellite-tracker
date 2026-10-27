/** Antigüedad de los datos orbitales (RF-16). */

export type FreshnessLevel = 'fresh' | 'aging' | 'stale';

/** Los elementos de una LEO se degradan ~1–3 km por día; más de una semana ya no es confiable. */
export const EPOCH_AGING_DAYS = 3;
export const EPOCH_STALE_DAYS = 7;

export interface Freshness {
  level: FreshnessLevel;
  /** Días transcurridos desde la época de los elementos orbitales. */
  epochAgeDays: number;
  /** Horas transcurridas desde la última descarga. */
  fetchAgeHours: number;
  /** La descarga superó el TTL configurado (datos sin poder refrescarse). */
  ttlExpired: boolean;
}

export function assessFreshness(
  epochIso: string,
  fetchedAt: number,
  now: number,
  ttlMs: number
): Freshness {
  const epoch = Date.parse(epochIso.endsWith('Z') ? epochIso : `${epochIso}Z`);
  const epochAgeDays = (now - epoch) / 86_400_000;
  const fetchAgeMs = now - fetchedAt;
  const ttlExpired = fetchAgeMs > ttlMs;

  let level: FreshnessLevel = 'fresh';
  if (epochAgeDays > EPOCH_STALE_DAYS) level = 'stale';
  else if (epochAgeDays > EPOCH_AGING_DAYS || ttlExpired) level = 'aging';

  return { level, epochAgeDays, fetchAgeHours: fetchAgeMs / 3_600_000, ttlExpired };
}

export function formatAge(days: number): string {
  if (days < 1) return `${Math.max(0, Math.round(days * 24))} h`;
  return `${days.toFixed(1)} d`;
}
