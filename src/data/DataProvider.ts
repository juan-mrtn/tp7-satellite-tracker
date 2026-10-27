import type { Observer, OrbitalElements } from '../core/orbital/types';
import type { CacheStore } from './cache/CacheStore';
import {
  AllProvidersFailedError,
  CircuitOpenError,
  MissingCredentialsError,
  UnsupportedOperationError,
  type ProviderAttempt,
} from './errors';
import { CelesTrakProvider } from './providers/CelesTrakProvider';
import { N2yoProvider } from './providers/N2yoProvider';
import { SpaceTrackProvider } from './providers/SpaceTrackProvider';
import { WhereTheIssProvider } from './providers/WhereTheIssProvider';
import { systemClock, type Clock } from './resilience';
import type {
  CatalogEntry,
  CatalogGroup,
  CredentialsSource,
  DataMeta,
  DataProvider,
  DataResult,
  OrbitalRequest,
  ProviderId,
  ValidationPosition,
} from './types';

export type {
  CatalogEntry,
  CatalogGroup,
  CredentialsSource,
  DataMeta,
  DataProvider,
  DataResult,
  OrbitalRequest,
  ProviderCapabilities,
  ProviderId,
  ValidationPosition,
} from './types';

export const HOUR_MS = 3_600_000;
/** TTL permitido: 12–24 h (RF-09). */
export const TTL_MIN_MS = 12 * HOUR_MS;
export const TTL_MAX_MS = 24 * HOUR_MS;
/** CelesTrak actualiza GP/SupGP cada ~2 h: refrescar antes no trae datos nuevos. */
export const MIN_FORCE_REFRESH_MS = 2 * HOUR_MS;

export interface OrchestratorOptions {
  /** Proveedores en orden de prioridad (el primero es el principal, los demás son fallback). */
  providers: DataProvider[];
  cache: CacheStore;
  clock?: Clock;
  ttlMs?: number;
  minForceRefreshMs?: number;
}

export interface ValidationOutcome {
  provider: ProviderId;
  label: string;
  position?: ValidationPosition;
  error?: string;
  /** El proveedor no aplica a este satélite (p. ej. Where the ISS at? con un satélite que no es la ISS). */
  unsupported?: boolean;
}

/**
 * Fábrica de proveedores (Abstract Factory): arma la familia completa con sus límites de uso
 * y reintentos. El orden de la lista es el orden de prioridad para los datos orbitales:
 * CelesTrak (principal) → Space-Track (fallback). N2YO y Where the ISS at? solo validan.
 */
export function createDataProviders(
  credentials: CredentialsSource,
  options: { fetchImpl?: typeof fetch; clock?: Clock; maxObjectsPerGroup?: number } = {}
): DataProvider[] {
  return [
    new CelesTrakProvider(options),
    new SpaceTrackProvider({ credentials, ...options }),
    new N2yoProvider({ credentials, fetchImpl: options.fetchImpl, clock: options.clock }),
    new WhereTheIssProvider({ fetchImpl: options.fetchImpl, clock: options.clock }),
  ];
}

/**
 * Orquestador de datos orbitales: caché con TTL + fallback automático entre proveedores.
 *
 *  1. Si hay datos en caché vigentes (< TTL) no se toca la red.
 *  2. Si vencieron, se consulta a los proveedores en orden de prioridad; cada uno aplica su
 *     propio rate limiter, breaker y backoff. Un proveedor sin credenciales, en pausa o que
 *     falla se saltea y se prueba el siguiente.
 *  3. Si todos fallan pero hay caché (aunque vencida) se sirve igual, marcada `stale`, para
 *     poder operar sin conectividad en el momento del pase.
 */
export class DataOrchestrator {
  private readonly clock: Clock;
  private readonly providers: DataProvider[];
  private readonly cache: CacheStore;
  private ttlMs: number;
  private readonly minForceRefreshMs: number;

