/**
 * Marcha — Pipeline v4.1 + trayectoria (corregido)
 */

const engine = require('./engine');
const fs = require('fs');
const path = require('path');

const COMUNA_STATIONS_FILE = path.join(__dirname, '..', 'data', 'comunas-stations.json');

const FETCH_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 10 * 60 * 1000;

const MIN_REALISTIC_PRICES = {
  diesel: 1200,
  gas93: 1200,
  gas95: 1250,
  gas97: 1300
};

const ORS_API_KEY = '5b3ce3597851110001cf6248c9d8c8c5c8a84f2d8c8c8c8c8c8c8c';

const stationsCache = new Map();
const routeCache = new Map();

// 🔴 CORRECCIÓN CRÍTICA
let comunasMapCache = null;
function loadComunaStationsMap() {
  if (comunasMapCache) return comunasMapCache;

  try {
    if (!fs.existsSync(COMUNA_STATIONS_FILE)) {
      console.error('[pipeline] ❌ comunas-stations.json no encontrado');
      return {};
    }

    const raw = JSON.parse(fs.readFileSync(COMUNA_STATIONS_FILE, 'utf8'));
    comunasMapCache = raw.comunas || {};

    console.log(`[pipeline] 📍 Mapeo cargado: ${Object.keys(comunasMapCache).length} comunas`);

    return comunasMapCache;
  } catch (err) {
    console.error('[pipeline] Error cargando mapeo:', err.message);
    return {};
  }
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

// 🔴 NUEVO: AUTONOMÍA
function calcularAutonomia(userProfile) {
  const kmPorLitro = 100 / userProfile.fuel_consumption;
  const litros = userProfile.tank_capacity * (userProfile.current_level_pct / 100);
  return kmPorLitro * litros;
}

// 🔴 NUEVO: DIRECCIÓN
function getVector(a, b) {
  return {
    x: b.lon - a.lon,
    y: b.lat - a.lat
  };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y;
}

function enRuta(origen, destino, punto) {
  return dot(getVector(origen, destino), getVector(origen, punto)) > 0;
}
function buscarCentroComuna(nombre, comunaMap) {
  for (const [key, value] of Object.entries(comunaMap)) {
    if (key.toLowerCase() === nombre.toLowerCase()) {
      return {
        lat: value.lat || 0,
        lon: value.lon || 0
      };
    }
  }
  return null;
}
async function runPipeline({ userProfile, context }) {

  console.log('[pipeline] 🚀 Iniciando...');

  const { user_lat, user_lon, fuel_type = 'diesel', comuna, destino } = context;

  if (typeof user_lat !== 'number' || typeof user_lon !== 'number') {
    return { mode: 3, message: 'Ubicación inválida' };
  }

  if (!comuna) {
    return { mode: 3, message: 'Selecciona una comuna válida' };
  }

  const comunaMap = loadComunaStationsMap();

  if (!comunaMap[comuna]) {
    return { mode: 3, message: `No hay estaciones para ${comuna}` };
  }

  const stationIds = comunaMap[comuna].stations?.map(s => s.id) || [];

  if (stationIds.length === 0) {
    return { mode: 3, message: `No hay estaciones para ${comuna}` };
  }

  console.log(`[pipeline] 📍 Comuna: ${comuna}, IDs: ${stationIds.length}`);

  const stations = await fetchStationsByIds(stationIds);

  if (stations.length === 0) {
    return { mode: 3, message: 'No se encontraron estaciones' };
  }

  console.log('[pipeline] 🗺️ Calculando distancias...');

  const stationsWithRealDist = [];

  for (const station of stations) {
    const realDist = await getRealDistance(user_lat, user_lon, station.lat, station.lon);

    const finalDist = realDist !== null
      ? realDist
      : haversineDistance(user_lat, user_lon, station.lat, station.lon);

    stationsWithRealDist.push({
      ...station,
      _real_distance_km: finalDist
    });
  }

  // ===============================
  // 🔴 AUTONOMÍA
  // ===============================

  const autonomia = calcularAutonomia(userProfile);

  let filtradas = stationsWithRealDist.filter(s => s._real_distance_km <= autonomia);

  // ===============================
  // 🔴 TRAYECTORIA
  // ===============================

  if (destino) {
    console.log(`[pipeline] 🧭 Aplicando trayectoria hacia ${destino}`);

    const destinoCentro = buscarCentroComuna(destino, comunaMap);

    if (destinoCentro) {
      const origen = { lat: user_lat, lon: user_lon };

      const enTrayecto = filtradas.filter(s =>
        enRuta(origen, destinoCentro, { lat: s.lat, lon: s.lon })
      );

      if (enTrayecto.length > 0) {
        filtradas = enTrayecto;
        console.log(`[pipeline] ➡️ Estaciones en ruta: ${filtradas.length}`);
      }
    }
  }
    filtradas.sort((a, b) => a._real_distance_km - b._real_distance_km);

  const engineStations = filtradas
    .map(s => prepareStation(s, fuel_type, s._real_distance_km))
    .filter(Boolean);

  if (engineStations.length === 0) {
    return { mode: 3, message: 'No hay estaciones disponibles' };
  }

  const refPrice = calculateReferencePrice(engineStations);

  const result = engine.decide(
    userProfile,
    engineStations,
    {
      user_lat,
      user_lon,
      reference_price: refPrice
    }
  );

  result.message =
    `Autonomía estimada: ${Math.floor(autonomia)} km.` +
    (destino
      ? ` Evaluando estaciones en ruta hacia ${destino}.`
      : '');

  return result;
}

module.exports = { runPipeline };
