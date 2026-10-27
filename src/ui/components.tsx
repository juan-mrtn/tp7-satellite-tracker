import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { colors, radius, spacing } from './theme';
import { formatAge } from '../data/freshness';
import type { Freshness } from '../data/freshness';
import type { DataMeta } from '../data/types';

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[s.card, style]}>{children}</View>;
}

export function Chip({
  label,
  active,
  onPress,
  disabled,
}: {
  label: string;
  active?: boolean;
  onPress?: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ selected: !!active, disabled: !!disabled }}
      style={[s.chip, active && s.chipActive, disabled && { opacity: 0.4 }]}
    >
      <Text style={[s.chipText, active && s.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  busy,
  disabled,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'ghost' | 'danger';
  busy?: boolean;
  disabled?: boolean;
}) {
  const bg = variant === 'primary' ? colors.accent : variant === 'danger' ? '#5a2323' : 'transparent';
  const fg = variant === 'primary' ? '#04110f' : colors.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={busy || disabled}
      accessibilityRole="button"
      style={[
        s.button,
        { backgroundColor: bg, borderColor: variant === 'ghost' ? colors.border : bg },
        (busy || disabled) && { opacity: 0.55 },
      ]}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Text style={[s.buttonText, { color: fg }]}>{label}</Text>}
    </Pressable>
  );
}

export function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <View style={s.stat}>
      <Text style={s.statLabel}>{label}</Text>
      <Text style={s.statValue}>{value}</Text>
      {sub ? <Text style={s.statSub}>{sub}</Text> : null}
    </View>
  );
}

export function Banner({ tone, text }: { tone: 'info' | 'warn' | 'danger'; text: string }) {
  const c = tone === 'danger' ? colors.danger : tone === 'warn' ? colors.warn : colors.accent;
  return (
    <View style={[s.banner, { borderColor: c }]}>
      <Text style={[s.bannerText, { color: c }]}>{text}</Text>
    </View>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  celestrak: 'CelesTrak',
  spacetrack: 'Space-Track',
  unknown: 'caché local',
};

/**
 * Antigüedad de los datos orbitales (RF-16): siempre visible, y en alerta cuando los elementos
 * son viejos, la descarga superó el TTL o se están usando datos de caché por falta de red.
 */
export function DataAgeBanner({ freshness, meta }: { freshness: Freshness; meta: DataMeta | null }) {
  const source = meta ? SOURCE_LABEL[meta.provider] ?? meta.provider : '—';
  const detail = `Elementos de hace ${formatAge(freshness.epochAgeDays)} · fuente ${source}`;
  if (freshness.level === 'stale') {
    return <Banner tone="danger" text={`Datos desactualizados (${detail}). La posición puede tener errores de decenas de km.`} />;
  }
  if (meta?.stale) {
    return <Banner tone="warn" text={`Sin conexión con los proveedores: se usan datos en caché. ${detail}.`} />;
  }
  if (freshness.level === 'aging') {
    return <Banner tone="warn" text={`Datos con cierta antigüedad. ${detail}.`} />;
  }
  return <Banner tone="info" text={detail} />;
}

const s = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  chipActive: { backgroundColor: colors.accentDim, borderColor: colors.accent },
  chipText: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },
  chipTextActive: { color: colors.text },
  button: {
    minHeight: 44,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { fontSize: 15, fontWeight: '700' },
  stat: { flex: 1, minWidth: 90 },
  statLabel: { color: colors.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6 },
  statValue: { color: colors.text, fontSize: 17, fontWeight: '700', marginTop: 2 },
  statSub: { color: colors.textMuted, fontSize: 12, marginTop: 1 },
  banner: {
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: 'rgba(5,7,13,0.82)',
  },
  bannerText: { fontSize: 12, fontWeight: '600' },
});
