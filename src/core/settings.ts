import type { Observer } from './orbital/types';
import type { CatalogGroup } from '../data/types';

export interface AppSettings {
  /** TTL de la caché orbital en horas (12–24). */
  ttlHours: number;
  /** Elevación mínima para considerar un pase, grados. */
  minElevationDeg: number;
  /** Minutos de anticipación del recordatorio. */
  notifyMinutes: number;
  /** Máximo de satélites dibujados en la capa de constelación. */
  constellationLimit: number;
  /** Refresco del marcador en tiempo real, segundos (1–5). */
  positionRefreshSec: number;
  /** Elevación mínima usada para dimensionar el footprint, grados. */
  footprintMinElevationDeg: number;
  showGroundTrack: boolean;
  showFootprint: boolean;
  constellationGroup: CatalogGroup | null;
  selectedNoradId: number;
  trackedNoradIds: number[];
  /** Última ubicación conocida (la usa la tarea en segundo plano, que no tiene GPS). */
  lastObserver: Observer | null;
}

export const DEFAULT_SETTINGS: AppSettings = {
  ttlHours: 12,
  minElevationDeg: 10,
  notifyMinutes: 10,
  constellationLimit: 150,
  positionRefreshSec: 2,
  footprintMinElevationDeg: 10,
  showGroundTrack: true,
  showFootprint: true,
  constellationGroup: null,
  selectedNoradId: 25544,
  trackedNoradIds: [],
  lastObserver: null,
};

const GROUPS: CatalogGroup[] = ['stations', 'starlink', 'gps', 'weather', 'geo'];

const num = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;

/** Valida y acota lo leído del almacenamiento: datos viejos o corruptos nunca rompen la app. */
export function sanitizeSettings(raw: unknown): AppSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  const obs = r.lastObserver as Partial<Observer> | null | undefined;
  const validObserver =
    obs &&
    typeof obs.latitude === 'number' &&
    typeof obs.longitude === 'number' &&
    Math.abs(obs.latitude) <= 90 &&
    Math.abs(obs.longitude) <= 180;

  return {
    ttlHours: num(r.ttlHours, 12, 24, d.ttlHours),
    minElevationDeg: num(r.minElevationDeg, 0, 80, d.minElevationDeg),
    notifyMinutes: num(r.notifyMinutes, 1, 120, d.notifyMinutes),
    constellationLimit: Math.round(num(r.constellationLimit, 10, 500, d.constellationLimit)),
    positionRefreshSec: Math.round(num(r.positionRefreshSec, 1, 5, d.positionRefreshSec)),
    footprintMinElevationDeg: num(r.footprintMinElevationDeg, 0, 60, d.footprintMinElevationDeg),
    showGroundTrack: typeof r.showGroundTrack === 'boolean' ? r.showGroundTrack : d.showGroundTrack,
    showFootprint: typeof r.showFootprint === 'boolean' ? r.showFootprint : d.showFootprint,
    constellationGroup: GROUPS.includes(r.constellationGroup as CatalogGroup)
      ? (r.constellationGroup as CatalogGroup)
      : null,
    selectedNoradId: Math.round(num(r.selectedNoradId, 1, 999_999, d.selectedNoradId)),
    trackedNoradIds: Array.isArray(r.trackedNoradIds)
      ? [...new Set(r.trackedNoradIds.filter((n): n is number => Number.isInteger(n) && n > 0))].slice(0, 20)
      : [],
    lastObserver: validObserver
      ? {
          latitude: obs.latitude as number,
          longitude: obs.longitude as number,
          altitudeKm: typeof obs.altitudeKm === 'number' && Number.isFinite(obs.altitudeKm) ? obs.altitudeKm : 0,
        }
      : null,
  };
}
