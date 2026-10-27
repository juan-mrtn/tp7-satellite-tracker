import * as Location from 'expo-location';
import type { Observer } from '../core/orbital/types';

export type LocationStatus = 'unknown' | 'granted' | 'denied';

export async function requestLocationPermission(): Promise<LocationStatus> {
  const current = await Location.getForegroundPermissionsAsync();
  if (current.granted) return 'granted';
  const res = await Location.requestForegroundPermissionsAsync();
  return res.granted ? 'granted' : 'denied';
}

const toObserver = (loc: Location.LocationObject): Observer => ({
  latitude: loc.coords.latitude,
  longitude: loc.coords.longitude,
  // altitude viene en metros y puede ser null; SGP4 la usa en km.
  altitudeKm: (loc.coords.altitude ?? 0) / 1000,
});

/** Posición GPS del observador. Si el fix tarda, cae a la última conocida. */
export async function getObserver(): Promise<Observer | null> {
  try {
    const fix = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 12_000)),
    ]);
    if (fix) return toObserver(fix);
    const last = await Location.getLastKnownPositionAsync();
    return last ? toObserver(last) : null;
  } catch {
    return null;
  }
}

/** Sigue la posición con baja frecuencia (el observador casi no se mueve entre pases). */
export async function watchObserver(onChange: (o: Observer) => void): Promise<() => void> {
  const sub = await Location.watchPositionAsync(
    { accuracy: Location.Accuracy.Balanced, distanceInterval: 1000, timeInterval: 60_000 },
    (loc) => onChange(toObserver(loc))
  );
  return () => sub.remove();
}
