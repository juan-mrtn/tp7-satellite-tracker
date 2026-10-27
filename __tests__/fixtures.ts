import type { OrbitalElements } from '../src/core/orbital/types';

/** Caso de prueba 00005 de Vallado (Spacetrack Report #3 / revisited). */
export const VALLADO_00005: OrbitalElements = {
  noradId: 5,
  name: 'VANGUARD 1',
  epoch: '2000-06-27T18:50:19.733568Z',
  tle: [
    '1 00005U 58002B   00179.78495062  .00000023  00000-0  28098-4 0  4753',
    '2 00005  34.2682 348.7242 1859667 331.7664  19.3264 10.82419157413667',
  ],
};

/** El mismo objeto en formato OMM/JSON (como lo entrega CelesTrak). */
export const VALLADO_00005_OMM = {
  OBJECT_NAME: 'VANGUARD 1',
  OBJECT_ID: '1958-002B',
  EPOCH: '2000-06-27T18:50:19.733568',
  MEAN_MOTION: 10.82419157,
  ECCENTRICITY: 0.1859667,
  INCLINATION: 34.2682,
  RA_OF_ASC_NODE: 348.7242,
  ARG_OF_PERICENTER: 331.7664,
  MEAN_ANOMALY: 19.3264,
  EPHEMERIS_TYPE: 0 as const,
  CLASSIFICATION_TYPE: 'U' as const,
  NORAD_CAT_ID: 5,
  ELEMENT_SET_NO: 475,
  REV_AT_EPOCH: 41366,
  BSTAR: 0.000028098,
  MEAN_MOTION_DOT: 0.00000023,
  MEAN_MOTION_DDOT: 0,
};

/** ISS (ejemplo del README de satellite.js, época 2019-06-05). */
export const ISS_TLE: OrbitalElements = {
  noradId: 25544,
  name: 'ISS (ZARYA)',
  epoch: '2019-06-05T12:12:58.000Z',
  tle: [
    '1 25544U 98067A   19156.50900463  .00003075  00000-0  59442-4 0  9992',
    '2 25544  51.6433  59.2583 0008217  16.4489 347.6017 15.51174618173442',
  ],
};

export const ISS_EPOCH = new Date('2019-06-05T12:12:58.000Z');

/** Oro Verde, Entre Ríos (aprox.). */
export const OBSERVER = { latitude: -31.82, longitude: -60.52, altitudeKm: 0.07 };
