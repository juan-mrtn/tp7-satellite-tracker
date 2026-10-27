import {
  angleDiff, computeGuidance, computeOrientation, declinationFromHeading,
  normalizeAccelerometer, smoothVec, type Vec3,
} from '../src/core/orientation';
import { pathToSvg, polarPoint, samplePassPath } from '../src/core/skyChart';
import { compareToReference, summarize, validationToMarkdown } from '../src/core/validation';
import { compassName, formatCountdown, formatDuration, formatLat, formatLon } from '../src/core/format';
import { planReminders, reminderContent, reminderId, reminderPrefixFor } from '../src/services/passReminders';
import { OrbitalEngine } from '../src/core/orbital/OrbitalEngine';
import { distance3dKm } from '../src/core/orbital/geo';
import type { Pass } from '../src/core/orbital/types';
import { ISS_EPOCH, ISS_TLE } from './fixtures';

const DEG = Math.PI / 180;
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const unit = (a: Vec3): Vec3 => { const n = Math.hypot(a.x, a.y, a.z); return { x: a.x / n, y: a.y / n, z: a.z / n }; };

/**
 * Construye lo que medirían acelerómetro (convención Android) y magnetómetro si el equipo
 * apunta (cámara trasera) hacia (az, pitch) con un giro `roll` sobre su propio eje de apuntado.
 * Mundo ENU: x = Este, y = Norte, z = Arriba. Campo magnético con inclinación (dip) hacia abajo.
 */
function simulate(az: number, pitch: number, roll = 0) {
  const d: Vec3 = { x: Math.cos(pitch * DEG) * Math.sin(az * DEG), y: Math.cos(pitch * DEG) * Math.cos(az * DEG), z: Math.sin(pitch * DEG) };
  const up: Vec3 = { x: 0, y: 0, z: 1 };
  const x0 = unit(cross(d, up));
  const z = { x: -d.x, y: -d.y, z: -d.z };
  const y0 = cross(z, x0);
  const c = Math.cos(roll * DEG), s = Math.sin(roll * DEG);
  const xa = { x: x0.x * c + y0.x * s, y: x0.y * c + y0.y * s, z: x0.z * c + y0.z * s };
  const ya = { x: -x0.x * s + y0.x * c, y: -x0.y * s + y0.y * c, z: -x0.z * s + y0.z * c };
  const toDev = (v: Vec3): Vec3 => ({ x: dot(v, xa), y: dot(v, ya), z: dot(v, z) });
  return { accel: toDev(up), mag: toDev({ x: 0, y: 20, z: -40 }) };
}

