import { OrbitalEngine } from '../core/orbital/OrbitalEngine';
import type { Observer, OrbitalElements, Pass } from '../core/orbital/types';
import type { AppSettings } from '../core/settings';
import type { DataResult } from '../data/types';

export interface RefreshDeps {
  settings: Pick<AppSettings, 'trackedNoradIds' | 'lastObserver' | 'minElevationDeg' | 'notifyMinutes'>;
  getSatellite(noradId: number): Promise<DataResult<OrbitalElements>>;
  replaceReminders(noradId: number, name: string, passes: Pass[], minutesBefore: number): Promise<number>;
  now(): number;
  /** Horizonte de pases a agendar, en horas. Los avisos quedan programados aunque la app no se abra. */
  horizonHours?: number;
}

export interface RefreshReport {
  refreshed: number;
  scheduled: number;
  failures: { noradId: number; error: string }[];
}

/**
 * Recalcula los próximos pases de los satélites seguidos y reagenda sus avisos. La usan la
 * tarea en segundo plano y el botón "seguir satélite".
 *
 * Los datos orbitales pasan por el orquestador, que respeta el TTL: aunque la tarea corra
 * seguido, solo hay red cuando la caché venció. Los avisos se agendan con 72 h de
 * anticipación, así que siguen sonando aunque el sistema no ejecute la tarea (iOS la
 * difiere a ventanas que elige él).
 */
export async function refreshTrackedSatellites(deps: RefreshDeps): Promise<RefreshReport> {
  const report: RefreshReport = { refreshed: 0, scheduled: 0, failures: [] };
  const observer: Observer | null = deps.settings.lastObserver;
  if (!observer) return report; // sin ubicación conocida no hay pases que calcular

  for (const noradId of deps.settings.trackedNoradIds) {
    try {
      const { data: elements } = await deps.getSatellite(noradId);
      const engine = new OrbitalEngine(elements);
      const passes = await engine.predictPasses(observer, new Date(deps.now()), {
        minElevationDeg: deps.settings.minElevationDeg,
        horizonHours: deps.horizonHours ?? 72,
        maxPasses: 12,
      });
      report.scheduled += await deps.replaceReminders(
        noradId,
        elements.name,
        passes,
        deps.settings.notifyMinutes
      );
      report.refreshed++;
    } catch (e) {
      report.failures.push({ noradId, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return report;
}
