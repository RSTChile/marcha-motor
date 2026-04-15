/**
 * Marcha — Pipeline real
 * dataset local → filtro geográfico → engine
 */

const fs = require('fs');
const path = require('path');
const engine = require('./engine');
const { crawlAll } = require('./crawler');

const DATA_FILE = path.join(__dirname, '..', 'data', 'stations.json');
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas

let _cache = null;
let _cacheLoadedAt = null;

function loadStations(forceReload = false) {
  const now = Date.now();

  if (!forceReload && _cache && _cacheLoadedAt && (now - _cacheLoadedAt) < CACHE_TTL_MS) {
    return _cache;
  }

  if (!fs.existsSync(DATA_FILE)) {
    return [];
  }

  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    _cache = raw.stations || [];
    _cacheLoadedAt = now;
    return _cache;
  } catch (err) {
    console.error('[pipeline] Error leyendo stations.json:', err.message);
    return [];
  }
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  return engine.distanceMeters(lat1, lon1, lat2, lon2);
}

function getNearbyStations(userLat, userLon, stations, radiusMeters = 5000) {
  return stations
    .filter(s => {
      if (typeof s.lat !== 'number' || typeof s.lon !== 'number') return false;
      const dist = distanceMeters(userLat, userLon, s.lat, s.lon);
      return dist <= radiusMeters;
    })
    .map(s => ({
      ...s,
      _dist_m: distanceMeters(userLat, userLon, s.lat, s.lon),
    }))
    .sort((a, b) => a._dist_m - b._dist_m);
}

function prepareForEngine(station, fuelType = 'gas95') {
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

    // Por ahora default. Luego puede calcularse por ruta real.
    leaves_main_route: false,
  };
}

function computeReferencePrice(stations, fuelType) {
  const prices = stations
    .map(s => s.precios?.[fuelType])
    .filter(p => typeof p === 'number' && p > 0)
    .sort((a, b) => a - b);

  if (prices.length === 0) {
    if (fuelType === 'diesel') return 1500;
    if (fuelType === 'gas93') return 1500;
    if (fuelType === 'gas95') return 1550;
    if (fuelType === 'gas97') return 1600;
    return 1500;
  }

  const mid = Math.floor(prices.length / 2);
  return prices.length % 2 === 0
    ? Math.round((prices[mid - 1] + prices[mid]) / 2)
    : prices[mid];
}

function getAdaptiveRadius(userProfile, context) {
  if (userProfile.context_type === 'cargo') return 20000;

  // Caso doméstico rural/semi-rural: abrir más el radio
  const fuelType = context.fuel_type || 'gas95';
  if (fuelType === 'diesel') return 20000;

  return 8000;
}

function getDatasetStats() {
  const stations = loadStations();
  if (stations.length === 0) {
    return { total: 0, fresh: 0, stale: 0, noDate: 0, freshPct: 0 };
  }

  const now = Date.now();
  let fresh = 0;
  let stale = 0;
  let noDate = 0;

  for (const s of stations) {
    if (!s.updated_at) {
      noDate++;
      continue;
    }
    const ageH = (now - new Date(s.updated_at).getTime()) / 3600000;
    if (ageH < 24) fresh++;
    else stale++;
  }

  return {
    total: stations.length,
    fresh,
    stale,
    noDate,
    freshPct: Math.round((fresh / stations.length) * 100),
  };
}

async function ensureStationsDataset() {
  const current = loadStations();
  if (current.length > 0) return current;

  console.log('[pipeline] No hay dataset. Ejecutando crawl inicial...');
  await crawlAll({ testLimit: 80 });

  return loadStations(true);
}

async function runPipeline({ userProfile, context }) {
  const {
    user_lat,
    user_lon,
    lat,
    lon,
    fuel_type = 'gas95',
    reference_price,
    is_urban_peak = false,
    toll_estimate = 0,
  } = context;

  const finalLat = user_lat ?? lat;
  const finalLon = user_lon ?? lon;

  if (typeof finalLat !== 'number' || typeof finalLon !== 'number') {
    return {
      mode: 3,
      recommendation: null,
      alternative: null,
      message: 'Ubicación inválida o no disponible.',
    };
  }

  const allStations = await ensureStationsDataset();

  if (!allStations.length) {
    return {
      mode: 3,
      recommendation: null,
      alternative: null,
      message: 'No encontramos estaciones disponibles todavía. Intenta nuevamente en unos minutos.',
    };
  }

  // Primer intento: radio adaptativo
  const radius1 = getAdaptiveRadius(userProfile, context);
  let nearby = getNearbyStations(finalLat, finalLon, allStations, radius1);

  // Segundo intento: abrir radio si no hay nada
  if (nearby.length === 0) {
    nearby = getNearbyStations(finalLat, finalLon, allStations, 35000);
  }

  if (nearby.length === 0) {
    return {
      mode: 3,
      recommendation: null,
      alternative: null,
      message: 'No encontramos estaciones de servicio cerca de tu ubicación.',
    };
  }

  const refPrice = reference_price || computeReferencePrice(nearby, fuel_type);

  const engineStations = nearby
    .map(s => {
      const prepared = prepareForEngine(s, fuel_type);
      if (!prepared) return null;

      if (
        userProfile.convenio_marca &&
        s.marca === userProfile.convenio_marca &&
        userProfile.convenio_discount
      ) {
        prepared.precio_convenio = Math.max(
          0,
          prepared.precio_actual - userProfile.convenio_discount
        );
      }

      return prepared;
    })
    .filter(Boolean);

  if (engineStations.length === 0) {
    return {
      mode: 3,
      recommendation: null,
      alternative: null,
      message: `No encontramos estaciones con ${fuel_type} cerca de tu ubicación.`,
    };
  }

  const engineContext = {
    user_lat: finalLat,
    user_lon: finalLon,
    reference_price: refPrice,
    is_urban_peak,
    toll_estimate,
  };

  return engine.decide(engineStations, userProfile, engineContext);
}

module.exports = {
  loadStations,
  getNearbyStations,
  prepareForEngine,
  computeReferencePrice,
  getDatasetStats,
  runPipeline,
};