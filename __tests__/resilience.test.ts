import { CircuitBreaker, RateLimiter, ResilientHttp, retryWithBackoff, DEFAULT_RETRY } from '../src/data/resilience';
import { CircuitOpenError, HttpError, NetworkError, RateLimitError } from '../src/data/errors';
import { FakeClock, jsonResponse } from './helpers';

describe('RateLimiter', () => {
  it('permite ráfagas hasta el máximo y luego espera', async () => {
    const clock = new FakeClock();
    const rl = new RateLimiter('x', [{ max: 3, windowMs: 1000 }], clock);
    const t0 = clock.now();
    await rl.acquire();
    await rl.acquire();
    await rl.acquire();
    expect(clock.now() - t0).toBe(0);
    await rl.acquire(); // 4.º: debe esperar a que venza el primero
    expect(clock.now() - t0).toBe(1000);
  });

  it('aplica varias ventanas a la vez (Space-Track: por minuto y por hora)', async () => {
    const clock = new FakeClock();
    const rl = new RateLimiter('st', [{ max: 20, windowMs: 60_000 }, { max: 250, windowMs: 3_600_000 }], clock);
    const t0 = clock.now();
    for (let i = 0; i < 250; i++) await rl.acquire(Infinity);
    // 250 requests con tope de 20/min no pueden terminar en menos de ~12 min.
    expect(clock.now() - t0).toBeGreaterThanOrEqual(12 * 60_000);
    // Y la 251.ª tiene que esperar a que se libere la ventana horaria.
    const before = clock.now();
    await rl.acquire(Infinity);
    expect(clock.now() - t0).toBeGreaterThanOrEqual(3_600_000);
    expect(clock.now()).toBeGreaterThan(before);
  });

  it('falla con RateLimitError si la espera supera lo tolerado', async () => {
    const clock = new FakeClock();
    const rl = new RateLimiter('x', [{ max: 1, windowMs: 60_000 }], clock);
    await rl.acquire();
    await expect(rl.acquire(1000)).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe('CircuitBreaker', () => {
  it('abre tras N fallos blandos, pasa a half-open tras el enfriamiento y cierra con un éxito', () => {
    const clock = new FakeClock();
    const b = new CircuitBreaker('x', { failureThreshold: 3, cooldownMs: 1000 }, clock);
    b.onFailure(false);
    b.onFailure(false);
    expect(b.currentState).toBe('closed');
    b.onFailure(false);
    expect(b.currentState).toBe('open');
    expect(() => b.assertCanRequest()).toThrow(CircuitOpenError);
    clock.advance(1000);
    expect(b.currentState).toBe('half-open');
    b.assertCanRequest();
    b.onSuccess();
    expect(b.currentState).toBe('closed');
  });

  it('un fallo duro abre de inmediato cuando openOnHardFailure (política CelesTrak)', () => {
    const clock = new FakeClock();
    const b = new CircuitBreaker('ct', { failureThreshold: 3, cooldownMs: 1000, hardCooldownMs: 5000, openOnHardFailure: true }, clock);
    b.onFailure(true);
    expect(b.currentState).toBe('open');
    clock.advance(4999);
    expect(b.currentState).toBe('open');
    clock.advance(1);
    expect(b.currentState).toBe('half-open');
  });

  it('si la prueba en half-open falla vuelve a abrir', () => {
    const clock = new FakeClock();
    const b = new CircuitBreaker('x', { failureThreshold: 1, cooldownMs: 1000 }, clock);
    b.onFailure(false);
    clock.advance(1000);
    b.assertCanRequest();
    b.onFailure(false);
    expect(b.currentState).toBe('open');
  });
});

describe('retryWithBackoff', () => {
  it('duplica la espera entre intentos y termina con éxito', async () => {
    const clock = new FakeClock();
    let calls = 0;
    const waits: number[] = [];
    const spy = jest.spyOn(clock, 'sleep').mockImplementation(async (ms) => {
      waits.push(ms);
    });
    const result = await retryWithBackoff(
      async () => {
        if (++calls < 3) throw new NetworkError('x');
        return 'ok';
      },
      { ...DEFAULT_RETRY, baseDelayMs: 500, factor: 2 },
      clock
    );
    expect(result).toBe('ok');
    expect(waits).toEqual([500, 1000]);
    spy.mockRestore();
  });

  it('respeta Retry-After si es mayor que el backoff', async () => {
    const clock = new FakeClock();
    const waits: number[] = [];
    jest.spyOn(clock, 'sleep').mockImplementation(async (ms) => {
      waits.push(ms);
    });
    let calls = 0;
    await retryWithBackoff(
      async () => {
        if (++calls < 2) throw new HttpError(429, 'x', 30_000);
        return 1;
      },
      DEFAULT_RETRY,
      clock
    );
    expect(waits).toEqual([30_000]);
  });

  it('no reintenta errores que no corresponden y agota los intentos', async () => {
    let calls = 0;
    await expect(
      retryWithBackoff(async () => { calls++; throw new HttpError(404, 'x'); }, DEFAULT_RETRY, new FakeClock())
    ).rejects.toBeInstanceOf(HttpError);
    expect(calls).toBe(1);
    calls = 0;
    await expect(
      retryWithBackoff(async () => { calls++; throw new NetworkError('x'); }, DEFAULT_RETRY, new FakeClock())
    ).rejects.toBeInstanceOf(NetworkError);
    expect(calls).toBe(3);
  });
});

describe('ResilientHttp', () => {
  const make = (fetchImpl: typeof fetch, over: Partial<ConstructorParameters<typeof CircuitBreaker>[1]> = {}) => {
    const clock = new FakeClock();
    return {
      clock,
      http: new ResilientHttp({
        provider: 'X',
        clock,
        fetchImpl,
        limiter: new RateLimiter('X', [{ max: 100, windowMs: 1000 }], clock),
        breaker: new CircuitBreaker('X', { failureThreshold: 2, cooldownMs: 60_000, ...over }, clock),
      }),
    };
  };

  it('devuelve la respuesta 2xx', async () => {
    const { http } = make(async () => jsonResponse({ a: 1 }));
    const res = await http.request('https://x');
    expect(await res.json()).toEqual({ a: 1 });
  });

  it('clasifica HTTP no-2xx como HttpError y cuenta para el breaker', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse('err', 503));
    const { http } = make(fetchImpl as unknown as typeof fetch, { openOnHardFailure: true });
    await expect(http.request('https://x')).rejects.toBeInstanceOf(HttpError);
    // El breaker abrió: la segunda llamada ni siquiera sale a la red.
    await expect(http.request('https://x')).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('convierte fallos de fetch en NetworkError', async () => {
    const { http } = make(async () => { throw new TypeError('Network request failed'); });
    await expect(http.request('https://x')).rejects.toBeInstanceOf(NetworkError);
  });
});
