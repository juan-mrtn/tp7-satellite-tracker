import type { OrbitalElements } from '../../core/orbital/types';
import type { ProviderId } from '../types';

export interface CachedSet {
  provider: ProviderId | 'unknown';
  /** Cuándo se descargó (epoch ms). El TTL se mide desde acá. */
  fetchedAt: number;
  elements: OrbitalElements[];
}

/** Resultado de una medición de validación cruzada (RF-15), persistido para armar el informe. */
export interface ValidationRecord {
  id?: number;
  createdAt: number;
  noradId: number;
  satelliteName: string;
  reference: ProviderId;
  referenceTimestampMs: number;
  /** Error 3D entre la posición SGP4 local y la de la API, en km. */
  errorKm: number;
  /** Diferencia horizontal (sobre la superficie), km. */
  horizontalKm: number;
  /** Diferencia de altitud (local − API), km. */
  altitudeDiffKm: number;
  localLat: number;
  localLon: number;
  localAltKm: number;
  apiLat: number;
  apiLon: number;
  apiAltKm: number;
  elementsEpoch: string;
  elementsAgeDays: number;
  elementsSource: string;
}

/**
 * Almacenamiento local de efemérides y mediciones. La lógica de TTL NO vive acá: la tiene el
 * orquestador, que compara `fetchedAt` con su reloj. Implementaciones: SqliteCacheStore
 * (producción) y MemoryCacheStore (pruebas).
 */
export interface CacheStore {
  init(): Promise<void>;

  getGroup(key: string): Promise<CachedSet | null>;
  putGroup(key: string, set: CachedSet): Promise<void>;

  getElements(noradId: number): Promise<{ elements: OrbitalElements; fetchedAt: number; provider: ProviderId | 'unknown' } | null>;
  putElements(
    elements: readonly OrbitalElements[],
    provider: ProviderId | 'unknown',
    fetchedAt: number
  ): Promise<void>;

  searchByName(query: string, limit: number): Promise<OrbitalElements[]>;
  clear(): Promise<void>;

  addValidationRecord(record: ValidationRecord): Promise<void>;
  listValidationRecords(limit: number): Promise<ValidationRecord[]>;
  clearValidationRecords(): Promise<void>;
}
