import { DataOrchestrator, createDataProviders, HOUR_MS, TTL_MAX_MS, TTL_MIN_MS } from '../src/data/DataProvider';
import { MemoryCacheStore } from '../src/data/cache/MemoryCacheStore';
import { AllProvidersFailedError } from '../src/data/errors';
import { parseOmmArray } from '../src/data/omm';
import { celestrakUrl } from '../src/data/providers/CelesTrakProvider';
import { spaceTrackUrl } from '../src/data/providers/SpaceTrackProvider';
import { assessFreshness } from '../src/data/freshness';
import { OBSERVER } from './fixtures';
import { FakeClock, credentials, jsonResponse, rawOmm } from './helpers';

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function setup(opts: { handlers?: Record<string, Handler>; creds?: ReturnType<typeof credentials>; ttlHours?: number } = {}) {
  const clock = new FakeClock();
  const calls: string[] = [];
  const routes = opts.handlers ?? {};
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    for (const [fragment, handler] of Object.entries(routes)) {
      if (url.includes(fragment)) return handler(url, init);
    }
    return jsonResponse('not routed', 404);
  }) as unknown as typeof fetch;

  const cache = new MemoryCacheStore();
  const providers = createDataProviders(opts.creds ?? credentials(), { fetchImpl, clock });
  const orch = new DataOrchestrator({ providers, cache, clock, ttlMs: (opts.ttlHours ?? 12) * HOUR_MS });
  return { clock, calls, cache, orch, routes, fetchImpl };
}

const group = (ids: number[]) => ids.map((id) => rawOmm(id, `SAT ${id}`));
const callsTo = (calls: string[], fragment: string) => calls.filter((c) => c.includes(fragment)).length;

