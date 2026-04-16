const engine = require('./engine');

// ===============================
// CONFIG
// ===============================

const CACHE_TTL_MS = 10 * 60 * 1000;

const stationsCache = new Map();
const routeCache = new Map();

let comunaMapCache = null;
let comunaCoordsCache = null;

// ===============================
// LOAD COMUNAS (IDS)
// ===============================

async function loadComunaStationsMap() {
  if (comunaMapCache) return comunaMapCache;

  const res = await fetch(
    'https://raw.githubusercontent.com/RSTChile/marcha-motor/refs/heads/main/data/comunas-stations.json'
  );

  const json = await res.json();

  comunaMapCache = json.comunas || {};
  return comunaMapCache;
}

// ===============================
// LOAD COORDS
// ===============================

async function loadComunaCoords() {
  if (comunaCoordsCache) return comunaCoordsCache;

  const res = await fetch(
    'https://raw.githubusercontent.com/RSTChile/marcha-motor/refs/heads/main/data/comunas-completo.json'
  );

  const json = await res.json();

  comunaCoordsCache = {};

  for (const c of json) {
    comunaCoordsCache[c.nombre] = {
      lat: parseFloat(c.lat),
      lon: parseFloat(c.lon)
    };
  }

  return comunaCoordsCache;
}

function getComunaCoords(name) {
  return comunaCoordsCache?.[name] || null;
}

// ===============================
// DISTANCIA
// ===============================

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

// ===============================
// ORS
// ===============================

async function getRealDistance(lat1, lon1, lat2, lon2) {
  const key = `${lat1},${lon1}|${lat2},${lon2}`;

  const cached = routeCache.get(key);
  if (cached && Date.now() - cached.t < CACHE_TTL_MS) {
    return cached.d;
  }

  try {
    const url = `https://api.openrouteservice.org/v2/directions/driving-car?api_key=${process.env.ORS_API_KEY}&start=${lon1},${lat1}&end=${lon2},${lat2}`;

    const res = await fetch(url);
    if (!res.ok) return null;

    const json = await res.json();
    const dist = json.features?.[0]?.properties?.summary?.distance;

    if (!dist) return null;

    const km = dist / 1000;

    routeCache.set(key, { d: km, t: Date.now() });

    return km;

  } catch {
    return null;
  }
}

// ===============================
// FETCH ESTACIÓN
// ===============================

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
      direccion: d.direccion,
      comuna: d.comuna,
      lat: parseFloat(d.latitud),
      lon: parseFloat(d.longitud),
      precios,
      fetched_at: Date.now()
    };

    stationsCache.set(id, { d: station, t: Date.now() });

    return station;

  } catch {
    return null;
  }
}

async function fetchStations(ids) {
  const out = [];

  for (const id of ids) {
    const s = await fetchStationById(id);
    if (s) out.push(s);
  }

  return out;
}

// ===============================
// AUTONOMÍA
// ===============================

function calculateAutonomyKm(userProfile) {
  const tank = Number(userProfile?.tank_capacity || 45);
  const consumption = Number(userProfile?.fuel_consumption || 8);

  const kmPerLiter = 100 / consumption;

  return tank * kmPerLiter;
}
// ===============================
// DIRECCIÓN DE VIAJE
// ===============================

function isForward(origin, destination, point) {
  const dx = destination.lon - origin.lon;
  const dy = destination.lat - origin.lat;

  const px = point.lon - origin.lon;
  const py = point.lat - origin.lat;

  return (dx * px + dy * py) > 0;
}

// ===============================
// SELECCIÓN DE ESTACIONES EN RUTA
// ===============================

function selectStationsInRoute({
  comunaMap,
  user_lat,
  user_lon,
  destinoCoords,
  autonomia
}) {
  const ids = [];

  const maxRange = autonomia * 1.1;

  for (const [name, data] of Object.entries(comunaMap)) {

    const coords = getComunaCoords(name);
    if (!coords) continue;

    const dist = haversineDistance(
      user_lat,
      user_lon,
      coords.lat,
      coords.lon
    );

    if (dist > maxRange) continue;

    if (!isForward(
      { lat: user_lat, lon: user_lon },
      destinoCoords,
      coords
    )) continue;

    ids.push(...data.stations.map(s => s.id));
  }

  return ids;
}
async function runPipeline({ userProfile, context }) {

  const {
    user_lat,
    user_lon,
    comuna,
    destino,
    fuel_type = 'diesel'
  } = context;

  const autonomia = calculateAutonomyKm(userProfile);

  const comunaMap = await loadComunaStationsMap();
  await loadComunaCoords();

  let stationIds = [];

  // ===============================
  // MODO VIAJE
  // ===============================

  if (destino) {

    const destinoCoords = getComunaCoords(destino);

    if (destinoCoords) {

      stationIds = selectStationsInRoute({
        comunaMap,
        user_lat,
        user_lon,
        destinoCoords,
        autonomia
      });
    }
  }

  // fallback
  if (stationIds.length === 0) {
    stationIds = comunaMap[comuna]?.stations.map(s => s.id) || [];
  }

  const stations = await fetchStations(stationIds);

  // ===============================
  // PRE-FILTRO (Haversine)
  // ===============================

  const prelim = stations.map(s => ({
    ...s,
    _approx: haversineDistance(user_lat, user_lon, s.lat, s.lon)
  }));

  prelim.sort((a, b) => a._approx - b._approx);

  const top = prelim.slice(0, 10);

  // ===============================
  // DISTANCIA REAL
  // ===============================

  const enriched = [];

  for (const s of top) {

    let dist = await getRealDistance(
      user_lat,
      user_lon,
      s.lat,
      s.lon
    );

    if (!dist) dist = s._approx;

    if (!s.precios[fuel_type]) continue;

    enriched.push({
      ...s,
      _real_distance_km: dist
    });
  }

  enriched.sort((a, b) => a._real_distance_km - b._real_distance_km);

  // ===============================
  // ENGINE INPUT
  // ===============================

  const engineStations = enriched.map(s => ({
    id: s.id,
    nombre: s.nombre,
    direccion: s.direccion,
    comuna: s.comuna,
    precio_actual: s.precios[fuel_type],
    _real_distance_km: s._real_distance_km
  }));

  if (engineStations.length === 0) {
    return { mode: 3, message: 'No hay estaciones disponibles' };
  }

  const result = engine.decide(userProfile, engineStations, {});

  // ===============================
  // REINTEGRAR DATOS VISUALES
  // ===============================

  const enrich = (r) => {
    if (!r) return r;

    const s = enriched.find(x => x.id === r.station_id);
    if (!s) return r;

    r.display_price = s.precios[fuel_type];
    r.display_distance_km = s._real_distance_km;

    r.station = {
      id: s.id,
      nombre: s.nombre,
      direccion: s.direccion,
      comuna: s.comuna
    };

    return r;
  };

  result.recommendation = enrich(result.recommendation);

  if (Array.isArray(result.alternatives)) {
    result.alternatives = result.alternatives.map(enrich);
  }

  result.autonomy_km = Math.round(autonomia);

  return result;
}

module.exports = { runPipeline };
