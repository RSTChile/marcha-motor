const fs = require('fs');
const path = require('path');

const engine = require('./engine');

const ORS_API_KEY = process.env.ORS_API_KEY;

const CACHE_TTL_MS = 1000 * 60 * 5;
const FETCH_TIMEOUT_MS = 5000;

const SAFE_AUTONOMY_FACTOR = 0.9;

const COMUNA_STATIONS_FILE = path.join(__dirname, '../data/comunas-stations.json');
const COMUNAS_COORDS_FILE = path.join(__dirname, '../data/comunas-completo.json');

const routeCache = new Map();
const stationsCache = new Map();

let comunasMapCache = null;
let comunasCoordsCache = null;
function loadComunaStationsMap() {
  if (comunasMapCache) return comunasMapCache;

  try {
    const raw = JSON.parse(fs.readFileSync(COMUNA_STATIONS_FILE, 'utf8'));
    comunasMapCache = raw.comunas || {};
    return comunasMapCache;
  } catch (err) {
    console.error('[pipeline] Error cargando comunas-stations:', err.message);
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
    console.error('[pipeline] Error cargando coordenadas:', err.message);
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
  const coordsMap = loadComunaCoordsMap();
  const resolved = resolveComunaData(coordsMap, comuna);
  return resolved?.value || null;
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
  if (!ORS_API_KEY) return null;

  const cacheKey = `${lat1.toFixed(4)},${lon1.toFixed(4)}|${lat2.toFixed(4)},${lon2.toFixed(4)}`;

  const cached = routeCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
    return cached.distance;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(
      'https://api.openrouteservice.org/v2/directions/driving-car',
      {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: ORS_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          coordinates: [
            [lon1, lat1],
            [lon2, lat2]
          ]
        })
      }
    );
    clearTimeout(timeout);

    if (!response.ok) return null;

    const data = await response.json();

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

  if (tank <= 0 || pct <= 0 || consumption <= 0) return 0;

  const liters = tank * (pct / 100);
  const kmPerLiter = 100 / consumption;

  return liters * kmPerLiter;
}

function calculateSafeAutonomyKm(km) {
  return km * SAFE_AUTONOMY_FACTOR;
}
async function fetchStationById(id) {
  const cached = stationsCache.get(id);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
    return cached.data;
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

    for (const c of d.combustibles || []) {
      const precio = Math.floor(parseFloat(c.precio));
      if (!precio) continue;

      if (c.nombre_corto === 'DI') precios.diesel = precio;
      if (c.nombre_corto === '93') precios.gas93 = precio;
      if (c.nombre_corto === '95') precios.gas95 = precio;
      if (c.nombre_corto === '97') precios.gas97 = precio;
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

async function fetchStationsByIds(ids) {
  const results = [];

  for (const id of ids) {
    const s = await fetchStationById(id);
    if (s) results.push(s);
  }

  return results;
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
async function runPipeline({ userProfile, context }) {

  const {
    user_lat,
    user_lon,
    fuel_type = 'diesel',
    comuna,
    destino
  } = context;
  const userLat = Number(user_lat);
  const userLon = Number(user_lon);

  if (!Number.isFinite(userLat) || !Number.isFinite(userLon)) {
    return { mode: 3, message: 'Ubicación de usuario inválida' };
  }

  const autonomiaKm = calculateAutonomyKm(userProfile);
  const autonomiaSeguraKm = calculateSafeAutonomyKm(autonomiaKm);

  const comunaMap = loadComunaStationsMap();
  const resolved = resolveComunaData(comunaMap, comuna);

  if (!resolved) {
    return { mode: 3, message: `No hay estaciones para ${comuna}` };
  }

  let stationIds = resolved.value?.stations?.map(s => s.id) || [];

  // 🔥 MODO VIAJE REAL
  if (destino) {

    const destinoCoords = getComunaCoords(destino);

    if (destinoCoords) {

      const coordsMap = loadComunaCoordsMap();

      const candidates = [];

      for (const cName of Object.keys(coordsMap)) {
        const coords = coordsMap[cName];

        if (!isForward(
          { lat: userLat, lon: userLon },
          destinoCoords,
          coords
        )) continue;

        const progress = computeProgress(
          { lat: userLat, lon: userLon },
          coords
        );

        if (progress > autonomiaSeguraKm * 1.1) continue;

        candidates.push({ comuna: cName, progress });
      }

      candidates.sort((a, b) => a.progress - b.progress);

      const selected = candidates.slice(0, 5).map(c => c.comuna);

      stationIds = [];

      for (const c of selected) {
        const r = resolveComunaData(comunaMap, c);
        if (r) {
          stationIds.push(...(r.value.stations.map(s => s.id)));
        }
      }
    }
  }

  const stations = await fetchStationsByIds(stationIds);

  const enrichedStations = [];

  for (const s of stations) {
    const dist = await getRealDistance(userLat, userLon, s.lat, s.lon)
      || haversineDistance(userLat, userLon, s.lat, s.lon);

    enrichedStations.push({ ...s, _real_distance_km: dist });
  }

  const engineStations = enrichedStations
    .map(s => ({
      id: s.id,
      nombre: s.nombre,
      precio_actual: s.precios[fuel_type],
      _real_distance_km: s._real_distance_km
    }))
    .filter(s => s.precio_actual);

  const result = engine.decide(userProfile, engineStations, {});

  result.autonomy_km = autonomiaKm;

  return result;
}

module.exports = { runPipeline };
