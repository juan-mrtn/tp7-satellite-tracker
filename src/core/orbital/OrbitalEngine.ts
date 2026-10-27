import * as satellite from 'satellite.js';
import type { SatRec } from 'satellite.js';
import { buildGroundTrack, type GroundTrack, type GroundTrackOptions } from './groundTrack';
import { footprintPolygons } from './footprint';
import { DEG, normalizeLon } from './geo';
import { findPasses } from './passPredictor';
import type {
  GeoPosition,
  LatLng,
  LookAngles,
  Observer,
  OrbitalElements,
  Pass,
  PassSearchOptions,
} from './types';

const MU_KM3_S2 = 398600.4418;
const EARTH_RADIUS_KM = 6378.137;

export class OrbitalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrbitalError';
  }
}

/** Construye el registro SGP4. OMM/JSON tiene prioridad: soporta catálogos de 6 dígitos. */
export function createSatRec(elements: OrbitalElements): SatRec {
  let satrec: SatRec;
  if (elements.omm) {
    satrec = satellite.json2satrec(elements.omm);
  } else if (elements.tle) {
    satrec = satellite.twoline2satrec(elements.tle[0], elements.tle[1]);
  } else {
    throw new OrbitalError(`Sin datos orbitales utilizables para NORAD ${elements.noradId}`);
  }
  if (satrec.error !== satellite.SatRecError.None) {
    throw new OrbitalError(
      `SGP4 rechazó los elementos de NORAD ${elements.noradId} (código ${satrec.error})`
    );
  }
  return satrec;
}

/**
 * Wrapper matemático de satellite.js para UN satélite: posición subsatelital, ángulos
 * topocéntricos y predicción de pases (AOS / TCA / LOS).
 *
 * Convenciones: entradas y salidas en grados y km; los instantes se aceptan como `Date` o
 * epoch ms. El cálculo es 100 % local: no hace ninguna llamada de red.
 */
export class OrbitalEngine {
  readonly satrec: SatRec;
  readonly elements: OrbitalElements;

  constructor(elements: OrbitalElements) {
    this.elements = elements;
    this.satrec = createSatRec(elements);
  }

  /** Período orbital en minutos, a partir del movimiento medio (rad/min). */
  get periodMinutes(): number {
    return (2 * Math.PI) / this.satrec.no;
  }

  /** Semieje mayor (km), según el movimiento medio. */
  private get semiMajorAxisKm(): number {
    const nRadS = this.satrec.no / 60;
    return Math.cbrt(MU_KM3_S2 / (nRadS * nRadS));
  }

  /**
   * Cota de la velocidad angular de la elevación (°/s): velocidad en perigeo sobre la altura
   * de perigeo, con 20 % de margen. La usa el predictor para dimensionar el paso.
   */
  get maxElevationRateDegPerSec(): number {
    const a = this.semiMajorAxisKm;
    const rp = a * (1 - this.satrec.ecco);
    const vp = Math.sqrt(MU_KM3_S2 * (2 / rp - 1 / a));
    const hp = Math.max(150, rp - EARTH_RADIUS_KM);
    return (vp / hp / DEG) * 1.2;
  }

  /** Posición ECI (TEME, km) o null si SGP4 falla para ese instante. */
  eciAt(when: Date | number) {
    const date = typeof when === 'number' ? new Date(when) : when;
    const pv = satellite.propagate(this.satrec, date) as ReturnType<typeof satellite.propagate> | null;
    if (!pv || !pv.position || typeof pv.position === 'boolean') return null;
    return { position: pv.position, velocity: pv.velocity, date };
  }

  /** Punto subsatelital (lat/lon en grados, altitud en km) o null si SGP4 falla. */
  positionAt(when: Date | number): GeoPosition | null {
    const eci = this.eciAt(when);
    if (!eci) return null;
    const gmst = satellite.gstime(eci.date);
    const geo = satellite.eciToGeodetic(eci.position, gmst);
    return {
      latitude: satellite.degreesLat(geo.latitude),
      longitude: normalizeLon(satellite.degreesLong(geo.longitude)),
      altitudeKm: geo.height,
    };
  }

  /** Velocidad escalar (km/s) en el instante dado. */
  speedAt(when: Date | number): number | null {
    const eci = this.eciAt(when);
    if (!eci) return null;
    const v = eci.velocity;
    return Math.hypot(v.x, v.y, v.z);
  }

  /** Azimut (0° = Norte, horario), elevación y distancia oblicua desde el observador. */
  lookAnglesAt(when: Date | number, observer: Observer): LookAngles | null {
    const eci = this.eciAt(when);
    if (!eci) return null;
    const gmst = satellite.gstime(eci.date);
    const ecf = satellite.eciToEcf(eci.position, gmst);
    const look = satellite.ecfToLookAngles(
      {
        latitude: observer.latitude * DEG,
        longitude: observer.longitude * DEG,
        height: observer.altitudeKm,
      },
      ecf
    );
    return {
      azimuth: ((look.azimuth / DEG) % 360 + 360) % 360,
      elevation: look.elevation / DEG,
      rangeKm: look.rangeSat,
    };
  }

  /** Ground track pasado y futuro (por defecto un período a cada lado), dividido en el antimeridiano. */
  groundTrack(center: Date, options?: GroundTrackOptions): GroundTrack {
    return buildGroundTrack((ms) => this.positionAt(ms), this.periodMinutes, center, options);
  }

  /** Polígonos de la huella de cobertura para una elevación mínima dada. */
  footprint(position: GeoPosition, minElevationDeg = 0): LatLng[][] {
    return footprintPolygons(position, minElevationDeg);
  }

  /** Próximos pases visibles (AOS, elevación máxima, LOS). Asíncrono y cooperativo con la UI. */
  async predictPasses(
    observer: Observer,
    from: Date,
    options: PassSearchOptions = {}
  ): Promise<Pass[]> {
    return findPasses(
      (ms) => {
        const look = this.lookAnglesAt(ms, observer);
        // Si SGP4 falla se trata como "muy por debajo del horizonte".
        return look ?? { elevation: -90, azimuth: 0 };
      },
      {
        startMs: from.getTime(),
        horizonMs: (options.horizonHours ?? 48) * 3_600_000,
        minElevationDeg: options.minElevationDeg ?? 10,
        maxPasses: options.maxPasses ?? 20,
        maxElevationRateDegPerSec: this.maxElevationRateDegPerSec,
        budgetMs: options.budgetMs,
        signal: options.signal,
      }
    );
  }
}

/** Antigüedad (días) de los elementos orbitales respecto de `now`. */
export function elementsAgeDays(elements: OrbitalElements, now: Date = new Date()): number {
  const epoch = Date.parse(elements.epoch.endsWith('Z') ? elements.epoch : `${elements.epoch}Z`);
  return (now.getTime() - epoch) / 86_400_000;
}
