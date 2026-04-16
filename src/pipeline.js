const engine = require('./engine');

// =============================================
// CONFIGURACIÓN GENERAL
// =============================================

const CACHE_TTL_MS = 10 * 60 * 1000;
const SAFE_AUTONOMY_FACTOR = 0.92;
const LONG_TRIP_FACTOR = 0.75;
const CORRIDOR_WIDTH_KM = 25;
const TOP_STATIONS_FOR_ORS = 12;

const stationsCache = new Map();
const routeCache = new Map();

let comunaMapCache = null;
let comunaCoordsCache = null;

// =============================================
// NORMALIZACIÓN
// =============================================

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

// =============================================
// MARCAS (NOMBRE REAL)
// =============================================

function getMarcaNombre(marca) {
  if (!marca) return 'Estación';

  if (typeof marca === 'string' && marca.trim().length > 2) {
    return marca.trim().toUpperCase();
  }

  const marcas = {
    1: 'COPEC',
    2: 'SHELL',
    3: 'PETROBRAS',
    4: 'ENEX',
    5: 'COPEC',
    10: 'SHELL',
    15: 'PETROBRAS',
    23: 'ABASTIBLE',
    24: 'LIPIGAS',
    151: 'ESMAX',
    177: 'AUTOGASCO'
  };

  return marcas[marca] || 'Estación';
}

// =============================================
// CARGA DE COMUNAS (IDS DE ESTACIONES)
// =============================================

async function loadComunaStationsMap() {
  if (comunaMapCache) return comunaMapCache;

  try {
    const res = await fetch(
      'https://raw.githubusercontent.com/RSTChile/marcha-motor/refs/heads/main/data/comunas-stations.json'
    );

    if (!res.ok) {
      console.error('[pipeline] ❌ Error cargando comunas-stations.json:', res.status);
      comunaMapCache = {};
      return comunaMapCache;
    }

    const json = await res.json();
    comunaMapCache = json?.comunas || {};

    console.log(`[pipeline] 📍 Mapeo cargado: ${Object.keys(comunaMapCache).length} comunas`);
    return comunaMapCache;
  } catch (err) {
    console.error('[pipeline] ❌ Error mapeo comunas:', err.message);
    comunaMapCache = {};
    return comunaMapCache;
  }
}

// =============================================
// CARGA DE COORDENADAS (ROBUSTA)
// =============================================

async function loadComunaCoords() {
  if (comunaCoordsCache) return comunaCoordsCache;

  try {
    const url =
      'https://raw.githubusercontent.com/RSTChile/marcha-motor/refs/heads/main/data/comunas-completo.json';

    const res = await fetch(url);

    if (!res.ok) {
      console.error('[pipeline] ❌ Error HTTP coords:', res.status);
      comunaCoordsCache = {};
      return comunaCoordsCache;
    }

    const json = await res.json();

    console.log('[pipeline] DEBUG coords tipo:', typeof json);

    let items = [];

    if (Array.isArray(json)) {
      items = json;
    } else if (Array.isArray(json.comunas)) {
      items = json.comunas;
    } else if (typeof json === 'object' && json !== null) {
      items = Object.values(json);
    }

    const map = {};

    for (const item of items) {
      const nombre =
        item?.nombre ||
        item?.comuna ||
        item?.name ||
        null;

      const lat = Number(
        item?.lat ??
        item?.latitud ??
        item?.latitude
      );

      const lon = Number(
        item?.lon ??
        item?.lng ??
        item?.longitud ??
        item?.longitude
      );

      if (!nombre) continue;
      if (!Number.isFinite(lat)) continue;
      if (!Number.isFinite(lon)) continue;

      map[normalizeText(nombre)] = {
        nombre,
        lat,
        lon
      };
    }

    comunaCoordsCache = map;

    console.log(
      `[pipeline] 🗺️ Coordenadas cargadas: ${Object.keys(map).length} comunas`
    );

    if (Object.keys(map).length === 0) {
      console.log('[pipeline] ⚠️ WARNING: mapa de coords vacío');
      console.log('[pipeline] muestra json:', JSON.stringify(json).slice(0, 300));
    }

    return comunaCoordsCache;
  } catch (err) {
    console.error('[pipeline] ❌ Error coords:', err.message);
    comunaCoordsCache = {};
    return comunaCoordsCache;
  }
}

