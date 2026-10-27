import {
  CircuitOpenError,
  HttpError,
  NetworkError,
  RateLimitError,
} from './errors';

/** Fuente de tiempo inyectable: permite probar límites y backoff sin esperar de verdad. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

// ───────────────────────── Rate limiter ─────────────────────────

export interface RateRule {
  /** Máximo de requests permitidas dentro de la ventana. */
  max: number;
  windowMs: number;
}

/**
 * Limitador de ventana deslizante con varias reglas simultáneas (p. ej. Space-Track:
 * 20/min y 250/h). `acquire` espera hasta que haya turno; si la espera supera `maxWaitMs`
 * falla con RateLimitError para que el orquestador pase al siguiente proveedor.
 */
export class RateLimiter {
  private readonly stamps: number[][];

  constructor(
    private readonly provider: string,
    private readonly rules: readonly RateRule[],
    private readonly clock: Clock = systemClock
  ) {
    this.stamps = rules.map(() => []);
  }

  /** Milisegundos hasta poder hacer la próxima request (0 si ya se puede). */
  waitTimeMs(): number {
    const now = this.clock.now();
    let wait = 0;
    this.rules.forEach((rule, i) => {
      const log = this.stamps[i] as number[];
      while (log.length && (log[0] as number) <= now - rule.windowMs) log.shift();
      if (log.length >= rule.max) {
        wait = Math.max(wait, (log[log.length - rule.max] as number) + rule.windowMs - now);
      }
    });
    return wait;
  }

  async acquire(maxWaitMs = 10_000): Promise<void> {
    for (;;) {
      const wait = this.waitTimeMs();
      if (wait <= 0) {
        const now = this.clock.now();
        this.stamps.forEach((log) => log.push(now));
        return;
      }
      if (wait > maxWaitMs) throw new RateLimitError(this.provider, wait);
      await this.clock.sleep(wait);
    }
  }
}

// ───────────────────────── Circuit breaker ─────────────────────────

export interface BreakerOptions {
  /** Fallos "blandos" consecutivos (red, timeout) para abrir el circuito. */
  failureThreshold: number;
  cooldownMs: number;
  /** Enfriamiento tras un fallo "duro" (respuesta HTTP de error). Si falta, usa cooldownMs. */
  hardCooldownMs?: number;
  /** Si es true, un fallo duro abre el circuito de inmediato (política de CelesTrak). */
  openOnHardFailure?: boolean;
}

type BreakerState = 'closed' | 'open' | 'half-open';

export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private failures = 0;
  private openUntil = 0;

  constructor(
    private readonly provider: string,
    private readonly options: BreakerOptions,
    private readonly clock: Clock = systemClock
  ) {}

  get currentState(): BreakerState {
    this.refresh();
    return this.state;
  }

  private refresh(): void {
    if (this.state === 'open' && this.clock.now() >= this.openUntil) this.state = 'half-open';
  }

  /** Lanza CircuitOpenError si no se debe consultar. En half-open deja pasar una prueba. */
  assertCanRequest(): void {
    this.refresh();
    if (this.state === 'open') {
      throw new CircuitOpenError(this.provider, this.openUntil - this.clock.now());
    }
  }

  onSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }

  onFailure(hard: boolean): void {
    this.failures += 1;
    const opens =
      this.state === 'half-open' ||
      (hard && this.options.openOnHardFailure) ||
      this.failures >= this.options.failureThreshold;
    if (opens) {
      const cooldown = hard
        ? this.options.hardCooldownMs ?? this.options.cooldownMs
        : this.options.cooldownMs;
      this.state = 'open';
      this.openUntil = this.clock.now() + cooldown;
    }
  }
}

// ───────────────────────── Reintentos con backoff ─────────────────────────

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  factor: number;
  maxDelayMs: number;
  /** Decide si el error merece otro intento. */
  shouldRetry: (error: unknown) => boolean;
}

export const NO_RETRY: RetryPolicy = {
  maxAttempts: 1,
  baseDelayMs: 0,
  factor: 1,
  maxDelayMs: 0,
  shouldRetry: () => false,
};

/** Backoff exponencial: espera = min(maxDelay, base · factor^(n-1)), respetando Retry-After. */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
  clock: Clock = systemClock
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= policy.maxAttempts || !policy.shouldRetry(error)) throw error;
      const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * policy.factor ** (attempt - 1));
      const retryAfter = error instanceof HttpError ? error.retryAfterMs ?? 0 : 0;
      await clock.sleep(Math.max(exp, retryAfter));
    }
  }
  throw lastError;
}

/** Política por defecto: reintenta solo fallos de red y 5xx/429, hasta 3 intentos. */
export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  factor: 2,
  maxDelayMs: 8_000,
  shouldRetry: (e) =>
    e instanceof NetworkError || (e instanceof HttpError && (e.status === 429 || e.status >= 500)),
};

// ───────────────────────── HTTP resiliente ─────────────────────────

export interface ResilientHttpOptions {
  provider: string;
  limiter: RateLimiter;
  breaker: CircuitBreaker;
  retry?: RetryPolicy;
  clock?: Clock;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Espera máxima tolerada en el limitador antes de ceder al siguiente proveedor. */
  maxLimiterWaitMs?: number;
}

/**
 * Pipeline común a todos los proveedores:
 *   circuit breaker → rate limiter → fetch con timeout → clasificación de errores → reintentos.
 * Un 4xx/5xx es "fallo duro" para el breaker; un error de red es "fallo blando".
 */
export class ResilientHttp {
  private readonly clock: Clock;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ResilientHttpOptions) {
    this.clock = opts.clock ?? systemClock;
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
  }

  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const { provider, breaker, limiter } = this.opts;
    return retryWithBackoff(
      async () => {
        breaker.assertCanRequest();
        await limiter.acquire(this.opts.maxLimiterWaitMs ?? 10_000);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 20_000);
        let response: Response;
        try {
          response = await this.fetchImpl(url, { ...init, signal: controller.signal });
        } catch (cause) {
          breaker.onFailure(false);
          throw new NetworkError(provider, cause);
        } finally {
          clearTimeout(timer);
        }

        if (!response.ok) {
          breaker.onFailure(true);
          const ra = Number(response.headers?.get?.('retry-after'));
          throw new HttpError(response.status, provider, Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined);
        }
        breaker.onSuccess();
        return response;
      },
      this.opts.retry ?? NO_RETRY,
      this.clock
    );
  }
}
