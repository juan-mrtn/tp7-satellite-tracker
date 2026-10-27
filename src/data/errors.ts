/** Errores tipados de la capa de datos. El orquestador decide qué hacer según la clase. */

export class DataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** La respuesta HTTP no fue 2xx. */
export class HttpError extends DataError {
  constructor(
    readonly status: number,
    readonly provider: string,
    readonly retryAfterMs?: number
  ) {
    super(`${provider}: HTTP ${status}`);
  }
}

/** Fallo de red: sin conexión, timeout, DNS, etc. */
export class NetworkError extends DataError {
  constructor(readonly provider: string, readonly cause?: unknown) {
    super(`${provider}: error de red`);
  }
}

/** La respuesta no se pudo interpretar. */
export class ParseError extends DataError {
  constructor(readonly provider: string, detail: string) {
    super(`${provider}: respuesta inválida (${detail})`);
  }
}

/** El rate limiter local no puede conceder un turno dentro del tiempo de espera tolerado. */
export class RateLimitError extends DataError {
  constructor(readonly provider: string, readonly retryAfterMs: number) {
    super(`${provider}: límite de uso alcanzado, reintentar en ${Math.ceil(retryAfterMs / 1000)} s`);
  }
}

/** El circuit breaker del proveedor está abierto: no se consulta hasta que pase el enfriamiento. */
export class CircuitOpenError extends DataError {
  constructor(readonly provider: string, readonly retryAfterMs: number) {
    super(`${provider}: proveedor en pausa durante ${Math.ceil(retryAfterMs / 1000)} s`);
  }
}

/** Faltan credenciales del proveedor (no es una falla del proveedor: se lo saltea). */
export class MissingCredentialsError extends DataError {
  constructor(readonly provider: string) {
    super(`${provider}: faltan credenciales`);
  }
}

/** Credenciales rechazadas por el proveedor. */
export class AuthError extends DataError {
  constructor(readonly provider: string) {
    super(`${provider}: credenciales rechazadas`);
  }
}

/** El proveedor no implementa esa operación. */
export class UnsupportedOperationError extends DataError {
  constructor(readonly provider: string, operation: string) {
    super(`${provider}: no soporta ${operation}`);
  }
}

export interface ProviderAttempt {
  provider: string;
  ok: boolean;
  error?: string;
  skipped?: boolean;
}

/** Ningún proveedor ni la caché pudieron resolver la consulta. */
export class AllProvidersFailedError extends DataError {
  constructor(readonly attempts: ProviderAttempt[]) {
    super(
      `No se pudieron obtener datos: ${attempts
        .map((a) => `${a.provider}${a.skipped ? ' (omitido)' : ''}: ${a.error ?? 'ok'}`)
        .join('; ')}`
    );
  }
}
