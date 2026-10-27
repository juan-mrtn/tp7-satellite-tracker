/** Geometría del sky chart polar (RF-05): cenit al centro, horizonte en el borde, Norte arriba. */

const DEG = Math.PI / 180;

export interface PolarPoint {
  x: number;
  y: number;
}

/**
 * Proyecta (azimut, elevación) al plano del gráfico. Se dibuja como se ve el cielo mirando
 * hacia arriba: Norte arriba y Este a la IZQUIERDA. Elevación 90° → centro, 0° → borde.
 */
export function polarPoint(
  azimuthDeg: number,
  elevationDeg: number,
  radius: number,
  cx: number,
  cy: number
): PolarPoint {
  const el = Math.max(0, Math.min(90, elevationDeg));
  const r = (radius * (90 - el)) / 90;
  const az = azimuthDeg * DEG;
  return { x: cx - r * Math.sin(az), y: cy - r * Math.cos(az) };
}

export interface PathSample {
  ms: number;
  azimuth: number;
  elevation: number;
}

/** Muestras de azimut/elevación a lo largo de un pase (incluye siempre AOS y LOS exactos). */
export function samplePassPath(
  look: (ms: number) => { azimuth: number; elevation: number } | null,
  aosMs: number,
  losMs: number,
  stepSec = 10
): PathSample[] {
  const out: PathSample[] = [];
  const push = (ms: number) => {
    const l = look(ms);
    if (l) out.push({ ms, azimuth: l.azimuth, elevation: l.elevation });
  };
  for (let t = aosMs; t < losMs; t += stepSec * 1000) push(t);
  push(losMs);
  return out;
}

/** Trazo SVG (`d` de un <Path>) de la trayectoria. */
export function pathToSvg(samples: readonly PathSample[], radius: number, cx: number, cy: number): string {
  return samples
    .map((s, i) => {
      const p = polarPoint(s.azimuth, s.elevation, radius, cx, cy);
      return `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
    })
    .join(' ');
}
