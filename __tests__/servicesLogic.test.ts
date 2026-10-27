import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/core/settings';
import { selectVisible } from '../src/core/orbital/viewport';
import type { ConstellationSnapshot } from '../src/core/orbital/constellation';
import { refreshTrackedSatellites } from '../src/services/trackedRefresh';
import { runValidation } from '../src/services/ValidationService';
import { MemoryCacheStore } from '../src/data/cache/MemoryCacheStore';
import { OrbitalEngine } from '../src/core/orbital/OrbitalEngine';
import { ISS_EPOCH, ISS_TLE, OBSERVER } from './fixtures';

const snapshot = (pts: [number, number][]): ConstellationSnapshot => ({
  noradIds: Int32Array.from(pts.map((_, i) => i + 1)),
  data: Float32Array.from(pts.flatMap(([lat, lon]) => [lat, lon, 550])),
  count: pts.length,
  computedAt: 0,
});

describe('settings', () => {
  it('valores por defecto ante datos ausentes o corruptos', () => {
    expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings('basura')).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings({ ttlHours: 'x', trackedNoradIds: 5, lastObserver: { latitude: 'a' } })).toEqual(DEFAULT_SETTINGS);
  });

  it('acota rangos: TTL 12–24 h, refresco 1–5 s, sin duplicados en seguidos', () => {
    const s = sanitizeSettings({ ttlHours: 1, positionRefreshSec: 99, constellationLimit: 99999, trackedNoradIds: [1, 1, 2, -3, 'x', 4.5], notifyMinutes: 0 });
    expect(s.ttlHours).toBe(12);
    expect(s.positionRefreshSec).toBe(5);
    expect(s.constellationLimit).toBe(500);
    expect(s.trackedNoradIds).toEqual([1, 2]);
    expect(s.notifyMinutes).toBe(1);
    expect(sanitizeSettings({ ttlHours: 99 }).ttlHours).toBe(24);
  });

  it('descarta ubicaciones fuera de rango y grupos desconocidos', () => {
    expect(sanitizeSettings({ lastObserver: { latitude: 120, longitude: 0 } }).lastObserver).toBeNull();
    expect(sanitizeSettings({ lastObserver: { latitude: -31, longitude: -60 } }).lastObserver).toEqual({ latitude: -31, longitude: -60, altitudeKm: 0 });
    expect(sanitizeSettings({ constellationGroup: 'nope' }).constellationGroup).toBeNull();
    expect(sanitizeSettings({ constellationGroup: 'starlink' }).constellationGroup).toBe('starlink');
  });
});

describe('capa de constelación: selección de visibles', () => {
  const region = { latitude: 0, longitude: 0, latitudeDelta: 40, longitudeDelta: 40 };

  it('filtra por la región visible (con margen) y descarta NaN', () => {
    const snap = snapshot([[0, 0], [10, 10], [50, 0], [0, 100], [NaN, NaN]]);
    expect(selectVisible(snap, region, 100).map((s) => s.noradId)).toEqual([1, 2]);
  });

  it('respeta el antimeridiano: región centrada en 179° incluye satélites en -178°', () => {
    const snap = snapshot([[0, -178], [0, 170], [0, 0]]);
    const r = { latitude: 0, longitude: 179, latitudeDelta: 20, longitudeDelta: 20 };
    expect(selectVisible(snap, r, 100).map((s) => s.noradId)).toEqual([1, 2]);
  });

  it('si hay más que el límite devuelve una muestra uniforme y estable', () => {
    const pts: [number, number][] = Array.from({ length: 1000 }, (_, i) => [0, (i % 20) - 10]);
    const a = selectVisible(snapshot(pts), region, 100);
    const b = selectVisible(snapshot(pts), region, 100);
    expect(a).toHaveLength(100);
    expect(a.map((s) => s.noradId)).toEqual(b.map((s) => s.noradId));
    expect(new Set(a.map((s) => s.noradId)).size).toBe(100);
  });

  it('sin región (mapa mundial) toma todos hasta el límite', () => {
    expect(selectVisible(snapshot([[80, 170], [-60, -100]]), null, 10)).toHaveLength(2);
    expect(selectVisible(snapshot([[0, 0], [0, 1], [0, 2]]), { ...region, longitudeDelta: 360 }, 2)).toHaveLength(2);
  });
});

describe('refresco de satélites seguidos', () => {
  const base = {
    settings: { trackedNoradIds: [25544, 99999], lastObserver: OBSERVER, minElevationDeg: 10, notifyMinutes: 15 },
    now: () => ISS_EPOCH.getTime(),
  };

  it('recalcula pases con la ubicación guardada y reagenda; un satélite que falla no frena al resto', async () => {
    const scheduled: { id: number; passes: number; minutes: number }[] = [];
    const report = await refreshTrackedSatellites({
      ...base,
      getSatellite: async (id) => {
        if (id === 99999) throw new Error('sin datos');
        return { data: ISS_TLE, meta: {} as never };
      },
      replaceReminders: async (id, _n, passes, minutes) => {
        scheduled.push({ id, passes: passes.length, minutes });
        return passes.length;
      },
    });
    expect(report.refreshed).toBe(1);
    expect(report.failures).toEqual([{ noradId: 99999, error: 'sin datos' }]);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({ id: 25544, minutes: 15 });
    expect(scheduled[0]!.passes).toBeGreaterThan(3); // ~4–6 pases útiles por día para la ISS en 72 h
    expect(report.scheduled).toBe(scheduled[0]!.passes);
  });

  it('sin ubicación guardada no hace nada', async () => {
    const getSatellite = jest.fn();
    const report = await refreshTrackedSatellites({
      ...base,
      settings: { ...base.settings, lastObserver: null },
      getSatellite,
      replaceReminders: jest.fn(),
    });
    expect(report).toEqual({ refreshed: 0, scheduled: 0, failures: [] });
    expect(getSatellite).not.toHaveBeenCalled();
  });
});

describe('ValidationService', () => {
  const engine = new OrbitalEngine(ISS_TLE);
  const t = ISS_EPOCH.getTime() + 600_000;
  const local = engine.positionAt(t)!;

  it('persiste una medición por fuente que respondió y reporta las que fallaron', async () => {
    const store = new MemoryCacheStore();
    const run = await runValidation(
      {
        fetchValidationPositions: async () => [
          { provider: 'n2yo', label: 'N2YO', position: { provider: 'n2yo', noradId: 25544, timestampMs: t, ...local, altitudeKm: local.altitudeKm + 2 } },
          { provider: 'wheretheiss', label: 'Where the ISS at?', error: 'timeout' },
        ],
      },
      store,
      ISS_TLE,
      OBSERVER,
      123
    );
    expect(run.records).toHaveLength(1);
    expect(run.records[0]).toMatchObject({ reference: 'n2yo', createdAt: 123, noradId: 25544 });
    expect(run.records[0]!.errorKm).toBeCloseTo(2, 6);
    expect(run.failures).toEqual([{ provider: 'wheretheiss', label: 'Where the ISS at?', error: 'timeout' }]);
    expect(await store.listValidationRecords(10)).toHaveLength(1);
  });
});