describe('Brújula: orientación a partir de acelerómetro + magnetómetro', () => {
  it('casos básicos: apuntar al Norte, Este y al cenit', () => {
    const north = computeOrientation(simulate(0, 0).accel, simulate(0, 0).mag)!;
    expect(north.azimuth).toBeCloseTo(0, 6);
    expect(north.pitch).toBeCloseTo(0, 6);
    const east = computeOrientation(simulate(90, 0).accel, simulate(90, 0).mag)!;
    expect(east.azimuth).toBeCloseTo(90, 6);
    const high = computeOrientation(simulate(200, 80).accel, simulate(200, 80).mag)!;
    expect(high.pitch).toBeCloseTo(80, 6);
    expect(high.azimuth).toBeCloseTo(200, 6);
  });

  it('recupera azimut y elevación en toda la grilla, sin importar el giro (roll) del equipo', () => {
    for (let az = 0; az < 360; az += 25) {
      for (let pitch = -70; pitch <= 80; pitch += 15) {
        for (const roll of [0, 30, -75, 160]) {
          const { accel, mag } = simulate(az, pitch, roll);
          const o = computeOrientation(accel, mag)!;
          expect(angleDiff(az, o.azimuth)).toBeCloseTo(0, 5);
          expect(o.pitch).toBeCloseTo(pitch, 5);
        }
      }
    }
  });

  it('es invariante a la escala de los sensores (g vs m/s², µT)', () => {
    const { accel, mag } = simulate(137, 33, 10);
    const o = computeOrientation({ x: accel.x * 9.81, y: accel.y * 9.81, z: accel.z * 9.81 }, { x: mag.x * 3, y: mag.y * 3, z: mag.z * 3 })!;
    expect(o.azimuth).toBeCloseTo(137, 5);
    expect(o.pitch).toBeCloseTo(33, 5);
  });

  it('devuelve null con sensores degenerados', () => {
    expect(computeOrientation({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 })).toBeNull();
    expect(computeOrientation({ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 5 })).toBeNull(); // campo ∥ gravedad
  });

  it('iOS invierte el signo del acelerómetro: la normalización lo deja en convención Android', () => {
    const { accel, mag } = simulate(75, 20);
    const iosRaw = { x: -accel.x, y: -accel.y, z: -accel.z };
    const o = computeOrientation(normalizeAccelerometer(iosRaw, 'ios'), mag)!;
    expect(o.azimuth).toBeCloseTo(75, 5);
    expect(normalizeAccelerometer(accel, 'android')).toBe(accel);
  });

  it('angleDiff, declinación y suavizado', () => {
    expect(angleDiff(350, 10)).toBe(20);
    expect(angleDiff(10, 350)).toBe(-20);
    expect(angleDiff(0, 180)).toBe(180);
    expect(declinationFromHeading(352, 0)).toBe(-8); // Argentina: declinación ~ 8° al Oeste
    expect(declinationFromHeading(-1, 10)).toBeNull();
    expect(smoothVec(null, { x: 1, y: 2, z: 3 })).toEqual({ x: 1, y: 2, z: 3 });
    expect(smoothVec({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, 0.2).x).toBeCloseTo(2);
  });

  it('guía hacia el satélite: giro, elevación y "bloqueado" dentro de la tolerancia', () => {
    const g = computeGuidance({ azimuth: 350, pitch: 10 }, { azimuth: 20, elevation: 40 });
    expect(g.deltaAzimuth).toBe(30);
    expect(g.deltaElevation).toBe(30);
    expect(g.locked).toBe(false);
    expect(computeGuidance({ azimuth: 100, pitch: 30 }, { azimuth: 102, elevation: 31 }).locked).toBe(true);
    // Cerca del cenit una diferencia grande de azimut es una separación pequeña.
    expect(computeGuidance({ azimuth: 0, pitch: 88 }, { azimuth: 180, elevation: 88 }).separation).toBeCloseTo(4, 3);
  });
});

describe('Sky chart: proyección polar', () => {
  const R = 100, cx = 150, cy = 150;
  it('Norte arriba, Este a la izquierda, cenit al centro, horizonte en el borde', () => {
    expect(polarPoint(0, 0, R, cx, cy)).toEqual({ x: 150, y: 50 });
    const e = polarPoint(90, 0, R, cx, cy);
    expect(e.x).toBeCloseTo(50);
    expect(e.y).toBeCloseTo(150);
    const w = polarPoint(270, 0, R, cx, cy);
    expect(w.x).toBeCloseTo(250);
    const s = polarPoint(180, 0, R, cx, cy);
    expect(s.y).toBeCloseTo(250);
    expect(polarPoint(123, 90, R, cx, cy)).toEqual({ x: 150, y: 150 });
    expect(polarPoint(0, 45, R, cx, cy).y).toBeCloseTo(100);
  });

  it('elevaciones negativas se recortan al horizonte', () => {
    expect(polarPoint(0, -20, R, cx, cy)).toEqual(polarPoint(0, 0, R, cx, cy));
  });

  it('muestrea un pase real incluyendo AOS y LOS y arma el trazo SVG', async () => {
    const engine = new OrbitalEngine(ISS_TLE);
    const obs = { latitude: -31.82, longitude: -60.52, altitudeKm: 0.07 };
    const [pass] = await engine.predictPasses(obs, ISS_EPOCH, { minElevationDeg: 10, maxPasses: 1 });
    const samples = samplePassPath((ms) => engine.lookAnglesAt(ms, obs), pass!.aos.getTime(), pass!.los.getTime(), 10);
    expect(samples[0]!.ms).toBe(pass!.aos.getTime());
    expect(samples[samples.length - 1]!.ms).toBe(pass!.los.getTime());
    expect(samples.every((s) => s.elevation >= 9.5)).toBe(true);
    expect(samples.length).toBeGreaterThan(5);
    const d = pathToSvg(samples, R, cx, cy);
    expect(d.startsWith('M')).toBe(true);
    expect(d.match(/L/g)!.length).toBe(samples.length - 1);
  });
});

describe('Validación: error SGP4 vs referencia', () => {
  const engine = new OrbitalEngine(ISS_TLE);
  const t = ISS_EPOCH.getTime() + 3_600_000;
  const local = engine.positionAt(t)!;

  it('una referencia idéntica da error 0', () => {
    const rec = compareToReference(engine, { provider: 'n2yo', noradId: 25544, timestampMs: t, ...local }, 1)!;
    expect(rec.errorKm).toBeCloseTo(0, 6);
    expect(rec.horizontalKm).toBeCloseTo(0, 6);
    expect(rec.altitudeDiffKm).toBeCloseTo(0, 6);
    expect(rec.elementsAgeDays).toBeCloseTo((t - Date.parse(ISS_TLE.epoch)) / 86_400_000, 9);
  });

  it('desplazar la referencia 10 km de altitud da 10 km de error (3D) y Δalt coherente', () => {
    const rec = compareToReference(engine, { provider: 'wheretheiss', noradId: 25544, timestampMs: t, latitude: local.latitude, longitude: local.longitude, altitudeKm: local.altitudeKm - 10 }, 1)!;
    expect(rec.errorKm).toBeCloseTo(10, 6);
    expect(rec.altitudeDiffKm).toBeCloseTo(10, 6);
    expect(rec.horizontalKm).toBeCloseTo(0, 6);
  });

  it('la posición local se evalúa en el instante de la API (1 s de desfase ≈ 7 km)', () => {
    const at = engine.positionAt(t + 1000)!;
    const rec = compareToReference(engine, { provider: 'n2yo', noradId: 25544, timestampMs: t + 1000, ...local }, 1)!;
    expect(rec.errorKm).toBeCloseTo(distance3dKm(local, at), 9);
    expect(rec.errorKm).toBeGreaterThan(6);
    expect(rec.errorKm).toBeLessThan(8.5);
  });

  it('resumen estadístico y tabla Markdown', () => {
    const mk = (errorKm: number, reference: 'n2yo' | 'wheretheiss') => ({
      ...compareToReference(engine, { provider: reference, noradId: 25544, timestampMs: t, ...local }, 1)!,
      errorKm,
    });
    const recs = [mk(1, 'n2yo'), mk(3, 'n2yo'), mk(8, 'n2yo'), mk(2, 'wheretheiss')];
    const stats = summarize(recs);
    const n2yo = stats.find((s) => s.reference === 'n2yo')!;
    expect(n2yo).toMatchObject({ count: 3, meanKm: 4, medianKm: 3, minKm: 1, maxKm: 8 });
    const md = validationToMarkdown(recs);
    expect(md.split('\n')[0]).toContain('Error 3D (km)');
    expect(md).toContain('| N2YO |');
    expect(md).toContain('mediana 3.00 km');
  });
});

describe('Recordatorios de pase (RF-06)', () => {
  const mkPass = (aos: number): Pass => ({
    aos: new Date(aos), tca: new Date(aos + 240_000), los: new Date(aos + 480_000),
    aosAzimuth: 225, tcaAzimuth: 300, losAzimuth: 20, maxElevation: 62.4, durationSec: 480, inProgress: false, truncated: false,
  });
  const now = 1_000_000_000_000;

  it('agenda N minutos antes del AOS, ordenado y sin pasar de maxCount', () => {
    const passes = [mkPass(now + 3 * 3_600_000), mkPass(now + 1 * 3_600_000), mkPass(now + 5 * 3_600_000)];
    const plan = planReminders(passes, { noradId: 25544, satelliteName: 'ISS', minutesBefore: 10, now, maxCount: 2 });
    expect(plan).toHaveLength(2);
    expect(plan[0]!.fireAt.getTime()).toBe(now + 3_600_000 - 600_000);
    expect(plan[0]!.fireAt.getTime()).toBeLessThan(plan[1]!.fireAt.getTime());
    expect(plan[0]!.id.startsWith(reminderPrefixFor(25544))).toBe(true);
  });

  it('omite pases cuyo aviso ya pasó (o es inminente)', () => {
    const plan = planReminders([mkPass(now + 5 * 60_000), mkPass(now + 11 * 60_000)], {
      noradId: 1, satelliteName: 'X', minutesBefore: 10, now, maxCount: 10,
    });
    expect(plan).toHaveLength(1);
    expect(plan[0]!.pass.aos.getTime()).toBe(now + 11 * 60_000);
  });

  it('id estable y texto en español', () => {
    expect(reminderId(25544, 1_500)).toBe('pass:25544:2');
    const [r] = planReminders([mkPass(now + 3_600_000)], { noradId: 25544, satelliteName: 'ISS (ZARYA)', minutesBefore: 15, now, maxCount: 5 });
    const c = reminderContent(r!);
    expect(c.title).toBe('ISS (ZARYA): pase en 15 min');
    expect(c.body).toContain('SO');
    expect(c.body).toContain('62°');
    expect(c.body).toContain('8 min');
  });
});

describe('Formato', () => {
  it('puntos cardinales, coordenadas y tiempos', () => {
    expect(compassName(0)).toBe('N');
    expect(compassName(359)).toBe('N');
    expect(compassName(225)).toBe('SO');
    expect(compassName(100)).toBe('E');
    expect(formatLat(-31.82)).toBe('31.82° S');
    expect(formatLon(-60.52)).toBe('60.52° O');
    expect(formatDuration(75)).toBe('1 min 15 s');
    expect(formatDuration(45)).toBe('45 s');
    expect(formatDuration(3900)).toBe('1 h 5 min');
    expect(formatCountdown(10_000, 20_000)).toBe('ahora');
    expect(formatCountdown(70_000, 0)).toBe('en 1 min 10 s');
  });
});
