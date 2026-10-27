import { OrbitalEngine, elementsAgeDays, OrbitalError } from '../src/core/orbital/OrbitalEngine';
import { ConstellationPropagator } from '../src/core/orbital/constellation';
import { distance3dKm, normalizeLon, haversineKm } from '../src/core/orbital/geo';
import { ISS_TLE, ISS_EPOCH, OBSERVER, VALLADO_00005, VALLADO_00005_OMM } from './fixtures';

const valladoEpoch = Date.parse('2000-06-27T18:50:19.733568Z');

describe('OrbitalEngine – SGP4', () => {
  it('reproduce el vector de prueba de Vallado (t = 0 y t = 360 min)', () => {
    const engine = new OrbitalEngine(VALLADO_00005);
    const p0 = engine.eciAt(valladoEpoch)!.position;
    expect(p0.x).toBeCloseTo(7022.46529266, 1);
    expect(p0.y).toBeCloseTo(-1400.08296755, 1);
    expect(p0.z).toBeCloseTo(0.03995155, 1);
    const p360 = engine.eciAt(valladoEpoch + 360 * 60_000)!.position;
    expect(p360.x).toBeCloseTo(-7154.03120202, 1);
    expect(p360.y).toBeCloseTo(-3783.17682504, 1);
    expect(p360.z).toBeCloseTo(-3536.19412294, 1);
  });

  it('OMM/JSON y TLE producen la misma posición', () => {
    const fromTle = new OrbitalEngine(VALLADO_00005);
    const fromOmm = new OrbitalEngine({
      noradId: 5,
      name: 'VANGUARD 1',
      epoch: VALLADO_00005_OMM.EPOCH,
      omm: VALLADO_00005_OMM,
    });
    const t = valladoEpoch + 360 * 60_000;
    expect(distance3dKm(fromTle.positionAt(t)!, fromOmm.positionAt(t)!)).toBeLessThan(0.5);
  });

  it('acepta números de catálogo de 6 dígitos en OMM (no existen en TLE)', () => {
    const engine = new OrbitalEngine({
      noradId: 123456,
      name: 'NUEVO OBJETO',
      epoch: VALLADO_00005_OMM.EPOCH,
      omm: { ...VALLADO_00005_OMM, NORAD_CAT_ID: 123456 },
    });
    expect(engine.positionAt(valladoEpoch + 3_600_000)).not.toBeNull();
  });

  it('lanza OrbitalError si no hay datos', () => {
    expect(() => new OrbitalEngine({ noradId: 1, name: 'x', epoch: '2020-01-01T00:00:00Z' })).toThrow(
      OrbitalError
    );
  });

  it('la ISS está a ~400 km y dentro de su banda de inclinación', () => {
    const engine = new OrbitalEngine(ISS_TLE);
    for (let m = 0; m < 200; m += 10) {
      const p = engine.positionAt(ISS_EPOCH.getTime() + m * 60_000)!;
      expect(p.altitudeKm).toBeGreaterThan(380);
      expect(p.altitudeKm).toBeLessThan(440);
      expect(Math.abs(p.latitude)).toBeLessThanOrEqual(51.7);
      expect(p.longitude).toBeGreaterThan(-180);
      expect(p.longitude).toBeLessThanOrEqual(180);
    }
    expect(engine.periodMinutes).toBeGreaterThan(90);
    expect(engine.periodMinutes).toBeLessThan(94);
  });

  it('un observador bajo el satélite lo ve a ~90° de elevación', () => {
    const engine = new OrbitalEngine(ISS_TLE);
    const when = ISS_EPOCH.getTime() + 30 * 60_000;
    const sub = engine.positionAt(when)!;
    const look = engine.lookAnglesAt(when, {
      latitude: sub.latitude,
      longitude: sub.longitude,
      altitudeKm: 0,
    })!;
    expect(look.elevation).toBeGreaterThan(89);
    expect(Math.abs(look.rangeKm - sub.altitudeKm)).toBeLessThan(15);
  });

  it('azimut en [0, 360) y elevación en [-90, 90]', () => {
    const engine = new OrbitalEngine(ISS_TLE);
    for (let m = 0; m < 300; m += 7) {
      const look = engine.lookAnglesAt(ISS_EPOCH.getTime() + m * 60_000, OBSERVER)!;
      expect(look.azimuth).toBeGreaterThanOrEqual(0);
      expect(look.azimuth).toBeLessThan(360);
      expect(look.elevation).toBeGreaterThanOrEqual(-90);
      expect(look.elevation).toBeLessThanOrEqual(90);
    }
  });

  it('calcula la antigüedad de los elementos en días', () => {
    const age = elementsAgeDays(ISS_TLE, new Date('2019-06-07T12:12:58Z'));
    expect(age).toBeCloseTo(2, 3);
  });
});

describe('Constelación en lote', () => {
  it('propaga N satélites y coincide con el motor individual', async () => {
    const list = Array.from({ length: 60 }, (_, i) => ({ ...ISS_TLE, noradId: 90000 + i }));
    const prop = new ConstellationPropagator();
    const res = await prop.load(list);
    expect(res).toEqual({ loaded: 60, skipped: 0 });
    const when = new Date(ISS_EPOCH.getTime() + 600_000);
    const snap = await prop.snapshot(when);
    expect(snap.count).toBe(60);
    const ref = new OrbitalEngine(ISS_TLE).positionAt(when)!;
    expect(snap.data[0]).toBeCloseTo(ref.latitude, 3);
    expect(snap.data[1]).toBeCloseTo(ref.longitude, 3);
    expect(snap.noradIds[59]).toBe(90059);
  });

  it('descarta elementos inválidos sin romper el lote', async () => {
    const prop = new ConstellationPropagator();
    const res = await prop.load([ISS_TLE, { noradId: 2, name: 'malo', epoch: '2020-01-01T00:00:00Z' }]);
    expect(res).toEqual({ loaded: 1, skipped: 1 });
  });
});

