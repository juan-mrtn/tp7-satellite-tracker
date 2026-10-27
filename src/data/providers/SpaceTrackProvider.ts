import type { OrbitalElements } from '../../core/orbital/types';
import {
  AuthError,
  HttpError,
  MissingCredentialsError,
  NetworkError,
  ParseError,
  UnsupportedOperationError,
} from '../errors';
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
  CredentialsSource,
  DataProvider,
  OrbitalRequest,
  ProviderCapabilities,
  ValidationPosition,
} from '../types';

const BASE = 'https://www.space-track.org';
const GP = `${BASE}/basicspacedata/query/class/gp`;
/** La sesión de Space-Track vence a la hora: se renueva antes. */
const SESSION_MS = 50 * 60_000;

/** ISS, Tianhe, Wentian, Mengtian. */
const STATION_IDS = '25544,48274,53239,54216';

/**
 * Consultas GP de Space-Track. Space-Track no tiene "grupos": se aproximan con filtros por
 * nombre/período, siempre limitados a objetos no decaídos con elementos recientes (30 días).
 */
export function spaceTrackUrl(request: OrbitalRequest, limit: number): string {
  const live = 'DECAY_DATE/null-val/EPOCH/%3Enow-30';
  switch (request.kind) {
    case 'catnr':
      return `${GP}/NORAD_CAT_ID/${request.noradId}/orderby/EPOCH%20desc/limit/1/format/json`;
    case 'name':
      return `${GP}/OBJECT_NAME/~~${encodeURIComponent(request.name.toUpperCase())}/${live}/orderby/NORAD_CAT_ID/limit/50/format/json`;
    case 'group':
      switch (request.group) {
        case 'stations':
          return `${GP}/NORAD_CAT_ID/${STATION_IDS}/orderby/NORAD_CAT_ID/format/json`;
        case 'starlink':
          return `${GP}/OBJECT_NAME/~~STARLINK/${live}/orderby/NORAD_CAT_ID/limit/${limit}/format/json`;
        case 'gps':
          return `${GP}/OBJECT_NAME/~~NAVSTAR/${live}/orderby/NORAD_CAT_ID/limit/${limit}/format/json`;
        case 'weather':
          return `${GP}/OBJECT_NAME/~~NOAA/${live}/orderby/NORAD_CAT_ID/limit/${limit}/format/json`;
        case 'geo':
          return `${GP}/PERIOD/1430--1450/ECCENTRICITY/%3C0.02/${live}/orderby/NORAD_CAT_ID/limit/${limit}/format/json`;
      }
  }
}

export interface SpaceTrackOptions {
  credentials: CredentialsSource;
  fetchImpl?: typeof fetch;
  clock?: Clock;
  maxObjectsPerGroup?: number;
}

/**
 * Fallback oficial. Requiere cuenta (identity/password), que se leen de SecureStore en cada
 * sesión. Guía de uso: < 30 requests/min y 300/h; se limita a 20/min y 250/h.
 */
export class SpaceTrackProvider implements DataProvider {
  readonly id = 'spacetrack' as const;
  readonly label = 'Space-Track';
  readonly capabilities: ProviderCapabilities = { catalog: true, orbital: true, validation: false };

  private readonly http: ResilientHttp;
  private readonly credentials: CredentialsSource;
  private readonly clock: Clock;
  private readonly maxObjects: number;
  private loggedInAt = 0;

  constructor(options: SpaceTrackOptions) {
    this.credentials = options.credentials;
    this.clock = options.clock ?? systemClock;
    this.maxObjects = options.maxObjectsPerGroup ?? 1500;
    this.http = new ResilientHttp({
      provider: this.label,
      clock: this.clock,
      fetchImpl: options.fetchImpl,
      limiter: new RateLimiter(
        this.label,
        [
          { max: 20, windowMs: 60_000 },
          { max: 250, windowMs: 3_600_000 },
        ],
        this.clock
      ),
      breaker: new CircuitBreaker(
        this.label,
        { failureThreshold: 3, cooldownMs: 120_000, hardCooldownMs: 10 * 60_000 },
        this.clock
      ),
      retry: {
        maxAttempts: 2,
        baseDelayMs: 1_000,
        factor: 2,
        maxDelayMs: 4_000,
        shouldRetry: (e) => e instanceof NetworkError,
      },
      timeoutMs: 60_000,
    });
  }

  private async login(): Promise<void> {
    const creds = await this.credentials.getSpaceTrack();
    if (!creds) throw new MissingCredentialsError(this.label);

    const body = `identity=${encodeURIComponent(creds.identity)}&password=${encodeURIComponent(creds.password)}`;
    let response: Response;
    try {
      response = await this.http.request(`${BASE}/ajaxauth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        credentials: 'include',
      });
    } catch (e) {
      if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
        throw new AuthError(this.label);
      }
      throw e;
    }
    // Con credenciales inválidas Space-Track responde 200 con {"Login":"Failed"}.
    const text = await response.text();
    if (/"Login"\s*:\s*"Failed"/i.test(text)) throw new AuthError(this.label);
    this.loggedInAt = this.clock.now();
  }

  private async query(url: string, allowRelogin = true): Promise<unknown> {
    if (this.clock.now() - this.loggedInAt > SESSION_MS) await this.login();
    try {
      const response = await this.http.request(url, { credentials: 'include' });
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch {
        throw new ParseError(this.label, 'no es JSON');
      }
    } catch (e) {
      // Sesión vencida: una sola renovación y reintento.
      if (allowRelogin && e instanceof HttpError && (e.status === 401 || e.status === 403)) {
        this.loggedInAt = 0;
        return this.query(url, false);
      }
      throw e;
    }
  }

  async getOrbitalData(request: OrbitalRequest): Promise<OrbitalElements[]> {
    const payload = await this.query(spaceTrackUrl(request, this.maxObjects));
    return parseOmmArray(payload, this.id).elements;
  }

  async getCatalog(group: CatalogGroup): Promise<CatalogEntry[]> {
    const elements = await this.getOrbitalData({ kind: 'group', group });
    return elements.map((e) => ({ noradId: e.noradId, name: e.name, group }));
  }

  async getValidationPosition(): Promise<ValidationPosition> {
    throw new UnsupportedOperationError(this.label, 'validación de posición');
  }
}
