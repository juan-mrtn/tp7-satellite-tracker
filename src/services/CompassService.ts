import { Platform } from 'react-native';
import * as Location from 'expo-location';
import { Accelerometer, Magnetometer } from 'expo-sensors';
import {
  computeOrientation,
  declinationFromHeading,
  normalizeAccelerometer,
  smoothVec,
  type DeviceOrientation,
  type Vec3,
} from '../core/orientation';

export async function isCompassAvailable(): Promise<boolean> {
  const [a, m] = await Promise.all([Accelerometer.isAvailableAsync(), Magnetometer.isAvailableAsync()]);
  return a && m;
}

export interface CompassHandlers {
  /** Orientación con azimut VERDADERO (ya corregido por declinación, si se pudo estimar). */
  onOrientation: (o: DeviceOrientation) => void;
  onDeclination?: (declinationDeg: number | null) => void;
}

/**
 * Orientación del equipo en tiempo real (RF-07): acelerómetro + magnetómetro con filtro
 * pasa-bajos y compensación de inclinación. El azimut magnético se convierte a verdadero con
 * la declinación que informa expo-location (trueHeading − magHeading).
 * Devuelve una función para detener todo.
 */
export async function startCompass(handlers: CompassHandlers, intervalMs = 50): Promise<() => void> {
  Accelerometer.setUpdateInterval(intervalMs);
  Magnetometer.setUpdateInterval(intervalMs);

  let accel: Vec3 | null = null;
  let mag: Vec3 | null = null;
  let declination = 0;

  const accelSub = Accelerometer.addListener((s) => {
    accel = smoothVec(accel, normalizeAccelerometer({ x: s.x, y: s.y, z: s.z }, Platform.OS));
  });
  const magSub = Magnetometer.addListener((s) => {
    mag = smoothVec(mag, { x: s.x, y: s.y, z: s.z });
    if (!accel || !mag) return;
    const o = computeOrientation(accel, mag);
    if (o) handlers.onOrientation({ azimuth: (o.azimuth + declination + 360) % 360, pitch: o.pitch });
  });

  let headingSub: Location.LocationSubscription | null = null;
  try {
    headingSub = await Location.watchHeadingAsync((h) => {
      const d = declinationFromHeading(h.trueHeading, h.magHeading);
      if (d !== null) {
        declination = d;
        handlers.onDeclination?.(d);
      }
    });
  } catch {
    handlers.onDeclination?.(null); // sin permiso/servicio: se muestra el azimut magnético
  }

  return () => {
    accelSub.remove();
    magSub.remove();
    headingSub?.remove();
  };
}