describe('geo', () => {
  it('normalizeLon', () => {
    expect(normalizeLon(190)).toBeCloseTo(-170);
    expect(normalizeLon(-190)).toBeCloseTo(170);
    expect(normalizeLon(180)).toBe(180);
    expect(normalizeLon(-180)).toBe(180);
    expect(normalizeLon(540)).toBe(180);
  });
  it('distancias', () => {
    const a = { latitude: 10, longitude: 20, altitudeKm: 400 };
    expect(distance3dKm(a, a)).toBe(0);
    expect(distance3dKm(a, { ...a, altitudeKm: 410 })).toBeCloseTo(10, 6);
    expect(haversineKm({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 90 })).toBeCloseTo(
      10007.5,
      0
    );
  });
});

describe('Órbitas altas (SDP4) y formato OMM', () => {
  const base = { ...VALLADO_00005_OMM, EPOCH: '2026-10-24T06:00:00.000000' };
  const geoOmm = { ...base, OBJECT_NAME: 'GEO TEST', NORAD_CAT_ID: 99001, MEAN_MOTION: 1.00273, ECCENTRICITY: 0.0002, INCLINATION: 0.05, RA_OF_ASC_NODE: 80, ARG_OF_PERICENTER: 0, MEAN_ANOMALY: 0, BSTAR: 0, MEAN_MOTION_DOT: 0 };
  const gpsOmm = { ...base, OBJECT_NAME: 'GPS TEST', NORAD_CAT_ID: 99002, MEAN_MOTION: 2.0057, ECCENTRICITY: 0.005, INCLINATION: 55, RA_OF_ASC_NODE: 120, ARG_OF_PERICENTER: 40, MEAN_ANOMALY: 10, BSTAR: 0, MEAN_MOTION_DOT: 0 };
  const t0 = Date.parse('2026-10-24T06:00:00Z');

  it('geoestacionario: ~35 786 km de altura, latitud ~0 y período ~1436 min', () => {
    const e = new OrbitalEngine({ noradId: 99001, name: 'GEO', epoch: '2026-10-24T06:00:00Z', omm: geoOmm });
    expect(e.satrec.method).toBe('d'); // SDP4: órbitas de más de 225 min
    const p = e.positionAt(t0 + 6 * 3_600_000)!;
    expect(p.altitudeKm).toBeGreaterThan(35_700);
    expect(p.altitudeKm).toBeLessThan(35_900);
    expect(Math.abs(p.latitude)).toBeLessThan(1);
    expect(e.periodMinutes).toBeGreaterThan(1430);
    expect(e.periodMinutes).toBeLessThan(1440);
  });

  it('GEO visible todo el tiempo: un único pase "en curso" y "truncado", sin colgarse', async () => {
    const e = new OrbitalEngine({ noradId: 99001, name: 'GEO', epoch: '2026-10-24T06:00:00Z', omm: geoOmm });
    // Observador en el meridiano del satélite: siempre lo ve.
    const sub = e.positionAt(t0)!;
    const obs = { latitude: -31.8, longitude: sub.longitude, altitudeKm: 0 };
    const passes = await e.predictPasses(obs, new Date(t0), { horizonHours: 48, minElevationDeg: 10 });
    expect(passes).toHaveLength(1);
    expect(passes[0]).toMatchObject({ inProgress: true, truncated: true });
    expect(passes[0]!.maxElevation).toBeGreaterThan(40);
  });

  it('GPS (MEO, SDP4): altitud ~20 200 km y pases de varias horas', async () => {
    const e = new OrbitalEngine({ noradId: 99002, name: 'GPS', epoch: '2026-10-24T06:00:00Z', omm: gpsOmm });
    const p = e.positionAt(t0)!;
    expect(p.altitudeKm).toBeGreaterThan(19_500);
    expect(p.altitudeKm).toBeLessThan(21_000);
    const passes = await e.predictPasses({ latitude: -31.8, longitude: -60.5, altitudeKm: 0 }, new Date(t0), { horizonHours: 48, minElevationDeg: 10, maxPasses: 10 });
    expect(passes.length).toBeGreaterThanOrEqual(2);
    const complete = passes.find((x) => !x.inProgress && !x.truncated)!;
    expect(complete.durationSec).toBeGreaterThan(2 * 3600);
  });

  it('la época con o sin "Z" produce la misma órbita', () => {
    const a = new OrbitalEngine({ noradId: 5, name: 'x', epoch: '', omm: { ...base } });
    const b = new OrbitalEngine({ noradId: 5, name: 'x', epoch: '', omm: { ...base, EPOCH: '2026-10-24T06:00:00.000000Z' } });
    expect(distance3dKm(a.positionAt(t0 + 3_600_000)!, b.positionAt(t0 + 3_600_000)!)).toBeLessThan(1e-6);
  });
});
