import { createSatRec } from './OrbitalEngine';
import * as satellite from 'satellite.js';
import type { SatRec } from 'satellite.js';
import { TimeSlicer } from './chunkScheduler';
import { normalizeLon } from './geo';
import type { OrbitalElements } from './types';

export interface ConstellationSnapshot {
  noradIds: Int32Array;
  /** Intercalado [lat, lon, altKm] por satélite; NaN si SGP4 falló. */
  data: Float32Array;
  count: number;
  computedAt: number;
}

/**
 * Propaga en lote un conjunto de satélites (capa de constelación).
 *
 * - Los `satrec` se construyen una sola vez (`load`), de forma cooperativa.
 * - `snapshot` propaga todos para un instante, en tandas con presupuesto de tiempo, y guarda
 *   el resultado en un Float32Array (sin objetos intermedios por satélite).
 */
export class ConstellationPropagator {
  private satrecs: SatRec[] = [];
  private ids: number[] = [];

  get size(): number {
    return this.satrecs.length;
  }

  async load(
    elements: readonly OrbitalElements[],
    options: { budgetMs?: number; signal?: AbortSignal } = {}
  ): Promise<{ loaded: number; skipped: number }> {
    const slicer = new TimeSlicer(options.budgetMs ?? 8, options.signal);
    const satrecs: SatRec[] = [];
    const ids: number[] = [];
    let skipped = 0;
    for (const el of elements) {
      try {
        satrecs.push(createSatRec(el));
        ids.push(el.noradId);
      } catch {
        skipped++;
      }
      await slicer.tick();
    }
    this.satrecs = satrecs;
    this.ids = ids;
    return { loaded: satrecs.length, skipped };
  }

  async snapshot(
    when: Date,
    options: { budgetMs?: number; signal?: AbortSignal } = {}
  ): Promise<ConstellationSnapshot> {
    const n = this.satrecs.length;
    const data = new Float32Array(n * 3);
    const gmst = satellite.gstime(when);
    const slicer = new TimeSlicer(options.budgetMs ?? 6, options.signal);

    for (let i = 0; i < n; i++) {
      const pv = satellite.propagate(this.satrecs[i] as SatRec, when) as ReturnType<
        typeof satellite.propagate
      > | null;
      const o = i * 3;
      if (pv && pv.position && typeof pv.position !== 'boolean') {
        const geo = satellite.eciToGeodetic(pv.position, gmst);
        data[o] = satellite.degreesLat(geo.latitude);
        data[o + 1] = normalizeLon(satellite.degreesLong(geo.longitude));
        data[o + 2] = geo.height;
      } else {
        data[o] = NaN;
        data[o + 1] = NaN;
        data[o + 2] = NaN;
      }
      await slicer.tick();
    }
    return { noradIds: Int32Array.from(this.ids), data, count: n, computedAt: when.getTime() };
  }
}
