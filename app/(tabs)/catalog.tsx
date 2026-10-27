import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { elementsAgeDays } from '../../src/core/orbital/OrbitalEngine';
import type { OrbitalElements } from '../../src/core/orbital/types';
import { formatAge } from '../../src/data/freshness';
import { CATALOG_GROUPS, type CatalogGroup, type DataMeta } from '../../src/data/types';
import { useApp } from '../../src/state/AppContext';
import { Banner, Button, Chip } from '../../src/ui/components';
import { colors, radius, spacing } from '../../src/ui/theme';

const SOURCE: Record<string, string> = { celestrak: 'CelesTrak', spacetrack: 'Space-Track', unknown: 'caché' };

export default function CatalogScreen() {
  const router = useRouter();
  const { container, selectSatellite, selected } = useApp();
  const [group, setGroup] = useState<CatalogGroup>('stations');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<OrbitalElements[]>([]);
  const [meta, setMeta] = useState<DataMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [remote, setRemote] = useState<OrbitalElements[] | null>(null);

  const load = useCallback(
    async (forceRefresh = false) => {
      if (!container) return;
      setLoading(true);
      setError(null);
      setNotice(null);
      try {
        const res = await container.orchestrator.getGroup(group, { forceRefresh });
        setItems(res.data);
        setMeta(res.meta);
        if (res.meta.refreshSkipped) {
          setNotice('Los datos orbitales se actualizan cada ~2 h en origen: se mantiene la copia local para no sobrecargar al proveedor.');
        }
      } catch (e) {
        setItems([]);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [container, group]
  );

  useEffect(() => {
    setRemote(null);
    void load(false);
  }, [load]);

  const q = query.trim();
  const numericQuery = /^\d{1,6}$/.test(q);

  // Búsqueda por NORAD ID: va directo al orquestador (caché → proveedores).
  useEffect(() => {
    if (!container || !numericQuery) {
      if (!numericQuery) setRemote(null);
      return;
    }
    const t = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await container.orchestrator.search(q);
        setRemote(res.data);
        setMeta(res.meta);
      } catch (e) {
        setRemote([]);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    }, 500);
    return () => clearTimeout(t);
  }, [container, q, numericQuery]);

  const filtered = useMemo(() => {
    if (numericQuery) return remote ?? [];
    if (!q) return items;
    const needle = q.toLowerCase();
    return remote ?? items.filter((e) => e.name.toLowerCase().includes(needle));
  }, [items, q, numericQuery, remote]);

  const searchEverywhere = async () => {
    if (!container) return;
    setLoading(true);
    setError(null);
    try {
      const res = await container.orchestrator.search(q);
      setRemote(res.data);
      setMeta(res.meta);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => setRemote(null), [q]);

  const pick = (el: OrbitalElements) => {
    selectSatellite(el, meta);
    router.navigate('/');
  };

  return (
    <View style={s.root}>
      <View style={s.head}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Buscar por nombre o NORAD ID (p. ej. 25544)"
          placeholderTextColor={colors.textMuted}
          style={s.input}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          accessibilityLabel="Buscar satélite"
        />
        <FlatList
          horizontal
          data={CATALOG_GROUPS}
          keyExtractor={(g) => g.id}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: spacing.sm }}
          renderItem={({ item }) => (
            <Chip label={item.label.split(' (')[0] ?? item.label} active={group === item.id} onPress={() => setGroup(item.id)} />
          )}
        />
        {meta ? (
          <Text style={s.meta}>
            {filtered.length.toLocaleString('es-AR')} resultado{filtered.length === 1 ? '' : 's'} · fuente {SOURCE[meta.provider] ?? meta.provider}
            {meta.fromCache ? ' (caché)' : ''} · descargado hace {formatAge(meta.ageMs / 86_400_000)}
          </Text>
        ) : null}
        {meta?.stale ? <Banner tone="warn" text="Sin conexión con los proveedores: se muestran datos en caché que superaron el TTL." /> : null}
        {notice ? <Banner tone="info" text={notice} /> : null}
        {error ? <Banner tone="danger" text={error} /> : null}
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(e) => String(e.noradId)}
        initialNumToRender={20}
        windowSize={7}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => load(true)} tintColor={colors.accent} />}
        contentContainerStyle={{ padding: spacing.md, gap: spacing.sm }}
        renderItem={({ item }) => {
          const age = elementsAgeDays(item);
          const active = selected?.elements.noradId === item.noradId;
          return (
            <Pressable onPress={() => pick(item)} style={[s.row, active && s.rowActive]} accessibilityRole="button">
              <View style={{ flex: 1 }}>
                <Text style={s.name}>{item.name}</Text>
                <Text style={s.sub}>NORAD {item.noradId} · elementos de hace {formatAge(age)}</Text>
              </View>
              <Text style={s.go}>{active ? '●' : '›'}</Text>
            </Pressable>
          );
        }}
        ListEmptyComponent={
          loading ? null : (
            <View style={{ padding: spacing.xl, gap: spacing.md }}>
              <Text style={s.empty}>{q ? `Sin coincidencias para “${q}” en este grupo.` : 'No hay datos para mostrar.'}</Text>
              {q && !numericQuery ? <Button label="Buscar en todo el catálogo" variant="ghost" onPress={searchEverywhere} /> : null}
              {!q ? <Button label="Reintentar" onPress={() => load(true)} /> : null}
            </View>
          )
        }
      />
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  head: { padding: spacing.md, gap: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    color: colors.text,
    paddingHorizontal: spacing.md,
    height: 46,
    fontSize: 15,
  },
  meta: { color: colors.textMuted, fontSize: 12 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    minHeight: 56,
  },
  rowActive: { borderColor: colors.accent },
  name: { color: colors.text, fontSize: 15, fontWeight: '700' },
  sub: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  go: { color: colors.accent, fontSize: 22, paddingLeft: spacing.md },
  empty: { color: colors.textMuted, textAlign: 'center' },
});
