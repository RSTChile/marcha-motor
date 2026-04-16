const engine = require('./engine');

// ===============================
// CONFIG
// ===============================

const CACHE_TTL_MS = 10 * 60 * 1000;

const stationsCache = new Map();
const routeCache = new Map();

let comunaMapCache = null;

// ===============================
// LOAD COMUNAS (DESDE GITHUB)
// ===============================

async function loadComunaStationsMap() {
  if (comunaMapCache) return comunaMapCache;

  try {
    const res = await fetch(
      'https://raw.githubusercontent.com/RSTChile/marcha-motor/refs/heads/main/data/comunas-stations.json'
    );

    if (!res.ok) {
      console.error('[pipeline] ❌ Error cargando comunas');
      return {};
    }

    const json = await res.json();

    comunaMapCache = json.comunas || {};

    console.log(`[pipeline] 📍 Mapeo cargado: ${Object.keys(comunaMapCache).length} comunas`);

    return comunaMapCache;

  } catch (err) {
    console.error('[pipeline] 🔥 Error comunas:', err.message);
    return {};
  }
}

// ===============================
// DISTANCIA (Haversine)
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
// DISTANCIA REAL (ORS)
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
      comuna: d.comuna,
      direccion: d.direccion,
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

// ===============================
// FETCH MÚLTIPLE
// ===============================

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
  const consumption = Number(userProfile?.fuel_consumption || 8); // L/100km

  if (!tank || !consumption) return 400;

  const kmPerLiter = 100 / consumption;

  return tank * kmPerLiter;
}
// ===============================
// PIPELINE
// ===============================

async function runPipeline({ userProfile, context }) {

  const {
    user_lat,
    user_lon,
    comuna,
    fuel_type = 'diesel'
  } = context;

  const autonomia = calculateAutonomyKm(userProfile);

  const comunaMap = await loadComunaStationsMap();

  const comunaData = comunaMap[comuna];

  if (!comunaData) {
    return { mode: 3, message: 'Comuna no encontrada' };
  }

  let stationIds = comunaData.stations.map(s => s.id);

  const stations = await fetchStations(stationIds);

  // ===============================
  // 🔥 OPTIMIZACIÓN ORS
  // ===============================

  const prelim = stations.map(s => ({
    ...s,
    _approx: haversineDistance(user_lat, user_lon, s.lat, s.lon)
  }));

  prelim.sort((a, b) => a._approx - b._approx);

  const top = prelim.slice(0, 10);

  const enriched = [];

  for (const s of top) {

    let dist = await getRealDistance(user_lat, user_lon, s.lat, s.lon);

    if (!dist) dist = s._approx;

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
