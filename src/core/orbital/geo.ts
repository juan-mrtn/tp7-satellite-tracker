import type { LatLng } from './types';

export const DEG = Math.PI / 180;
/** Radio medio terrestre (km) para las aproximaciones esféricas (footprint). */
export const EARTH_MEAN_RADIUS_KM = 6371.0088;
const WGS84_A = 6378.137;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);

/** Normaliza una longitud al rango (-180, 180]. */
export function normalizeLon(lon: number): number {
  let l = ((lon + 180) % 360 + 360) % 360 - 180;
  if (l === -180) l = 180;
  return l;
}

/** Geodésico WGS84 (grados, km) a ECEF (km). */
export function geodeticToEcfKm(latDeg: number, lonDeg: number, altKm: number) {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  const sinLat = Math.sin(lat);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  return {
    x: (n + altKm) * Math.cos(lat) * Math.cos(lon),
    y: (n + altKm) * Math.cos(lat) * Math.sin(lon),
    z: (n * (1 - WGS84_E2) + altKm) * sinLat,
  };
}

/** Distancia 3D (km) entre dos posiciones geodésicas, vía ECEF. Se usa en la validación. */
export function distance3dKm(
  a: { latitude: number; longitude: number; altitudeKm: number },
  b: { latitude: number; longitude: number; altitudeKm: number }
): number {
  const pa = geodeticToEcfKm(a.latitude, a.longitude, a.altitudeKm);
  const pb = geodeticToEcfKm(b.latitude, b.longitude, b.altitudeKm);
  return Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z);
}

/** Distancia sobre la superficie (km), fórmula de haversine sobre esfera de radio medio. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = (b.latitude - a.latitude) * DEG;
  const dLon = (b.longitude - a.longitude) * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * DEG) * Math.cos(b.latitude * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_MEAN_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
