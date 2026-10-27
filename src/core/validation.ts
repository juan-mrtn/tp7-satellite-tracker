import type { ValidationRecord } from '../data/cache/CacheStore';
import type { ProviderId, ValidationPosition } from '../data/types';
import { distance3dKm, haversineKm } from './orbital/geo';
import type { OrbitalEngine } from './orbital/OrbitalEngine';

/**
 * Compara la posición SGP4 local contra la de una API externa (RF-15).
 *
 * Lo esencial: la posición local se calcula EN EL INSTANTE QUE INFORMA LA API (`timestampMs`),
 * no en el de la app; si no, el desfase de reloj (a 7,7 km/s, 1 s ≈ 7,7 km) contaminaría el error.
 * El error es la distancia 3D en ECEF (WGS84) entre ambas posiciones geodésicas.
 */
export function compareToReference(
  engine: OrbitalEngine,
  reference: ValidationPosition,
  createdAt: number
): ValidationRecord | null {
  const local = engine.positionAt(reference.timestampMs);
  if (!local) return null;
  const api = { latitude: reference.latitude, longitude: reference.longitude, altitudeKm: reference.altitudeKm };
  const epoch = Date.parse(engine.elements.epoch);
  return {
    createdAt,
    noradId: reference.noradId,
    satelliteName: engine.elements.name,
    reference: reference.provider,
    referenceTimestampMs: reference.timestampMs,
    errorKm: distance3dKm(local, api),
    horizontalKm: haversineKm(local, api),
    altitudeDiffKm: local.altitudeKm - api.altitudeKm,
    localLat: local.latitude,
    localLon: local.longitude,
    localAltKm: local.altitudeKm,
    apiLat: api.latitude,
    apiLon: api.longitude,
    apiAltKm: api.altitudeKm,
    elementsEpoch: engine.elements.epoch,
    elementsAgeDays: (reference.timestampMs - epoch) / 86_400_000,
    elementsSource: engine.elements.source ?? 'desconocida',
  };
}

export interface ValidationStats {
  reference: ProviderId;
  count: number;
  meanKm: number;
  medianKm: number;
  minKm: number;
  maxKm: number;
}

export function summarize(records: readonly ValidationRecord[]): ValidationStats[] {
  const byRef = new Map<ProviderId, number[]>();
  for (const r of records) {
    const list = byRef.get(r.reference) ?? [];
    list.push(r.errorKm);
    byRef.set(r.reference, list);
  }
  return [...byRef.entries()].map(([reference, values]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
    return {
      reference,
      count: values.length,
      meanKm: values.reduce((s, v) => s + v, 0) / values.length,
      medianKm: median,
      minKm: sorted[0] as number,
      maxKm: sorted[sorted.length - 1] as number,
    };
  });
}

const REF_LABEL: Record<ProviderId, string> = {
  n2yo: 'N2YO',
  wheretheiss: 'Where the ISS at?',
  celestrak: 'CelesTrak',
  spacetrack: 'Space-Track',
};

/** Tabla Markdown lista para pegar en el informe de validación. */
export function validationToMarkdown(records: readonly ValidationRecord[]): string {
  const head =
    '| Fecha (UTC) | Satélite | NORAD | Referencia | Error 3D (km) | Horizontal (km) | Δ altitud (km) | Edad de los elementos (d) | Origen de los elementos |\n' +
    '|---|---|---|---|---|---|---|---|---|';
  const rows = records.map(
    (r) =>
      `| ${new Date(r.referenceTimestampMs).toISOString().replace('T', ' ').slice(0, 19)} | ${r.satelliteName} | ${r.noradId} | ${REF_LABEL[r.reference]} | ` +
      `${r.errorKm.toFixed(2)} | ${r.horizontalKm.toFixed(2)} | ${r.altitudeDiffKm.toFixed(2)} | ${r.elementsAgeDays.toFixed(2)} | ${r.elementsSource} |`
  );
  const stats = summarize(records).map(
    (s) =>
      `- ${REF_LABEL[s.reference]}: n = ${s.count}, media ${s.meanKm.toFixed(2)} km, mediana ${s.medianKm.toFixed(2)} km, mín ${s.minKm.toFixed(2)} km, máx ${s.maxKm.toFixed(2)} km`
  );
  return [head, ...rows, '', ...(stats.length ? ['Resumen:', ...stats] : [])].join('\n');
}
