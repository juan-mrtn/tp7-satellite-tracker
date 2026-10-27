import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  Camera,
  GeoJSONSource,
  Layer,
  Map,
  UserLocation,
  type CameraRef,
  type ViewStateChangeEvent,
} from '@maplibre/maplibre-react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ConstellationLayer } from '../../src/components/ConstellationLayer';
import { compassName, formatLat, formatLon } from '../../src/core/format';
import type { LatLng } from '../../src/core/orbital/types';
import type { MapRegion } from '../../src/core/orbital/viewport';
import { CATALOG_GROUPS } from '../../src/data/types';
import { useApp } from '../../src/state/AppContext';
import { useLiveState, useNow } from '../../src/state/hooks';
import { Banner, Button, Card, Chip, DataAgeBanner, Stat } from '../../src/ui/components';
import { colors, MAP_STYLE_URL, radius, spacing } from '../../src/ui/theme';

const toLngLat = (p: LatLng): [number, number] => [p.longitude, p.latitude];

/** Tramos del ground track (ya divididos en el antimeridiano) como un MultiLineString. */
function lines(segments: LatLng[][] | undefined): GeoJSON.Feature<GeoJSON.MultiLineString> {
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'MultiLineString', coordinates: (segments ?? []).map((seg) => seg.map(toLngLat)) },
  };
}

/** Anillos del footprint como MultiPolygon (GeoJSON exige anillos cerrados). */
function polygons(rings: LatLng[][]): GeoJSON.Feature<GeoJSON.MultiPolygon> {
  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'MultiPolygon',
      coordinates: rings.map((ring) => {
        const coords = ring.map(toLngLat);
        if (coords.length) coords.push(coords[0] as [number, number]);
        return [coords];
      }),
    },
  };
}

/** Convierte la vista de MapLibre (centro + bounds) a la región que usa la capa de constelación. */
function toRegion(e: ViewStateChangeEvent): MapRegion {
  const [west, south, east, north] = e.bounds;
  const lonSpan = east - west;
  return {
    latitude: e.center[1],
    longitude: e.center[0],
    latitudeDelta: north - south,
    longitudeDelta: lonSpan > 0 ? lonSpan : lonSpan + 360,
  };
}

