import type { OMMJsonObject } from 'satellite.js';

/** Observador en la superficie terrestre. Latitud/longitud en grados, altitud en km. */
export interface Observer {
  latitude: number;
  longitude: number;
  altitudeKm: number;
}

/** Punto subsatelital. Latitud/longitud en grados (lon en (-180, 180]), altitud en km. */
export interface GeoPosition {
  latitude: number;
  longitude: number;
  altitudeKm: number;
}

export interface LatLng {
  latitude: number;
  longitude: number;
}

/** Ángulos topocéntricos en grados y distancia oblicua en km. */
export interface LookAngles {
  azimuth: number;
  elevation: number;
  rangeKm: number;
}

/**
 * Datos orbitales de un objeto. El formato principal es OMM/JSON (soporta números de
 * catálogo de 6 dígitos, que no tienen representación TLE). El TLE es solo un respaldo.
 */
export interface OrbitalElements {
  noradId: number;
  name: string;
  /** Época de los elementos, ISO-8601 en UTC. */
  epoch: string;
  omm?: OMMJsonObject;
  tle?: [string, string];
  /** Identificador de la fuente que los entregó (para mostrar en UI / informe). */
  source?: string;
}

export interface Pass {
  /** Acquisition of Signal: el satélite cruza la elevación mínima hacia arriba. */
  aos: Date;
  /** Time of Closest Approach: instante de elevación máxima. */
  tca: Date;
  /** Loss of Signal: el satélite baja de la elevación mínima. */
  los: Date;
  aosAzimuth: number;
  tcaAzimuth: number;
  losAzimuth: number;
  maxElevation: number;
  durationSec: number;
  /** El pase ya estaba en curso al inicio de la ventana de búsqueda. */
  inProgress: boolean;
  /** El pase seguía activo al final de la ventana (típico de GEO): LOS es el límite. */
  truncated: boolean;
}

export interface PassSearchOptions {
  /** Elevación mínima en grados. Por defecto 10. */
  minElevationDeg?: number;
  /** Horizonte de búsqueda en horas. Por defecto 48. */
  horizonHours?: number;
  /** Máximo de pases a devolver. Por defecto 20. */
  maxPasses?: number;
  /** Presupuesto de tiempo por tanda (ms) antes de ceder el hilo. Por defecto 8. */
  budgetMs?: number;
  signal?: AbortSignal;
}
