import * as SecureStore from 'expo-secure-store';
import type { CredentialsSource } from '../data/types';

const K = {
  stIdentity: 'spacetrack.identity',
  stPassword: 'spacetrack.password',
  n2yo: 'n2yo.apikey',
} as const;

/** AFTER_FIRST_UNLOCK: la tarea en segundo plano debe poder leer las claves con el equipo bloqueado. */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

const get = (key: string) => SecureStore.getItemAsync(key, OPTIONS).catch(() => null);

/**
 * Credenciales de Space-Track y N2YO en el almacenamiento seguro del sistema (Keychain /
 * Keystore). Nunca viajan en el código fuente ni en el bundle: las carga el usuario en Ajustes.
 */
export const secureKeys: CredentialsSource & {
  setSpaceTrack(identity: string, password: string): Promise<void>;
  setN2yoKey(key: string): Promise<void>;
  clearAll(): Promise<void>;
  status(): Promise<{ spaceTrack: boolean; n2yo: boolean }>;
} = {
  async getSpaceTrack() {
    const [identity, password] = await Promise.all([get(K.stIdentity), get(K.stPassword)]);
    return identity && password ? { identity, password } : null;
  },
  async getN2yoKey() {
    return (await get(K.n2yo)) || null;
  },
  async setSpaceTrack(identity, password) {
    await SecureStore.setItemAsync(K.stIdentity, identity.trim(), OPTIONS);
    await SecureStore.setItemAsync(K.stPassword, password, OPTIONS);
  },
  async setN2yoKey(key) {
    await SecureStore.setItemAsync(K.n2yo, key.trim(), OPTIONS);
  },
  async clearAll() {
    await Promise.all(
      Object.values(K).map((k) => SecureStore.deleteItemAsync(k, OPTIONS).catch(() => undefined))
    );
  },
  async status() {
    const [st, n2yo] = await Promise.all([this.getSpaceTrack(), this.getN2yoKey()]);
    return { spaceTrack: !!st, n2yo: !!n2yo };
  },
};
