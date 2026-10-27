import type { OrbitalElements } from '../../core/orbital/types';
import type { ProviderId } from '../types';
import type { CacheStore, CachedSet, ValidationRecord } from './CacheStore';

/** Subconjunto de la API async de expo-sqlite que usa el store (permite probarlo con otro motor). */
export interface SqliteDb {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: (string | number | null)[]): Promise<unknown>;
  getFirstAsync<T>(sql: string, ...params: (string | number | null)[]): Promise<T | null>;
  getAllAsync<T>(sql: string, ...params: (string | number | null)[]): Promise<T[]>;
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
}

const SCHEMA_VERSION = 1;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS elements (
    norad_id   INTEGER PRIMARY KEY NOT NULL,
    name       TEXT    NOT NULL,
    epoch_ms   INTEGER NOT NULL,
    provider   TEXT    NOT NULL,
    fetched_at INTEGER NOT NULL,
    data       TEXT    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_elements_name ON elements(name COLLATE NOCASE);
  CREATE TABLE IF NOT EXISTS group_meta (
    group_key  TEXT PRIMARY KEY NOT NULL,
    provider   TEXT    NOT NULL,
    fetched_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS group_members (
    group_key TEXT    NOT NULL,
    norad_id  INTEGER NOT NULL,
    position  INTEGER NOT NULL,
    PRIMARY KEY (group_key, norad_id)
  );
  CREATE TABLE IF NOT EXISTS validation_runs (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at             INTEGER NOT NULL,
    norad_id               INTEGER NOT NULL,
    satellite_name         TEXT    NOT NULL,
    reference              TEXT    NOT NULL,
    reference_timestamp_ms INTEGER NOT NULL,
    error_km               REAL    NOT NULL,
    horizontal_km          REAL    NOT NULL,
    altitude_diff_km       REAL    NOT NULL,
    local_lat REAL NOT NULL, local_lon REAL NOT NULL, local_alt_km REAL NOT NULL,
    api_lat   REAL NOT NULL, api_lon   REAL NOT NULL, api_alt_km   REAL NOT NULL,
    elements_epoch         TEXT    NOT NULL,
    elements_age_days      REAL    NOT NULL,
    elements_source        TEXT    NOT NULL
  );
`;

interface ElementsRow {
  data: string;
  fetched_at: number;
  provider: string;
}

/** Abre la base con expo-sqlite. El import es perezoso para no cargar el módulo nativo en tests. */
export async function openExpoDb(name = 'satellite-tracker.db'): Promise<SqliteDb> {
  const SQLite = await import('expo-sqlite');
  return (await SQLite.openDatabaseAsync(name)) as unknown as SqliteDb;
}

/**
 * Caché persistente en SQLite. Tablas normalizadas: un registro por satélite (`elements`),
 * la pertenencia a grupos con su orden (`group_members`) y los metadatos de descarga
 * (`group_meta`), más las mediciones de validación.
 */
export class SqliteCacheStore implements CacheStore {
  private db: SqliteDb | null = null;

  constructor(private readonly openDb: () => Promise<SqliteDb> = openExpoDb) {}

  async init(): Promise<void> {
    if (this.db) return;
    const db = await this.openDb();
    await db.execAsync(`PRAGMA journal_mode = WAL;`);
    await db.execAsync(SCHEMA);
    await db.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    this.db = db;
  }

  private get conn(): SqliteDb {
    if (!this.db) throw new Error('SqliteCacheStore: llamar a init() primero');
    return this.db;
  }

  /**
   * Upsert por lotes (INSERT multi-fila): un grupo de ~1 500 satélites se guarda en ~15 viajes
   * a SQLite en lugar de 1 500. SQLite admite hasta 999 variables por sentencia: 6 por fila.
   */
  private async upsertElements(
    elements: readonly OrbitalElements[],
    provider: string,
    fetchedAt: number
  ) {
    const CHUNK = 100;
    for (let i = 0; i < elements.length; i += CHUNK) {
      const slice = elements.slice(i, i + CHUNK);
      const params: (string | number)[] = [];
      for (const e of slice) {
        params.push(e.noradId, e.name, Date.parse(e.epoch), provider, fetchedAt, JSON.stringify(e));
      }
      await this.conn.runAsync(
        `INSERT INTO elements (norad_id, name, epoch_ms, provider, fetched_at, data)
         VALUES ${slice.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}
         ON CONFLICT(norad_id) DO UPDATE SET
           name = excluded.name, epoch_ms = excluded.epoch_ms, provider = excluded.provider,
           fetched_at = excluded.fetched_at, data = excluded.data`,
        ...params
      );
    }
  }

  async putElements(
    elements: readonly OrbitalElements[],
    provider: ProviderId | 'unknown',
    fetchedAt: number
  ) {
    await this.conn.withTransactionAsync(() => this.upsertElements(elements, provider, fetchedAt));
  }

  async getElements(noradId: number) {
    const row = await this.conn.getFirstAsync<ElementsRow>(
      'SELECT data, fetched_at, provider FROM elements WHERE norad_id = ?',
      noradId
    );
    if (!row) return null;
    return {
      elements: JSON.parse(row.data) as OrbitalElements,
      fetchedAt: row.fetched_at,
      provider: row.provider as ProviderId | 'unknown',
    };
  }

  async putGroup(key: string, set: CachedSet) {
    await this.conn.withTransactionAsync(async () => {
      await this.upsertElements(set.elements, set.provider, set.fetchedAt);
      await this.conn.runAsync('DELETE FROM group_members WHERE group_key = ?', key);
      const CHUNK = 250; // 3 variables por fila
      for (let i = 0; i < set.elements.length; i += CHUNK) {
        const slice = set.elements.slice(i, i + CHUNK);
        const params: (string | number)[] = [];
        slice.forEach((e, k) => params.push(key, e.noradId, i + k));
        await this.conn.runAsync(
          `INSERT OR REPLACE INTO group_members (group_key, norad_id, position)
           VALUES ${slice.map(() => '(?, ?, ?)').join(', ')}`,
          ...params
        );
      }
      await this.conn.runAsync(
        'INSERT OR REPLACE INTO group_meta (group_key, provider, fetched_at) VALUES (?, ?, ?)',
        key,
        set.provider,
        set.fetchedAt
      );
    });
  }

  async getGroup(key: string): Promise<CachedSet | null> {
    const meta = await this.conn.getFirstAsync<{ provider: string; fetched_at: number }>(
      'SELECT provider, fetched_at FROM group_meta WHERE group_key = ?',
      key
    );
    if (!meta) return null;
    const rows = await this.conn.getAllAsync<{ data: string }>(
      `SELECT e.data AS data FROM group_members m
         JOIN elements e ON e.norad_id = m.norad_id
        WHERE m.group_key = ? ORDER BY m.position`,
      key
    );
    return {
      provider: meta.provider as ProviderId | 'unknown',
      fetchedAt: meta.fetched_at,
      elements: rows.map((r) => JSON.parse(r.data) as OrbitalElements),
    };
  }

  async searchByName(query: string, limit: number): Promise<OrbitalElements[]> {
    const escaped = query.trim().replace(/[\\%_]/g, (c) => `\\${c}`);
    const rows = await this.conn.getAllAsync<{ data: string }>(
      `SELECT data FROM elements WHERE name LIKE ? ESCAPE '\\' COLLATE NOCASE ORDER BY name LIMIT ?`,
      `%${escaped}%`,
      limit
    );
    return rows.map((r) => JSON.parse(r.data) as OrbitalElements);
  }

  async clear() {
    await this.conn.execAsync('DELETE FROM group_members; DELETE FROM group_meta; DELETE FROM elements;');
  }

  async addValidationRecord(r: ValidationRecord) {
    await this.conn.runAsync(
      `INSERT INTO validation_runs (created_at, norad_id, satellite_name, reference,
         reference_timestamp_ms, error_km, horizontal_km, altitude_diff_km,
         local_lat, local_lon, local_alt_km, api_lat, api_lon, api_alt_km,
         elements_epoch, elements_age_days, elements_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.createdAt, r.noradId, r.satelliteName, r.reference, r.referenceTimestampMs,
      r.errorKm, r.horizontalKm, r.altitudeDiffKm,
      r.localLat, r.localLon, r.localAltKm, r.apiLat, r.apiLon, r.apiAltKm,
      r.elementsEpoch, r.elementsAgeDays, r.elementsSource
    );
  }

  async listValidationRecords(limit: number): Promise<ValidationRecord[]> {
    const rows = await this.conn.getAllAsync<Record<string, number | string>>(
      'SELECT * FROM validation_runs ORDER BY id DESC LIMIT ?',
      limit
    );
    return rows.map((r) => ({
      id: r.id as number,
      createdAt: r.created_at as number,
      noradId: r.norad_id as number,
      satelliteName: r.satellite_name as string,
      reference: r.reference as ProviderId,
      referenceTimestampMs: r.reference_timestamp_ms as number,
      errorKm: r.error_km as number,
      horizontalKm: r.horizontal_km as number,
      altitudeDiffKm: r.altitude_diff_km as number,
      localLat: r.local_lat as number,
      localLon: r.local_lon as number,
      localAltKm: r.local_alt_km as number,
      apiLat: r.api_lat as number,
      apiLon: r.api_lon as number,
      apiAltKm: r.api_alt_km as number,
      elementsEpoch: r.elements_epoch as string,
      elementsAgeDays: r.elements_age_days as number,
      elementsSource: r.elements_source as string,
    }));
  }

  async clearValidationRecords() {
    await this.conn.runAsync('DELETE FROM validation_runs');
  }
}
