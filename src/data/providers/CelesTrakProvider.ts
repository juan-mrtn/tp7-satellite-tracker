import type { OrbitalElements } from '../../core/orbital/types';
import { NetworkError, ParseError, UnsupportedOperationError } from '../errors';
import { parseOmmArray } from '../omm';
import {
  CircuitBreaker,
  RateLimiter,
  ResilientHttp,
  systemClock,
  type Clock,
} from '../resilience';
import type {
  CatalogEntry,
  CatalogGroup,
  DataProvider,
  OrbitalRequest,
  ProviderCapabilities,
  ValidationPosition,
} from '../types';

const BASE = 'https://celestrak.org/NORAD/elements';

/** Grupos de CelesTrak. Starlink usa el set suplementario (SupGP), derivado de efemérides del operador. */
export function celestrakUrl(request: OrbitalRequest): string {
  switch (request.kind) {
    case 'catnr':
      return `${BASE}/gp.php?CATNR=${request.noradId}&FORMAT=json`;
    case 'name':
      return `${BASE}/gp.php?NAME=${encodeURIComponent(request.name)}&FORMAT=json`;
    case 'group': {
      switch (request.group) {
        case 'starlink':
          return `${BASE}/supplemental/sup-gp.php?FILE=starlink&FORMAT=json`;
        case 'stations':
          return `${BASE}/gp.php?GROUP=stations&FORMAT=json`;
        case 'gps':
          return `${BASE}/gp.php?GROUP=gps-ops&FORMAT=json`;
        case 'weather':
          return `${BASE}/gp.php?GROUP=weather&FORMAT=json`;
        case 'geo':
          return `${BASE}/gp.php?GROUP=geo&FORMAT=json`;
      }
    }
  }
}

export interface CelesTrakOptions {
  fetchImpl?: typeof fetch;
  clock?: Clock;
  /** Tope de objetos por grupo (Starlink supera los 9 000). Por defecto 1 500. */
  maxObjectsPerGroup?: number;
}

/**
 * Proveedor principal. Sin API key. Su política de uso pide consultar cada grupo como máximo
 * cada 2 h y detenerse ante cualquier respuesta distinta de 200: por eso el breaker se abre de
 * inmediato ante un error HTTP y el limitador es conservador.
 */
export class CelesTrakProvider implements DataProvider {
  readonly id = 'celestrak' as const;
  readonly label = 'CelesTrak';
  readonly capabilities: ProviderCapabilities = { catalog: true, orbital: true, validation: false };

  private readonly http: ResilientHttp;
  private readonly maxObjects: number;

  constructor(options: CelesTrakOptions = {}) {
    const clock = options.clock ?? systemClock;
    this.maxObjects = options.maxObjectsPerGroup ?? 1500;
    this.http = new ResilientHttp({
      provider: this.label,
      clock,
      fetchImpl: options.fetchImpl,
      limiter: new RateLimiter(
        this.label,
        [
          { max: 1, windowMs: 2_000 },
          { max: 30, windowMs: 3_600_000 },
        ],
        clock
      ),
      breaker: new CircuitBreaker(
        this.label,
        {
          failureThreshold: 3,
          cooldownMs: 60_000,
          hardCooldownMs: 30 * 60_000,
          openOnHardFailure: true,
        },
        clock
      ),
      retry: {
        maxAttempts: 2,
        baseDelayMs: 1_000,
        factor: 2,
        maxDelayMs: 4_000,
        shouldRetry: (e) => e instanceof NetworkError,
      },
      timeoutMs: 45_000,
    });
  }

  async getOrbitalData(request: OrbitalRequest): Promise<OrbitalElements[]> {
    const response = await this.http.request(celestrakUrl(request));
    const text = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      // Sin resultados CelesTrak responde 200 con texto plano ("No GP data found").
      if (/no gp data found/i.test(text)) return [];
      throw new ParseError(this.label, 'no es JSON');
    }
    const { elements } = parseOmmArray(payload, this.id);
    return request.kind === 'group' ? elements.slice(0, this.maxObjects) : elements;
  }

  async getCatalog(group: CatalogGroup): Promise<CatalogEntry[]> {
    const elements = await this.getOrbitalData({ kind: 'group', group });
    return elements.map((e) => ({ noradId: e.noradId, name: e.name, group }));
  }

  async getValidationPosition(): Promise<ValidationPosition> {
    throw new UnsupportedOperationError(this.label, 'validación de posición');
  }
}
