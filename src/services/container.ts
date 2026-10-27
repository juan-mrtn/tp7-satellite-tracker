import { SqliteCacheStore } from '../data/cache/SqliteCacheStore';
import { DataOrchestrator, createDataProviders } from '../data/DataProvider';
import { loadSettings } from './SettingsStore';
import { secureKeys } from './SecureKeys';

export interface Container {
  store: SqliteCacheStore;
  orchestrator: DataOrchestrator;
}

let pending: Promise<Container> | null = null;

/**
 * Contenedor único de dependencias: caché SQLite + orquestador con los cuatro proveedores.
 * Lo comparten la UI y la tarea en segundo plano (que corre en el mismo proceso JS pero puede
 * arrancar antes de que se monte ninguna pantalla), por eso se inicializa de forma perezosa.
 */
export function getContainer(): Promise<Container> {
  if (!pending) {
    pending = (async () => {
      const store = new SqliteCacheStore();
      const settings = await loadSettings();
      const orchestrator = new DataOrchestrator({
        providers: createDataProviders(secureKeys),
        cache: store,
        ttlMs: settings.ttlHours * 3_600_000,
      });
      await orchestrator.init();
      return { store, orchestrator };
    })().catch((e) => {
      pending = null; // permite reintentar si falló la apertura de la base
      throw e;
    });
  }
  return pending;
}
