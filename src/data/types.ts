import type { Observer, OrbitalElements } from '../core/orbital/types';

export type ProviderId = 'celestrak' | 'spacetrack' | 'n2yo' | 'wheretheiss';

/** Grupos de catálogo para filtrar por constelación (RF-08). */
export type CatalogGroup = 'stations' | 'starlink' | 'gps' | 'weather' | 'geo';

export const CATALOG_GROUPS: { id: CatalogGroup; label: string }[] = [
  { id: 'stations', label: 'Estaciones (ISS, Tiangong)' },
  { id: 'starlink', label: 'Starlink' },
  { id: 'gps', label: 'GPS' },
  { id: 'weather', label: 'Meteorológicos' },
  { id: 'geo', label: 'Geoestacionarios' },
];

export interface CatalogEntry {
  noradId: number;
  name: string;
  group?: CatalogGroup;
}

/** Qué se pide a un proveedor de datos orbitales. */
export type OrbitalRequest =
  | { kind: 'group'; group: CatalogGroup }
  | { kind: 'catnr'; noradId: number }
  | { kind: 'name'; name: string };

/** Posición de referencia entregada por una API externa, para la validación (RF-15). */
export interface ValidationPosition {
  provider: ProviderId;
  noradId: number;
  /** Instante al que corresponde la posición, epoch ms (el que informa la API). */
  timestampMs: number;
  latitude: number;
  longitude: number;
  altitudeKm: number;
  azimuth?: number;
  elevation?: number;
}

export interface ProviderCapabilities {
  catalog: boolean;
  orbital: boolean;
  validation: boolean;
}

/**
 * Estrategia común de proveedores (patrón Strategy). Las operaciones no soportadas lanzan
 * UnsupportedOperationError; `capabilities` permite al orquestador no intentarlas.
 */
export interface DataProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly capabilities: ProviderCapabilities;
  getCatalog(group: CatalogGroup): Promise<CatalogEntry[]>;
  getOrbitalData(request: OrbitalRequest): Promise<OrbitalElements[]>;
  getValidationPosition(noradId: number, observer: Observer): Promise<ValidationPosition>;
}

/** Procedencia y estado de los datos que recibe la UI. */
export interface DataMeta {
  /** Proveedor que los entregó originalmente. */
  provider: ProviderId | 'unknown';
  /** Cuándo se descargaron (epoch ms). */
  fetchedAt: number;
  ageMs: number;
  /** Salieron de la caché local sin consultar la red. */
  fromCache: boolean;
  /** Vencieron el TTL pero se usaron porque ningún proveedor respondió. */
  stale: boolean;
  /** Se pidió refrescar pero se respetó el intervalo mínimo del proveedor. */
  refreshSkipped?: boolean;
  attempts: import('./errors').ProviderAttempt[];
}

export interface DataResult<T> {
  data: T;
  meta: DataMeta;
}

/** Credenciales provistas en tiempo de ejecución (SecureStore), nunca en el bundle. */
export interface CredentialsSource {
  getSpaceTrack(): Promise<{ identity: string; password: string } | null>;
  getN2yoKey(): Promise<string | null>;
}
