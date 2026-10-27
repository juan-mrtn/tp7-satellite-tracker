import { OrbitalEngine } from '../src/core/orbital/OrbitalEngine';
import { splitAtAntimeridian, groundTrackStepSec } from '../src/core/orbital/groundTrack';
import {
  footprintAngularRadiusDeg,
  footprintPolygons,
  footprintRadiusKm,
} from '../src/core/orbital/footprint';
import { haversineKm } from '../src/core/orbital/geo';
import { ISS_TLE, ISS_EPOCH } from './fixtures';

const pt = (latitude: number, longitude: number) => ({ latitude, longitude });

describe('splitAtAntimeridian', () => {
  it('no divide una polilínea que no cruza', () => {
    const line = [pt(0, 10), pt(5, 20), pt(10, 30)];
    expect(splitAtAntimeridian(line)).toEqual([line]);
  });

  it('cruce hacia el este (170 → -170): corta en +180 y reanuda en -180 con latitud interpolada', () => {
    const segs = splitAtAntimeridian([pt(0, 170), pt(10, -170)]);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toEqual([pt(0, 170), pt(5, 180)]);
    expect(segs[1]).toEqual([pt(5, -180), pt(10, -170)]);
  });

  it('cruce hacia el oeste (-179 → 179): corta en -180 y reanuda en +180', () => {
    const segs = splitAtAntimeridian([pt(-4, -179), pt(4, 179)]);
    expect(segs).toHaveLength(2);
    expect(segs[0]?.[1]).toEqual(pt(0, -180));
    expect(segs[1]?.[0]).toEqual(pt(0, 180));
  });

  it('interpola proporcionalmente cuando el cruce no está a mitad de camino', () => {
    // 170 → -150 equivale a +40° de lon; el antimeridiano está a 10/40 = 25 % del tramo.
    const segs = splitAtAntimeridian([pt(0, 170), pt(20, -150)]);
    expect(segs[0]?.[1]?.latitude).toBeCloseTo(5, 9);
  });

  it('maneja varios cruces', () => {
    const segs = splitAtAntimeridian([pt(0, 170), pt(2, -170), pt(4, -175), pt(6, 175), pt(8, 170)]);
    expect(segs).toHaveLength(3);
  });

  it('un salto exactamente de 180° no se considera cruce', () => {
    expect(splitAtAntimeridian([pt(0, -90), pt(0, 90)])).toHaveLength(1);
  });

  it('ground track real de la ISS: ningún segmento salta más de 180° y hay cruces', () => {
    const engine = new OrbitalEngine(ISS_TLE);
    const track = engine.groundTrack(new Date(ISS_EPOCH.getTime() + 20 * 60_000));
    const all = [...track.past, ...track.future];
    expect(all.length).toBeGreaterThanOrEqual(3); // ≥ 1 cruce en dos órbitas
    for (const seg of all) {
      for (let i = 1; i < seg.length; i++) {
        expect(Math.abs((seg[i]!.longitude) - (seg[i - 1]!.longitude))).toBeLessThanOrEqual(180);
      }
    }
  });

  it('cubre al menos una órbita completa hacia adelante y hacia atrás', () => {
    const engine = new OrbitalEngine(ISS_TLE);
    const center = new Date(ISS_EPOCH.getTime() + 20 * 60_000);
    const step = groundTrackStepSec(engine.periodMinutes);
    expect(step).toBeGreaterThanOrEqual(30);
    expect(step).toBeLessThanOrEqual(60);
    const track = engine.groundTrack(center);
    const count = (s: { latitude: number; longitude: number }[][]) =>
      s.reduce((n, seg) => n + seg.length, 0);
    const expected = (engine.periodMinutes * 60) / step;
    expect(count(track.future)).toBeGreaterThan(expected);
    expect(count(track.past)).toBeGreaterThan(expected);
  });
});

describe('footprint', () => {
  it('radio de la huella de la ISS (420 km, ε = 0°) ≈ 2250 km', () => {
    expect(footprintRadiusKm(420, 0)).toBeGreaterThan(2200);
    expect(footprintRadiusKm(420, 0)).toBeLessThan(2300);
  });

  it('una elevación mínima mayor reduce la cobertura', () => {
    expect(footprintAngularRadiusDeg(550, 25)).toBeLessThan(footprintAngularRadiusDeg(550, 0));
    expect(footprintAngularRadiusDeg(550, 90)).toBe(0);
  });

  it('geoestacionario (35786 km, ε = 0°) cubre ~81° de arco', () => {
    expect(footprintAngularRadiusDeg(35786, 0)).toBeCloseTo(81.3, 0);
  });

  it('huella común: un polígono con vértices a la distancia esperada', () => {
    const center = { latitude: 10, longitude: 20, altitudeKm: 550 };
    const polys = footprintPolygons(center, 10);
    expect(polys).toHaveLength(1);
    const r = footprintRadiusKm(550, 10);
    for (const v of polys[0]!) expect(haversineKm(center, v)).toBeCloseTo(r, 0);
  });

  it('huella que cruza el antimeridiano: dos polígonos, todo dentro de [-180, 180]', () => {
    const polys = footprintPolygons({ latitude: 0, longitude: 179, altitudeKm: 420 }, 0);
    expect(polys.length).toBe(2);
    for (const ring of polys) {
      for (const v of ring) {
        expect(v.longitude).toBeGreaterThanOrEqual(-180 - 1e-9);
        expect(v.longitude).toBeLessThanOrEqual(180 + 1e-9);
      }
    }
    const hasEast = polys.some((r) => r.some((v) => v.longitude > 170));
    const hasWest = polys.some((r) => r.some((v) => v.longitude < -170));
    expect(hasEast && hasWest).toBe(true);
  });

  it('huella que encierra un polo: se cierra por el polo y queda en [-180, 180]', () => {
    const polys = footprintPolygons({ latitude: 80, longitude: 30, altitudeKm: 800 }, 0);
    expect(polys.length).toBeGreaterThanOrEqual(1);
    const all = polys.flat();
    expect(Math.max(...all.map((v) => v.latitude))).toBe(90);
    for (const v of all) {
      expect(v.longitude).toBeGreaterThanOrEqual(-180 - 1e-9);
      expect(v.longitude).toBeLessThanOrEqual(180 + 1e-9);
    }
  });

  it('con el polo sur el cierre es por -90', () => {
    const polys = footprintPolygons({ latitude: -85, longitude: -100, altitudeKm: 600 }, 5);
    expect(Math.min(...polys.flat().map((v) => v.latitude))).toBe(-90);
  });
});
