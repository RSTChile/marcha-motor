const engine = require('./engine');

// 🔧 CONFIGURACIÓN
const ID_START = 1400;
const ID_END = 1900;
const MAX_CONCURRENT = 8;
const FETCH_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 300000; // 5 minutos

// 🔒 CACHÉ GLOBAL
let stationCache = {
  data: [],
  timestamp: 0
};

// =============================================
// CACHÉ UTILITIES
// =============================================

function isCacheValid() {
  const isValid = (Date.now() - stationCache.timestamp) < CACHE_TTL_MS;
  if (isValid) {
    console.log(`[pipeline] 📦 Caché válido (${Math.round((CACHE_TTL_MS - (Date.now() - stationCache.timestamp)) / 1000)}s restantes)`);
  }
  return isValid;
}

function setCacheData(data) {
  stationCache = {
    data,
    timestamp: Date.now()
  };
  console.log(`[pipeline] 💾 Caché actualizado con ${data.length} estaciones`);
}

// =============================================
// FETCH ESTACIÓN (TIEMPO REAL)
// =============================================

async function fetchStation(id) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch(
      `https://api.bencinaenlinea.cl/api/estacion_ciudadano/${id}`,
      {
        signal: controller.signal,
        headers: {
          'Accept': 'application/json',
          'Origin': 'https://www.bencinaenlinea.cl',
          'Referer': 'https://www.bencinaenlinea.cl/',
        }
      }
    );

    clearTimeout(timeout);

    if (!res.ok) return null;

    const json = await res.json();
    const d = json?.data;

    if (!d?.latitud || !d?.longitud) return null;

    const precios = {};

    for (const c of d.combustibles || []) {
      if (!c.precio) continue;

      if (c.nombre_corto === 'DI') precios.diesel = parseFloat(c.precio);
      if (c.nombre_corto === '93') precios.gas93 = parseFloat(c.precio);
      if (c.nombre_corto === '95') precios.gas95 = parseFloat(c.precio);
      if (c.nombre_corto === '97') precios.gas97 = parseFloat(c.precio);
    }

    if (Object.keys(precios).length === 0) return null;

    return {
      id: d.id,
      nombre: d.razon_social?.razon_social || 'Estación',
      marca: d.marca || 'NA',
      region: d.region || '',
      lat: parseFloat(d.latitud),
      lon: parseFloat(d.longitud),
      precios,
      fetched_at: Date.now()
    };

  } catch (err) {
    return null;
  }
}

// =============================================
// DISTANCIA
// =============================================

function distanceMeters(lat1, lon1, lat2, lon2) {
  return engine.distanceMeters(lat1, lon1, lat2, lon2);
}

// =============================================
// FETCH CONCURRENTE CON PROGRESO
// =============================================

async function fetchStationsBatch() {
  console.log('[pipeline] 🔄 Iniciando fetch de estaciones...');
  
  const ids = [];
  for (let i = ID_START; i <= ID_END; i++) ids.push(i);

  const results = [];
  const totalBatches = Math.ceil(ids.length / MAX_CONCURRENT);

  for (let i = 0; i < ids.length; i += MAX_CONCURRENT) {
    const batchNum = Math.floor(i / MAX_CONCURRENT) + 1;
    const chunk = ids.slice(i, i + MAX_CONCURRENT);

    const batch = await Promise.all(
      chunk.map(id => fetchStation(id))
    );

    const valid = batch.filter(Boolean);
    results.push(...valid);

    const progress = Math.round((batchNum / totalBatches) * 100);
    console.log(`[pipeline] Batch ${batchNum}/${totalBatches} (${progress}%) - ${results.length} estaciones`);
  }

  console.log(`[pipeline] ✅ Fetch completado: ${results.length} estaciones`);
  return results;
}

// =============================================
// INFERIR ZONA DESDE REGIÓN
// =============================================

function inferZoneType(region) {
  if (!region) return 'semi';
  
  if (region.toLowerCase().includes('metropolitana')) return 'urban';
  
  const semiUrban = ['valparaíso', 'coquimbo', 'biobío', 'maule', "o'higgins", 'araucanía', 'los lagos'];
  if (semiUrban.some(r => region.toLowerCase().includes(r))) return 'semi';
  
  return 'rural';
}

// =============================================
// CALCULAR PRECIO REFERENCIA
// =============================================

function calculateReferencePrice(stations) {
  const allPrices = [];
  
  for (const s of stations) {
    for (const [fuel, price] of Object.entries(s.precios)) {
      if (price && price > 0) {
        allPrices.push(price);
      }
    }
  }

  if (allPrices.length === 0) return 1500; // fallback

  allPrices.sort((a, b) => a - b);
  const mid = Math.floor(allPrices.length / 2);
  
  // Retornar mediana
  return allPrices.length % 2 !== 0 
    ? allPrices[mid]
    : Math.round((allPrices[mid - 1] + allPrices[mid]) / 2);
}

