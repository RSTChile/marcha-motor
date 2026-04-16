const fs = require('fs');
const path = require('path');

const engine = require('./engine');

const ORS_API_KEY = process.env.ORS_API_KEY;

const CACHE_TTL_MS = 1000 * 60 * 5;
const FETCH_TIMEOUT_MS = 5000;

const SAFE_AUTONOMY_FACTOR = 0.9;
const ROUTE_CORRIDOR_WIDTH = 0.3;

const TRIP_TARGET_NEAR = 0.15;
const TRIP_TARGET_MID = 0.5;
const TRIP_TARGET_LIMIT = 0.9;

const COMUNA_STATIONS_FILE = path.join(__dirname, '../data/comunas-stations.json');
const COMUNAS_COORDS_FILE = path.join(__dirname, '../data/comunas-completo.json');

const routeCache = new Map();
const stationsCache = new Map();

let comunasMapCache = null;
let comunasCoordsCache = null;

// ----------------------------
// LOADERS
// ----------------------------

function loadComunaStationsMap() {
  if (comunasMapCache) return comunasMapCache;

  try {
    const raw = JSON.parse(fs.readFileSync(COMUNA_STATIONS_FILE, 'utf8'));
    comunasMapCache = raw.comunas || {};
    return comunasMapCache;
  } catch (err) {
    console.error('[pipeline] Error cargando comunas:', err.message);
    return {};
  }
}

function loadComunaCoordsMap() {
  if (comunasCoordsCache) return comunasCoordsCache;

  try {
    const raw = JSON.parse(fs.readFileSync(COMUNAS_COORDS_FILE, 'utf8'));
    comunasCoordsCache = raw.comunas || {};
    return comunasCoordsCache;
  } catch (err) {
    console.error('[pipeline] Error coords:', err.message);
    return {};
  }
}

function normalizeText(text) {
  return text?.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '') || '';
}

function resolveComunaData(map, comuna) {
  const norm = normalizeText(comuna);

  for (const key of Object.keys(map)) {
    if (normalizeText(key) === norm) {
      return { key, value: map[key] };
    }
  }

  return null;
}

function getComunaCoords(comuna) {
  const map = loadComunaCoordsMap();

  for (const key of Object.keys(map)) {
    if (normalizeText(key) === normalizeText(comuna)) {
      return map[key];
    }
  }

  return null;
}
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

async function getRealDistance(lat1, lon1, lat2, lon2) {
  const cacheKey = `${lat1.toFixed(4)},${lon1.toFixed(4)}|${lat2.toFixed(4)},${lon2.toFixed(4)}`;

  const cached = routeCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.distance;
  }

  try {
    const res = await fetch('https://api.openrouteservice.org/v2/directions/driving-car', {
      method: 'POST',
      headers: {
        Authorization: ORS_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        coordinates: [[lon1, lat1], [lon2, lat2]]
      })
    });

    if (!res.ok) return null;

    const data = await res.json();
    const meters = data?.features?.[0]?.properties?.summary?.distance;

    if (!meters) return null;

    const km = meters / 1000;

    routeCache.set(cacheKey, {
      distance: km,
      timestamp: Date.now()
    });

    return km;

  } catch {
    return null;
  }
}

function calculateAutonomyKm(userProfile) {
  const tank = Number(userProfile?.tank_capacity || 0);
  const pct = Number(userProfile?.current_level_pct || 0);
  const consumption = Number(userProfile?.fuel_consumption || 0);

  if (!tank || !pct || !consumption) return 0;

  const liters = tank * (pct / 100);
  const kmPerLiter = 100 / consumption;

  return liters * kmPerLiter;
}
function isForward(origin, destination, point) {
  const dx = destination.lon - origin.lon;
  const dy = destination.lat - origin.lat;

  const px = point.lon - origin.lon;
  const py = point.lat - origin.lat;

  return (dx * px + dy * py) > 0;
}

