import type { ConstellationSnapshot } from './constellation';
import { angleDiff } from '../orientation';

export interface MapRegion {
  latitude: number;
  longitude: number;
  latitudeDelta: number;
  longitudeDelta: number;
}

export interface VisibleSatellite {
  noradId: number;
  latitude: number;
  longitude: number;
  altitudeKm: number;
}

/**
 * Elige qué satélites de la capa de constelación se dibujan: solo los que caen dentro de la
 * región visible del mapa (con 20 % de margen) y, si hay más que `limit`, una muestra uniforme
 * y estable (mismo criterio entre refrescos, así los marcadores no "bailan").
 * Maneja el antimeridiano comparando longitudes con diferencia angular.
 */
export function selectVisible(
  snapshot: ConstellationSnapshot,
  region: MapRegion | null,
  limit: number
): VisibleSatellite[] {
  const inView: VisibleSatellite[] = [];
  const latHalf = region ? (region.latitudeDelta / 2) * 1.2 : 0;
  const lonHalf = region ? (region.longitudeDelta / 2) * 1.2 : 0;
  const allLongitudes = !region || region.longitudeDelta >= 300;

  for (let i = 0; i < snapshot.count; i++) {
    const lat = snapshot.data[i * 3] as number;
    const lon = snapshot.data[i * 3 + 1] as number;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (region) {
      if (Math.abs(lat - region.latitude) > latHalf) continue;
      if (!allLongitudes && Math.abs(angleDiff(region.longitude, lon)) > lonHalf) continue;
    }
    inView.push({
      noradId: snapshot.noradIds[i] as number,
      latitude: lat,
      longitude: lon,
      altitudeKm: snapshot.data[i * 3 + 2] as number,
    });
  }

  if (inView.length <= limit) return inView;
  const step = inView.length / limit;
  return Array.from({ length: limit }, (_, k) => inView[Math.floor(k * step)] as VisibleSatellite);
}
