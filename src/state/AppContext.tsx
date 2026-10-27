import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { OrbitalEngine } from '../core/orbital/OrbitalEngine';
import type { Observer, OrbitalElements } from '../core/orbital/types';
import { DEFAULT_SETTINGS, sanitizeSettings, type AppSettings } from '../core/settings';
import { assessFreshness, type Freshness } from '../data/freshness';
import type { DataMeta } from '../data/types';
import { registerBackgroundRefresh } from '../services/BackgroundRefresh';
import { getContainer, type Container } from '../services/container';
import { getObserver, requestLocationPermission, type LocationStatus } from '../services/LocationService';
import { initNotifications } from '../services/NotificationService';
import { loadSettings, saveSettings } from '../services/SettingsStore';
import { useNow } from './hooks';

export interface SelectedSatellite {
  elements: OrbitalElements;
  meta: DataMeta | null;
}

interface AppState {
  ready: boolean;
  initError: string | null;
  container: Container | null;
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
  observer: Observer | null;
  locationStatus: LocationStatus;
  refreshLocation: () => Promise<void>;
  selected: SelectedSatellite | null;
  selectionError: string | null;
  selecting: boolean;
  engine: OrbitalEngine | null;
  engineError: string | null;
  freshness: Freshness | null;
  selectSatellite: (elements: OrbitalElements, meta?: DataMeta | null) => void;
  loadSatellite: (noradId: number, forceRefresh?: boolean) => Promise<void>;
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp debe usarse dentro de <AppProvider>');
  return v;
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [container, setContainer] = useState<Container | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [observer, setObserver] = useState<Observer | null>(null);
  const [locationStatus, setLocationStatus] = useState<LocationStatus>('unknown');
  const [selected, setSelected] = useState<SelectedSatellite | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const containerRef = useRef<Container | null>(null);

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    const next = sanitizeSettings({ ...settingsRef.current, ...patch });
    settingsRef.current = next;
    setSettings(next);
    void saveSettings(next);
    if (patch.ttlHours !== undefined) containerRef.current?.orchestrator.setTtlHours(next.ttlHours);
  }, []);

  const refreshLocation = useCallback(async () => {
    const status = await requestLocationPermission();
    setLocationStatus(status);
    if (status !== 'granted') return;
    const obs = await getObserver();
    if (obs) {
      setObserver(obs);
      updateSettings({ lastObserver: obs });
    }
  }, [updateSettings]);

  const selectSatellite = useCallback(
    (elements: OrbitalElements, meta: DataMeta | null = null) => {
      setSelected({ elements, meta });
      setSelectionError(null);
      updateSettings({ selectedNoradId: elements.noradId });
    },
    [updateSettings]
  );

  const loadSatellite = useCallback(
    async (noradId: number, forceRefresh = false) => {
      const c = containerRef.current;
      if (!c) return;
      setSelecting(true);
      try {
        const res = await c.orchestrator.getSatellite(noradId, { forceRefresh });
        selectSatellite(res.data, res.meta);
      } catch (e) {
        setSelectionError(e instanceof Error ? e.message : String(e));
      } finally {
        setSelecting(false);
      }
    },
    [selectSatellite]
  );

  // Arranque: base de datos, preferencias, notificaciones, tarea en segundo plano, ubicación, satélite.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [c, stored] = await Promise.all([getContainer(), loadSettings()]);
        if (cancelled) return;
        containerRef.current = c;
        settingsRef.current = stored;
        setContainer(c);
        setSettings(stored);
        if (stored.lastObserver) setObserver(stored.lastObserver);
        setReady(true);

        initNotifications().catch(() => undefined);
        registerBackgroundRefresh().catch(() => undefined);
        void refreshLocation();
        await loadSatellite(stored.selectedNoradId);
      } catch (e) {
        if (!cancelled) setInitError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { engine, engineError } = useMemo(() => {
    if (!selected) return { engine: null, engineError: null };
    try {
      return { engine: new OrbitalEngine(selected.elements), engineError: null };
    } catch (e) {
      return { engine: null, engineError: e instanceof Error ? e.message : String(e) };
    }
  }, [selected]);

  const now = useNow(60_000, !!selected);
  const freshness = useMemo(
    () =>
      selected
        ? assessFreshness(
            selected.elements.epoch,
            selected.meta?.fetchedAt ?? now,
            now,
            settings.ttlHours * 3_600_000
          )
        : null,
    [selected, now, settings.ttlHours]
  );

  const value: AppState = {
    ready,
    initError,
    container,
    settings,
    updateSettings,
    observer,
    locationStatus,
    refreshLocation,
    selected,
    selectionError,
    selecting,
    engine,
    engineError,
    freshness,
    selectSatellite,
    loadSatellite,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