describe('Orquestador: caché con TTL', () => {
  it('primera consulta va a CelesTrak y guarda; la segunda sale de caché sin red', async () => {
    const { orch, calls } = setup({ handlers: { 'GROUP=stations': () => jsonResponse(group([25544, 48274])) } });
    const first = await orch.getGroup('stations');
    expect(first.data).toHaveLength(2);
    expect(first.meta).toMatchObject({ provider: 'celestrak', fromCache: false, stale: false });
    const second = await orch.getGroup('stations');
    expect(second.meta.fromCache).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('al vencer el TTL (12 h) vuelve a consultar', async () => {
    const { orch, calls, clock } = setup({ handlers: { 'GROUP=stations': () => jsonResponse(group([25544])) } });
    await orch.getGroup('stations');
    clock.advance(11 * HOUR_MS);
    await orch.getGroup('stations');
    expect(calls).toHaveLength(1);
    clock.advance(2 * HOUR_MS);
    const res = await orch.getGroup('stations');
    expect(res.meta.fromCache).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it('el TTL se limita al rango 12–24 h', () => {
    const { orch } = setup();
    orch.setTtlHours(1);
    expect(orch.ttl).toBe(TTL_MIN_MS);
    orch.setTtlHours(100);
    expect(orch.ttl).toBe(TTL_MAX_MS);
    orch.setTtlHours(18);
    expect(orch.ttl).toBe(18 * HOUR_MS);
  });

  it('forceRefresh antes de 2 h respeta el intervalo mínimo y no consulta la red', async () => {
    const { orch, calls, clock } = setup({ handlers: { 'GROUP=stations': () => jsonResponse(group([25544])) } });
    await orch.getGroup('stations');
    clock.advance(30 * 60_000);
    const res = await orch.getGroup('stations', { forceRefresh: true });
    expect(res.meta.refreshSkipped).toBe(true);
    expect(calls).toHaveLength(1);
    clock.advance(2 * HOUR_MS);
    const again = await orch.getGroup('stations', { forceRefresh: true });
    expect(again.meta.fromCache).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it('Starlink usa el set suplementario (sup-gp.php?FILE=starlink)', async () => {
    const { orch, calls } = setup({ handlers: { 'sup-gp.php?FILE=starlink': () => jsonResponse(group([44713, 44714])) } });
    const res = await orch.getGroup('starlink');
    expect(res.data).toHaveLength(2);
    expect(calls[0]).toBe('https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?FILE=starlink&FORMAT=json');
  });
});

describe('Orquestador: fallback CelesTrak → Space-Track', () => {
  const spaceTrack = (ids: number[]): Record<string, Handler> => ({
    '/ajaxauth/login': () => jsonResponse('""'),
    '/basicspacedata/query': () => jsonResponse(group(ids)),
  });

  it('si CelesTrak responde 503 usa Space-Track (login + consulta) y lo registra en attempts', async () => {
    const { orch, calls } = setup({
      handlers: { 'celestrak.org': () => jsonResponse('down', 503), ...spaceTrack([25544]) },
    });
    const res = await orch.getGroup('stations');
    expect(res.meta.provider).toBe('spacetrack');
    expect(res.meta.attempts.map((a) => [a.provider, a.ok])).toEqual([['CelesTrak', false], ['Space-Track', true]]);
    expect(callsTo(calls, '/ajaxauth/login')).toBe(1);
    expect(callsTo(calls, '/basicspacedata/query')).toBe(1);
  });

  it('CelesTrak queda en pausa tras un error HTTP: no se lo vuelve a consultar (política de uso)', async () => {
    const { orch, calls } = setup({
      handlers: { 'celestrak.org': () => jsonResponse('forbidden', 403), ...spaceTrack([1]) },
    });
    await orch.getGroup('stations');
    await orch.getGroup('gps');
    await orch.getGroup('weather');
    expect(callsTo(calls, 'celestrak.org')).toBe(1);
    expect(callsTo(calls, '/basicspacedata/query')).toBe(3);
    // La sesión de Space-Track se reutiliza: un solo login.
    expect(callsTo(calls, '/ajaxauth/login')).toBe(1);
  });

  it('un fallo de red en CelesTrak se reintenta con backoff antes de pasar al fallback', async () => {
    let n = 0;
    const { orch, calls } = setup({
      handlers: {
        'celestrak.org': () => { n++; throw new TypeError('Network request failed'); },
        ...spaceTrack([7]),
      },
    });
    const res = await orch.getGroup('stations');
    expect(n).toBe(2); // 1 intento + 1 reintento
    expect(res.meta.provider).toBe('spacetrack');
    expect(callsTo(calls, 'celestrak.org')).toBe(2);
  });

  it('"No GP data found" (200 de texto plano) cuenta como sin resultados y pasa al fallback', async () => {
    const { orch } = setup({
      handlers: { 'celestrak.org': () => jsonResponse('No GP data found'), ...spaceTrack([9]) },
    });
    const res = await orch.getGroup('stations');
    expect(res.meta.provider).toBe('spacetrack');
    expect(res.meta.attempts[0]).toMatchObject({ provider: 'CelesTrak', ok: false, error: 'sin resultados' });
  });

  it('sin credenciales de Space-Track, ese proveedor se omite y se informa', async () => {
    const { orch } = setup({
      creds: credentials({ st: false }),
      handlers: { 'celestrak.org': () => jsonResponse('down', 500) },
    });
    const err = await orch.getGroup('stations').catch((e) => e);
    expect(err).toBeInstanceOf(AllProvidersFailedError);
    expect((err as AllProvidersFailedError).attempts[1]).toMatchObject({ provider: 'Space-Track', skipped: true });
  });

  it('credenciales rechazadas por Space-Track ({"Login":"Failed"}) se reportan como error de autenticación', async () => {
    const { orch } = setup({
      handlers: {
        'celestrak.org': () => jsonResponse('down', 500),
        '/ajaxauth/login': () => jsonResponse({ Login: 'Failed' }),
      },
    });
    const err = (await orch.getGroup('stations').catch((e) => e)) as AllProvidersFailedError;
    expect(err.attempts[1]?.error).toMatch(/credenciales rechazadas/);
  });

  it('si todos fallan y hay caché vencida, la sirve marcada como stale', async () => {
    const handlers: Record<string, Handler> = { 'GROUP=stations': () => jsonResponse(group([25544])) };
    const { orch, clock, routes } = setup({ handlers });
    await orch.getGroup('stations');
    clock.advance(30 * HOUR_MS);
    routes['GROUP=stations'] = () => jsonResponse('down', 503);
    routes['celestrak.org'] = () => jsonResponse('down', 503);
    delete routes['GROUP=stations'];
    const res = await orch.getGroup('stations');
    expect(res.meta).toMatchObject({ fromCache: true, stale: true });
    expect(res.meta.ageMs).toBeGreaterThan(24 * HOUR_MS);
    expect(res.data).toHaveLength(1);
  });

  it('sin caché y con todo caído lanza AllProvidersFailedError', async () => {
    const { orch } = setup({ handlers: { 'celestrak.org': () => jsonResponse('x', 500) }, creds: credentials({ st: false }) });
    await expect(orch.getGroup('geo')).rejects.toBeInstanceOf(AllProvidersFailedError);
  });
});

describe('Orquestador: satélites y búsqueda', () => {
  it('getSatellite pide por CATNR y guarda en caché', async () => {
    const { orch, calls } = setup({ handlers: { 'CATNR=25544': () => jsonResponse([rawOmm(25544, 'ISS (ZARYA)')]) } });
    const a = await orch.getSatellite(25544);
    expect(a.data.name).toBe('ISS (ZARYA)');
    const b = await orch.getSatellite(25544);
    expect(b.meta.fromCache).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('acepta números de catálogo de 6 dígitos', async () => {
    const { orch } = setup({ handlers: { 'CATNR=100123': () => jsonResponse([rawOmm(100123, 'NUEVO')]) } });
    const res = await orch.search('100123');
    expect(res.data[0]?.noradId).toBe(100123);
  });

  it('buscar por nombre: primero caché local, sin red', async () => {
    const { orch, calls } = setup({ handlers: { 'GROUP=stations': () => jsonResponse([rawOmm(25544, 'ISS (ZARYA)'), rawOmm(48274, 'CSS (TIANHE)')]) } });
    await orch.getGroup('stations');
    const res = await orch.search('tian');
    expect(res.data.map((e) => e.noradId)).toEqual([48274]);
    expect(calls).toHaveLength(1);
  });

  it('buscar por nombre sin coincidencias locales consulta a los proveedores (NAME=)', async () => {
    const { orch, calls } = setup({ handlers: { 'NAME=NOAA': () => jsonResponse([rawOmm(33591, 'NOAA 19')]) } });
    const res = await orch.search('NOAA');
    expect(res.data[0]?.name).toBe('NOAA 19');
    expect(calls[0]).toContain('gp.php?NAME=NOAA');
  });

  it('búsquedas vacías o de menos de 3 letras no usan la red', async () => {
    const { orch, calls } = setup();
    expect((await orch.search('  ')).data).toEqual([]);
    expect((await orch.search('ab')).data).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('Validación: fuentes independientes', () => {
  const n2yo = () => jsonResponse({ info: { satid: 25544 }, positions: [{ satlatitude: 10, satlongitude: 20, sataltitude: 420, azimuth: 100, elevation: 5, timestamp: 1_700_000_100 }] });
  const wtia = () => jsonResponse({ latitude: 11, longitude: 21, altitude: 421, timestamp: 1_700_000_101 });

  it('para la ISS consulta N2YO y Where the ISS at?', async () => {
    const { orch, calls } = setup({ handlers: { 'api.n2yo.com': n2yo, 'wheretheiss.at': wtia } });
    const out = await orch.fetchValidationPositions(25544, OBSERVER);
    expect(out.map((o) => o.provider).sort()).toEqual(['n2yo', 'wheretheiss']);
    expect(out.find((o) => o.provider === 'n2yo')?.position).toMatchObject({ latitude: 10, timestampMs: 1_700_000_100_000, azimuth: 100 });
    const n2yoUrl = calls.find((c) => c.includes('n2yo'))!;
    expect(n2yoUrl).toContain('/positions/25544/-31.82000/-60.52000/70/1/&apiKey=KEY123');
  });

  it('para otro satélite Where the ISS at? se omite en silencio', async () => {
    const { orch, calls } = setup({ handlers: { 'api.n2yo.com': n2yo } });
    const out = await orch.fetchValidationPositions(44713, OBSERVER);
    expect(out.map((o) => o.provider)).toEqual(['n2yo']);
    expect(callsTo(calls, 'wheretheiss')).toBe(0);
  });

  it('sin API key de N2YO informa el error sin llamar a la red', async () => {
    const { orch, calls } = setup({ creds: credentials({ n2yo: false }), handlers: { 'wheretheiss.at': wtia } });
    const out = await orch.fetchValidationPositions(25544, OBSERVER);
    expect(out.find((o) => o.provider === 'n2yo')?.error).toMatch(/faltan credenciales/);
    expect(callsTo(calls, 'n2yo')).toBe(0);
  });

  it('una API key inválida de N2YO se reporta sin filtrar la clave en el mensaje', async () => {
    const { orch } = setup({ handlers: { 'api.n2yo.com': () => jsonResponse({ error: 'Invalid API Key!' }) } });
    const out = await orch.fetchValidationPositions(44713, OBSERVER);
    expect(out[0]?.error).toMatch(/credenciales rechazadas/);
    expect(JSON.stringify(out)).not.toContain('KEY123');
  });

  it('el límite de Where the ISS at? (~1 req/s) se respeta con el reloj', async () => {
    const { orch, clock } = setup({ handlers: { 'wheretheiss.at': wtia, 'api.n2yo.com': n2yo } });
    const t0 = clock.now();
    await orch.fetchValidationPositions(25544, OBSERVER);
    await orch.fetchValidationPositions(25544, OBSERVER);
    expect(clock.now() - t0).toBeGreaterThanOrEqual(1200);
  });
});

describe('Parseo OMM y URLs', () => {
  it('descarta registros inválidos y normaliza tipos', () => {
    const { elements, skipped } = parseOmmArray(
      [rawOmm(1), { OBJECT_NAME: 'roto' }, rawOmm(2, 'X', { INCLINATION: 'abc' }), rawOmm(100500)],
      'celestrak'
    );
    expect(skipped).toBe(2);
    expect(elements.map((e) => e.noradId)).toEqual([1, 100500]);
    expect(typeof elements[0]?.omm?.MEAN_MOTION).toBe('number');
    expect(elements[0]?.epoch.endsWith('Z')).toBe(true);
  });

  it('URLs de CelesTrak y Space-Track', () => {
    expect(celestrakUrl({ kind: 'group', group: 'gps' })).toContain('GROUP=gps-ops');
    expect(celestrakUrl({ kind: 'name', name: 'ISS (ZARYA)' })).toContain('NAME=ISS%20(ZARYA)');
    expect(spaceTrackUrl({ kind: 'catnr', noradId: 25544 }, 100)).toContain('NORAD_CAT_ID/25544/orderby/EPOCH%20desc/limit/1');
    expect(spaceTrackUrl({ kind: 'group', group: 'starlink' }, 300)).toContain('OBJECT_NAME/~~STARLINK');
    expect(spaceTrackUrl({ kind: 'group', group: 'starlink' }, 300)).toContain('limit/300');
  });

  it('respeta el tope de objetos por grupo', async () => {
    const clock = new FakeClock();
    const fetchImpl = (async () => jsonResponse(group(Array.from({ length: 50 }, (_, i) => i + 1)))) as unknown as typeof fetch;
    const providers = createDataProviders(credentials(), { fetchImpl, clock, maxObjectsPerGroup: 10 });
    const orch = new DataOrchestrator({ providers, cache: new MemoryCacheStore(), clock });
    expect((await orch.getGroup('starlink')).data).toHaveLength(10);
  });
});

describe('Antigüedad de los datos (RF-16)', () => {
  const now = Date.parse('2026-10-24T12:00:00Z');
  it('niveles según la época y el TTL', () => {
    expect(assessFreshness('2026-10-24T06:00:00Z', now - HOUR_MS, now, 12 * HOUR_MS).level).toBe('fresh');
    expect(assessFreshness('2026-10-20T12:00:00Z', now - HOUR_MS, now, 12 * HOUR_MS).level).toBe('aging');
    expect(assessFreshness('2026-10-10T12:00:00Z', now - HOUR_MS, now, 12 * HOUR_MS).level).toBe('stale');
    expect(assessFreshness('2026-10-24T06:00:00Z', now - 13 * HOUR_MS, now, 12 * HOUR_MS)).toMatchObject({ level: 'aging', ttlExpired: true });
  });
});
