import { clamp, normalizeLon } from './geo';
import type { GeoPosition, LatLng } from './types';

/**
 * Divide una polilínea en segmentos cada vez que la longitud salta más de 180° entre muestras
 * consecutivas (cruce del antimeridiano).
 *
 * En cada cruce se interpola la latitud exacta en ±180° y se cierra el segmento actual en el
 * antimeridiano; el siguiente segmento arranca en el lado opuesto. Así no queda un hueco visible
 * ni se dibuja una línea recta de lado a lado del mapa.
 *
 * Entrada: puntos con longitud normalizada en (-180, 180]. Salida: segmentos de ≥ 2 puntos.
 */
export function splitAtAntimeridian(points: readonly LatLng[]): LatLng[][] {
  const segments: LatLng[][] = [];
  let current: LatLng[] = [];

  for (let i = 0; i < points.length; i++) {
    const p = points[i] as LatLng;
    const prev = i > 0 ? (points[i - 1] as LatLng) : null;

    if (prev) {
      const delta = p.longitude - prev.longitude;
      if (Math.abs(delta) > 180) {
        // delta > 180: va hacia el oeste (p.e. -179 → 179). delta < -180: hacia el este.
        const edge = delta > 0 ? -180 : 180;
        const unwrappedLon = delta > 0 ? p.longitude - 360 : p.longitude + 360;
        const t = (edge - prev.longitude) / (unwrappedLon - prev.longitude);
        const latAtEdge = prev.latitude + t * (p.latitude - prev.latitude);
        current.push({ latitude: latAtEdge, longitude: edge });
        if (current.length >= 2) segments.push(current);
        current = [{ latitude: latAtEdge, longitude: -edge }];
      }
    }
    current.push({ latitude: p.latitude, longitude: p.longitude });
  }
  if (current.length >= 2) segments.push(current);
  return segments;
}

/** Paso de muestreo (s) según el período: 30–60 s en LEO, mayor en órbitas altas. */
export function groundTrackStepSec(periodMinutes: number): number {
  return clamp(Math.round((periodMinutes * 60) / 120), 30, 240);
}

export interface GroundTrackOptions {
  /** Minutos hacia atrás desde `center`. Por defecto, un período completo. */
  pastMinutes?: number;
  /** Minutos hacia adelante desde `center`. Por defecto, un período completo. */
  futureMinutes?: number;
  stepSec?: number;
}

export interface GroundTrack {
  past: LatLng[][];
  future: LatLng[][];
}

/**
 * Ground track pasado y futuro alrededor de `center`, ya dividido en el antimeridiano.
 * `positionAt` recibe epoch ms y devuelve la posición subsatelital (o null si SGP4 falla).
 */
export function buildGroundTrack(
  positionAt: (ms: number) => GeoPosition | null,
  periodMinutes: number,
  center: Date,
  options: GroundTrackOptions = {}
): GroundTrack {
  const stepSec = options.stepSec ?? groundTrackStepSec(periodMinutes);
  const pastMin = options.pastMinutes ?? periodMinutes;
  const futureMin = options.futureMinutes ?? periodMinutes;
  const c = center.getTime();

  const sample = (fromMs: number, toMs: number): LatLng[] => {
    const out: LatLng[] = [];
    for (let t = fromMs; t <= toMs + 1; t += stepSec * 1000) {
      const p = positionAt(t);
      if (p) out.push({ latitude: p.latitude, longitude: normalizeLon(p.longitude) });
    }
    return out;
  };

  const past = sample(c - pastMin * 60_000, c);
  const future = sample(c, c + futureMin * 60_000);
  return { past: splitAtAntimeridian(past), future: splitAtAntimeridian(future) };
}
