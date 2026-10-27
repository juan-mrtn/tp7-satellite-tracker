import { DEG, EARTH_MEAN_RADIUS_KM, clamp } from './geo';
import type { GeoPosition, LatLng } from './types';

/**
 * Radio angular (grados, medido desde el centro de la Tierra) del área de cobertura de un
 * satélite a altura `altitudeKm` para una elevación mínima `minElevationDeg`:
 *
 *     λ = arccos( Re · cos(ε) / (Re + h) ) − ε
 *
 * Es el ángulo central entre el punto subsatelital y el borde de la huella (Tierra esférica).
 */
export function footprintAngularRadiusDeg(altitudeKm: number, minElevationDeg: number): number {
  const eps = minElevationDeg * DEG;
  const cosArg = (EARTH_MEAN_RADIUS_KM * Math.cos(eps)) / (EARTH_MEAN_RADIUS_KM + Math.max(0, altitudeKm));
  const lambda = Math.acos(clamp(cosArg, -1, 1)) - eps;
  return Math.max(0, lambda) / DEG;
}

/** Radio de la huella sobre la superficie (km). */
export function footprintRadiusKm(altitudeKm: number, minElevationDeg: number): number {
  return footprintAngularRadiusDeg(altitudeKm, minElevationDeg) * DEG * EARTH_MEAN_RADIUS_KM;
}

const wrap180 = (d: number): number => ((d + 180) % 360 + 360) % 360 - 180;

/** Sutherland–Hodgman contra una recta vertical (longitud constante). */
function clipAgainst(ring: LatLng[], edgeLon: number, keepGreater: boolean): LatLng[] {
  const inside = (p: LatLng) => (keepGreater ? p.longitude >= edgeLon : p.longitude <= edgeLon);
  const out: LatLng[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as LatLng;
    const b = ring[(i + 1) % ring.length] as LatLng;
    const aIn = inside(a);
    const bIn = inside(b);
    if (aIn) out.push(a);
    if (aIn !== bIn) {
      const t = (edgeLon - a.longitude) / (b.longitude - a.longitude);
      out.push({ latitude: a.latitude + t * (b.latitude - a.latitude), longitude: edgeLon });
    }
  }
  return out;
}

/**
 * Polígono(s) de la huella de cobertura, listos para una capa `fill` de MapLibre.
 *
 * - Vértices: punto destino sobre la esfera a distancia angular λ en `vertices` rumbos.
 * - Las longitudes se "desenvuelven" para ser continuas (sin saltos de 360°).
 * - Si la huella encierra un polo, el contorno desenvuelto da una vuelta completa (±360°); se
 *   cierra por el polo.
 * - Finalmente se recorta contra [-180, 180] copiando el polígono desplazado ±360°, de modo que
 *   una huella que cruza el antimeridiano se devuelve como dos polígonos, uno a cada lado.
 */
export function footprintPolygons(
  center: GeoPosition,
  minElevationDeg = 0,
  vertices = 72
): LatLng[][] {
  const lambda = footprintAngularRadiusDeg(center.altitudeKm, minElevationDeg) * DEG;
  if (lambda <= 0) return [];

  const lat0 = center.latitude * DEG;
  const sinLat0 = Math.sin(lat0);
  const cosLat0 = Math.cos(lat0);
  const sinL = Math.sin(lambda);
  const cosL = Math.cos(lambda);

  const lats: number[] = [];
  const dlons: number[] = [];
  for (let k = 0; k < vertices; k++) {
    const theta = (2 * Math.PI * k) / vertices;
    const lat = Math.asin(clamp(sinLat0 * cosL + cosLat0 * sinL * Math.cos(theta), -1, 1));
    const dlon = Math.atan2(Math.sin(theta) * sinL * cosLat0, cosL - sinLat0 * Math.sin(lat));
    lats.push(lat / DEG);
    dlons.push(dlon / DEG);
  }

  // Desenvolver longitudes relativas al centro.
  const lons: number[] = [center.longitude + (dlons[0] as number)];
  for (let k = 1; k < vertices; k++) {
    lons.push((lons[k - 1] as number) + wrap180((dlons[k] as number) - (dlons[k - 1] as number)));
  }
  const closing = wrap180((dlons[0] as number) - (dlons[vertices - 1] as number));
  const winding = (lons[vertices - 1] as number) + closing - (lons[0] as number);

  let ring: LatLng[] = lats.map((latitude, k) => ({ latitude, longitude: lons[k] as number }));
  if (Math.abs(winding) > 180) {
    // El contorno rodea un polo: se cierra por él.
    const pole = center.latitude >= 0 ? 90 : -90;
    const first = ring[0] as LatLng;
    ring = [
      ...ring,
      { latitude: first.latitude, longitude: first.longitude + winding },
      { latitude: pole, longitude: first.longitude + winding },
      { latitude: pole, longitude: first.longitude },
    ];
  }

  const minLon = Math.min(...ring.map((p) => p.longitude));
  const maxLon = Math.max(...ring.map((p) => p.longitude));
  const result: LatLng[][] = [];
  for (let n = -4; n <= 4; n++) {
    const shift = 360 * n;
    if (maxLon + shift < -180 || minLon + shift > 180) continue;
    let clipped = ring.map((p) => ({ latitude: p.latitude, longitude: p.longitude + shift }));
    clipped = clipAgainst(clipped, -180, true);
    if (clipped.length >= 3) clipped = clipAgainst(clipped, 180, false);
    if (clipped.length >= 3) result.push(clipped);
  }
  return result;
}
