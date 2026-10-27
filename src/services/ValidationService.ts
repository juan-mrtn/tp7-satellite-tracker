import { OrbitalEngine } from '../core/orbital/OrbitalEngine';
import type { Observer, OrbitalElements } from '../core/orbital/types';
import { compareToReference } from '../core/validation';
import type { CacheStore, ValidationRecord } from '../data/cache/CacheStore';
import type { ValidationOutcome } from '../data/DataProvider';

export interface ValidationRun {
  records: ValidationRecord[];
  failures: { provider: string; label: string; error: string }[];
}

/**
 * Ejecuta la validación cruzada (RF-15): pide la posición a N2YO y/o Where the ISS at?,
 * calcula localmente la posición en el mismo instante, mide el error y lo persiste.
 */
export async function runValidation(
  source: { fetchValidationPositions(noradId: number, observer: Observer): Promise<ValidationOutcome[]> },
  store: Pick<CacheStore, 'addValidationRecord'>,
  elements: OrbitalElements,
  observer: Observer,
  now: number = Date.now()
): Promise<ValidationRun> {
  const engine = new OrbitalEngine(elements);
  const outcomes = await source.fetchValidationPositions(elements.noradId, observer);
  const run: ValidationRun = { records: [], failures: [] };

  for (const o of outcomes) {
    if (!o.position) {
      run.failures.push({ provider: o.provider, label: o.label, error: o.error ?? 'sin datos' });
      continue;
    }
    const record = compareToReference(engine, o.position, now);
    if (!record) {
      run.failures.push({ provider: o.provider, label: o.label, error: 'SGP4 no pudo propagar ese instante' });
      continue;
    }
    await store.addValidationRecord(record);
    run.records.push(record);
  }
  return run;
}
