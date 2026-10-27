import React from 'react';
import Svg, { Circle, G, Line, Path, Text as SvgText } from 'react-native-svg';
import { pathToSvg, polarPoint, type PathSample } from '../core/skyChart';
import { colors } from '../ui/theme';

export interface SkyChartProps {
  size: number;
  /** Trayectoria del pase (azimut/elevación). */
  samples: readonly PathSample[];
  /** Posición actual del satélite, si está sobre el horizonte. */
  current?: { azimuth: number; elevation: number } | null;
  /** Elevación mínima configurada: se dibuja como anillo punteado. */
  minElevation?: number;
}

/**
 * Sky chart polar (RF-05) en SVG: cenit en el centro, horizonte en el borde, Norte arriba y
 * Este a la izquierda (así se ve el cielo mirando hacia arriba). Anillos cada 30° de elevación.
 */
export function SkyChart({ size, samples, current, minElevation }: SkyChartProps) {
  const pad = 30;
  const R = size / 2 - pad;
  const c = size / 2;
  const ringR = (el: number) => (R * (90 - el)) / 90;

  const first = samples[0];
  const last = samples[samples.length - 1];
  const peak = samples.reduce<PathSample | null>((best, s) => (!best || s.elevation > best.elevation ? s : best), null);
  const dot = (s: PathSample | undefined | null, color: string, label: string) => {
    if (!s) return null;
    const p = polarPoint(s.azimuth, s.elevation, R, c, c);
    return (
      <G key={label}>
        <Circle cx={p.x} cy={p.y} r={5} fill={color} />
        <SvgText x={p.x + 8} y={p.y - 6} fill={color} fontSize={11} fontWeight="700">
          {label}
        </SvgText>
      </G>
    );
  };
  const cur = current && current.elevation >= 0 ? polarPoint(current.azimuth, current.elevation, R, c, c) : null;

  return (
    <Svg width={size} height={size} accessibilityLabel="Sky chart polar con la trayectoria del pase">
      {/* anillos de elevación */}
      <Circle cx={c} cy={c} r={ringR(0)} stroke={colors.border} strokeWidth={1.5} fill={colors.surface} />
      <Circle cx={c} cy={c} r={ringR(30)} stroke={colors.border} strokeWidth={1} fill="none" />
      <Circle cx={c} cy={c} r={ringR(60)} stroke={colors.border} strokeWidth={1} fill="none" />
      {minElevation ? (
        <Circle
          cx={c}
          cy={c}
          r={ringR(minElevation)}
          stroke={colors.warn}
          strokeWidth={1}
          strokeDasharray="4 4"
          fill="none"
          opacity={0.7}
        />
      ) : null}
      {/* ejes N–S y E–O */}
      <Line x1={c} y1={c - R} x2={c} y2={c + R} stroke={colors.border} strokeWidth={1} />
      <Line x1={c - R} y1={c} x2={c + R} y2={c} stroke={colors.border} strokeWidth={1} />
      {/* etiquetas de elevación */}
      <SvgText x={c + 4} y={c - ringR(30) + 12} fill={colors.textMuted} fontSize={10}>
        30°
      </SvgText>
      <SvgText x={c + 4} y={c - ringR(60) + 12} fill={colors.textMuted} fontSize={10}>
        60°
      </SvgText>
      {/* puntos cardinales (Este a la izquierda) */}
      <SvgText x={c} y={c - R - 9} fill={colors.text} fontSize={14} fontWeight="700" textAnchor="middle">
        N
      </SvgText>
      <SvgText x={c} y={c + R + 20} fill={colors.text} fontSize={14} fontWeight="700" textAnchor="middle">
        S
      </SvgText>
      <SvgText x={c - R - 14} y={c + 5} fill={colors.text} fontSize={14} fontWeight="700" textAnchor="middle">
        E
      </SvgText>
      <SvgText x={c + R + 14} y={c + 5} fill={colors.text} fontSize={14} fontWeight="700" textAnchor="middle">
        O
      </SvgText>
      {/* trayectoria */}
      {samples.length > 1 ? (
        <Path d={pathToSvg(samples, R, c, c)} stroke={colors.accent} strokeWidth={3} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      ) : null}
      {dot(first, colors.ok, 'AOS')}
      {dot(peak, colors.sat, 'MAX')}
      {dot(last, colors.danger, 'LOS')}
      {/* posición actual */}
      {cur ? (
        <G>
          <Circle cx={cur.x} cy={cur.y} r={11} stroke="#fff" strokeWidth={2} fill="none" opacity={0.9} />
          <Circle cx={cur.x} cy={cur.y} r={5} fill="#fff" />
        </G>
      ) : null}
    </Svg>
  );
}
