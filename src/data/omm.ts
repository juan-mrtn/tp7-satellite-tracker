import type { OMMJsonObject } from 'satellite.js';
import type { OrbitalElements } from '../core/orbital/types';

const NUMERIC_FIELDS = [
  'MEAN_MOTION',
  'ECCENTRICITY',
  'INCLINATION',
  'RA_OF_ASC_NODE',
  'ARG_OF_PERICENTER',
  'MEAN_ANOMALY',
  'BSTAR',
  'MEAN_MOTION_DOT',
  'MEAN_MOTION_DDOT',
] as const;

type Raw = Record<string, unknown>;

const isFiniteNumber = (v: unknown): boolean => v !== '' && v !== null && Number.isFinite(Number(v));

/**
 * Convierte un registro OMM/JSON de CelesTrak o Space-Track en OrbitalElements.
 * Se conservan solo los campos que usa SGP4 (menos espacio en la caché) y los numéricos se
 * normalizan a `number`. Devuelve null si falta algo imprescindible.
 */
export function ommToElements(raw: Raw, source: string): OrbitalElements | null {
  if (!raw || typeof raw !== 'object') return null;
  for (const f of NUMERIC_FIELDS) {
    if (f === 'MEAN_MOTION_DDOT') continue; // algunos orígenes lo omiten
    if (!isFiniteNumber(raw[f])) return null;
  }
  if (!isFiniteNumber(raw.NORAD_CAT_ID) || typeof raw.EPOCH !== 'string') return null;

  const noradId = Number(raw.NORAD_CAT_ID);
  const omm: Raw = {
    OBJECT_NAME: String(raw.OBJECT_NAME ?? `NORAD ${noradId}`),
    OBJECT_ID: String(raw.OBJECT_ID ?? ''),
    EPOCH: raw.EPOCH,
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: typeof raw.CLASSIFICATION_TYPE === 'string' ? raw.CLASSIFICATION_TYPE : 'U',
    NORAD_CAT_ID: noradId,
    ELEMENT_SET_NO: isFiniteNumber(raw.ELEMENT_SET_NO) ? Number(raw.ELEMENT_SET_NO) : 999,
    REV_AT_EPOCH: isFiniteNumber(raw.REV_AT_EPOCH) ? Number(raw.REV_AT_EPOCH) : 0,
  };
  for (const f of NUMERIC_FIELDS) omm[f] = isFiniteNumber(raw[f]) ? Number(raw[f]) : 0;

  const epoch = raw.EPOCH.endsWith('Z') ? raw.EPOCH : `${raw.EPOCH}Z`;
  if (Number.isNaN(Date.parse(epoch))) return null;

  return {
    noradId,
    name: String(omm.OBJECT_NAME).trim(),
    epoch,
    omm: omm as unknown as OMMJsonObject,
    source,
  };
}

/** Convierte un arreglo JSON completo, descartando los registros inválidos. */
export function parseOmmArray(
  payload: unknown,
  source: string
): { elements: OrbitalElements[]; skipped: number } {
  if (!Array.isArray(payload)) return { elements: [], skipped: 0 };
  const elements: OrbitalElements[] = [];
  let skipped = 0;
  for (const item of payload) {
    const el = ommToElements(item as Raw, source);
    if (el) elements.push(el);
    else skipped++;
  }
  return { elements, skipped };
}
