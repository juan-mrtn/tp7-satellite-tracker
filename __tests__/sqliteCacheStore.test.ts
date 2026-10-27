import { DatabaseSync } from 'node:sqlite';
import { SqliteCacheStore, type SqliteDb } from '../src/data/cache/SqliteCacheStore';
import type { ValidationRecord } from '../src/data/cache/CacheStore';
import { elementsFor } from './helpers';

/** Adaptador de node:sqlite a la API async de expo-sqlite, para probar el SQL real. */
class NodeSqliteDb implements SqliteDb {
  private db = new DatabaseSync(':memory:');
  async execAsync(sql: string) { this.db.exec(sql); }
  async runAsync(sql: string, ...p: (string | number | null)[]) { return this.db.prepare(sql).run(...p); }
  async getFirstAsync<T>(sql: string, ...p: (string | number | null)[]) { return (this.db.prepare(sql).get(...p) as T | undefined) ?? null; }
  async getAllAsync<T>(sql: string, ...p: (string | number | null)[]) { return this.db.prepare(sql).all(...p) as T[]; }
  async withTransactionAsync(task: () => Promise<void>) {
    this.db.exec('BEGIN');
    try { await task(); this.db.exec('COMMIT'); } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
}

const record = (over: Partial<ValidationRecord> = {}): ValidationRecord => ({
  createdAt: 1, noradId: 25544, satelliteName: 'ISS', reference: 'n2yo', referenceTimestampMs: 2,
  errorKm: 3.2, horizontalKm: 3, altitudeDiffKm: 1.1, localLat: 1, localLon: 2, localAltKm: 420,
  apiLat: 1.1, apiLon: 2.1, apiAltKm: 419, elementsEpoch: '2026-10-24T00:00:00Z', elementsAgeDays: 0.5,
  elementsSource: 'celestrak', ...over,
});

describe('SqliteCacheStore (SQL real sobre node:sqlite)', () => {
  let store: SqliteCacheStore;
  beforeEach(async () => {
    store = new SqliteCacheStore(async () => new NodeSqliteDb());
    await store.init();
  });

  it('guarda y recupera un grupo conservando el orden y el momento de descarga', async () => {
    const elements = [elementsFor(3, 'C'), elementsFor(1, 'A'), elementsFor(2, 'B')];
    await store.putGroup('group:test', { provider: 'celestrak', fetchedAt: 123, elements });
    const got = await store.getGroup('group:test');
    expect(got?.fetchedAt).toBe(123);
    expect(got?.provider).toBe('celestrak');
    expect(got?.elements.map((e) => e.noradId)).toEqual([3, 1, 2]);
    expect(got?.elements[0]?.tle).toEqual(elements[0]?.tle);
    expect(await store.getGroup('inexistente')).toBeNull();
  });

  it('reemplazar un grupo elimina miembros viejos y actualiza los elementos', async () => {
    await store.putGroup('g', { provider: 'celestrak', fetchedAt: 1, elements: [elementsFor(1, 'A'), elementsFor(2, 'B')] });
    await store.putGroup('g', { provider: 'spacetrack', fetchedAt: 2, elements: [elementsFor(2, 'B2')] });
    const got = await store.getGroup('g');
    expect(got?.elements.map((e) => [e.noradId, e.name])).toEqual([[2, 'B2']]);
    expect(got?.provider).toBe('spacetrack');
    expect((await store.getElements(2))?.fetchedAt).toBe(2);
  });

  it('getElements / putElements por NORAD ID (incluye 6 dígitos)', async () => {
    await store.putElements([elementsFor(100123, 'NUEVO')], 'celestrak', 99);
    const got = await store.getElements(100123);
    expect(got).toMatchObject({ fetchedAt: 99, provider: 'celestrak' });
    expect(got?.elements.name).toBe('NUEVO');
    expect(await store.getElements(5)).toBeNull();
  });

  it('búsqueda por nombre: sin distinguir mayúsculas y escapando comodines', async () => {
    await store.putElements([elementsFor(1, 'STARLINK-1007'), elementsFor(2, 'STARLINK-1008'), elementsFor(3, 'ISS (ZARYA)'), elementsFor(4, '100%_RARO')], 'celestrak', 1);
    expect((await store.searchByName('starlink', 10)).map((e) => e.noradId)).toEqual([1, 2]);
    expect((await store.searchByName('zarya', 10)).map((e) => e.noradId)).toEqual([3]);
    expect((await store.searchByName('%', 10)).map((e) => e.noradId)).toEqual([4]);
    expect(await store.searchByName('starlink', 1)).toHaveLength(1);
  });

  it('clear vacía la caché pero no las mediciones de validación', async () => {
    await store.putGroup('g', { provider: 'celestrak', fetchedAt: 1, elements: [elementsFor(1)] });
    await store.addValidationRecord(record());
    await store.clear();
    expect(await store.getGroup('g')).toBeNull();
    expect(await store.getElements(1)).toBeNull();
    expect(await store.listValidationRecords(10)).toHaveLength(1);
  });

  it('mediciones de validación: se listan de la más nueva a la más vieja y se pueden borrar', async () => {
    await store.addValidationRecord(record({ errorKm: 1 }));
    await store.addValidationRecord(record({ errorKm: 2, reference: 'wheretheiss' }));
    const list = await store.listValidationRecords(10);
    expect(list.map((r) => r.errorKm)).toEqual([2, 1]);
    expect(list[0]).toMatchObject({ reference: 'wheretheiss', elementsSource: 'celestrak', noradId: 25544 });
    await store.clearValidationRecords();
    expect(await store.listValidationRecords(10)).toEqual([]);
  });

  it('init es idempotente y exige init antes de usar', async () => {
    await store.init();
    const fresh = new SqliteCacheStore(async () => new NodeSqliteDb());
    await expect(fresh.getGroup('x')).rejects.toThrow(/init/);
  });
});

describe('SqliteCacheStore: volumen (tamaño de Starlink)', () => {
  it('guarda y recupera 1 500 satélites en orden, con duplicados entre grupos', async () => {
    const store = new SqliteCacheStore(async () => new NodeSqliteDb());
    await store.init();
    const many = Array.from({ length: 1500 }, (_, i) => elementsFor(44000 + i, `STARLINK-${1000 + i}`));
    await store.putGroup('group:starlink', { provider: 'celestrak', fetchedAt: 7, elements: many });
    // Un segundo grupo que comparte satélites no debe duplicar ni romper nada.
    await store.putGroup('group:otro', { provider: 'spacetrack', fetchedAt: 9, elements: many.slice(0, 120) });
    const got = await store.getGroup('group:starlink');
    expect(got?.elements).toHaveLength(1500);
    expect(got?.elements[0]?.noradId).toBe(44000);
    expect(got?.elements[1499]?.noradId).toBe(45499);
    expect(got?.fetchedAt).toBe(7);
    expect((await store.getGroup('group:otro'))?.elements).toHaveLength(120);
    expect((await store.searchByName('STARLINK-2499', 5)).map((e) => e.noradId)).toEqual([45499]);
    expect((await store.getElements(44000))?.fetchedAt).toBe(9); // el último grupo lo refrescó
  });
});