// =============================================
// FILTRO GEOGRÁFICO
// =============================================

function getNearby(stations, lat, lon, radiusMeters) {
  return stations
    .map(s => ({
      ...s,
      dist: distanceMeters(lat, lon, s.lat, s.lon)
    }))
    .filter(s => s.dist <= radiusMeters)
    .sort((a, b) => a.dist - b.dist);
}

// =============================================
// PREPARAR PARA ENGINE
// =============================================

function prepareStation(station, fuelType) {
  const price = station.precios[fuelType];
  if (!price || price <= 0) return null;

  const ageMinutes = Math.round((Date.now() - station.fetched_at) / 60000);

  return {
    id: station.id,
    nombre: station.nombre,
    marca: station.marca,
    lat: station.lat,
    lon: station.lon,
    precio_actual: price,
    precio_convenio: null,
    data_age_minutes: Math.min(ageMinutes, 60), // max 60 min
    report_count: 1,
    zone_type: inferZoneType(station.region),
    leaves_main_route: false,
  };
}

// =============================================
// PIPELINE PRINCIPAL
// =============================================

async function runPipeline({ userProfile, context }) {
  try {
    console.log('[pipeline] 🚀 runPipeline iniciado');

    const {
      user_lat,
      user_lon,
      fuel_type = 'diesel'
    } = context;

    // Validar entrada
    if (typeof user_lat !== 'number' || typeof user_lon !== 'number') {
      console.log('[pipeline] ❌ Coordenadas inválidas');
      return {
        mode: 3,
        recommendation: null,
        alternative: null,
        message: 'Ubicación inválida'
      };
    }

    // 🔥 1. Obtener estaciones (con caché)
    let allStations;
    
    if (isCacheValid()) {
      allStations = stationCache.data;
    } else {
      console.log('[pipeline] ⏳ Caché expirado, fetching nueva data...');
      allStations = await fetchStationsBatch();
      
      if (allStations.length === 0) {
        return {
          mode: 3,
          recommendation: null,
          alternative: null,
          message: 'No hay datos disponibles en este momento'
        };
      }
      
      setCacheData(allStations);
    }

    console.log(`[pipeline] 📍 Buscando estaciones cerca de (${user_lat}, ${user_lon})`);

    // 🔥 2. Filtro cercano (30km)
    let nearby = getNearby(allStations, user_lat, user_lon, 30000);

    // 🔥 3. Fallback sin cercanas
    if (!nearby.length) {
      console.log('[pipeline] ⚠️ Sin estaciones en 30km, usando fallback');
      nearby = allStations
        .map(s => ({
          ...s,
          dist: distanceMeters(user_lat, user_lon, s.lat, s.lon)
        }))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 10);
    }

    console.log(`[pipeline] 📌 ${nearby.length} estaciones cercanas`);

    // 🔥 4. Preparar para engine
    let engineStations = nearby
      .map(s => prepareStation(s, fuel_type))
      .filter(Boolean);

    // 🔥 5. Fallback combustible
    if (!engineStations.length) {
      console.log(`[pipeline] ⚠️ Sin ${fuel_type}, usando cualquier combustible`);
      engineStations = nearby.slice(0, 3).map(s => {
        const firstFuel = Object.keys(s.precios)[0];
        return {
          id: s.id,
          nombre: s.nombre,
          marca: s.marca,
          lat: s.lat,
          lon: s.lon,
          precio_actual: s.precios[firstFuel],
          precio_convenio: null,
          data_age_minutes: Math.round((Date.now() - s.fetched_at) / 60000),
          report_count: 1,
          zone_type: inferZoneType(s.region),
          leaves_main_route: false,
        };
      });
    }

    // 🔒 Garantía
    if (!engineStations || engineStations.length === 0) {
      console.log('[pipeline] ❌ Sin estaciones utilizables');
      return {
        mode: 3,
        recommendation: null,
        alternative: null,
        message: 'No hay estaciones disponibles'
      };
    }

    // Calcular precio referencia dinámicamente
    const refPrice = calculateReferencePrice(engineStations);
    console.log(`[pipeline] 💹 Precio referencia calculado: $${refPrice}`);

    // 🔥 6. DECISIÓN (PARÁMETROS CORRECTOS)
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

    console.log(`[pipeline] ✅ Motor respondió con mode: ${result.mode}`);
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

module.exports = {
  runPipeline,
  // Para testing/debug
  fetchStationsBatch,
  getNearby,
  prepareStation,
  calculateReferencePrice,
  clearCache: () => {
    stationCache = { data: [], timestamp: 0 };
    console.log('[pipeline] 🗑️ Caché limpiado');
  }
};
