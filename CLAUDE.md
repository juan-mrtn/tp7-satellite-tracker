# CLAUDE.md — Satellite Tracker (TP7 Desarrollo Mobile, FCyT · UADER)

Contexto del proyecto para no tener que releer todo el código en cada consulta. Ante la duda, el código manda;
si cambiás algo estructural, actualizá este archivo.

## Qué es

App móvil que rastrea satélites en tiempo real **calculando todo localmente con SGP4** (`satellite.js`):
posición lat/lon/alt, azimut/elevación desde el usuario, pases (AOS / elevación máx. / LOS), ground track,
footprint, avisos pre-pase, modo brújula y validación contra APIs externas. Los elementos orbitales (OMM/JSON)
vienen de CelesTrak (principal) con Space-Track como fallback, cacheados en SQLite con TTL 12–24 h.

UI y comentarios del código **en español (rioplatense)**. Mantener ese idioma.

## Stack

- React Native 0.86 + **Expo SDK 57** + **Expo Router** (typed routes), TypeScript estricto, Hermes.
- `satellite.js` 6 (SGP4/SDP4).
- **Mapa: `@maplibre/maplibre-react-native` v11 + tiles de OpenFreeMap** (`https://tiles.openfreemap.org/styles/dark`,
  constante `MAP_STYLE_URL` en `src/ui/theme.ts`). **No** se usa `react-native-maps` ni Google Maps: se
  reemplazó porque Google exige cuenta de facturación. No reintroducirlo. Todo se dibuja como
  `GeoJSONSource` + `Layer` (`line`, `fill`, `circle`).
- `react-native-svg` (Sky Chart), `expo-sqlite` (caché + kv-store de ajustes), `expo-location`, `expo-sensors`,
  `expo-notifications`, `expo-background-task` + `expo-task-manager`, `expo-secure-store`, `expo-dev-client`.
- Tests: Jest (`jest-expo`), 8 suites / 115 tests en `__tests__/`.

## Cómo se ejecuta (flujo de Juan)

PC con Windows 11, Node 24 LTS y `eas-cli` global. **No hay JDK ni Android SDK local**: los builds se hacen en
la nube de EAS.

1. `eas login` (una vez).
2. `npm run build:dev` → development build (APK) en EAS; se instala en el celular desde el link/QR.
3. `npm start` (= `expo start --dev-client`) → Metro en la PC; el celular (misma Wi-Fi) se conecta.

Solo hay que rehacer el build cuando cambian dependencias nativas, plugins o `app.json`. Cambios de JS/TS se
ven con el server levantado. **No funciona en Expo Go** (MapLibre y otros módulos nativos).

Otros scripts: `npm run typecheck`, `npm test`, `npm run doctor`, `npm run build:apk` (APK autónomo, perfil
`preview`). Perfiles en `eas.json` (development / preview / production).

Verificación rápida tras un cambio: `npx tsc --noEmit` + `npx jest` + (opcional)
`npx expo export --platform android --output-dir <tmp>` para confirmar que el bundle compila.

`expo-doctor` marca TypeScript 5.9 vs 6.0 esperado: conocido, no afecta.

## Requisitos funcionales → dónde están

| RF | Qué | Archivos |
|----|-----|----------|
| 01/08/13 | Búsqueda, filtro por grupo, capa de constelación | `app/(tabs)/catalog.tsx`, `src/components/ConstellationLayer.tsx`, `src/core/orbital/constellation.ts`, `viewport.ts` |
| 02/03 | SGP4 local, lat/lon/alt, az/el topocéntrico | `src/core/orbital/OrbitalEngine.ts` |
| 04/05 | Predictor de pases + Sky Chart polar SVG | `src/core/orbital/passPredictor.ts`, `src/core/skyChart.ts`, `src/components/SkyChart.tsx`, `app/pass/[noradId].tsx` |
| 09/14/16 | Orquestador CelesTrak→Space-Track, caché TTL, rate limit, aviso de antigüedad | `src/data/DataProvider.ts`, `src/data/providers/*`, `src/data/cache/*`, `src/data/resilience.ts`, `src/data/freshness.ts` |
| 10/11/12 | Marcador en vivo, ground track (antimeridiano), footprint | `app/(tabs)/index.tsx`, `src/core/orbital/groundTrack.ts`, `footprint.ts` |
| 06/07 | Notificaciones pre-pase, brújula | `src/services/NotificationService.ts`, `passReminders.ts`, `trackedRefresh.ts`, `BackgroundRefresh.ts`, `src/components/CompassOverlay.tsx`, `src/core/orientation.ts`, `src/services/CompassService.ts` |
| 15 | Validación vs N2YO / Where the ISS at? (error km) | `src/core/validation.ts`, `src/services/ValidationService.ts`, `app/(tabs)/validation.tsx` |

## Arquitectura en capas