function computeProgress(origin, point) {
  return haversineDistance(origin.lat, origin.lon, point.lat, point.lon);
}

function getRouteComunas(origin, destino, autonomiaKm) {
  const coordsMap = loadComunaCoordsMap();
  const destCoords = getComunaCoords(destino);

  if (!destCoords) return [];

  const maxDist = autonomiaKm * SAFE_AUTONOMY_FACTOR;

  const candidates = [];

  for (const comunaName of Object.keys(coordsMap)) {
    const c = coordsMap[comunaName];

    if (!isForward(origin, destCoords, c)) continue;

    const dist = computeProgress(origin, c);

    if (dist > maxDist) continue;

    candidates.push({ comuna: comunaName, dist });
  }

  candidates.sort((a, b) => a.dist - b.dist);

  return candidates.slice(0, 5).map(c => c.comuna);
}
async function fetchStationById(id) {
  const cached = stationsCache.get(id);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const res = await fetch(`https://api.bencinaenlinea.cl/api/estacion_ciudadano/${id}`);
    if (!res.ok) return null;

    const json = await res.json();
    const d = json?.data;

    if (!d || d.estado_bandera !== 1) return null;

    const precios = {};

    for (const c of d.combustibles || []) {
      const p = Math.floor(parseFloat(c.precio));
      if (!p) continue;

      if (c.nombre_corto === 'DI') precios.diesel = p;
      if (c.nombre_corto === '93') precios.gas93 = p;
      if (c.nombre_corto === '95') precios.gas95 = p;
      if (c.nombre_corto === '97') precios.gas97 = p;
    }

    const station = {
      id: d.id,
      nombre: d.marca || 'Estación',
      comuna: d.comuna,
      direccion: d.direccion,
      lat: parseFloat(d.latitud),
      lon: parseFloat(d.longitud),
      precios,
      fetched_at: Date.now()
    };

    stationsCache.set(id, { data: station, timestamp: Date.now() });

    return station;

  } catch {
    return null;
  }
}

async function fetchStations(ids) {
  const results = [];

  for (const id of ids) {
    const s = await fetchStationById(id);
    if (s) results.push(s);
  }

  return results;
}

async function runPipeline({ userProfile, context }) {

  const { user_lat, user_lon, comuna, destino, fuel_type = 'diesel' } = context;

  const autonomia = calculateAutonomyKm(userProfile);

  const comunaMap = loadComunaStationsMap();
  const resolved = resolveComunaData(comunaMap, comuna);

  if (!resolved) {
    return { mode: 3, message: 'Comuna no encontrada' };
  }

  let stationIds = resolved.value.stations.map(s => s.id);

  // 🔥 MODO VIAJE
  if (destino) {
    const comunasRuta = getRouteComunas(
      { lat: user_lat, lon: user_lon },
      destino,
      autonomia
    );

    stationIds = [];

    for (const c of comunasRuta) {
      const r = resolveComunaData(comunaMap, c);
      if (r) {
        stationIds.push(...r.value.stations.map(s => s.id));
      }
    }
  }

  const stations = await fetchStations(stationIds);

  const enriched = [];

  for (const s of stations) {
    const dist = await getRealDistance(user_lat, user_lon, s.lat, s.lon)
      || haversineDistance(user_lat, user_lon, s.lat, s.lon);

    if (!s.precios[fuel_type]) continue;

    enriched.push({
      ...s,
      _real_distance_km: dist
    });
  }

  enriched.sort((a, b) => a._real_distance_km - b._real_distance_km);

  const engineStations = enriched.map(s => ({
    id: s.id,
    nombre: s.nombre,
    precio_actual: s.precios[fuel_type],
    _real_distance_km: s._real_distance_km
  }));

  if (engineStations.length === 0) {
    return { mode: 3, message: 'No hay estaciones disponibles' };
  }

  const result = engine.decide(userProfile, engineStations, {});

  result.autonomy_km = Math.round(autonomia);

  return result;
}

module.exports = { runPipeline };