// =============================================
// RESOLVER COMUNA
// =============================================

function getComunaCoords(name) {
  if (!name || !comunaCoordsCache) return null;
  return comunaCoordsCache[normalizeText(name)] || null;
}

function resolveComunaData(map, name) {
  if (!map || !name) return null;

  const target = normalizeText(name);

  for (const key of Object.keys(map)) {
    if (normalizeText(key) === target) {
      return {
        key,
        value: map[key]
      };
    }
  }

  return null;
}
// =============================================
// DISTANCIA (HAVERSINE)
// =============================================

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;

  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
      Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// =============================================
// DISTANCIA REAL (ORS)
// =============================================

async function getRealDistance(lat1, lon1, lat2, lon2) {
  const key = `${lat1.toFixed(4)},${lon1.toFixed(4)}|${lat2.toFixed(4)},${lon2.toFixed(4)}`;

  const cached = routeCache.get(key);
  if (cached && Date.now() - cached.t < CACHE_TTL_MS) {
    return cached.d;
  }

  try {
    const url =
      `https://api.openrouteservice.org/v2/directions/driving-car` +
      `?api_key=${process.env.ORS_API_KEY}` +
      `&start=${lon1},${lat1}&end=${lon2},${lat2}`;

    const res = await fetch(url);
    if (!res.ok) return null;

    const json = await res.json();
    const dist = json?.features?.[0]?.properties?.summary?.distance;
    if (!dist) return null;

    const km = dist / 1000;

    routeCache.set(key, { d: km, t: Date.now() });
    return km;
  } catch {
    return null;
  }
}

// =============================================
// FETCH ESTACIÓN POR ID
// =============================================

async function fetchStationById(id) {
  const cached = stationsCache.get(id);
  if (cached && Date.now() - cached.t < CACHE_TTL_MS) {
    return cached.d;
  }

  try {
    const res = await fetch(
      `https://api.bencinaenlinea.cl/api/estacion_ciudadano/${id}`
    );

    if (!res.ok) return null;

    const json = await res.json();
    const d = json?.data;

    if (!d || d.estado_bandera !== 1) return null;

    const precios = {};
    const precios_detalle = [];

    for (const c of d.combustibles || []) {
      const p = Math.floor(parseFloat(c.precio));
      if (!p) continue;

      if (c.nombre_corto === 'DI') precios.diesel = p;
      if (c.nombre_corto === '93') precios.gas93 = p;
      if (c.nombre_corto === '95') precios.gas95 = p;
      if (c.nombre_corto === '97') precios.gas97 = p;
      if (c.nombre_corto === 'KE') precios.kerosene = p;

      precios_detalle.push({
        tipo: c.nombre_largo || c.nombre_corto,
        precio: p,
        actualizado: c.actualizado || null,
        unidad: c.unidad_cobro || '$/L'
      });
    }

    const station = {
      id: d.id,
      nombre: getMarcaNombre(d.marca || d.razon_social?.marca),
      direccion: d.direccion || '',
      comuna: d.comuna || '',
      region: d.region || '',
      lat: parseFloat(d.latitud),
      lon: parseFloat(d.longitud),
      precios,
      precios_detalle,
      servicios: d.servicios || [],
      metodos_pago: d.metodos_pago || [],
      fetched_at: Date.now()
    };

    stationsCache.set(id, { d: station, t: Date.now() });
    return station;
  } catch {
    return null;
  }
}

// =============================================
// FETCH MÚLTIPLE DE ESTACIONES
// =============================================

async function fetchStations(ids) {
  const out = [];
  const uniqueIds = [...new Set(ids || [])];

  for (const id of uniqueIds) {
    const s = await fetchStationById(id);
    if (s) out.push(s);
  }

  return out;
}

// =============================================
// AUTONOMÍA
// fuel_consumption viene desde la interfaz como km/L
// =============================================

