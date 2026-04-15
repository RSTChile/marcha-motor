/**
 * Marcha — Pipeline UNIFICADO v3.0
 * ✅ Usa comunas-stations.json (mapeo real 1,223 estaciones)
 * ✅ Caché inteligente de estaciones (TTL 5 min)
 * ✅ Fetch paralelo controlado (concurrencia 10)
 * ✅ Búsqueda por comuna O por proximidad geográfica
 * ✅ Logging detallado con timing
 */

const engine = require('./engine');
const fs = require('fs');
const path = require('path');

// =============================================
// CONFIGURACIÓN
// =============================================

const COMUNA_STATIONS_FILE = path.join(__dirname, '..', 'data', 'comunas-stations.json');
const API_BASE = 'https://api.bencinaenlinea.cl/api/estacion_ciudadano';
const FETCH_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos
const FETCH_BATCH_SIZE = 10;
const FETCH_BATCH_DELAY_MS = 100;
const MAX_RADIUS_M = 50000; // 50km
const MAX_NEARBY_COMUNAS = 5;

// =============================================
// CACHÉS
// =============================================

const stationsCache = new Map(); // id → { data, timestamp }
let comunasMapCache = null;

// =============================================
// CARGA Y CACHEO DEL MAPEO
// =============================================

function loadComunasMap() {
  if (comunasMapCache) return comunasMapCache;
  
  try {
    if (!fs.existsSync(COMUNA_STATIONS_FILE)) {
      console.error('[pipeline] ❌ comunas-stations.json no encontrado');
      return { meta: {}, comunas: {} };
    }
    
    const raw = JSON.parse(fs.readFileSync(COMUNA_STATIONS_FILE, 'utf8'));
    comunasMapCache = raw;
    console.log(`[pipeline] 📍 Mapeo cargado: ${raw.meta.total_comunas} comunas, ${raw.meta.total_stations} estaciones`);
    return raw;
  } catch (err) {
    console.error('[pipeline] ❌ Error cargando mapeo:', err.message);
    return { meta: {}, comunas: {} };
  }
}

// =============================================
// NORMALIZACIÓN Y BÚSQUEDA DE COMUNAS
// =============================================

function normalizeString(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function findComunaByName(nombreBuscado, comunasMap) {
  const normalized = normalizeString(nombreBuscado);
  
  for (const [key, value] of Object.entries(comunasMap)) {
    if (normalizeString(key) === normalized) {
      return { nombre: key, data: value };
    }
  }
  return null;
}

function findNearestComunas(userLat, userLon, comunasMap, maxDistance = MAX_RADIUS_M, limit = MAX_NEARBY_COMUNAS) {
  return Object.entries(comunasMap)
    .map(([nombre, info]) => ({
      nombre,
      region: info.region,
      lat: info.lat,
      lon: info.lon,
      stations: info.stations || [],
      dist: distanceMeters(userLat, userLon, info.lat, info.lon)
    }))
    .filter(c => c.dist <= maxDistance && c.stations.length > 0)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, limit);
}

// =============================================
// DISTANCIA (Haversine)
// =============================================

function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = deg => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) *
            Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// =============================================
// FETCH DE ESTACIÓN INDIVIDUAL (CON CACHÉ)
// =============================================

async function fetchStationById(id) {
  // Verificar caché
  const cached = stationsCache.get(id);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    
    const res = await fetch(`${API_BASE}/${id}`, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'Origin': 'https://www.bencinaenlinea.cl',
        'Referer': 'https://www.bencinaenlinea.cl/',
      }
    });
    
    clearTimeout(timeout);
    
    if (!res.ok) return null;
    
    const json = await res.json();
    const d = json?.data;
    
    if (!d?.latitud || !d?.longitud) return null;
    
    // Extraer precios disponibles
    const precios = {};
    for (const c of d.combustibles || []) {
      if (!c.precio) continue;
      if (c.nombre_corto === 'DI') precios.diesel = parseFloat(c.precio);
      if (c.nombre_corto === '93') precios.gas93 = parseFloat(c.precio);
      if (c.nombre_corto === '95') precios.gas95 = parseFloat(c.precio);
      if (c.nombre_corto === '97') precios.gas97 = parseFloat(c.precio);
    }
    
    if (Object.keys(precios).length === 0) return null;
    
    const station = {
      id: d.id,
      nombre: d.razon_social?.razon_social || 'Estación',
      marca: d.marca || 'NA',
      region: d.region || '',
      comuna: d.comuna || '',
      lat: parseFloat(d.latitud),
      lon: parseFloat(d.longitud),
      precios,
      fetched_at: Date.now()
    };
    
    // Guardar en caché
    stationsCache.set(id, { data: station, timestamp: Date.now() });
    return station;
    
  } catch (err) {
    return null;
  }
}