export default function MapScreen() {
  const router = useRouter();
  const {
    engine, engineError, selected, selecting, selectionError, freshness, observer, settings, updateSettings,
    selectSatellite,
  } = useApp();
  const cameraRef = useRef<CameraRef>(null);
  const [region, setRegion] = useState<MapRegion | null>(null);
  const [constellationStatus, setConstellationStatus] = useState<string | null>(null);
  // Panel inferior minimizable para dejar ver el mapa completo.
  const [collapsed, setCollapsed] = useState(false);

  const live = useLiveState(engine, observer, settings.positionRefreshSec);
  const position = live?.position ?? null;

  // El ground track se recalcula una vez por minuto (o al cambiar de satélite), no en cada refresco.
  const trackNow = useNow(60_000, !!engine && settings.showGroundTrack);
  const track = useMemo(
    () => (engine && settings.showGroundTrack ? engine.groundTrack(new Date(trackNow)) : null),
    [engine, trackNow, settings.showGroundTrack]
  );

  // El footprint sí sigue al satélite en cada refresco (es barato: ~72 vértices).
  const footprint = useMemo(
    () =>
      engine && position && settings.showFootprint
        ? engine.footprint(position, settings.footprintMinElevationDeg)
        : [],
    [engine, position, settings.showFootprint, settings.footprintMinElevationDeg]
  );

  const pastTrack = useMemo(() => lines(track?.past), [track]);
  const futureTrack = useMemo(() => lines(track?.future), [track]);
  const footprintShape = useMemo(() => polygons(footprint), [footprint]);
  const selectedPoint = useMemo<GeoJSON.Feature<GeoJSON.Point> | null>(
    () =>
      position && selected
        ? { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [position.longitude, position.latitude] } }
        : null,
    [position, selected]
  );

  // Al elegir otro satélite se centra el mapa en él.
  const lastCentered = useRef<number | null>(null);
  useEffect(() => {
    if (!position || !selected || lastCentered.current === selected.elements.noradId) return;
    lastCentered.current = selected.elements.noradId;
    cameraRef.current?.easeTo({ center: [position.longitude, position.latitude], zoom: 1.5, duration: 600 });
  }, [position, selected]);

  const center = () => {
    if (!position) return;
    cameraRef.current?.easeTo({ center: [position.longitude, position.latitude], zoom: 2.3, duration: 500 });
  };

  const visible = live?.look ? live.look.elevation >= 0 : null;

  return (
    <View style={s.root}>
      <Map
        style={StyleSheet.absoluteFill}
        mapStyle={MAP_STYLE_URL}
        onRegionDidChange={(e) => setRegion(toRegion(e.nativeEvent))}
        compass={false}
        touchRotate={false}
        touchPitch={false}
        attributionPosition={{ top: 8, right: 8 }}
        logo={false}
      >
        <Camera ref={cameraRef} initialViewState={{ center: [-30, 0], zoom: 0.8 }} />
        <UserLocation />

        <GeoJSONSource id="footprint" data={footprintShape}>
          <Layer id="footprint-fill" type="fill" paint={{ 'fill-color': 'rgba(79,209,197,0.14)' }} />
          <Layer id="footprint-line" type="line" paint={{ 'line-color': 'rgba(79,209,197,0.8)', 'line-width': 1.5 }} />
        </GeoJSONSource>
        <GeoJSONSource id="track-past" data={pastTrack}>
          <Layer
            id="track-past-line"
            type="line"
            paint={{ 'line-color': 'rgba(143,160,186,0.7)', 'line-width': 2, 'line-dasharray': [3, 3] }}
          />
        </GeoJSONSource>
        <GeoJSONSource id="track-future" data={futureTrack}>
          <Layer id="track-future-line" type="line" paint={{ 'line-color': colors.accent, 'line-width': 3 }} />
        </GeoJSONSource>

        {settings.constellationGroup ? (
          <ConstellationLayer
            group={settings.constellationGroup}
            limit={settings.constellationLimit}
            region={region}
            excludeNoradId={selected?.elements.noradId}
            onSelect={(el, meta) => selectSatellite(el, meta)}
            onStatus={setConstellationStatus}
          />
        ) : null}
        {selectedPoint ? (
          <GeoJSONSource id="selected-sat" data={selectedPoint}>
            <Layer
              id="selected-sat-halo"
              type="circle"
              paint={{
                'circle-radius': 15,
                'circle-color': 'rgba(255,209,102,0.28)',
                'circle-stroke-color': colors.sat,
                'circle-stroke-width': 2,
              }}
            />
            <Layer id="selected-sat-core" type="circle" paint={{ 'circle-radius': 5, 'circle-color': colors.sat }} />
          </GeoJSONSource>
        ) : null}
      </Map>

      <SafeAreaView edges={['top']} style={s.top} pointerEvents="box-none">
        {selected ? (
          <Text style={s.title}>
            {selected.elements.name} <Text style={s.titleSub}>· NORAD {selected.elements.noradId}</Text>
          </Text>
        ) : (
          <Text style={s.title}>{selecting ? 'Cargando satélite…' : 'Sin satélite seleccionado'}</Text>
        )}
        {freshness ? <DataAgeBanner freshness={freshness} meta={selected?.meta ?? null} /> : null}
        {selectionError ? <Banner tone="danger" text={selectionError} /> : null}
        {engineError ? <Banner tone="danger" text={engineError} /> : null}
        {constellationStatus ? <Banner tone="info" text={constellationStatus} /> : null}
      </SafeAreaView>

      <View style={s.bottom} pointerEvents="box-none">
        <Card style={collapsed ? { ...s.panel, ...s.panelCollapsed } : s.panel}>
          <Pressable
            onPress={() => setCollapsed((c) => !c)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={collapsed ? 'Mostrar panel' : 'Minimizar panel'}
            style={s.handleRow}
          >
            <View style={s.handleBar} />
            {collapsed ? (
              <Text style={s.summary} numberOfLines={1}>
                {position
                  ? `${formatLat(position.latitude)} ${formatLon(position.longitude)} · ${Math.round(position.altitudeKm).toLocaleString('es-AR')} km`
                  : 'Sin posición'}
                {live?.look ? ` · El ${Math.round(live.look.elevation)}°` : ''}
              </Text>
            ) : null}
            <Text style={s.handleLabel}>{collapsed ? '▴' : '▾'}</Text>
          </Pressable>

          {collapsed ? null : (
          <>
          <View style={s.statsRow}>
            <Stat
              label="Posición"
              value={position ? `${formatLat(position.latitude)}` : '—'}
              sub={position ? formatLon(position.longitude) : undefined}
            />
            <Stat
              label="Altitud"
              value={position ? `${Math.round(position.altitudeKm).toLocaleString('es-AR')} km` : '—'}
              sub={live?.speedKmS ? `${live.speedKmS.toFixed(2)} km/s` : undefined}
            />
            <Stat
              label="Desde tu ubicación"
              value={live?.look ? `El ${Math.round(live.look.elevation)}°` : observer ? '—' : 'sin GPS'}
              sub={
                live?.look
                  ? `Az ${Math.round(live.look.azimuth)}° ${compassName(live.look.azimuth)}${visible ? ' · visible' : ''}`
                  : undefined
              }
            />
          </View>

          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips}>
            <Chip label="Ground track" active={settings.showGroundTrack} onPress={() => updateSettings({ showGroundTrack: !settings.showGroundTrack })} />
            <Chip label="Footprint" active={settings.showFootprint} onPress={() => updateSettings({ showFootprint: !settings.showFootprint })} />
            <Chip label="Sin constelación" active={!settings.constellationGroup} onPress={() => updateSettings({ constellationGroup: null })} />
            {CATALOG_GROUPS.map((g) => (
              <Chip
                key={g.id}
                label={g.id === 'starlink' ? 'Starlink' : g.label.split(' (')[0] ?? g.label}
                active={settings.constellationGroup === g.id}
                onPress={() => updateSettings({ constellationGroup: g.id })}
              />
            ))}
          </ScrollView>

          {settings.showFootprint ? (
            <View style={s.fpRow}>
              <Text style={s.fpLabel}>Elevación mín. del footprint: {settings.footprintMinElevationDeg}°</Text>
              <View style={s.fpButtons}>
                {[0, 5, 10, 20, 30].map((el) => (
                  <Chip key={el} label={`${el}°`} active={settings.footprintMinElevationDeg === el} onPress={() => updateSettings({ footprintMinElevationDeg: el })} />
                ))}
              </View>
            </View>
          ) : null}

          <View style={s.actions}>
            <View style={{ flex: 1 }}>
              <Button label="Centrar" variant="ghost" onPress={center} disabled={!position} />
            </View>
            <View style={{ flex: 1 }}>
              <Button label="Ver pases" onPress={() => router.push('/passes')} disabled={!engine} />
            </View>
          </View>
          </>
          )}
        </Card>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  top: { position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: spacing.md, gap: spacing.xs },
  title: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '800',
    backgroundColor: 'rgba(5,7,13,0.82)',
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  titleSub: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: spacing.md },
  panel: { backgroundColor: 'rgba(14,21,34,0.95)', gap: spacing.md, padding: spacing.md, paddingTop: spacing.sm },
  panelCollapsed: { paddingBottom: spacing.sm },
  handleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 28 },
  handleBar: { width: 32, height: 4, borderRadius: 2, backgroundColor: colors.border },
  summary: { flex: 1, color: colors.text, fontSize: 13, fontWeight: '600' },
  handleLabel: { marginLeft: 'auto', color: colors.textMuted, fontSize: 18, paddingHorizontal: spacing.xs },
  statsRow: { flexDirection: 'row', gap: spacing.md },
  chips: { gap: spacing.sm, paddingRight: spacing.md },
  fpRow: { gap: spacing.xs },
  fpLabel: { color: colors.textMuted, fontSize: 12 },
  fpButtons: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  actions: { flexDirection: 'row', gap: spacing.md },
});
