import type { OrbitalElements } from '../../core/orbital/types';
import type { ProviderId } from '../types';
import type { CacheStore, CachedSet, ValidationRecord } from './CacheStore';

/** Implementación en memoria: para pruebas y como respaldo si SQLite no estuviera disponible. */
export class MemoryCacheStore implements CacheStore {
  private groups = new Map<string, CachedSet>();
  private elements = new Map<
    number,
    { elements: OrbitalElements; fetchedAt: number; provider: ProviderId | 'unknown' }
  >();
  private records: ValidationRecord[] = [];
  private nextId = 1;

  async init(): Promise<void> {}

  async getGroup(key: string) {
    return this.groups.get(key) ?? null;
  }

  async putGroup(key: string, set: CachedSet) {
    this.groups.set(key, set);
    await this.putElements(set.elements, set.provider, set.fetchedAt);
  }

  async getElements(noradId: number) {
    return this.elements.get(noradId) ?? null;
  }

  async putElements(
    elements: readonly OrbitalElements[],
    provider: ProviderId | 'unknown',
    fetchedAt: number
  ) {
    for (const e of elements) this.elements.set(e.noradId, { elements: e, fetchedAt, provider });
  }

  async searchByName(query: string, limit: number) {
    const q = query.trim().toLowerCase();
    const out: OrbitalElements[] = [];
    for (const { elements } of this.elements.values()) {
      if (elements.name.toLowerCase().includes(q)) out.push(elements);
      if (out.length >= limit) break;
    }
    return out;
  }

  async clear() {
    this.groups.clear();
    this.elements.clear();
  }

  async addValidationRecord(record: ValidationRecord) {
    this.records.unshift({ ...record, id: this.nextId++ });
  }

  async listValidationRecords(limit: number) {
    return this.records.slice(0, limit);
  }

  async clearValidationRecords() {
    this.records = [];
  }
}