function calculateAutonomyKm(userProfile) {
  const tank = Number(userProfile?.tank_capacity || 0);
  const level = Number(userProfile?.current_level_pct || 0);
  const kmPerLiter = Number(userProfile?.fuel_consumption || 0);

  if (!Number.isFinite(tank) || tank <= 0) return 0;
  if (!Number.isFinite(level) || level <= 0) return 0;
  if (!Number.isFinite(kmPerLiter) || kmPerLiter <= 0) return 0;

  return tank * (level / 100) * kmPerLiter;
}
// =============================================
// DIRECCIÓN Y CORREDOR DE VIAJE
// =============================================

function isForward(origin, dest, point) {
  const dx = dest.lon - origin.lon;
  const dy = dest.lat - origin.lat;

  const px = point.lon - origin.lon;
  const py = point.lat - origin.lat;

  return dx * px + dy * py > 0;
}

function distanceToLine(origin, dest, point) {
  const dx = dest.lon - origin.lon;
  const dy = dest.lat - origin.lat;

  const px = point.lon - origin.lon;
  const py = point.lat - origin.lat;

  const len = Math.sqrt(dx * dx + dy * dy);
  if (!len) return Infinity;

  return Math.abs(dx * py - dy * px) / len;
}

// =============================================
// SELECCIÓN DE COMUNAS EN RUTA
// =============================================

function selectRouteComunas(originCoords, destinoCoords, autonomiaKm) {
  const out = [];

  for (const name of Object.keys(comunaMapCache || {})) {
    const coords = getComunaCoords(name);
    if (!coords) continue;

    const dist = haversineDistance(
      originCoords.lat,
      originCoords.lon,
      coords.lat,
      coords.lon
    );

    if (dist > autonomiaKm * 1.1) continue;
    if (!isForward(originCoords, destinoCoords, coords)) continue;

    const lateral = distanceToLine(originCoords, destinoCoords, coords);
    if (lateral > CORRIDOR_WIDTH_KM) continue;

    out.push(name);
  }

  return out;
}

// =============================================
// ENRIQUECIMIENTO VISUAL DEL RESULTADO
// =============================================

function attachFullData(target, fullList, fuelType) {
  if (!target || !fullList?.length) return target;

  const found = fullList.find(s =>
    s.id === target.station_id || s.id === target.id
  );

  if (!found) return target;

  const displayPrice =
    found.precios?.[fuelType] ||
    target.display_price ||
    target.precio_actual ||
    0;

  const displayDistance =
    found._real_distance_km ||
    target.display_distance_km ||
    0;

  target.station_id = found.id;
  target.id = found.id;
  target.nombre = found.nombre;
  target.direccion = found.direccion;
  target.comuna = found.comuna;
  target.display_price = displayPrice;
  target.display_distance_km = displayDistance;

  target.station = {
    id: found.id,
    nombre: found.nombre,
    direccion: found.direccion,
    comuna: found.comuna,
    precios_detalle: found.precios_detalle || [],
    servicios: found.servicios || [],
    metodos_pago: found.metodos_pago || []
  };

  return target;
}

// =============================================
// MENSAJE INTELIGENTE
// =============================================

function buildMarginMessage(autonomiaKm, nearestKm) {
  if (!Number.isFinite(autonomiaKm) || !Number.isFinite(nearestKm)) return '';

  const margin = autonomiaKm - nearestKm;

  if (margin < 0) {
    return 'Con tu conducción actual podrías no alcanzar a llegar a la estación más cercana. Pero, si reduces velocidad y mantienes conducción suave, es probable que llegues sin problemas.';
  }

  if (margin < 120) {
    return 'Podrías llegar justo a la próxima estación. Con conducción eficiente deberías alcanzarla sin inconvenientes.';
  }

  return 'Tienes margen suficiente para seguir avanzando y evaluar opciones antes de cargar.';
}
// =============================================
// PIPELINE PRINCIPAL
// =============================================