```
app/ (Expo Router, pantallas)
  └─► src/state (AppContext, hooks)  ─► src/services (adaptadores Expo) ─► src/data (orquestador, proveedores, caché)
  └─► src/components, src/ui                                              
src/core  ← TS puro, SIN imports de React Native/Expo → testeable en Node con Jest
```

Regla: **`src/core` no importa nada de RN ni Expo.** Las dependencias de Expo viven solo en `src/services`,
`src/state`, `src/components` y `app/`.

## Directorios y archivos

### `app/` (rutas)
- `_layout.tsx` — raíz: `AppProvider`, Stack; importa `BackgroundRefresh` para que `defineTask` corra al cargar.
- `(tabs)/_layout.tsx` — tabs.
- `(tabs)/index.tsx` — **Mapa** (MapLibre `Map` + `Camera` + `UserLocation`). Fuentes GeoJSON: `footprint`
  (fill+line), `track-past` (línea punteada), `track-future`, `constellation` (via `ConstellationLayer`),
  `selected-sat` (círculos halo+núcleo). `toRegion()` convierte bounds de MapLibre a `MapRegion`. Ground track
  se recalcula cada 60 s; footprint en cada refresco. Panel inferior con stats y chips (ground track,
  footprint, grupo de constelación, elevación mín. del footprint).
- `(tabs)/catalog.tsx` — búsqueda por nombre/NORAD y filtro por grupo; selecciona satélite.
- `(tabs)/passes.tsx` — próximos pases (72 h), asíncrono y cancelable; chip "Seguir este satélite" agenda avisos.
- `(tabs)/validation.tsx` — botón Comparar, historial, compartir tabla Markdown.
- `(tabs)/settings.tsx` — TTL, elevación mínima, minutos de aviso, credenciales (secure store), límite de constelación.
- `pass/[noradId].tsx` — vista de pase: Sky Chart + modo brújula.

### `src/core/` (lógica pura)
- `orbital/OrbitalEngine.ts` — wrapper de satellite.js: satrec (OMM preferido, soporta NORAD de 6 dígitos),
  `positionAt`, look angles, `groundTrack()`, `footprint()`, período.
- `orbital/passPredictor.ts` — barrido adaptativo acotado por la velocidad máx. de cambio de elevación,
  bisección a 0,5 s para AOS/LOS, ternaria para el máximo; detecta pases en curso.
- `orbital/groundTrack.ts` — muestreo (30–240 s según período) y **split en el antimeridiano**: si |Δlon| > 180°
  se desenrolla ±360°, se interpola la latitud del cruce y se cierra/abre tramo en ±180°.
- `orbital/footprint.ts` — radio λ = arccos(Re·cosε/(Re+h)) − ε; polígono desenrollado, cierre por el polo si
  lo encierra, recorte Sutherland–Hodgman en ±180° (puede devolver 2 polígonos).
- `orbital/constellation.ts` — `ConstellationPropagator`: propagación en lote a `Float32Array` [lat,lon,alt].
- `orbital/chunkScheduler.ts` — `TimeSlicer`: chunking cooperativo (Hermes no tiene Web Workers): presupuesto
  de ms + `setTimeout(0)`, cancelable con `AbortSignal`.
- `orbital/viewport.ts` — `MapRegion`, `selectVisible()` (recorte por región +20 %, muestreo estable hasta `limit`).
- `orbital/geo.ts`, `orbital/types.ts` — constantes, conversiones ECEF, tipos (`LatLng`, `Observer`, `GeoPosition`…).
- `orientation.ts` — orientación del equipo (acelerómetro+magnetómetro, compensación de inclinación).
- `skyChart.ts` — proyección az/el al gráfico polar (N arriba, E a la izquierda).
- `validation.ts` — compara SGP4 vs API **en el timestamp que informa la API**; error 3D, horizontal, Δalt.
- `settings.ts` — `AppSettings`, defaults y `sanitizeSettings`. `format.ts` — formatos en español.

### `src/data/`
- `DataProvider.ts` — `createDataProviders()` (Abstract Factory; orden = prioridad) y `DataOrchestrator`
  (Strategy + caché): 1) caché vigente → sin red; 2) proveedores en orden; 3) todo falla y hay caché vencida →
  se sirve marcada `stale`. TTL acotado a 12–24 h; no fuerza refresh antes de 2 h (CelesTrak actualiza ~2 h).
- `providers/CelesTrakProvider.ts` — GP/OMM; **Starlink usa SupGP** (set suplementario).
- `providers/SpaceTrackProvider.ts` — fallback con login/sesión (vence a la hora); grupos aproximados por filtros.
- `providers/N2yoProvider.ts`, `providers/WhereTheIssProvider.ts` — solo validación (WTIA: solo ISS, sin auth).
- `resilience.ts` — `RateLimiter`, `CircuitBreaker`, `retryWithBackoff`, `Clock` inyectable.
- `cache/` — `CacheStore` (interfaz), `SqliteCacheStore` (tablas `elements`, `group_meta`, `group_members`,
  `validation_runs`), `MemoryCacheStore` (tests/respaldo).
