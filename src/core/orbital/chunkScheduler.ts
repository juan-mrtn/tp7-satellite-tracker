/**
 * Cómputo cooperativo para no bloquear el hilo JS.
 *
 * Hermes no tiene Web Workers, así que el trabajo pesado (propagar cientos de satélites,
 * barrer días de órbita) se parte en tandas con un presupuesto de tiempo: al agotarlo se cede
 * el hilo con `setTimeout(0)` para que la UI procese gestos y renderice entre tandas.
 */

const now = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export class AbortError extends Error {
  constructor() {
    super('Operación cancelada');
    this.name = 'AbortError';
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortError();
}

/** Cede el hilo cada vez que se agota el presupuesto de tiempo (ms). */
export class TimeSlicer {
  private start = now();
  constructor(private readonly budgetMs = 8, private readonly signal?: AbortSignal) {}

  /** Llamar dentro de los bucles. Devuelve true si cedió el hilo. */
  async tick(): Promise<boolean> {
    throwIfAborted(this.signal);
    if (now() - this.start < this.budgetMs) return false;
    await yieldToEventLoop();
    throwIfAborted(this.signal);
    this.start = now();
    return true;
  }
}

/** Aplica `fn` a cada elemento, cediendo el hilo entre tandas. */
export async function processInChunks<T>(
  items: readonly T[],
  fn: (item: T, index: number) => void,
  options: { budgetMs?: number; signal?: AbortSignal } = {}
): Promise<void> {
  const slicer = new TimeSlicer(options.budgetMs, options.signal);
  for (let i = 0; i < items.length; i++) {
    fn(items[i] as T, i);
    await slicer.tick();
  }
}
