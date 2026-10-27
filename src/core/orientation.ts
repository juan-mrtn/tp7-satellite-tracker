/**
 * Orientación del dispositivo a partir de acelerómetro + magnetómetro (modo brújula, RF-07).
 *
 * Marco del dispositivo: x → derecha, y → arriba de la pantalla, z → saliendo de la pantalla.
 * "Hacia dónde apunta" el usuario = la dirección de la cámara trasera = −z del dispositivo.
 *
 * Convención del acelerómetro: la lectura apunta HACIA ARRIBA cuando el equipo está quieto
 * (Android: boca arriba sobre la mesa z = +1 g). iOS entrega CoreMotion crudo, con el signo
 * opuesto; `normalizeAccelerometer` los unifica.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface DeviceOrientation {
  /** Azimut magnético de la dirección de apuntado, 0–360° (0 = Norte, horario). */
  azimuth: number;
  /** Elevación de la dirección de apuntado sobre el horizonte, −90…90°. */
  pitch: number;
}

const DEG = Math.PI / 180;

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const norm = (a: Vec3) => Math.hypot(a.x, a.y, a.z);
const scale = (a: Vec3, k: number): Vec3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });

/** iOS invierte el signo del acelerómetro respecto de Android (expo-sensors no lo corrige). */
export function normalizeAccelerometer(sample: Vec3, platform: 'ios' | 'android' | string): Vec3 {
  return platform === 'ios' ? { x: -sample.x, y: -sample.y, z: -sample.z } : sample;
}

/**
 * Azimut magnético y elevación de la dirección de apuntado, con compensación de inclinación
 * (mismo método que SensorManager.getRotationMatrix de Android):
 *   Este = m × a,   Norte = a × Este,   Arriba = a
 * y la dirección de apuntado d = (0, 0, −1) se proyecta sobre esos tres ejes.
 * Devuelve null si los vectores son degenerados (sensor sin datos o campo paralelo a la gravedad).
 */
export function computeOrientation(accel: Vec3, mag: Vec3): DeviceOrientation | null {
  const na = norm(accel);
  if (na < 1e-6) return null;
  const up = scale(accel, 1 / na);
  const east = cross(mag, up);
  const ne = norm(east);
  if (ne < 1e-6) return null;
  const eastN = scale(east, 1 / ne);
  const northN = cross(up, eastN);

  const d: Vec3 = { x: 0, y: 0, z: -1 };
  const e = dot(eastN, d);
  const n = dot(northN, d);
  const u = Math.max(-1, Math.min(1, dot(up, d)));

  return {
    azimuth: (((Math.atan2(e, n) / DEG) % 360) + 360) % 360,
    pitch: Math.asin(u) / DEG,
  };
}

/** Diferencia angular con signo b − a, en (−180, 180]. */
export function angleDiff(a: number, b: number): number {
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return d === -180 ? 180 : d;
}

/** Filtro pasa-bajos exponencial sobre un vector (suaviza el ruido de los sensores). */
export function smoothVec(prev: Vec3 | null, next: Vec3, alpha = 0.2): Vec3 {
  if (!prev) return next;
  return {
    x: prev.x + alpha * (next.x - prev.x),
    y: prev.y + alpha * (next.y - prev.y),
    z: prev.z + alpha * (next.z - prev.z),
  };
}

/**
 * Declinación magnética (° al Este) a partir del heading de expo-location:
 * trueHeading − magHeading. `trueHeading` es −1 cuando no es válido.
 */
export function declinationFromHeading(trueHeading: number, magHeading: number): number | null {
  if (trueHeading < 0 || magHeading < 0) return null;
  return angleDiff(magHeading, trueHeading);
}

export interface Guidance {
  /** Cuánto girar en azimut para llegar al objetivo (+ = hacia la derecha), −180…180°. */
  deltaAzimuth: number;
  /** Cuánto subir (+) o bajar (−) el equipo, grados. */
  deltaElevation: number;
  /** Separación angular total entre la dirección de apuntado y el objetivo. */
  separation: number;
  locked: boolean;
}

/** Guía hacia el objetivo (azimut/elevación verdaderos) desde la orientación actual del equipo. */
export function computeGuidance(
  device: DeviceOrientation,
  target: { azimuth: number; elevation: number },
  lockToleranceDeg = 5
): Guidance {
  const deltaAzimuth = angleDiff(device.azimuth, target.azimuth);
  const deltaElevation = target.elevation - device.pitch;
  const e1 = device.pitch * DEG;
  const e2 = target.elevation * DEG;
  const cosSep = Math.sin(e1) * Math.sin(e2) + Math.cos(e1) * Math.cos(e2) * Math.cos(deltaAzimuth * DEG);
  const separation = Math.acos(Math.max(-1, Math.min(1, cosSep))) / DEG;
  return { deltaAzimuth, deltaElevation, separation, locked: separation <= lockToleranceDeg };
}