// =============================================
// FETCH MÚLTIPLES IDs (PARALELO CONTROLADO)
// =============================================

async function fetchStationsByIds(ids) {
  if (!ids.length) return [];
  
  console.log(`[pipeline] 🔄 Fetching ${ids.length} estaciones (batch: ${FETCH_BATCH_SIZE})...`);
  
  const results = [];
  let succeeded = 0;
  
  for (let i = 0; i < ids.length; i += FETCH_BATCH_SIZE) {
    const batch = ids.slice(i, i + FETCH_BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(id => fetchStationById(id)));
    
    for (const station of batchResults) {
      if (station) {
        results.push(station);
        succeeded++;
      }
    }
    
    // Pausa entre batches
    if (i + FETCH_BATCH_SIZE < ids.length) {
      await new Promise(r => setTimeout(r, FETCH_BATCH_DELAY_MS));
    }
  }
  
  console.log(`[pipeline] ✅ ${succeeded}/${ids.length} estaciones obtenidas`);
  return results;
}

// =============================================
// INFERIR TIPO DE ZONA
// =============================================

function inferZoneType(region) {
  if (!region) return 'semi';
  const r = region.toLowerCase();
  if (r.includes('metropolitana')) return 'urban';
  
  const semiUrban = ['valparaíso', 'coquimbo', 'biobío', 'maule', "o'higgins", 'araucanía', 'los lagos'];
  if (semiUrban.some(x => r.includes(x))) return 'semi';
  
  return 'rural';
}

// =============================================
// PREPARAR ESTACIÓN PARA EL MOTOR
// =============================================

function prepareStation(station, fuelType) {
  const price = station.precios[fuelType];
  if (!price || price <= 0) return null;
  
  const ageMinutes = Math.min(Math.round((Date.now() - station.fetched_at) / 60000), 60);
  
  return {
    id: station.id,
    nombre: station.nombre,
    marca: station.marca,
    lat: station.lat,
    lon: station.lon,
    precio_actual: price,
    precio_convenio: null,
    data_age_minutes: ageMinutes,
    report_count: 1,
    zone_type: inferZoneType(station.region),
    leaves_main_route: false,
  };
}

// =============================================
// CALCULAR PRECIO DE REFERENCIA
// =============================================

function calculateReferencePrice(stations) {
  const prices = stations
    .map(s => s.precio_actual)
    .filter(p => p && p > 0)
    .sort((a, b) => a - b);
  
  if (prices.length === 0) return 1500;
  
  const mid = Math.floor(prices.length / 2);
  return prices.length % 2 === 0 
    ? Math.round((prices[mid - 1] + prices[mid]) / 2) 
    : prices[mid];
}

// =============================================
// PIPELINE PRINCIPAL - UNIFICADO
// =============================================

