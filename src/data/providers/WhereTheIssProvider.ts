import type { Observer, OrbitalElements } from '../../core/orbital/types';
import { NetworkError, ParseError, UnsupportedOperationError } from '../errors';
import {
  CircuitBreaker,
  RateLimiter,
  ResilientHttp,
  systemClock,
  type Clock,
} from '../resilience';
import type {
  CatalogEntry,
  DataProvider,
  ProviderCapabilities,
  ValidationPosition,
} from '../types';

export const ISS_NORAD_ID = 25544;
const URL_ISS = `https://api.wheretheiss.at/v1/satellites/${ISS_NORAD_ID}?units=kilometers`;

export interface WhereTheIssOptions {
  fetchImpl?: typeof fetch;
  clock?: Clock;
}

/**
 * "Where the ISS at?": solo la ISS, sin autenticación, ~1 request/s. Fuente independiente
 * para validar la posición de la ISS (RF-15).
 */
export class WhereTheIssProvider implements DataProvider {
  readonly id = 'wheretheiss' as const;
  readonly label = 'Where the ISS at?';
  readonly capabilities: ProviderCapabilities = { catalog: false, orbital: false, validation: true };

  private readonly http: ResilientHttp;

  constructor(options: WhereTheIssOptions = {}) {
    const clock = options.clock ?? systemClock;
    this.http = new ResilientHttp({
      provider: this.label,
      clock,
      fetchImpl: options.fetchImpl,
      // ~1 request/s según la documentación; se deja un margen.
      limiter: new RateLimiter(this.label, [{ max: 1, windowMs: 1_200 }], clock),
      breaker: new CircuitBreaker(this.label, { failureThreshold: 3, cooldownMs: 60_000 }, clock),
      retry: {
        maxAttempts: 2,
        baseDelayMs: 1_000,
        factor: 2,
        maxDelayMs: 4_000,
        shouldRetry: (e) => e instanceof NetworkError,
      },
    });
  }

  async getCatalog(): Promise<CatalogEntry[]> {
    throw new UnsupportedOperationError(this.label, 'catálogo');
  }

  async getOrbitalData(): Promise<OrbitalElements[]> {
    throw new UnsupportedOperationError(this.label, 'datos orbitales');
  }

  async getValidationPosition(noradId: number, _observer?: Observer): Promise<ValidationPosition> {
    if (noradId !== ISS_NORAD_ID) {
      throw new UnsupportedOperationError(this.label, `satélites distintos de la ISS (${noradId})`);
    }
    const response = await this.http.request(URL_ISS);
    let body: Record<string, unknown>;
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new ParseError(this.label, 'no es JSON');
    }
    const { latitude, longitude, altitude, timestamp } = body as {
      latitude?: number;
      longitude?: number;
      altitude?: number;
      timestamp?: number;
    };
    if (
      typeof latitude !== 'number' ||
      typeof longitude !== 'number' ||
      typeof altitude !== 'number' ||
      typeof timestamp !== 'number'
    ) {
      throw new ParseError(this.label, 'faltan campos');
    }
    return {
      provider: this.id,
      noradId,
      timestampMs: timestamp * 1000,
      latitude,
      longitude,
      altitudeKm: altitude,
    };
  }
}
