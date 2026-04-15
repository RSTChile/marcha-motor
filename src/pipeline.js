/**
 * Marcha — Pipeline EFICIENTE v4.0
 * Usa OpenRouteService para calcular distancia REAL por carretera
 * Sin lógica restrictiva. El motor decide.
 */

const engine = require('./engine');
const fs = require('fs');
const path = require('path');

const COMUNA_STATIONS_FILE = path.join(__dirname, '..', 'data', 'comunas-stations.json');
const FETCH_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutos para distancia real

// Precios mínimos realistas
const MIN_REALISTIC_PRICES = {
  diesel: 1200,
  gas93: 1200,
  gas95: 1250,
  gas97: 1300
};

// API Key de OpenRouteService
const ORS_API_KEY = '5b3ce3597851110001cf6248c9d8c8c5c8a84f2d8c8c8c8c8c8c8c8c';

const stationsCache = new Map(); // id → { data, timestamp }
const routeCache = new Map();    // `${from_lat},${from_lon}|${to_lat},${to_lon}` → { distance, timestamp }
let comunasMapCache = null;

// =============================================
// CARGA DEL MAPEO COMUNA → IDs
// =============================================

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

// =============================================
// DISTANCIA REAL POR CARRETERA (OpenRouteService)
// =============================================

async function getRealDistance(lat1, lon1, lat2, lon2) {
  const cacheKey = `${lat1.toFixed(4)},${lon1.toFixed(4)}|${lat2.toFixed(4)},${lon2.toFixed(4)}`;
  
  // Verificar caché de rutas
  const cached = routeCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
    return cached.distance;
  }
  
  const url = `https://api.openrouteservice.org/v2/directions/driving-car?start=${lon1},${lat1}&end=${lon2},${lat2}`;
  
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${ORS_API_KEY}`,
        'Content-Type': 'application/json'
      },
      signal: controller.signal
    });
    clearTimeout(timeout);
    
    if (!response.ok) {
      console.error(`[ORS] HTTP ${response.status}`);
      return null;
    }
    
    const routeData = await response.json();
    if (routeData.features && routeData.features[0] && routeData.features[0].properties.summary) {
      const distanceKm = routeData.features[0].properties.summary.distance / 1000;
      
      // Guardar en caché
      routeCache.set(cacheKey, { distance: distanceKm, timestamp: Date.now() });
      
      return distanceKm;
    }
    return null;
  } catch (err) {
    console.error('[ORS] Error:', err.message);
    return null;
  }
}

// =============================================
// CONSULTA A LA API POR ID
// =============================================

async function fetchStationById(id) {
  const cached = stationsCache.get(id);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
    return cached.data;
  }

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
    
    // Filtrar estaciones inactivas
    if (d.estado_bandera !== 1) {
      console.log(`[pipeline] 🚫 Excluyendo estación ${d.id}: inactiva`);
      return null;
    }
    
    // Extraer precios
    const precios = {
      diesel: null,
      gas93: null,
      gas95: null,
      gas97: null,
      kerosene: null
    };
    const preciosDetalle = [];
    
    for (const c of d.combustibles || []) {
      if (!c.precio) continue;
      const precioNum = Math.floor(parseFloat(c.precio));
      const tipo = c.nombre_corto;
      
      if (tipo === 'DI') precios.diesel = precioNum;
      if (tipo === '93') precios.gas93 = precioNum;
      if (tipo === '95') precios.gas95 = precioNum;
      if (tipo === '97') precios.gas97 = precioNum;
      if (tipo === 'KE') precios.kerosene = precioNum;
      
      preciosDetalle.push({
        tipo: c.nombre_largo || c.nombre_corto,
        precio: precioNum,
        unidad: c.unidad_cobro || '$/L',
        actualizado: c.actualizado || null
      });
    }
    
    const marcaNombre = getMarcaNombre(d.marca);
    
    const station = {
      id: d.id,
      nombre: marcaNombre,
      nombre_legal: d.razon_social?.razon_social || d.razon_social || 'Estación',
      marca: d.marca || 'NA',
      region: d.region || '',
      comuna: d.comuna || '',
      direccion: d.direccion || '',
      lat: parseFloat(d.latitud),
      lon: parseFloat(d.longitud),
      precios,
      precios_detalle: preciosDetalle,
      servicios: d.servicios || [],
      metodos_pago: d.metodos_pago || [],
      horario_atencion: d.horario_atencion || [],
      fetched_at: Date.now()
    };
    
    stationsCache.set(id, { data: station, timestamp: Date.now() });
    return station;
    
  } catch (err) {
    console.error(`[pipeline] Error fetching station ${id}:`, err.message);
    return null;
  }
}

function getMarcaNombre(marcaId) {
  const marcas = {
    1: 'Copec', 2: 'Shell', 3: 'Petrobras', 4: 'ENEX', 5: 'Copec',
    10: 'Shell', 15: 'Petrobras', 23: 'Abastible', 24: 'Lipigas',
    151: 'Esmax', 177: 'Autogasco'
  };
  return marcas[marcaId] || 'Estación';
}

// =============================================
// CONSULTAR MÚLTIPLES ESTACIONES
// =============================================

async function fetchStationsByIds(ids) {
  console.log(`[pipeline] 🔄 Consultando ${ids.length} estaciones...`);
  
  const batchSize = 10;
  const results = [];
  
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(id => fetchStationById(id)));
    results.push(...batchResults.filter(Boolean));
    if (i + batchSize < ids.length) await new Promise(r => setTimeout(r, 100));
  }
  
  console.log(`[pipeline] ✅ ${results.length} estaciones obtenidas`);
  return results;
}

// =============================================
// DISTANCIA EN LÍNEA RECTA (Haversine) - FALLBACK
// =============================================

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1 * Math.PI / 180) *
            Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
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

function prepareStation(station, fuelType, realDistanceKm) {
  let price = null;
  let selectedFuel = null;
  let minPrice = MIN_REALISTIC_PRICES[fuelType] || 1200;
  
  if (fuelType === 'diesel') {
    price = station.precios.diesel;
    selectedFuel = 'Diesel';
  } else if (fuelType === 'gas93') {
    price = station.precios.gas93;
    selectedFuel = 'Gasolina 93';
  } else if (fuelType === 'gas95') {
    price = station.precios.gas95;
    selectedFuel = 'Gasolina 95';
  } else if (fuelType === 'gas97') {
    price = station.precios.gas97;
    selectedFuel = 'Gasolina 97';
  }
  
  // Filtrar precios irrealmente bajos
  if (price && price < minPrice) {
    console.log(`[pipeline] ⚠️ Excluyendo ${station.nombre}: ${selectedFuel} = $${price} (mínimo $${minPrice})`);
    return null;
  }
  
  if (!price || price <= 0) {
    return null;
  }
  
  const ageMinutes = Math.min(Math.round((Date.now() - station.fetched_at) / 60000), 60);
  
  // Convertir distancia real de km a metros (el motor espera metros)
  const distanceMeters = realDistanceKm * 1000;
  
  console.log(`[pipeline] 📊 ${station.nombre} (${station.comuna}): ${selectedFuel}=$${price}, distancia_real=${realDistanceKm.toFixed(1)}km`);
  
  return {
    id: station.id,
    nombre: station.nombre,
    nombre_legal: station.nombre_legal,
    direccion: station.direccion,
    comuna: station.comuna,
    marca: station.marca,
    lat: station.lat,
    lon: station.lon,
    precio_actual: price,
    precios_detalle: station.precios_detalle,
    servicios: station.servicios,
    metodos_pago: station.metodos_pago,
    precio_convenio: null,
    data_age_minutes: ageMinutes,
    report_count: 1,
    zone_type: inferZoneType(station.region),
    leaves_main_route: false, // El motor usa la distancia real, no necesita esta bandera
    _real_distance_km: realDistanceKm,
    _distance_meters: distanceMeters
  };
}

// =============================================
// CALCULAR PRECIO DE REFERENCIA
// =============================================

function calculateReferencePrice(engineStations) {
  const prices = engineStations.map(s => s.precio_actual).filter(p => p > 0).sort((a, b) => a - b);
  if (prices.length === 0) return 1500;
  const mid = Math.floor(prices.length / 2);
  return prices.length % 2 === 0 ? Math.round((prices[mid - 1] + prices[mid]) / 2) : prices[mid];
}

// =============================================
// PIPELINE PRINCIPAL
// =============================================

async function runPipeline({ userProfile, context }) {
  const startTime = Date.now();
  
  try {
    console.log('[pipeline] 🚀 Iniciando...');
    
    const { user_lat, user_lon, fuel_type = 'diesel', comuna } = context;
    
    if (typeof user_lat !== 'number' || typeof user_lon !== 'number') {
      console.log('[pipeline] ❌ Coordenadas inválidas');
      return { mode: 3, recommendation: null, alternative: null, message: 'Ubicación inválida' };
    }
    
    if (!comuna) {
      console.log('[pipeline] ❌ No se recibió comuna');
      return { mode: 3, recommendation: null, alternative: null, message: 'Selecciona una comuna válida' };
    }
    
    const comunaMap = loadComunaStationsMap();
    
    const comunaNormalized = comuna.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    let comunaData = null;
    let comunaOriginal = null;
    
    for (const [key, value] of Object.entries(comunaMap)) {
      const keyNormalized = key.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      if (keyNormalized === comunaNormalized) {
        comunaData = value;
        comunaOriginal = key;
        break;
      }
    }
    
    if (!comunaData) {
      console.log(`[pipeline] ⚠️ Comuna "${comuna}" no encontrada`);
      return { mode: 3, recommendation: null, alternative: null, message: `No hay estaciones para ${comuna}` };
    }
    
    const stationIds = comunaData.stations?.map(s => s.id) || [];
    
    if (stationIds.length === 0) {
      return { mode: 3, recommendation: null, alternative: null, message: `No hay estaciones para ${comuna}` };
    }
    
    console.log(`[pipeline] 📍 Comuna: ${comunaOriginal}, IDs: ${stationIds.length} estaciones`);
    
    const stations = await fetchStationsByIds(stationIds);
    
    if (stations.length === 0) {
      return { mode: 3, recommendation: null, alternative: null, message: 'No se encontraron estaciones' };
    }
    
    // Calcular distancia REAL por carretera para cada estación
    console.log(`[pipeline] 🗺️ Calculando distancias reales por carretera...`);
    
    const stationsWithRealDist = [];
    
    for (const station of stations) {
      const realDist = await getRealDistance(user_lat, user_lon, station.lat, station.lon);
      
      let finalDist = realDist;
      let isEstimated = false;
      
      if (realDist === null) {
        // Fallback a distancia en línea recta si ORS falla
        finalDist = haversineDistance(user_lat, user_lon, station.lat, station.lon);
        isEstimated = true;
        console.log(`[pipeline] ⚠️ ORS falló para ${station.nombre}, usando línea recta: ${finalDist.toFixed(1)}km`);
      }
      
      stationsWithRealDist.push({
        ...station,
        _real_distance_km: finalDist,
        _is_estimated: isEstimated
      });
      
      // Pequeña pausa para no saturar la API
      await new Promise(r => setTimeout(r, 200));
    }
    
    // Ordenar por distancia real
    stationsWithRealDist.sort((a, b) => a._real_distance_km - b._real_distance_km);
    
    console.log(`[pipeline] 📌 ${stationsWithRealDist.length} estaciones (más cercana: ${stationsWithRealDist[0]?._real_distance_km.toFixed(1)}km)`);
    
    // Preparar estaciones para el motor
    const engineStations = stationsWithRealDist
      .map(s => prepareStation(s, fuel_type, s._real_distance_km))
      .filter(Boolean);
    
    console.log(`[pipeline] 🔍 Estaciones con ${fuel_type}: ${engineStations.length}`);
    
    if (engineStations.length === 0) {
      return { mode: 3, recommendation: null, alternative: null, message: `No hay estaciones con ${fuel_type} en ${comuna}` };
    }
    
    const refPrice = calculateReferencePrice(engineStations);
    console.log(`[pipeline] 💹 Precio referencia: $${refPrice}`);
    
    // Ejecutar motor
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
    
    // Enriquecer resultado con datos completos
    if (result.recommendation && result.recommendation.station && result.recommendation.station.id) {
      const stationId = result.recommendation.station.id;
      const originalStation = stationsWithRealDist.find(s => s.id === stationId);
      
      if (originalStation) {
        let correctPrice = null;
        if (fuel_type === 'diesel') correctPrice = originalStation.precios.diesel;
        else if (fuel_type === 'gas93') correctPrice = originalStation.precios.gas93;
        else if (fuel_type === 'gas95') correctPrice = originalStation.precios.gas95;
        else if (fuel_type === 'gas97') correctPrice = originalStation.precios.gas97;
        
        if (correctPrice && correctPrice > 0) {
          result.recommendation.display_price = correctPrice;
          const liters = result.recommendation.display_liters || 0;
          result.recommendation.display_total_cost = Math.floor(correctPrice * liters);
        }
        
        // Asegurar que la distancia sea la real
        result.recommendation.display_distance_km = originalStation._real_distance_km;
        
        result.recommendation.station = {
          ...result.recommendation.station,
          nombre: originalStation.nombre,
          direccion: originalStation.direccion,
          comuna: originalStation.comuna,
          precios_detalle: originalStation.precios_detalle
        };
      }
    }
    
    if (result.alternative && result.alternative.station && result.alternative.station.id) {
      const stationId = result.alternative.station.id;
      const originalStation = stationsWithRealDist.find(s => s.id === stationId);
      if (originalStation) {
        result.alternative.display_distance_km = originalStation._real_distance_km;
      }
    }
    
    if (result.recommendation && result.recommendation.net_saving) {
      result.recommendation.net_saving = Math.floor(result.recommendation.net_saving);
    }
    if (result.alternative && result.alternative.net_saving) {
      result.alternative.net_saving = Math.floor(result.alternative.net_saving);
    }
    
    const elapsed = Date.now() - startTime;
    console.log(`[pipeline] ✅ Motor respondió mode: ${result.mode} (${elapsed}ms)`);
    return result;
    
  } catch (err) {
    console.error('[pipeline] 🔥 Error fatal:', err);
    return { mode: 3, recommendation: null, alternative: null, message: `Error: ${err.message}` };
  }
}

module.exports = { runPipeline };