- `freshness.ts` (antigüedad, RF-16), `omm.ts` (parseo OMM), `errors.ts` (errores tipados), `types.ts`
  (`CATALOG_GROUPS`, `DataProvider`, `DataMeta`…).

### `src/services/`
`container.ts` (singleton perezoso: caché + orquestador, compartido con la tarea en background),
`LocationService` (expo-location, solo "mientras se usa"), `CompassService` (expo-sensors, azimut verdadero),
`NotificationService` (canal `passes`, tope 60 por límite de 64 de iOS), `passReminders` (ids estables
satélite+AOS), `trackedRefresh` (recalcula pases de satélites seguidos y reagenda), `BackgroundRefresh`
(refresca efemérides vencidas + reagenda), `SecureKeys` (credenciales Space-Track/N2YO, AFTER_FIRST_UNLOCK),
`SettingsStore` (kv de expo-sqlite), `ValidationService`.

### `src/state/`, `src/components/`, `src/ui/`
- `state/AppContext.tsx` — estado global: container, settings, observer (GPS), satélite seleccionado,
  `OrbitalEngine`, freshness; `useApp()`.
- `state/hooks.ts` — `useNow(intervalMs)`, `useLiveState(engine, observer, sec)` (posición en vivo).
- `components/` — `ConstellationLayer` (GeoJSON + capa `circle`, refresco 3 s, tap selecciona), `SkyChart`,
  `CompassOverlay`.
- `ui/theme.ts` (colores, spacing, `MAP_STYLE_URL`), `ui/components.tsx` (Banner, Button, Card, Chip, Stat,
  DataAgeBanner).

### Raíz
`app.json` (plugins: expo-router, expo-dev-client, expo-location, expo-sensors, expo-notifications,
expo-sqlite, expo-secure-store, expo-background-task, `@maplibre/maplibre-react-native`; package
`ar.edu.uader.satellitetracker`), `eas.json`, `babel.config.js`, `tsconfig.json`, `README.md`,
`INFORME_TECNICO.md` (informe académico: SupGP Starlink, límites de APIs y caché, supuestos SGP4,
validación esperada). `assets/dot.png` quedó sin uso tras pasar a MapLibre.

## Guía de estilo de documentación (preferencia de Juan)

Todo `.md` del repo (README, informe, docs nuevas) sigue este patrón. Objetivo: **esquemas que muestren
ciclos de vida y flujos + explicaciones cortas y simples**, en español rioplatense.

1. **Encabezado:** título `#` + 1–2 líneas que dicen qué es y con qué stack. Nada de párrafos largos.
2. **Secciones H2 con emoji**, separadas por `---`. Set habitual: 🏛️ Arquitectura · 📱 Pantallas ·
   🔄 Diagramas de flujo · ♻️ Ciclos de vida · 🚨 Manejo de errores · 🛠️ Stack · 🚀 Instalación ·
   ⚙️ Configuración · 🔒 Reglas/seguridad · ⚠️ Limitaciones · 📄 Documentos complementarios.
3. **Referencias a la consigna en los títulos:** p. ej. `### 2. Predicción de pases (RF-04 & RF-05)`.
4. **Arquitectura global:** mermaid `graph TD` con `subgraph` por capa; cada nodo con nombre + `<br/>` + una
   línea de detalle (archivo o tecnología).
5. **Pantallas:** tabla `| **NN · Nombre** (`archivo.tsx`) | qué hace + reglas clave |`.
6. **Happy paths:** numerados, cada uno un `sequenceDiagram` con `autonumber`, `actor Usuario`, participants
   con el nombre del archivo/servicio, `Note over` para reglas y `alt/else` para errores.
7. **Ciclos de vida / estados:** `stateDiagram-v2` con estados compuestos y `note`.
8. **Manejo de errores:** `flowchart TD` de decisiones (`{¿condición?}` → `Sí`/`No` → acción).
9. **Stack:** bullets `**Rol:** tecnología (detalle)`.
10. **Instalación:** pasos numerados como H3 con bloque `bash`; avisos de seguridad como cita `>`.
11. Cada diagrama va acompañado de **1–3 líneas** que lo expliquen. Tablas para datos comparativos.
12. Mermaid compatible con GitHub: textos con caracteres especiales entre comillas, sin `;` sueltos,
    `<br/>` para saltos de línea.

## Credenciales

Space-Track (usuario/contraseña) y N2YO (API key) se cargan en **Ajustes** y van a `expo-secure-store`.
Nunca en código, `.env` ni bundle. El mapa no necesita key. CelesTrak y Where the ISS at? no requieren cuenta.

## Limitaciones conocidas

Visibilidad solo geométrica (sin iluminación solar); footprint con Tierra esférica; grupos aproximados en
Space-Track; sin backend propio; brújula depende del magnetómetro.
