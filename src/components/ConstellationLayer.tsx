import React, { useEffect, useMemo, useRef, useState } from 'react';
import { GeoJSONSource, Layer } from '@maplibre/maplibre-react-native';
import { ConstellationPropagator, type ConstellationSnapshot } from '../core/orbital/constellation';
import type { OrbitalElements } from '../core/orbital/types';
import { selectVisible, type MapRegion, type VisibleSatellite } from '../core/orbital/viewport';
import { useApp } from '../state/AppContext';
import type { CatalogGroup, DataMeta } from '../data/types';
import { colors } from '../ui/theme';

const REFRESH_MS = 3_000;

export interface ConstellationLayerProps {
  group: CatalogGroup;
  limit: number;
  region: MapRegion | null;
  /** No dibujar este satélite (ya está resaltado como seleccionado). */
  excludeNoradId?: number;
  onSelect: (elements: OrbitalElements, meta: DataMeta | null) => void;
  onStatus: (text: string | null) => void;
}

/**
 * Capa de constelación (RF-13) sin degradar la UI:
 *  - La propagación de todo el grupo se hace en lote y por tandas (ConstellationPropagator).
 *  - Se dibuja solo lo visible en el mapa y hasta `limit` puntos.
 *  - Todos los satélites van en una única fuente GeoJSON con una capa `circle`: MapLibre los
 *    dibuja en GPU, sin una vista nativa por satélite.
 *  - Refresco cada 3 s, sin solaparse si una tanda tarda más.
 */
export function ConstellationLayer({ group, limit, region, excludeNoradId, onSelect, onStatus }: ConstellationLayerProps) {
  const { container } = useApp();
  const propagator = useRef(new ConstellationPropagator()).current;
  const elementsById = useRef(new Map<number, OrbitalElements>());
  const metaRef = useRef<DataMeta | null>(null);
  const snapshotRef = useRef<ConstellationSnapshot | null>(null);
  const regionRef = useRef(region);
  const limitRef = useRef(limit);
  const [visible, setVisible] = useState<VisibleSatellite[]>([]);
  regionRef.current = region;
  limitRef.current = limit;

  const recompute = () => {
    const snap = snapshotRef.current;
    if (snap) setVisible(selectVisible(snap, regionRef.current, limitRef.current));
  };

  // Al cambiar el grupo: descargar/leer de caché, cargar los satrec y empezar a refrescar.
  useEffect(() => {
    if (!container) return;
    const ac = new AbortController();
    let timer: ReturnType<typeof setInterval> | null = null;
    let busy = false;
    snapshotRef.current = null;
    setVisible([]);

    (async () => {
      try {
        onStatus('Cargando constelación…');
        const res = await container.orchestrator.getGroup(group);
        if (ac.signal.aborted) return;
        elementsById.current = new Map(res.data.map((e) => [e.noradId, e]));
        metaRef.current = res.meta;
        const { loaded } = await propagator.load(res.data, { signal: ac.signal });
        onStatus(
          `${loaded} satélites propagados${res.meta.stale ? ' · datos en caché sin actualizar' : ''}`
        );

        const tick = async () => {
          if (busy || ac.signal.aborted) return;
          busy = true;
          try {
            snapshotRef.current = await propagator.snapshot(new Date(), { signal: ac.signal });
            recompute();
          } catch {
            /* cancelado */
          } finally {
            busy = false;
          }
        };
        await tick();
        timer = setInterval(tick, REFRESH_MS);
      } catch (e) {
        if (!ac.signal.aborted) onStatus(`No se pudo cargar la constelación: ${e instanceof Error ? e.message : e}`);
      }
    })();

    return () => {
      ac.abort();
      if (timer) clearInterval(timer);
      onStatus(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [container, group]);

  // Al mover el mapa o cambiar el límite solo se vuelve a filtrar (sin re-propagar).
  useEffect(recompute, [region, limit]); // eslint-disable-line react-hooks/exhaustive-deps

  const data = useMemo<GeoJSON.FeatureCollection<GeoJSON.Point>>(
    () => ({
      type: 'FeatureCollection',
      features: visible
        .filter((v) => v.noradId !== excludeNoradId)
        .map((v) => ({
          type: 'Feature',
          id: v.noradId,
          properties: { noradId: v.noradId },
          geometry: { type: 'Point', coordinates: [v.longitude, v.latitude] },
        })),
    }),
    [visible, excludeNoradId]
  );

  return (
    <GeoJSONSource
      id="constellation"
      data={data}
      hitbox={{ top: 12, right: 12, bottom: 12, left: 12 }}
      onPress={(e) => {
        e.stopPropagation();
        const noradId = e.nativeEvent.features[0]?.properties?.noradId;
        const el = typeof noradId === 'number' ? elementsById.current.get(noradId) : undefined;
        if (el) onSelect(el, metaRef.current);
      }}
    >
      <Layer
        id="constellation-dots"
        type="circle"
        paint={{
          'circle-radius': 3.5,
          'circle-color': colors.textMuted,
          'circle-stroke-color': colors.bg,
          'circle-stroke-width': 1,
        }}
      />
    </GeoJSONSource>
  );
}
