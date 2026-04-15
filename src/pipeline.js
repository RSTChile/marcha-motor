/**
 * Marcha — Pipeline REAL v2 (robusto, sin fallos)
 * - Nunca rompe
 * - Nunca entrega estructura inválida al engine
 * - Siempre intenta decidir (aunque sea fallback)
 */

const fs = require('fs');
const path = require('path');
const engine = require('./engine');
const { crawlAll } = require('./crawler');

const DATA_FILE = path.join(__dirname, '..', 'data', 'stations.json');
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

let _cache = null;
let _cacheLoadedAt = null;

// -----------------------------
// LOAD DATASET
// -----------------------------
function loadStations(forceReload = false) {
  const now = Date.now();

  if (!forceReload && _cache && _cacheLoadedAt && (now - _cacheLoadedAt) < CACHE_TTL_MS) {
    return _cache;
  }

  if (!fs.existsSync(DATA_FILE)) return [];

  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    _cache = raw.stations || [];
    _cacheLoadedAt = now;
    return _cache;
  } catch (err) {
    console.error('[pipeline] Error leyendo dataset:', err.message);
    return [];
  }
}

// -----------------------------
// DISTANCIA
// -----------------------------
function distanceMeters(lat1, lon1, lat2, lon2) {
  return engine.distanceMeters(lat1, lon1, lat2, lon2);
}

// -----------------------------
// FILTRO GEOGRÁFICO
// -----------------------------
function getNearbyStations(userLat, userLon, stations, radiusMeters) {
  return stations
    .filter(s => {
      if (typeof s.lat !== 'number' || typeof s.lon !== 'number') return false;
      return distanceMeters(userLat, userLon, s.lat, s.lon) <= radiusMeters;
    })
    .map(s => ({
      ...s,
      _dist_m: distanceMeters(userLat, userLon, s.lat, s.lon),
    }))
    .sort((a, b) => a._dist_m - b._dist_m);
}

// -----------------------------
// PREPARACIÓN PARA ENGINE
// -----------------------------
function prepareForEngine(station, fuelType) {
  const precio = station.precios?.[fuelType];
  if (!precio) return null;

  const ageMinutes = station.updated_at
    ? (Date.now() - new Date(station.updated_at).getTime()) / 60000
    : 99999;

  return {
    id: station.id,
    nombre: station.nombre,
    marca: station.marca,
    lat: station.lat,
    lon: station.lon,
    precio_actual: precio,
    precio_convenio: null,
    data_age_minutes: Math.round(ageMinutes),
    report_count: station.report_count || 1,
    zone_type: station.zone_type || 'semi',
    leaves_main_route: false,
  };
}

// -----------------------------
// PRECIO REFERENCIA
// -----------------------------
function computeReferencePrice(stations, fuelType) {
  const prices = stations
    .map(s => s.precios?.[fuelType])
    .filter(p => typeof p === 'number' && p > 0)
    .sort((a, b) => a - b);

  if (!prices.length) return 1500;

  const mid = Math.floor(prices.length / 2);
  return prices.length % 2 === 0
    ? Math.round((prices[mid - 1] + prices[mid]) / 2)
    : prices[mid];
}

// -----------------------------
// RADIO ADAPTATIVO
// -----------------------------
function getRadius(fuelType) {
  if (fuelType === 'diesel') return 30000; // clave para tu caso real
  return 10000;
}

// -----------------------------
// ASEGURAR DATASET
// -----------------------------
async function ensureDataset() {
  let stations = loadStations();

  if (stations.length > 0) return stations;

  console.log('[pipeline] Generando dataset inicial...');
  await crawlAll({ testLimit: 80 });

  return loadStations(true);
}

// -----------------------------
// FALLBACK: SIEMPRE UNA ESTACIÓN
// -----------------------------
function fallbackClosest(userLat, userLon, stations) {
  return stations
    .filter(s => s.lat && s.lon)
    .map(s => ({
      ...s,
      _dist_m: distanceMeters(userLat, userLon, s.lat, s.lon),
    }))
    .sort((a, b) => a._dist_m - b._dist_m)
    .slice(0, 5); // top 5 cercanas SIEMPRE
}

// -----------------------------
// PIPELINE PRINCIPAL
// -----------------------------
async function runPipeline({ userProfile, context }) {
  try {
    const {
      user_lat,
      user_lon,
      fuel_type = 'diesel',
      reference_price,
      is_urban_peak = false,
      toll_estimate = 0,
    } = context;

    if (typeof user_lat !== 'number' || typeof user_lon !== 'number') {
      return {
        mode: 3,
        recommendation: null,
        alternative: null,
        message: 'Ubicación inválida',
      };
    }

    const stations = await ensureDataset();

    if (!stations.length) {
      return {
        mode: 3,
        recommendation: null,
        alternative: null,
        message: 'Sin dataset disponible',
      };
    }

    // 1. Intento normal
    const radius = getRadius(fuel_type);
    let nearby = getNearbyStations(user_lat, user_lon, stations, radius);

    // 2. Si no hay → fallback global
    if (nearby.length === 0) {
      console.log('[pipeline] fallback global activado');
      nearby = fallbackClosest(user_lat, user_lon, stations);
    }

    // 3. Preparar para engine
    let engineStations = nearby
      .map(s => prepareForEngine(s, fuel_type))
      .filter(Boolean);

    // 4. Si no hay combustible → fallback sin filtro
    if (engineStations.length === 0) {
      console.log('[pipeline] fallback combustible activado');

      const fallback = fallbackClosest(user_lat, user_lon, stations);

      engineStations = fallback
        .map(s => {
          const anyFuel =
            s.precios?.diesel ||
            s.precios?.gas93 ||
            s.precios?.gas95 ||
            s.precios?.gas97;

          if (!anyFuel) return null;

          return {
            id: s.id,
            nombre: s.nombre,
            marca: s.marca,
            lat: s.lat,
            lon: s.lon,
            precio_actual: anyFuel,
            precio_convenio: null,
            data_age_minutes: 999,
            report_count: 1,
            zone_type: 'semi',
            leaves_main_route: false,
          };
        })
        .filter(Boolean);
    }

    // 5. GARANTÍA TOTAL (esto evita tu error)
    if (!Array.isArray(engineStations) || engineStations.length === 0) {
      return {
        mode: 3,
        recommendation: null,
        alternative: null,
        message: 'No hay estaciones utilizables',
      };
    }

    // 6. Contexto engine
    const engineContext = {
      user_lat,
      user_lon,
      reference_price: reference_price || computeReferencePrice(stations, fuel_type),
      is_urban_peak,
      toll_estimate,
    };

    // 🔥 EJECUCIÓN FINAL
    return engine.decide(engineStations, userProfile, engineContext);

  } catch (err) {
    console.error('[pipeline ERROR]', err);

    return {
      mode: 3,
      recommendation: null,
      alternative: null,
      message: 'Error interno del sistema',
    };
  }
}

// -----------------------------
module.exports = {
  runPipeline,
};