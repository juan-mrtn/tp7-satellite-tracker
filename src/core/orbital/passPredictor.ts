import { TimeSlicer, throwIfAborted } from './chunkScheduler';
import { clamp } from './geo';
import type { Pass } from './types';

/** Devuelve elevación/azimut (grados) del satélite visto desde el observador en `ms` (epoch ms). */
export type LookSampler = (ms: number) => { elevation: number; azimuth: number };

export interface PredictorConfig {
  startMs: number;
  horizonMs: number;
  minElevationDeg: number;
  maxPasses: number;
  /**
   * Cota superior de la velocidad angular de la elevación (grados/s). Permite agrandar el paso
   * cuando el satélite está lejos del horizonte sin riesgo de saltearse un pase.
   */
  maxElevationRateDegPerSec: number;
  budgetMs?: number;
  signal?: AbortSignal;
}

const MIN_STEP_S = 4;
const MAX_STEP_S = 300;
const REFINE_TOLERANCE_MS = 500;
const MAX_BACKTRACK_MS = 45 * 60 * 1000;

/**
 * Búsqueda de pases por refinamiento grueso → fino.
 *
 * 1. Barrido grueso con paso adaptativo: el paso crece con la distancia angular al umbral, pero
 *    nunca supera `(umbral − e) / velocidadMáxima`, por lo que el satélite no puede cruzar el
 *    umbral y volver a bajar entre dos muestras sin ser detectado.
 * 2. Al detectar un cambio de signo de (elevación − umbral) se refina AOS/LOS por bisección
 *    hasta 0,5 s.
 * 3. La elevación máxima (TCA) se obtiene por búsqueda ternaria dentro de [AOS, LOS], donde la
 *    elevación es unimodal.
 *
 * El trabajo se parte en tandas (TimeSlicer) para no bloquear el hilo de UI.
 */
export async function findPasses(sample: LookSampler, cfg: PredictorConfig): Promise<Pass[]> {
  const { startMs, minElevationDeg: minEl, maxPasses, signal } = cfg;
  const endMs = startMs + cfg.horizonMs;
  const rate = Math.max(cfg.maxElevationRateDegPerSec, 1e-4);
  const slicer = new TimeSlicer(cfg.budgetMs ?? 8, signal);
  const elevationAt = (ms: number) => sample(ms).elevation;

  /** Bisección del cruce del umbral entre `lo` y `hi` (uno debajo y otro arriba). */
  const refineCrossing = (lo: number, hi: number, risingAtHi: boolean): number => {
    let a = lo;
    let b = hi;
    for (let i = 0; i < 40 && b - a > REFINE_TOLERANCE_MS; i++) {
      const mid = (a + b) / 2;
      const above = elevationAt(mid) >= minEl;
      if (above === risingAtHi) b = mid;
      else a = mid;
    }
    // Devuelve el extremo que está "arriba" del umbral.
    return risingAtHi ? b : a;
  };

  const peakTime = (aos: number, los: number): number => {
    let a = aos;
    let b = los;
    for (let i = 0; i < 60 && b - a > REFINE_TOLERANCE_MS; i++) {
      const m1 = a + (b - a) / 3;
      const m2 = b - (b - a) / 3;
      if (elevationAt(m1) < elevationAt(m2)) a = m1;
      else b = m2;
    }
    return (a + b) / 2;
  };

  const buildPass = (
    aosRaw: number,
    losRaw: number,
    inProgress: boolean,
    truncated: boolean
  ): Pass => {
    // Los instantes se redondean al ms para que Date y durationSec sean consistentes.
    const aos = Math.round(aosRaw);
    const los = Math.round(losRaw);
    const tca = Math.round(peakTime(aos, los));
    const tcaLook = sample(tca);
    return {
      aos: new Date(aos),
      tca: new Date(tca),
      los: new Date(los),
      aosAzimuth: sample(aos).azimuth,
      tcaAzimuth: tcaLook.azimuth,
      losAzimuth: sample(los).azimuth,
      maxElevation: tcaLook.elevation,
      durationSec: (los - aos) / 1000,
      inProgress,
      truncated,
    };
  };

  const stepFor = (e: number): number => {
    // Segundos que el satélite necesitaría, como mínimo, para alcanzar el umbral (o salir de él).
    const gap = Math.abs(minEl - e);
    return clamp((gap / rate) * 0.9, MIN_STEP_S, MAX_STEP_S) * 1000;
  };

  const passes: Pass[] = [];
  let t = startMs;
  let e = elevationAt(t);
  let above = e >= minEl;
  let currentAos = 0;
  let inProgress = false;

  if (above) {
    // Pase en curso: se busca hacia atrás el AOS real (hasta 45 min).
    inProgress = true;
    currentAos = startMs;
    let tb = startMs;
    while (startMs - tb < MAX_BACKTRACK_MS) {
      const prev = tb - stepFor(elevationAt(tb));
      if (elevationAt(prev) < minEl) {
        currentAos = refineCrossing(prev, tb, true);
        break;
      }
      tb = prev;
    }
  }

  while (t < endMs) {
    const next = Math.min(t + stepFor(e), endMs);
    const eNext = elevationAt(next);
    const aboveNext = eNext >= minEl;

    if (!above && aboveNext) {
      currentAos = refineCrossing(t, next, true);
      inProgress = false;
    } else if (above && !aboveNext) {
      const los = refineCrossing(t, next, false);
      passes.push(buildPass(currentAos, los, inProgress, false));
      inProgress = false;
      if (passes.length >= maxPasses) return passes;
    }

    t = next;
    e = eNext;
    above = aboveNext;
    await slicer.tick();
  }

  throwIfAborted(signal);
  if (above) passes.push(buildPass(currentAos, endMs, inProgress, true));
  return passes;
}
