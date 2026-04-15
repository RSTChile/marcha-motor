/**
 * Marcha — Pipeline de datos
 * Loader + filtro geográfico + integración con engine.js
 * No documentar públicamente.
 */

const fs = require('fs');
const path = require('path');
const engine = require('./engine');

const DATA_FILE = path.join(__dirname, '../data/stations.json');
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;  // 6 horas

// ─── Estado en memoria ───────────────────────────────────────────────────────

let _cache = null;
let _cacheLoadedAt = null;

// ─── Loader ──────────────────────────────────────────────────────────────────

/**
 * loadStations()
 * Carga estaciones desde disco con caché en memoria.
 */
function loadStations(forceReload = false) {
  const now = Date.now();
  if (!forceReload && _cache && _cacheLoadedAt && (now - _cacheLoadedAt) < CACHE_TTL_MS) {
    return _cache;
  }

  if (!fs.existsSync(DATA_FILE)) {
    console.warn('[pipeline] stations.json no encontrado. Ejecuta: node src/crawler.js --test 5');
    return [];
  }

  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    _cache = raw.stations || [];
    _cacheLoadedAt = now;
    return _cache;
  } catch (e) {
    console.error('[pipeline] Error leyendo stations.json:', e.message);
    return [];
  }
}

// ─── Filtro geográfico ───────────────────────────────────────────────────────

/**
 * getNearbyStations(userLat, userLon, stations, radiusMeters)
 * Filtra estaciones dentro del radio especificado.
 */
function getNearbyStations(userLat, userLon, stations, radiusMeters = 5000) {
  return stations
    .filter(s => {
      if (!s.lat || !s.lon) return false;
      const dist = engine.distanceMeters(userLat, userLon, s.lat, s.lon);
      return dist <= radiusMeters;
    })
    .map(s => ({
      ...s,
      _dist_m: engine.distanceMeters(userLat, userLon, s.lat, s.lon),
    }))
    .sort((a, b) => a._dist_m - b._dist_m);
}

// ─── Preparación para engine ─────────────────────────────────────────────────

/**
 * prepareForEngine(station, fuelType)
 * Transforma una estación al formato que espera engine.evaluateStation().
 */
function prepareForEngine(station, fuelType = 'diesel') {
  // Mapeo de tipos de combustible
  const fuelMap = {
    'gas93': 'gas93',
    'gas95': 'gas95',
    'gas97': 'gas97',
    'diesel': 'diesel',
    'kerosene': 'kerosene',
  };
  
  const targetFuel = fuelMap[fuelType] || 'diesel';
  const precio = station.precios?.[targetFuel];
  
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
    leaves_main_route: station.leaves_main_route || false,
  };
}

// ─── Precio de referencia ────────────────────────────────────────────────────

/**
 * computeReferencePrice(stations, fuelType)
 * Precio de referencia = mediana de estaciones cercanas.
 */
function computeReferencePrice(stations, fuelType = 'diesel') {
  const prices = stations
    .map(s => s.precios?.[fuelType])
    .filter(p => p && p > 0)
    .sort((a, b) => a - b);

  if (prices.length === 0) return 1100;
  
  const mid = Math.floor(prices.length / 2);
  return prices.length % 2 === 0
    ? Math.round((prices[mid - 1] + prices[mid]) / 2)
    : prices[mid];
}

// ─── Integración principal ───────────────────────────────────────────────────

/**
 * getDecision(userProfile, context)
 * Función principal del pipeline.
 */
function getDecision(userProfile, context) {
  const {
    lat,
    lon,
    fuel_type = 'diesel',
    reference_price,
    is_urban_peak = false,
    toll_estimate = 0,
  } = context;

  // 1. Cargar estaciones
  const allStations = loadStations();
  if (allStations.length === 0) {
    return {
      mode: 3,
      recommendation: null,
      alternative: null,
      message: 'Sin datos de estaciones disponibles. El sistema se está inicializando.',
    };
  }

  // 2. Radio según contexto
  const radius = userProfile.context_type === 'cargo' ? 15000 : 5000;
  const nearby = getNearbyStations(lat, lon, allStations, radius);
  
  if (nearby.length === 0) {
    return {
      mode: 3,
      recommendation: null,
      alternative: null,
      message: 'No encontramos estaciones en tu zona.',
    };
  }

  // 3. Precio de referencia
  const refPrice = reference_price || computeReferencePrice(nearby, fuel_type);

  // 4. Preparar estaciones para engine
  const engineContext = {
    user_lat: lat,
    user_lon: lon,
    reference_price: refPrice,
    is_urban_peak,
    toll_estimate,
  };

  const engineStations = nearby
    .map(s => prepareForEngine(s, fuel_type))
    .filter(Boolean);

  if (engineStations.length === 0) {
    return {
      mode: 3,
      recommendation: null,
      alternative: null,
      message: `No encontramos estaciones con ${fuel_type} en tu zona.`,
    };
  }

  // 5. Decisión
  const result = engine.decide(userProfile, engineStations, engineContext);
  
  // Enriquecer resultado con datos adicionales si hay recomendación
  if (result.recommendation) {
    const originalStation = nearby.find(s => s.id === result.recommendation.station.id);
    if (originalStation) {
      result.recommendation.direccion = originalStation.direccion;
      result.recommendation.comuna = originalStation.comuna;
    }
  }
  
  if (result.alternative) {
    const originalStation = nearby.find(s => s.id === result.alternative.station.id);
    if (originalStation) {
      result.alternative.direccion = originalStation.direccion;
      result.alternative.comuna = originalStation.comuna;
    }
  }

  return result;
}

// ─── Estadísticas ────────────────────────────────────────────────────────────

/**
 * getDatasetStats()
 * Retorna estadísticas del dataset para monitoreo.
 */
function getDatasetStats() {
  const stations = loadStations();
  if (stations.length === 0) return { total: 0, fresh: 0, stale: 0, noDate: 0 };

  const now = Date.now();
  let fresh = 0, stale = 0, noDate = 0;

  stations.forEach(s => {
    if (!s.updated_at) { noDate++; return; }
    const ageH = (now - new Date(s.updated_at).getTime()) / 3600000;
    if (ageH < 24) fresh++;
    else stale++;
  });

  return {
    total: stations.length,
    fresh,
    stale,
    noDate,
    freshPct: Math.round((fresh / stations.length) * 100),
  };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  loadStations,
  getNearbyStations,
  prepareForEngine,
  getDecision,
  getDatasetStats,
  computeReferencePrice,
};