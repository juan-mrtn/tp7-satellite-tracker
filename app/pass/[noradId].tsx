import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { CompassOverlay } from '../../src/components/CompassOverlay';
import { SkyChart } from '../../src/components/SkyChart';
import { compassName, formatCountdown, formatDateTime, formatDuration, formatTime } from '../../src/core/format';
import { samplePassPath } from '../../src/core/skyChart';
import { useApp } from '../../src/state/AppContext';
import { useLiveState, useNow } from '../../src/state/hooks';
import { Banner, Button, Card, DataAgeBanner, Stat } from '../../src/ui/components';
import { colors, spacing } from '../../src/ui/theme';

const num = (v: string | string[] | undefined, fallback = 0) => {
  const n = Number(Array.isArray(v) ? v[0] : v);
  return Number.isFinite(n) ? n : fallback;
};

export default function PassDetailScreen() {
  const params = useLocalSearchParams<{
    noradId: string; aos: string; tca: string; los: string; maxEl: string; aosAz: string; tcaAz: string; losAz: string;
  }>();
  const { width } = useWindowDimensions();
  const { engine, selected, observer, settings, freshness } = useApp();
  const [compass, setCompass] = useState(false);

  const aos = num(params.aos);
  const tca = num(params.tca);
  const los = num(params.los);
  const noradId = num(params.noradId);

  const live = useLiveState(engine, observer, 1);
  const now = useNow(1000);

  const samples = useMemo(
    () => (engine && observer && aos && los ? samplePassPath((ms) => engine.lookAnglesAt(ms, observer), aos, los, 10) : []),
    [engine, observer, aos, los]
  );

  if (!engine || !selected || !observer || selected.elements.noradId !== noradId) {
    return (
      <View style={s.center}>
        <Text style={s.muted}>
          No hay datos para este pase. Volvé a la lista de pases del satélite seleccionado.
        </Text>
      </View>
    );
  }

  const size = Math.min(width - spacing.lg * 2, 380);
  const inProgress = now >= aos && now <= los;
  const current = live?.look ?? null;
  const status = inProgress
    ? 'En curso ahora'
    : now < aos
      ? `Comienza ${formatCountdown(aos, now)}`
      : 'Este pase ya terminó';

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={s.scroll}>
        <Text style={s.title}>{selected.elements.name}</Text>
        <Text style={[s.status, inProgress && { color: colors.ok }]}>{status}</Text>
        {freshness ? <DataAgeBanner freshness={freshness} meta={selected.meta} /> : null}

        <View style={{ alignItems: 'center' }}>
          <SkyChart size={size} samples={samples} current={current} minElevation={settings.minElevationDeg} />
        </View>
        <Text style={s.legend}>Norte arriba, Este a la izquierda (el cielo visto desde abajo). Cada anillo es 30° de elevación; el punteado es tu elevación mínima.</Text>

        <Card style={{ gap: spacing.md }}>
          <View style={s.row}>
            <Stat label="AOS" value={formatTime(aos)} sub={`${Math.round(num(params.aosAz))}° ${compassName(num(params.aosAz))}`} />
            <Stat label="Máxima" value={formatTime(tca)} sub={`${Math.round(num(params.maxEl))}° · ${compassName(num(params.tcaAz))}`} />
            <Stat label="LOS" value={formatTime(los)} sub={`${Math.round(num(params.losAz))}° ${compassName(num(params.losAz))}`} />
          </View>
          <Text style={s.muted}>
            {formatDateTime(aos)} · duración {formatDuration((los - aos) / 1000)}
          </Text>
        </Card>

        {current ? (
          <Card style={s.row}>
            <Stat label="Ahora: azimut" value={`${Math.round(current.azimuth)}° ${compassName(current.azimuth)}`} />
            <Stat label="Elevación" value={`${Math.round(current.elevation)}°`} sub={current.elevation < 0 ? 'bajo el horizonte' : undefined} />
            <Stat label="Distancia" value={`${Math.round(current.rangeKm).toLocaleString('es-AR')} km`} />
          </Card>
        ) : null}

        {!inProgress && now > los ? <Banner tone="warn" text="Este pase ya terminó. Volvé a la lista para ver los próximos." /> : null}
        <Button label="Modo brújula" onPress={() => setCompass(true)} />
      </ScrollView>

      {compass ? (
        <CompassOverlay
          satelliteName={selected.elements.name}
          target={current ? { azimuth: current.azimuth, elevation: current.elevation } : null}
          onClose={() => setCompass(false)}
        />
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  scroll: { padding: spacing.lg, gap: spacing.lg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, backgroundColor: colors.bg },
  title: { color: colors.text, fontSize: 22, fontWeight: '800' },
  status: { color: colors.accent, fontSize: 15, fontWeight: '700', marginTop: -spacing.sm },
  muted: { color: colors.textMuted, fontSize: 13, textAlign: 'center' },
  legend: { color: colors.textMuted, fontSize: 12, textAlign: 'center' },
  row: { flexDirection: 'row', gap: spacing.md },
});
