import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Line } from 'react-native-svg';
import { computeGuidance, type DeviceOrientation } from '../core/orientation';
import { compassName } from '../core/format';
import { startCompass, isCompassAvailable } from '../services/CompassService';
import { Button } from '../ui/components';
import { colors, radius, spacing } from '../ui/theme';

export interface CompassOverlayProps {
  satelliteName: string;
  /** Azimut/elevación actuales del satélite (verdaderos), actualizados por el padre. */
  target: { azimuth: number; elevation: number } | null;
  onClose: () => void;
}

const SIZE = 280;
const HALF_RANGE_DEG = 60; // el retículo cubre ±60° alrededor de hacia donde apunta el equipo

/**
 * Modo brújula (RF-07): retículo que representa hacia dónde apunta la parte trasera del
 * equipo; el punto es el satélite. Moviendo el teléfono hasta centrar el punto se apunta al
 * satélite. Usa acelerómetro + magnetómetro (con declinación) a través de CompassService.
 */
export function CompassOverlay({ satelliteName, target, onClose }: CompassOverlayProps) {
  const [orientation, setOrientation] = useState<DeviceOrientation | null>(null);
  const [declination, setDeclination] = useState<number | null | undefined>(undefined);
  const [available, setAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    let stop: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const ok = await isCompassAvailable();
      if (cancelled) return;
      setAvailable(ok);
      if (!ok) return;
      stop = await startCompass({ onOrientation: setOrientation, onDeclination: setDeclination });
      if (cancelled) stop();
    })();
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  const guidance = useMemo(
    () => (orientation && target ? computeGuidance(orientation, target) : null),
    [orientation, target]
  );

  // Posición del punto en el retículo: x = giro (escalado por cos de la elevación), y = subir/bajar.
  const dot = useMemo(() => {
    if (!guidance || !orientation) return null;
    const dx = guidance.deltaAzimuth * Math.cos((orientation.pitch * Math.PI) / 180);
    const dy = -guidance.deltaElevation;
    const r = Math.hypot(dx, dy);
    const k = r > HALF_RANGE_DEG ? HALF_RANGE_DEG / r : 1;
    const px = (SIZE / 2) * (1 + (dx * k) / HALF_RANGE_DEG);
    const py = (SIZE / 2) * (1 + (dy * k) / HALF_RANGE_DEG);
    return { x: px, y: py, outside: r > HALF_RANGE_DEG };
  }, [guidance, orientation]);

  const instruction = (() => {
    if (!target) return 'Esperando la posición del satélite…';
    if (target.elevation < 0) return 'El satélite está bajo el horizonte: todavía no se puede apuntar.';
    if (!guidance) return 'Moviendo el teléfono para calibrar la brújula…';
    if (guidance.locked) return '¡Apuntando al satélite!';
    const turn = Math.round(Math.abs(guidance.deltaAzimuth));
    const tilt = Math.round(Math.abs(guidance.deltaElevation));
    const parts: string[] = [];
    if (turn >= 2) parts.push(`Girá ${turn}° a la ${guidance.deltaAzimuth > 0 ? 'derecha' : 'izquierda'}`);
    if (tilt >= 2) parts.push(`${guidance.deltaElevation > 0 ? 'Subí' : 'Bajá'} ${tilt}°`);
    return parts.join(' · ') || 'Casi…';
  })();

  return (
    <View style={s.root} accessibilityViewIsModal>
      <Text style={s.title}>Modo brújula · {satelliteName}</Text>
      <Text style={s.hint}>Sostené el teléfono en vertical y apuntá con la parte trasera hacia el cielo.</Text>

      {available === false ? (
        <Text style={s.error}>Este dispositivo no tiene los sensores necesarios (acelerómetro y magnetómetro).</Text>
      ) : (
        <>
          <View style={s.dial}>
            <Svg width={SIZE} height={SIZE}>
              <Circle cx={SIZE / 2} cy={SIZE / 2} r={SIZE / 2 - 2} stroke={colors.border} strokeWidth={2} fill={colors.surface} />
              <Circle cx={SIZE / 2} cy={SIZE / 2} r={SIZE / 4} stroke={colors.border} strokeWidth={1} fill="none" />
              <Line x1={SIZE / 2} y1={8} x2={SIZE / 2} y2={SIZE - 8} stroke={colors.border} strokeWidth={1} />
              <Line x1={8} y1={SIZE / 2} x2={SIZE - 8} y2={SIZE / 2} stroke={colors.border} strokeWidth={1} />
              <Circle
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={(SIZE / 2) * (5 / HALF_RANGE_DEG)}
                stroke={guidance?.locked ? colors.ok : colors.accent}
                strokeWidth={3}
                fill="none"
              />
              {dot ? (
                <Circle
                  cx={dot.x}
                  cy={dot.y}
                  r={dot.outside ? 9 : 8}
                  fill={dot.outside ? 'none' : guidance?.locked ? colors.ok : colors.sat}
                  stroke={dot.outside ? colors.warn : '#fff'}
                  strokeWidth={dot.outside ? 3 : 2}
                />
              ) : null}
            </Svg>
          </View>
          <Text style={[s.instruction, guidance?.locked && { color: colors.ok }]}>{instruction}</Text>

          <View style={s.row}>
            <View style={s.cell}>
              <Text style={s.cellLabel}>Tu equipo apunta</Text>
              <Text style={s.cellValue}>
                {orientation ? `${Math.round(orientation.azimuth)}° ${compassName(orientation.azimuth)}` : '—'}
              </Text>
              <Text style={s.cellSub}>elevación {orientation ? `${Math.round(orientation.pitch)}°` : '—'}</Text>
            </View>
            <View style={s.cell}>
              <Text style={s.cellLabel}>Satélite</Text>
              <Text style={s.cellValue}>
                {target ? `${Math.round(target.azimuth)}° ${compassName(target.azimuth)}` : '—'}
              </Text>
              <Text style={s.cellSub}>elevación {target ? `${Math.round(target.elevation)}°` : '—'}</Text>
            </View>
          </View>
          <Text style={s.note}>
            {declination === undefined
              ? 'Estimando declinación magnética…'
              : declination === null
                ? 'Sin corrección de declinación (norte magnético): puede haber un error de varios grados.'
                : `Declinación magnética aplicada: ${declination.toFixed(1)}°.`}{' '}
            Si la brújula parece desviada, mové el teléfono dibujando un 8.
          </Text>
        </>
      )}
      <View style={{ height: spacing.lg }} />
      <Button label="Cerrar" variant="ghost" onPress={onClose} />
    </View>
  );
}

const s = StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(5,7,13,0.97)',
    padding: spacing.lg,
    paddingTop: spacing.xl,
    alignItems: 'center',
    zIndex: 20,
  },
  title: { color: colors.text, fontSize: 18, fontWeight: '800', textAlign: 'center' },
  hint: { color: colors.textMuted, fontSize: 13, textAlign: 'center', marginTop: 4, marginBottom: spacing.lg },
  dial: { borderRadius: radius.pill, overflow: 'hidden' },
  instruction: { color: colors.text, fontSize: 20, fontWeight: '800', marginTop: spacing.lg, textAlign: 'center' },
  row: { flexDirection: 'row', gap: spacing.lg, marginTop: spacing.lg, width: '100%' },
  cell: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cellLabel: { color: colors.textMuted, fontSize: 11, textTransform: 'uppercase' },
  cellValue: { color: colors.text, fontSize: 18, fontWeight: '700', marginTop: 2 },
  cellSub: { color: colors.textMuted, fontSize: 12 },
  note: { color: colors.textMuted, fontSize: 12, textAlign: 'center', marginTop: spacing.md },
  error: { color: colors.danger, fontSize: 15, textAlign: 'center', marginTop: spacing.xl },
});
