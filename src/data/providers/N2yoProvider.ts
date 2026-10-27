import type { Observer, OrbitalElements } from '../../core/orbital/types';
import {
  AuthError,
  MissingCredentialsError,
  NetworkError,
  ParseError,
  UnsupportedOperationError,
} from '../errors';
import {
  CircuitBreaker,
  RateLimiter,
  ResilientHttp,
  systemClock,
  type Clock,
} from '../resilience';
import type {
  CatalogEntry,
  CredentialsSource,
  DataProvider,
  ProviderCapabilities,
  ValidationPosition,
} from '../types';

const BASE = 'https://api.n2yo.com/rest/v1/satellite';

export interface N2yoOptions {
  credentials: CredentialsSource;
  fetchImpl?: typeof fetch;
  clock?: Clock;
}

interface N2yoPositionsResponse {
  error?: string;
  info?: { satid: number; satname: string };
  positions?: {
    satlatitude: number;
    satlongitude: number;
    sataltitude: number;
    azimuth: number;
    elevation: number;
    timestamp: number;
  }[];
}

/**
 * N2YO se usa solo como fuente independiente para la validación cruzada (RF-15).
 * Límite: 1 000 transacciones/h en TLE y posiciones (se limita a 900/h).
 * La API key viaja en la URL, por lo que nunca se incluye en mensajes de error ni logs.
 */
export class N2yoProvider implements DataProvider {
  readonly id = 'n2yo' as const;
  readonly label = 'N2YO';
  readonly capabilities: ProviderCapabilities = { catalog: false, orbital: false, validation: true };

  private readonly http: ResilientHttp;
  private readonly credentials: CredentialsSource;

  constructor(options: N2yoOptions) {
    this.credentials = options.credentials;
    const clock = options.clock ?? systemClock;
    this.http = new ResilientHttp({
      provider: this.label,
      clock,
      fetchImpl: options.fetchImpl,
      limiter: new RateLimiter(
        this.label,
        [
          { max: 2, windowMs: 1_000 },
          { max: 900, windowMs: 3_600_000 },
        ],
        clock
      ),
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

  async getValidationPosition(noradId: number, observer: Observer): Promise<ValidationPosition> {
    const key = await this.credentials.getN2yoKey();
    if (!key) throw new MissingCredentialsError(this.label);

    // seconds = 1 → una sola posición, la del instante actual de N2YO.
    const alt = Math.round(observer.altitudeKm * 1000);
    const url =
      `${BASE}/positions/${noradId}/${observer.latitude.toFixed(5)}/` +
      `${observer.longitude.toFixed(5)}/${alt}/1/&apiKey=${encodeURIComponent(key)}`;

    const response = await this.http.request(url);
    let body: N2yoPositionsResponse;
    try {
      body = (await response.json()) as N2yoPositionsResponse;
    } catch {
      throw new ParseError(this.label, 'no es JSON');
    }
    if (body.error) {
      if (/key/i.test(body.error)) throw new AuthError(this.label);
      throw new ParseError(this.label, body.error);
    }
    const p = body.positions?.[0];
    if (!p) throw new ParseError(this.label, 'sin posiciones');
    return {
      provider: this.id,
      noradId,
      timestampMs: p.timestamp * 1000,
      latitude: p.satlatitude,
      longitude: p.satlongitude,
      altitudeKm: p.sataltitude,
      azimuth: p.azimuth,
      elevation: p.elevation,
    };
  }
}
