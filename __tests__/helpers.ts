import type { Clock } from '../src/data/resilience';
import type { CredentialsSource } from '../src/data/types';
import { ISS_TLE } from './fixtures';
import type { OrbitalElements } from '../src/core/orbital/types';

/** Reloj falso: sleep adelanta el tiempo en lugar de esperar. */
export class FakeClock implements Clock {
  constructor(public t = 1_700_000_000_000) {}
  now() {
    return this.t;
  }
  async sleep(ms: number) {
    this.t += ms;
  }
  advance(ms: number) {
    this.t += ms;
  }
}

export const credentials = (over: Partial<{ st: boolean; n2yo: boolean }> = {}): CredentialsSource => ({
  getSpaceTrack: async () => (over.st === false ? null : { identity: 'user@mail', password: 'secret' }),
  getN2yoKey: async () => (over.n2yo === false ? null : 'KEY123'),
});

/** Registro OMM crudo tal como lo entregan CelesTrak / Space-Track. */
export const rawOmm = (id: number, name = `SAT ${id}`, extra: Record<string, unknown> = {}) => ({
  OBJECT_NAME: name,
  OBJECT_ID: '1998-067A',
  EPOCH: '2026-10-24T06:00:00.000000',
  MEAN_MOTION: '15.50',
  ECCENTRICITY: '0.0008',
  INCLINATION: '51.64',
  RA_OF_ASC_NODE: '59.2',
  ARG_OF_PERICENTER: '16.4',
  MEAN_ANOMALY: '347.6',
  EPHEMERIS_TYPE: 0,
  CLASSIFICATION_TYPE: 'U',
  NORAD_CAT_ID: String(id),
  ELEMENT_SET_NO: '999',
  REV_AT_EPOCH: '1000',
  BSTAR: '0.0001',
  MEAN_MOTION_DOT: '0.0001',
  MEAN_MOTION_DDOT: '0',
  ...extra,
});

export const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });

export const elementsFor = (id: number, name = `SAT ${id}`): OrbitalElements => ({
  ...ISS_TLE,
  noradId: id,
  name,
});