  constructor(options: OrchestratorOptions) {
    this.clock = options.clock ?? systemClock;
    this.providers = options.providers;
    this.cache = options.cache;
    this.ttlMs = DataOrchestrator.clampTtl(options.ttlMs ?? TTL_MIN_MS);
    this.minForceRefreshMs = options.minForceRefreshMs ?? MIN_FORCE_REFRESH_MS;
  }

  static clampTtl(ms: number): number {
    return Math.min(TTL_MAX_MS, Math.max(TTL_MIN_MS, ms));
  }

  get ttl(): number {
    return this.ttlMs;
  }

  setTtlHours(hours: number): void {
    this.ttlMs = DataOrchestrator.clampTtl(hours * HOUR_MS);
  }

  async init(): Promise<void> {
    await this.cache.init();
  }

  // ───────────────────────── datos orbitales ─────────────────────────

  async getGroup(
    group: CatalogGroup,
    options: { forceRefresh?: boolean } = {}
  ): Promise<DataResult<OrbitalElements[]>> {
    const key = `group:${group}`;
    const cached = await this.cache.getGroup(key);
    const now = this.clock.now();

    if (cached) {
      const age = now - cached.fetchedAt;
      if (!options.forceRefresh && age < this.ttlMs) {
        return this.fromCache(cached.elements, cached.provider, cached.fetchedAt);
      }
      if (options.forceRefresh && age < this.minForceRefreshMs) {
        return this.fromCache(cached.elements, cached.provider, cached.fetchedAt, {
          refreshSkipped: true,
        });
      }
    }

    try {
      const { value, provider, attempts } = await this.tryProviders('orbital', (p) =>
        p.getOrbitalData({ kind: 'group', group })
      );
      const fetchedAt = this.clock.now();
      await this.cache.putGroup(key, { provider, fetchedAt, elements: value });
      return { data: value, meta: this.meta(provider, fetchedAt, false, false, attempts) };
    } catch (error) {
      if (cached && error instanceof AllProvidersFailedError) {
        return this.fromCache(cached.elements, cached.provider, cached.fetchedAt, {
          stale: true,
          attempts: error.attempts,
        });
      }
      throw error;
    }
  }

  async getCatalog(
    group: CatalogGroup,
    options: { forceRefresh?: boolean } = {}
  ): Promise<DataResult<CatalogEntry[]>> {
    const res = await this.getGroup(group, options);
    return {
      meta: res.meta,
      data: res.data.map((e) => ({ noradId: e.noradId, name: e.name, group })),
    };
  }

  async getSatellite(
    noradId: number,
    options: { forceRefresh?: boolean } = {}
  ): Promise<DataResult<OrbitalElements>> {
    const cached = await this.cache.getElements(noradId);
    const now = this.clock.now();

    if (cached && !options.forceRefresh && now - cached.fetchedAt < this.ttlMs) {
      return {
        data: cached.elements,
        meta: this.meta(cached.provider, cached.fetchedAt, true, false, []),
      };
    }
    if (cached && options.forceRefresh && now - cached.fetchedAt < this.minForceRefreshMs) {
      return {
        data: cached.elements,
        meta: { ...this.meta(cached.provider, cached.fetchedAt, true, false, []), refreshSkipped: true },
      };
    }

    try {
      const { value, provider, attempts } = await this.tryProviders('orbital', (p) =>
        p.getOrbitalData({ kind: 'catnr', noradId })
      );
      const fetchedAt = this.clock.now();
      await this.cache.putElements(value, provider, fetchedAt);
      const found = value.find((e) => e.noradId === noradId) ?? (value[0] as OrbitalElements);
      return { data: found, meta: this.meta(provider, fetchedAt, false, false, attempts) };
    } catch (error) {
      if (cached && error instanceof AllProvidersFailedError) {
        return {
          data: cached.elements,
          meta: this.meta(cached.provider, cached.fetchedAt, true, true, error.attempts),
        };
      }
      throw error;
    }
  }