async function runPipeline({ userProfile, context }) {
  const { user_lat, user_lon, comuna, destino, fuel_type = 'diesel' } = context;

  const autonomia = calculateAutonomyKm(userProfile);
  const safeAutonomia = autonomia * SAFE_AUTONOMY_FACTOR;

  let effectiveAutonomia = safeAutonomia;
  let tripDistanceKm = null;

  const comunaMap = await loadComunaStationsMap();
  await loadComunaCoords();

  const comunaResolved = resolveComunaData(comunaMap, comuna);

  if (!comunaResolved) {
    return { mode: 3, message: 'Comuna no encontrada' };
  }

  let stationIds = [];

  // =============================================
  // MODO VIAJE
  // =============================================

  if (destino) {
    const destinoCoords = getComunaCoords(destino);

    if (destinoCoords) {
      tripDistanceKm =
        await getRealDistance(user_lat, user_lon, destinoCoords.lat, destinoCoords.lon) ||
        haversineDistance(user_lat, user_lon, destinoCoords.lat, destinoCoords.lon);

      if (tripDistanceKm > 300) {
        effectiveAutonomia *= LONG_TRIP_FACTOR;
      }

      const comunasRuta = selectRouteComunas(
        { lat: user_lat, lon: user_lon },
        destinoCoords,
        effectiveAutonomia
      );

      for (const c of comunasRuta) {
        const r = resolveComunaData(comunaMap, c);
        if (r) {
          stationIds.push(...(r.value?.stations || []).map(s => s.id));
        }
      }
    }
  }

  // =============================================
  // FALLBACK A COMUNA ACTUAL
  // =============================================

  if (!stationIds.length) {
    stationIds = (comunaResolved.value?.stations || []).map(s => s.id);
  }

  const stations = await fetchStations(stationIds);

  // =============================================
  // REDUCCIÓN DE LLAMADAS ORS
  // =============================================

  stations.sort((a, b) =>
    haversineDistance(user_lat, user_lon, a.lat, a.lon) -
    haversineDistance(user_lat, user_lon, b.lat, b.lon)
  );

  const top = stations.slice(0, TOP_STATIONS_FOR_ORS);
  const rest = stations.slice(TOP_STATIONS_FOR_ORS);

  const enriched = [];

  for (const s of top) {
    let dist = await getRealDistance(user_lat, user_lon, s.lat, s.lon);

    if (!dist) {
      dist = haversineDistance(user_lat, user_lon, s.lat, s.lon);
    }

    if (!s.precios[fuel_type]) continue;

    enriched.push({
      ...s,
      _real_distance_km: dist
    });
  }

  for (const s of rest) {
    if (!s.precios[fuel_type]) continue;

    enriched.push({
      ...s,
      _real_distance_km: haversineDistance(user_lat, user_lon, s.lat, s.lon)
    });
  }

  enriched.sort((a, b) => a._real_distance_km - b._real_distance_km);

  const engineStations = enriched.map(s => ({
    id: s.id,
    nombre: s.nombre,
    direccion: s.direccion,
    comuna: s.comuna,
    precio_actual: s.precios[fuel_type],
    _real_distance_km: s._real_distance_km
  }));

  if (!engineStations.length) {
    return { mode: 3, message: 'No hay estaciones disponibles' };
  }

  const result = engine.decide(userProfile, engineStations, {});

  // =============================================
  // REINTEGRAR DATOS VISUALES
  // =============================================

  if (result.recommendation) {
    result.recommendation = attachFullData(result.recommendation, enriched, fuel_type);
  }

  if (Array.isArray(result.alternatives)) {
    result.alternatives = result.alternatives.map(alt =>
      attachFullData(alt, enriched, fuel_type)
    );
  }

  if (result.alternative) {
    result.alternative = attachFullData(result.alternative, enriched, fuel_type);
  }

  // Compatibilidad extra si el engine usa "top"
  if (result.top) {
    result.top = attachFullData(result.top, enriched, fuel_type);
  }

  const nearest =
    result.recommendation?.display_distance_km ||
    enriched[0]?._real_distance_km ||
    0;

  const msg = buildMarginMessage(autonomia, nearest);

  result.autonomy_km = Math.round(autonomia);
  result.trip_distance_km = tripDistanceKm ? Math.round(tripDistanceKm) : null;

  result.message =
    `Autonomía estimada: ${Math.round(autonomia)} km.` +
    (tripDistanceKm
      ? ` Distancia al destino: ${Math.round(tripDistanceKm)} km.`
      : '') +
    ` ${msg}`;

  return result;
}

// =============================================
// EXPORT
// =============================================

module.exports = { runPipeline };
