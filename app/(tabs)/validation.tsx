import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import type { ValidationRecord } from '../../src/data/cache/CacheStore';
import { summarize, validationToMarkdown } from '../../src/core/validation';
import { formatAge } from '../../src/data/freshness';
import { runValidation, type ValidationRun } from '../../src/services/ValidationService';
import { useApp } from '../../src/state/AppContext';
import { Banner, Button, Card, DataAgeBanner } from '../../src/ui/components';
import { colors, radius, spacing } from '../../src/ui/theme';

const LABEL: Record<string, string> = { n2yo: 'N2YO', wheretheiss: 'Where the ISS at?' };

export default function ValidationScreen() {
  const { container, selected, observer, freshness } = useApp();
  const [records, setRecords] = useState<ValidationRecord[]>([]);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<ValidationRun | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!container) return;
    setRecords(await container.store.listValidationRecords(100));
  }, [container]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async () => {
    if (!container || !selected) return;
    setRunning(true);
    setError(null);
    try {
      // La posición del satélite no depende del observador; sin GPS se usa (0, 0) solo para el pedido a N2YO.
      const obs = observer ?? { latitude: 0, longitude: 0, altitudeKm: 0 };
      setLastRun(await runValidation(container.orchestrator, container.store, selected.elements, obs));
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const share = () => Share.share({ message: validationToMarkdown(records), title: 'Validación SGP4' });

  const clear = async () => {
    await container?.store.clearValidationRecords();
    setLastRun(null);
    await reload();
  };

  if (!selected) {
    return (
      <View style={s.center}>
        <Text style={s.muted}>Elegí un satélite para validar su posición.</Text>
      </View>
    );
  }

  const stats = summarize(records);
  const isIss = selected.elements.noradId === 25544;

  return (
    <ScrollView style={{ backgroundColor: colors.bg }} contentContainerStyle={s.scroll}>
      <Text style={s.title}>Validación de {selected.elements.name}</Text>
      <Text style={s.muted}>
        Compara la posición calculada localmente con SGP4 contra una fuente independiente, en el instante que informa
        la API, y muestra el error en km. N2YO valida cualquier satélite{isIss ? '; Where the ISS at? valida la ISS' : ' (Where the ISS at? solo aplica a la ISS)'}.
      </Text>
      {freshness ? <DataAgeBanner freshness={freshness} meta={selected.meta} /> : null}
      <Text style={s.muted}>
        La antigüedad de los elementos orbitales es la principal causa de error: un TLE se degrada ~1–3 km por día.
      </Text>

      <Button label={running ? 'Consultando APIs…' : 'Validar ahora'} onPress={run} busy={running} />
      {error ? <Banner tone="danger" text={error} /> : null}

      {lastRun ? (
        <Card style={{ gap: spacing.md }}>
          <Text style={s.h2}>Última medición</Text>
          {lastRun.records.map((r) => (
            <View key={`${r.reference}${r.createdAt}`} style={s.result}>
              <Text style={s.refName}>{LABEL[r.reference] ?? r.reference}</Text>
              <Text style={[s.err, { color: r.errorKm < 5 ? colors.ok : r.errorKm < 25 ? colors.warn : colors.danger }]}>
                {r.errorKm.toFixed(2)} km
              </Text>
              <Text style={s.muted}>
                Horizontal {r.horizontalKm.toFixed(2)} km · Δ altitud {r.altitudeDiffKm.toFixed(2)} km · elementos de hace{' '}
                {formatAge(r.elementsAgeDays)}
              </Text>
              <Text style={s.muted}>
                Local ({r.localLat.toFixed(3)}, {r.localLon.toFixed(3)}, {r.localAltKm.toFixed(1)} km) vs API ({r.apiLat.toFixed(3)}, {r.apiLon.toFixed(3)}, {r.apiAltKm.toFixed(1)} km)
              </Text>
            </View>
          ))}
          {lastRun.failures.map((f) => (
            <Banner key={f.provider} tone="warn" text={`${f.label}: ${f.error}`} />
          ))}
        </Card>
      ) : null}

      {stats.length ? (
        <Card style={{ gap: spacing.sm }}>
          <Text style={s.h2}>Resumen ({records.length} mediciones)</Text>
          {stats.map((st) => (
            <Text key={st.reference} style={s.muted}>
              <Text style={{ color: colors.text, fontWeight: '700' }}>{LABEL[st.reference] ?? st.reference}</Text> · n = {st.count} · media {st.meanKm.toFixed(2)} km · mediana {st.medianKm.toFixed(2)} km · máx {st.maxKm.toFixed(2)} km
            </Text>
          ))}
        </Card>
      ) : null}

      {records.length ? (
        <>
          <Text style={s.h2}>Historial</Text>
          {records.slice(0, 30).map((r) => (
            <View key={r.id} style={s.hist}>
              <Text style={s.histMain}>
                {r.satelliteName} · {LABEL[r.reference] ?? r.reference}
              </Text>
              <Text style={s.histErr}>{r.errorKm.toFixed(2)} km</Text>
              <Text style={s.histSub}>
                {new Date(r.referenceTimestampMs).toLocaleString('es-AR')} · edad {formatAge(r.elementsAgeDays)} · {r.elementsSource}
              </Text>
            </View>
          ))}
          <View style={{ flexDirection: 'row', gap: spacing.md }}>
            <View style={{ flex: 1 }}>
              <Button label="Compartir tabla (Markdown)" variant="ghost" onPress={share} />
            </View>
            <View style={{ flex: 1 }}>
              <Button label="Borrar mediciones" variant="danger" onPress={clear} />
            </View>
          </View>
        </>
      ) : (
        <Text style={s.muted}>Todavía no hay mediciones guardadas. Cada medición queda registrada para armar la tabla del informe de validación.</Text>
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  scroll: { padding: spacing.lg, gap: spacing.md },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, backgroundColor: colors.bg },
  title: { color: colors.text, fontSize: 20, fontWeight: '800' },
  h2: { color: colors.text, fontSize: 16, fontWeight: '700' },
  muted: { color: colors.textMuted, fontSize: 13 },
  result: { gap: 2 },
  refName: { color: colors.textMuted, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.6 },
  err: { fontSize: 30, fontWeight: '800' },
  hist: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  histMain: { color: colors.text, fontSize: 14, fontWeight: '600' },
  histErr: { color: colors.accent, fontSize: 16, fontWeight: '800' },
  histSub: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
});