  /**
   * Búsqueda por NORAD ID o por nombre (RF-01). Un número se resuelve con getSatellite; un
   * texto se busca primero en la caché local y, si no hay coincidencias, en los proveedores.
   */
  async search(query: string): Promise<DataResult<OrbitalElements[]>> {
    const q = query.trim();
    if (!q) return { data: [], meta: this.meta('unknown', this.clock.now(), true, false, []) };

    if (/^\d{1,6}$/.test(q)) {
      const res = await this.getSatellite(Number(q));
      return { data: [res.data], meta: res.meta };
    }

    const local = await this.cache.searchByName(q, 50);
    if (local.length > 0) {
      return { data: local, meta: this.meta('unknown', this.clock.now(), true, false, []) };
    }
    if (q.length < 3) {
      return { data: [], meta: this.meta('unknown', this.clock.now(), true, false, []) };
    }
    const { value, provider, attempts } = await this.tryProviders('orbital', (p) =>
      p.getOrbitalData({ kind: 'name', name: q })
    );
    const fetchedAt = this.clock.now();
    await this.cache.putElements(value, provider, fetchedAt);
    return { data: value, meta: this.meta(provider, fetchedAt, false, false, attempts) };
  }

  // ───────────────────────── validación ─────────────────────────

  /**
   * Pide la posición de referencia a todas las fuentes de validación aplicables. No es un
   * fallback: son fuentes independientes y se comparan todas contra el cálculo local.
   */
  async fetchValidationPositions(noradId: number, observer: Observer): Promise<ValidationOutcome[]> {
    const validators = this.providers.filter((p) => p.capabilities.validation);
    const outcomes = await Promise.all(
      validators.map(async (p): Promise<ValidationOutcome> => {
        try {
          const position = await p.getValidationPosition(noradId, observer);
          return { provider: p.id, label: p.label, position };
        } catch (e) {
          return {
            provider: p.id,
            label: p.label,
            error: e instanceof Error ? e.message : String(e),
            unsupported: e instanceof UnsupportedOperationError,
          };
        }
      })
    );
    return outcomes.filter((o) => !o.unsupported);
  }

  // ───────────────────────── internos ─────────────────────────

  private async tryProviders(
    capability: 'orbital' | 'catalog',
    op: (provider: DataProvider) => Promise<OrbitalElements[]>
  ): Promise<{ value: OrbitalElements[]; provider: ProviderId; attempts: ProviderAttempt[] }> {
    const attempts: ProviderAttempt[] = [];
    for (const provider of this.providers) {
      if (!provider.capabilities[capability]) continue;
      try {
        const value = await op(provider);
        if (value.length === 0) {
          attempts.push({ provider: provider.label, ok: false, error: 'sin resultados' });
          continue;
        }
        attempts.push({ provider: provider.label, ok: true });
        return { value, provider: provider.id, attempts };
      } catch (e) {
        const skipped = e instanceof MissingCredentialsError || e instanceof CircuitOpenError;
        attempts.push({
          provider: provider.label,
          ok: false,
          skipped,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    throw new AllProvidersFailedError(attempts);
  }

  private meta(
    provider: ProviderId | 'unknown',
    fetchedAt: number,
    fromCache: boolean,
    stale: boolean,
    attempts: ProviderAttempt[]
  ): DataMeta {
    return {
      provider,
      fetchedAt,
      ageMs: this.clock.now() - fetchedAt,
      fromCache,
      stale,
      attempts,
    };
  }

  private fromCache(
    elements: OrbitalElements[],
    provider: ProviderId | 'unknown',
    fetchedAt: number,
    extra: { stale?: boolean; refreshSkipped?: boolean; attempts?: ProviderAttempt[] } = {}
  ): DataResult<OrbitalElements[]> {
    return {
      data: elements,
      meta: {
        ...this.meta(provider, fetchedAt, true, extra.stale ?? false, extra.attempts ?? []),
        refreshSkipped: extra.refreshSkipped,
      },
    };
  }
}
