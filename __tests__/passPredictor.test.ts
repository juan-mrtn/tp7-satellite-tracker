import { OrbitalEngine } from '../src/core/orbital/OrbitalEngine';
import { findPasses } from '../src/core/orbital/passPredictor';
import { AbortError } from '../src/core/orbital/chunkScheduler';
import { ISS_TLE, ISS_EPOCH, OBSERVER } from './fixtures';

const engine = new OrbitalEngine(ISS_TLE);
const MIN_EL = 10;

/** Referencia ingenua: elevación cada 1 s, sin ninguna optimización. */
function bruteForce(startMs: number, hours: number) {
  const out: { aos: number; los: number; max: number }[] = [];
  let above = false;
  let aos = 0;
  let max = -90;
  for (let t = startMs; t <= startMs + hours * 3_600_000; t += 1000) {
    const el = engine.lookAnglesAt(t, OBSERVER)!.elevation;
    if (!above && el >= MIN_EL) {
      above = true;
      aos = t;
      max = el;
    } else if (above) {
      max = Math.max(max, el);
      if (el < MIN_EL) {
        out.push({ aos, los: t, max });
        above = false;
      }
    }
  }
  return out;
}

describe('predictor de pases', () => {
  const start = ISS_EPOCH.getTime();
  let passes: Awaited<ReturnType<typeof engine.predictPasses>>;
  let reference: ReturnType<typeof bruteForce>;

  beforeAll(async () => {
    passes = await engine.predictPasses(OBSERVER, new Date(start), {
      minElevationDeg: MIN_EL,
      horizonHours: 24,
      maxPasses: 100,
    });
    reference = bruteForce(start, 24);
  });

  it('encuentra los mismos pases que la fuerza bruta a 1 s', () => {
    // La fuerza bruta puede cortar un pase que ya estaba en curso en t0; se compara desde el primero completo.
    const complete = passes.filter((p) => !p.inProgress && !p.truncated);
    expect(reference.length).toBeGreaterThan(0);
    expect(complete.length).toBe(reference.length);
  });

  it('AOS y LOS coinciden con la referencia (±2 s) y la elevación máxima (±0,05°)', () => {
    const complete = passes.filter((p) => !p.inProgress && !p.truncated);
    complete.forEach((p, i) => {
      const ref = reference[i]!;
      expect(Math.abs(p.aos.getTime() - ref.aos)).toBeLessThanOrEqual(2000);
      expect(Math.abs(p.los.getTime() - ref.los)).toBeLessThanOrEqual(2000);
      expect(Math.abs(p.maxElevation - ref.max)).toBeLessThanOrEqual(0.05);
    });
  });

  it('cada pase es coherente: AOS < TCA < LOS, azimut válido, elevación máxima ≥ umbral', () => {
    for (const p of passes) {
      expect(p.aos.getTime()).toBeLessThan(p.tca.getTime());
      expect(p.tca.getTime()).toBeLessThan(p.los.getTime());
      expect(p.maxElevation).toBeGreaterThanOrEqual(MIN_EL);
      expect(p.durationSec).toBeCloseTo((p.los.getTime() - p.aos.getTime()) / 1000, 6);
      for (const az of [p.aosAzimuth, p.tcaAzimuth, p.losAzimuth]) {
        expect(az).toBeGreaterThanOrEqual(0);
        expect(az).toBeLessThan(360);
      }
    }
  });

  it('una LEO tiene pases de pocos minutos', () => {
    for (const p of passes.filter((x) => !x.inProgress && !x.truncated)) {
      expect(p.durationSec).toBeGreaterThan(10);
      expect(p.durationSec).toBeLessThan(15 * 60);
    }
  });

  it('si la búsqueda arranca dentro de un pase lo marca inProgress y recupera el AOS real', async () => {
    const first = passes.find((p) => !p.inProgress && !p.truncated)!;
    const mid = new Date((first.aos.getTime() + first.los.getTime()) / 2);
    const res = await engine.predictPasses(OBSERVER, mid, {
      minElevationDeg: MIN_EL,
      horizonHours: 6,
      maxPasses: 1,
    });
    expect(res[0]!.inProgress).toBe(true);
    expect(Math.abs(res[0]!.aos.getTime() - first.aos.getTime())).toBeLessThanOrEqual(1000);
    expect(Math.abs(res[0]!.los.getTime() - first.los.getTime())).toBeLessThanOrEqual(1000);
  });

  it('respeta maxPasses', async () => {
    const res = await engine.predictPasses(OBSERVER, new Date(start), { maxPasses: 2 });
    expect(res).toHaveLength(2);
  });

  it('una elevación mínima mayor devuelve menos pases', async () => {
    const low = await engine.predictPasses(OBSERVER, new Date(start), { minElevationDeg: 5, horizonHours: 48, maxPasses: 100 });
    const high = await engine.predictPasses(OBSERVER, new Date(start), { minElevationDeg: 40, horizonHours: 48, maxPasses: 100 });
    expect(high.length).toBeLessThan(low.length);
  });

  it('cede el hilo (setTimeout) mientras calcula y no necesita muchas muestras', async () => {
    const spy = jest.spyOn(globalThis, 'setTimeout');
    let samples = 0;
    const res = await findPasses(
      (ms) => {
        samples++;
        return engine.lookAnglesAt(ms, OBSERVER)!;
      },
      {
        startMs: start,
        horizonMs: 48 * 3_600_000,
        minElevationDeg: MIN_EL,
        maxPasses: 100,
        maxElevationRateDegPerSec: engine.maxElevationRateDegPerSec,
        budgetMs: 2,
      }
    );
    expect(res.length).toBeGreaterThan(0);
    expect(spy).toHaveBeenCalled();
    // Barrido ingenuo cada 5 s en 48 h = 34 560 muestras; el paso adaptativo debe ser bastante menor.
    expect(samples).toBeLessThan(34_560);
    spy.mockRestore();
  }, 30_000);

  it('se puede cancelar con AbortSignal', async () => {
    const ac = new AbortController();
    const p = engine.predictPasses(OBSERVER, new Date(start), {
      horizonHours: 240,
      maxPasses: 1000,
      budgetMs: 0,
      signal: ac.signal,
    });
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(AbortError);
  });
});
