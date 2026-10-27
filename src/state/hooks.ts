import { useEffect, useRef, useState } from 'react';
import type { OrbitalEngine } from '../core/orbital/OrbitalEngine';
import type { GeoPosition, LookAngles, Observer } from '../core/orbital/types';

/** Reloj reactivo: re-renderiza cada `intervalMs` con la hora actual. */
export function useNow(intervalMs: number, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, enabled]);
  return now;
}

export interface LiveState {
  at: number;
  position: GeoPosition | null;
  speedKmS: number | null;
  look: LookAngles | null;
}

/**
 * Posición del satélite en tiempo real, calculada localmente con SGP4 cada `intervalSec`
 * segundos (RF-10). Es barato (≈ decenas de µs por cálculo): no necesita red ni worker.
 */
export function useLiveState(
  engine: OrbitalEngine | null,
  observer: Observer | null,
  intervalSec: number,
  enabled = true
): LiveState | null {
  const [state, setState] = useState<LiveState | null>(null);
  const observerRef = useRef(observer);
  observerRef.current = observer;

  useEffect(() => {
    if (!engine || !enabled) return;
    const tick = () => {
      const at = Date.now();
      const obs = observerRef.current;
      setState({
        at,
        position: engine.positionAt(at),
        speedKmS: engine.speedAt(at),
        look: obs ? engine.lookAnglesAt(at, obs) : null,
      });
    };
    tick();
    const id = setInterval(tick, intervalSec * 1000);
    return () => clearInterval(id);
  }, [engine, intervalSec, enabled]);

  return engine ? state : null;
}
