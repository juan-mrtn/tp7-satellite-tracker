import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { getContainer } from './container';
import { replaceRemindersFor } from './NotificationService';
import { loadSettings } from './SettingsStore';
import { refreshTrackedSatellites } from './trackedRefresh';

export const REFRESH_TASK = 'satellite-tracker-refresh';

/**
 * Tarea en segundo plano: refresca efemérides vencidas y reagenda los avisos de pase.
 * `defineTask` debe ejecutarse al cargar el módulo (en el arranque de la app), no dentro de un
 * componente: el sistema puede despertar la app solo para correr la tarea.
 */
TaskManager.defineTask(REFRESH_TASK, async () => {
  try {
    const { orchestrator } = await getContainer();
    const settings = await loadSettings();
    orchestrator.setTtlHours(settings.ttlHours);
    const report = await refreshTrackedSatellites({
      settings,
      getSatellite: (id) => orchestrator.getSatellite(id),
      replaceReminders: replaceRemindersFor,
      now: Date.now,
    });
    return report.failures.length && !report.refreshed
      ? BackgroundTask.BackgroundTaskResult.Failed
      : BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

/** Intervalo mínimo (min). El sistema decide cuándo corre realmente; iOS suele diferirla horas. */
const MIN_INTERVAL_MIN = 180;

export async function registerBackgroundRefresh(): Promise<'registered' | 'restricted'> {
  const status = await BackgroundTask.getStatusAsync();
  if (status !== BackgroundTask.BackgroundTaskStatus.Available) return 'restricted';
  if (!(await TaskManager.isTaskRegisteredAsync(REFRESH_TASK))) {
    await BackgroundTask.registerTaskAsync(REFRESH_TASK, { minimumInterval: MIN_INTERVAL_MIN });
  }
  return 'registered';
}
