import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { compassName, formatCountdown, formatDateTime, formatDuration } from '../../src/core/format';
import type { Pass } from '../../src/core/orbital/types';
import { ensureNotificationPermission, replaceRemindersFor, cancelRemindersFor, reminderId, scheduledPassIds, togglePassReminder } from '../../src/services/NotificationService';
import { useApp } from '../../src/state/AppContext';
import { useNow } from '../../src/state/hooks';
import { Banner, Button, Card, Chip, DataAgeBanner } from '../../src/ui/components';
import { colors, radius, spacing } from '../../src/ui/theme';

const HORIZON_HOURS = 72;

export default function PassesScreen() {
  const router = useRouter();
  const { engine, selected, observer, settings, updateSettings, freshness, locationStatus, refreshLocation } = useApp();
  const [passes, setPasses] = useState<Pass[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [scheduled, setScheduled] = useState<Set<string>>(new Set());
  const now = useNow(30_000, passes.length > 0);

  const noradId = selected?.elements.noradId ?? 0;
  const name = selected?.elements.name ?? '';
  const tracked = settings.trackedNoradIds.includes(noradId);

  const refreshScheduled = useCallback(async () => {
    try {
      setScheduled(await scheduledPassIds());
    } catch {
      /* notificaciones no disponibles */
    }
  }, []);

  // Predicción de pases (RF-04): asíncrona y cancelable; no bloquea la UI.
  useEffect(() => {
    if (!engine || !observer) {
      setPasses([]);
      return;
    }
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    engine
      .predictPasses(observer, new Date(), {
        minElevationDeg: settings.minElevationDeg,
        horizonHours: HORIZON_HOURS,
        maxPasses: 15,
        signal: ac.signal,
      })
      .then((list) => {
        if (ac.signal.aborted) return;
        setPasses(list);
        if (tracked) void replaceRemindersFor(noradId, name, list, settings.notifyMinutes).then(refreshScheduled);
        else void refreshScheduled();
      })
      .catch((e) => {
        if (!ac.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, observer, settings.minElevationDeg]);

  const onBell = async (pass: Pass) => {
    setMessage(null);
    if (!(await ensureNotificationPermission())) {
      setMessage('Las notificaciones están desactivadas para la app. Activalas en los ajustes del sistema.');
      return;
    }
    const on = await togglePassReminder(noradId, name, pass, settings.notifyMinutes);
    setMessage(on ? `Aviso agendado ${settings.notifyMinutes} min antes del pase.` : 'Aviso cancelado (o ya pasó la hora del aviso).');
    await refreshScheduled();
  };

  const onTrack = async () => {
    setMessage(null);
    if (tracked) {
      updateSettings({ trackedNoradIds: settings.trackedNoradIds.filter((n) => n !== noradId) });
      await cancelRemindersFor(noradId);
      setMessage('Dejaste de seguir este satélite: se cancelaron sus avisos.');
    } else {
      if (!(await ensureNotificationPermission())) {
        setMessage('Las notificaciones están desactivadas para la app. Activalas en los ajustes del sistema.');
        return;
      }
      updateSettings({ trackedNoradIds: [...settings.trackedNoradIds, noradId] });
      const n = await replaceRemindersFor(noradId, name, passes, settings.notifyMinutes);
      setMessage(`Siguiendo ${name}: ${n} aviso${n === 1 ? '' : 's'} agendado${n === 1 ? '' : 's'}. Se renuevan solos en segundo plano.`);
    }
    await refreshScheduled();
  };

  const open = (p: Pass) =>
    router.push({
      pathname: '/pass/[noradId]',
      params: {
        noradId: String(noradId),
        aos: String(p.aos.getTime()),
        tca: String(p.tca.getTime()),
        los: String(p.los.getTime()),
        maxEl: p.maxElevation.toFixed(1),
        aosAz: p.aosAzimuth.toFixed(1),
        tcaAz: p.tcaAzimuth.toFixed(1),
        losAz: p.losAzimuth.toFixed(1),
      },
    });

  if (!selected || !engine) {
    return (
      <View style={s.center}>
        <Text style={s.muted}>Elegí un satélite en el Catálogo o en el Mapa para ver sus pases.</Text>
      </View>
    );
  }

  return (
    <View style={s.root}>
      <View style={s.head}>
        <Text style={s.title}>{name}</Text>
        <Text style={s.muted}>
          Próximas {HORIZON_HOURS} h · elevación mínima {settings.minElevationDeg}° · aviso {settings.notifyMinutes} min antes
        </Text>
        {freshness ? <DataAgeBanner freshness={freshness} meta={selected.meta} /> : null}
        {!observer ? (
          <Banner
            tone="warn"
            text={
              locationStatus === 'denied'
                ? 'Sin permiso de ubicación: no se pueden calcular pases para tu posición.'
                : 'Obteniendo tu ubicación…'
            }
          />
        ) : null}
        {!observer ? <Button label="Reintentar ubicación" variant="ghost" onPress={() => void refreshLocation()} /> : null}
        {message ? <Banner tone="info" text={message} /> : null}
        {error ? <Banner tone="danger" text={error} /> : null}
        <View style={s.rowChips}>
          <Chip label={tracked ? '🔔 Siguiendo este satélite' : '🔕 Seguir este satélite'} active={tracked} onPress={onTrack} disabled={!observer} />
        </View>
      </View>

      {loading ? (
        <View style={s.center}>
          <ActivityIndicator color={colors.accent} />
          <Text style={[s.muted, { marginTop: spacing.sm }]}>Calculando pases…</Text>
        </View>
      ) : (
        <FlatList
          data={passes}
          keyExtractor={(p) => String(p.aos.getTime())}
          contentContainerStyle={{ padding: spacing.md, gap: spacing.sm }}
          ListEmptyComponent={
            observer ? <Text style={[s.muted, { textAlign: 'center', padding: spacing.xl }]}>No hay pases sobre {settings.minElevationDeg}° en las próximas {HORIZON_HOURS} h.</Text> : null
          }
          renderItem={({ item: p }) => {
            const on = scheduled.has(reminderId(noradId, p.aos.getTime()));
            const live = p.aos.getTime() <= now && now <= p.los.getTime();
            return (
              <Card style={s.pass}>
                <Pressable onPress={() => open(p)} style={{ flex: 1 }} accessibilityRole="button">
                  <Text style={s.when}>{formatDateTime(p.aos.getTime())}</Text>
                  <Text style={[s.countdown, live && { color: colors.ok }]}>{live ? 'En curso ahora' : formatCountdown(p.aos.getTime(), now)}</Text>
                  <Text style={s.detail}>
                    Sale por {compassName(p.aosAzimuth)} · máx. {Math.round(p.maxElevation)}° · {formatDuration(p.durationSec)}
                    {p.inProgress ? ' (ya en curso)' : ''}
                  </Text>
                </Pressable>
                <Pressable onPress={() => onBell(p)} style={s.bell} accessibilityRole="button" accessibilityLabel={on ? 'Cancelar aviso' : 'Avisarme de este pase'}>
                  <Text style={{ fontSize: 22 }}>{on ? '🔔' : '🔕'}</Text>
                </Pressable>
              </Card>
            );
          }}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  head: { padding: spacing.md, gap: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  title: { color: colors.text, fontSize: 20, fontWeight: '800' },
  muted: { color: colors.textMuted, fontSize: 13 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  rowChips: { flexDirection: 'row', gap: spacing.sm },
  pass: { flexDirection: 'row', alignItems: 'center', padding: spacing.md, borderRadius: radius.md },
  when: { color: colors.text, fontSize: 16, fontWeight: '700' },
  countdown: { color: colors.accent, fontSize: 13, fontWeight: '700', marginTop: 2 },
  detail: { color: colors.textMuted, fontSize: 13, marginTop: 4 },
  bell: { paddingLeft: spacing.md, paddingVertical: spacing.sm, minWidth: 48, alignItems: 'center' },
});