async function runPipeline({ userProfile, context }) {
  const startTime = Date.now();
  
  try {
    console.log('[pipeline] 🚀 Iniciando...');
    
    const {
      user_lat,
      user_lon,
      fuel_type = 'diesel',
      comuna = null // ✅ Comuna es OPCIONAL
    } = context;
    
    // Validar coordenadas
    if (typeof user_lat !== 'number' || typeof user_lon !== 'number') {
      console.log('[pipeline] ❌ Coordenadas inválidas');
      return {
        mode: 3,
        recommendation: null,
        alternative: null,
        message: 'Ubicación inválida'
      };
    }
    
    // Cargar mapeo
    const mapData = loadComunasMap();
    const comunasMap = mapData.comunas || {};
    
    if (Object.keys(comunasMap).length === 0) {
      return {
        mode: 3,
        recommendation: null,
        alternative: null,
        message: 'Mapeo de comunas no disponible'
      };
    }
    
    let stationIds = [];
    let selectedComunas = [];
    
    // =============================================
    // MODO 1: Si se especifica comuna → usar esa
    // =============================================
    if (comuna) {
      console.log(`[pipeline] 🎯 Modo: Comuna específica "${comuna}"`);
      
      const found = findComunaByName(comuna, comunasMap);
      
      if (!found) {
        console.log(`[pipeline] ⚠️ Comuna "${comuna}" no encontrada`);
        return {
          mode: 3,
          recommendation: null,
          alternative: null,
          message: `No hay estaciones registradas para ${comuna}`
        };
      }
      
      stationIds = found.data.stations?.map(s => s.id) || [];
      selectedComunas = [{ nombre: found.nombre, data: found.data }];
      
      console.log(`[pipeline] 📍 ${found.nombre}: ${stationIds.length} estaciones`);
    }
    
    // =============================================
    // MODO 2: Si NO hay comuna → buscar por proximidad
    // =============================================
    else {
      console.log(`[pipeline] 🎯 Modo: Proximidad geográfica (${MAX_RADIUS_M / 1000}km)`);
      
      const nearby = findNearestComunas(user_lat, user_lon, comunasMap);
      
      if (!nearby.length) {
        console.log('[pipeline] ⚠️ Sin comunas cercanas');
        return {
          mode: 3,
          recommendation: null,
          alternative: null,
          message: 'Sin comunas cercanas'
        };
      }
      
      selectedComunas = nearby;
      for (const c of nearby) {
        stationIds.push(...(c.stations.map(s => s.id) || []));
      }
      
      const comunaNames = nearby.map(c => `${c.nombre} (${(c.dist / 1000).toFixed(1)}km)`).join(', ');
      console.log(`[pipeline] 📍 Comunas cercanas: ${comunaNames}`);
    }
    
    if (!stationIds.length) {
      return {
        mode: 3,
        recommendation: null,
        alternative: null,
        message: 'No hay estaciones disponibles'
      };
    }
    
    console.log(`[pipeline] 🎯 Total IDs a consultar: ${stationIds.length}`);
    
    // =============================================
    // FETCH DE ESTACIONES
    // =============================================
    const stations = await fetchStationsByIds(stationIds);
    
    if (!stations.length) {
      return {
        mode: 3,
        recommendation: null,
        alternative: null,
        message: 'Error consultando estaciones'
      };
    }
    
    // =============================================
    // CALCULAR DISTANCIA Y ORDENAR
    // =============================================
    const stationsWithDist = stations
      .map(s => ({
        ...s,
        dist: distanceMeters(user_lat, user_lon, s.lat, s.lon)
      }))
      .sort((a, b) => a.dist - b.dist);
    
    const nearest = stationsWithDist[0]?.dist || 0;
    console.log(`[pipeline] 📌 ${stationsWithDist.length} estaciones (cercana: ${(nearest / 1000).toFixed(1)}km)`);
    
    // =============================================
    // PREPARAR PARA EL MOTOR
    // =============================================
    let engineStations = stationsWithDist
      .map(s => prepareStation(s, fuel_type))
      .filter(Boolean);
    
    if (!engineStations.length) {
      // Fallback: usar cualquier combustible disponible
      engineStations = stationsWithDist.slice(0, 5).map(s => {
        const availableFuel = Object.keys(s.precios)[0];
        return {
          id: s.id,
          nombre: s.nombre,
          marca: s.marca,
          lat: s.lat,
          lon: s.lon,
          precio_actual: s.precios[availableFuel],
          precio_convenio: null,
          data_age_minutes: Math.min(Math.round((Date.now() - s.fetched_at) / 60000), 60),
          report_count: 1,
          zone_type: inferZoneType(s.region),
          leaves_main_route: false,
        };
      });
    }
    
    if (!engineStations.length) {
      return {
        mode: 3,
        recommendation: null,
        alternative: null,
        message: 'Sin estaciones utilizables'
      };
    }
    
    // =============================================
    // CALCULAR PRECIO DE REFERENCIA
    // =============================================
    const refPrice = calculateReferencePrice(engineStations);
    console.log(`[pipeline] 💹 Precio referencia: $${refPrice}`);
    
    // =============================================
    // EJECUTAR MOTOR DE DECISIÓN
    // =============================================
    const result = engine.decide(
      userProfile,
      engineStations,
      {
        user_lat,
        user_lon,
        reference_price: refPrice,
        is_urban_peak: context.is_urban_peak || false,
        toll_estimate: context.toll_estimate || 0
      }
    );
    
    const elapsed = Date.now() - startTime;
    console.log(`[pipeline] ✅ Mode: ${result.mode} | ${engineStations.length} estaciones | ${elapsed}ms`);
    
    return result;
    
  } catch (err) {
    console.error('[pipeline] 🔥 Error fatal:', err);
    return {
      mode: 3,
      recommendation: null,
      alternative: null,
      message: `Error: ${err.message}`
    };
  }
}

// =============================================
// EXPORTS
// =============================================

module.exports = {
  runPipeline,
  // Para debugging
  loadComunasMap,
  findComunaByName,
  findNearestComunas
};
