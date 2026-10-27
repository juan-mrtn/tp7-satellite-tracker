import Storage from 'expo-sqlite/kv-store';
import { DEFAULT_SETTINGS, sanitizeSettings, type AppSettings } from '../core/settings';

const KEY = 'settings.v1';

/** Preferencias persistentes (kv-store de expo-sqlite). Lo guardado siempre se valida al leer. */
export async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = await Storage.getItem(KEY);
    return raw ? sanitizeSettings(JSON.parse(raw)) : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  try {
    await Storage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Sin persistencia la app sigue funcionando con los valores en memoria.
  }
}
