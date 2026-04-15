/**
 * Marcha — Pipeline v4.1
 * Correciones aplicadas:
 *   - ORS: API key en URL (corrige error 403)
 *   - Enriquecimiento: usa station_id (no station.id) para compatibilidad con engine v0.4
 *   - Alternativa: siempre se incluye si existe segunda estación, aunque ahorro sea bajo
 */

const engine = require('./engine');
const fs = require('fs');
const path = require('path');

const COMUNA_STATIONS_FILE = path.join(__dirname, '..', 'data', 'comunas-stations.json');
const FETCH_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutos

const MIN_REALISTIC_PRICES = {
  diesel:  1200,
  gas93:   1200,
  gas95:   1250,
  gas97:   1300
};

// ⚠️ Reemplaza con tu API key activa de openrouteservice.org
const ORS_API_KEY = '5b3ce3597851110001cf6248c9d8c8c5c8a84f2d8c8c8c8c8c8c8c8c';

const stationsCache  = new Map();
const routeCache     = new Map();
let   comunasMapCache = null;

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
// API key en la URL — corrige error 403
// =============================================

async function getRealDistance(lat1, lon1, lat2, lon2) {
  const cacheKey = `${lat1.toFixed(4)},${lon1.toFixed(4)}|${lat2.toFixed(4)},${lon2.toFixed(4)}`;

  const cached = routeCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
    return cached.distance;
  }

  // API key en la URL (más compatible con ORS v2)
  const url = `https://api.openrouteservice.org/v2/directions/driving-car?api_key=${ORS_API_KEY}&start=${lon1},${lat1}&end=${lon2},${lat2}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!response.ok) {
      console.error(`[ORS] HTTP ${response.status}: ${response.statusText}`);
      return null;
    }

    const routeData = await response.json();
    if (routeData.features?.[0]?.properties?.summary) {
      const distanceKm = routeData.features[0].properties.summary.distance / 1000;
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
// DISTANCIA EN LÍNEA RECTA (Haversine) — FALLBACK
// =============================================

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) *
            Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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

    if (d.estado_bandera !== 1) {
      console.log(`[pipeline] 🚫 Excluyendo estación ${d.id}: inactiva`);
      return null;
    }

    const precios = { diesel: null, gas93: null, gas95: null, gas97: null, kerosene: null };
    const preciosDetalle = [];

    for (const c of d.combustibles || []) {
      if (!c.precio) continue;
      const precioNum = Math.floor(parseFloat(c.precio));
      const tipo = c.nombre_corto;
      if (tipo === 'DI') precios.diesel  = precioNum;
      if (tipo === '93') precios.gas93   = precioNum;
      if (tipo === '95') precios.gas95   = precioNum;
      if (tipo === '97') precios.gas97   = precioNum;
      if (tipo === 'KE') precios.kerosene = precioNum;
      preciosDetalle.push({
        tipo:       c.nombre_largo || c.nombre_corto,
        precio:     precioNum,
        unidad:     c.unidad_cobro || '$/L',
        actualizado: c.actualizado || null
      });
    }

    const station = {
      id:              d.id,
      nombre:          getMarcaNombre(d.marca),
      nombre_legal:    d.razon_social?.razon_social || d.razon_social || 'Estación',
      marca:           d.marca || 'NA',
      region:          d.region || '',
      comuna:          d.comuna || '',
      direccion:       d.direccion || '',
      lat:             parseFloat(d.latitud),
      lon:             parseFloat(d.longitud),
      precios,
      precios_detalle: preciosDetalle,
      servicios:       d.servicios || [],
      metodos_pago:    d.metodos_pago || [],
      fetched_at:      Date.now()
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
  const results   = [];

  for (let i = 0; i < ids.length; i += batchSize) {
    const batch        = ids.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(id => fetchStationById(id)));
    results.push(...batchResults.filter(Boolean));
    if (i + batchSize < ids.length) await new Promise(r => setTimeout(r, 100));
  }

  console.log(`[pipeline] ✅ ${results.length} estaciones obtenidas`);
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

function prepareStation(station, fuelType, realDistanceKm) {
  const fuelMap = {
    diesel: 'diesel', gas93: 'gas93', gas95: 'gas95', gas97: 'gas97'
  };
  const fuelLabels = {
    diesel: 'Diesel', gas93: 'Gasolina 93', gas95: 'Gasolina 95', gas97: 'Gasolina 97'
  };

  const price = station.precios[fuelType];
  const minPrice = MIN_REALISTIC_PRICES[fuelType] || 1200;

  if (!price || price <= 0) return null;

  if (price < minPrice) {
    console.log(`[pipeline] ⚠️ Excluyendo ${station.nombre}: ${fuelLabels[fuelType]} = $${price} (mínimo $${minPrice})`);
    return null;
  }

  const ageMinutes = Math.min(Math.round((Date.now() - station.fetched_at) / 60000), 60);

  console.log(`[pipeline] 📊 ${station.nombre} (${station.comuna}): ${fuelLabels[fuelType]}=$${price}, distancia_real=${realDistanceKm.toFixed(1)}km`);

  return {
    id:                station.id,
    nombre:            station.nombre,
    nombre_legal:      station.nombre_legal,
    direccion:         station.direccion,
    comuna:            station.comuna,
    marca:             station.marca,
    lat:               station.lat,
    lon:               station.lon,
    precio_actual:     price,
    precios_detalle:   station.precios_detalle,
    servicios:         station.servicios,
    metodos_pago:      station.metodos_pago,
    precio_convenio:   null,
    data:              { ageminutes: ageMinutes, reportcount: 1 },
    zone_type:         inferZoneType(station.region),
    leaves_main_route: false,
    _real_distance_km: realDistanceKm,
  };
}

// =============================================
// PRECIO DE REFERENCIA (mediana)
// =============================================

function calculateReferencePrice(engineStations) {
  const prices = engineStations.map(s => s.precio_actual).filter(p => p > 0).sort((a, b) => a - b);
  if (prices.length === 0) return 1500;
  const mid = Math.floor(prices.length / 2);
  return prices.length % 2 === 0
    ? Math.round((prices[mid - 1] + prices[mid]) / 2)
    : prices[mid];
}

// =============================================
// ENRIQUECER RESULTADO DEL MOTOR
// Usa station_id (no station.id) — corrección crítica
// v4.1: enriquece también alternatives[]
// =============================================

function buildStationObj(original) {
  return {
    id:              original.id,
    nombre:          original.nombre,
    nombre_legal:    original.nombre_legal,
    direccion:       original.direccion,
    comuna:          original.comuna,
    marca:           original.marca,
    precios_detalle: original.precios_detalle,
    servicios:       original.servicios,
    metodos_pago:    original.metodos_pago,
  };
}

function enrichOne(scored, stationsWithRealDist, fuelType) {
  if (!scored) return scored;
  const original = stationsWithRealDist.find(s => s.id === scored.station_id);
  if (original) {
    const correctPrice = original.precios[fuelType];
    if (correctPrice && correctPrice > 0) {
      scored.display_price      = correctPrice;
      const liters = scored.display_liters || 0;
      scored.display_total_cost = Math.floor(correctPrice * liters);
    }
    scored.display_distance_km = original._real_distance_km;
    scored.station = buildStationObj(original);
  }
  if (scored.net_saving) scored.net_saving = Math.floor(scored.net_saving);
  return scored;
}

function enrichResult(result, stationsWithRealDist, fuelType) {
  result.recommendation = enrichOne(result.recommendation, stationsWithRealDist, fuelType);

  // Enriquecer alternatives[] (v0.5 engine)
  if (Array.isArray(result.alternatives)) {
    result.alternatives = result.alternatives.map(a => enrichOne(a, stationsWithRealDist, fuelType));
  }

  // Compatibilidad: mantener result.alternative apuntando a alternatives[0]
  result.alternative = result.alternatives?.[0] || null;

  return result;
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
      return { mode: 3, recommendation: null, alternative: null, message: 'Ubicación inválida' };
    }
    if (!comuna) {
      return { mode: 3, recommendation: null, alternative: null, message: 'Selecciona una comuna válida' };
    }

    // Cargar mapa de comunas
    const comunaMap = loadComunaStationsMap();

    // Normalizar nombre de comuna (sin tildes, case-insensitive)
    const comunaNorm = comuna.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    let comunaData    = null;
    let comunaOriginal = null;

    for (const [key, value] of Object.entries(comunaMap)) {
      const keyNorm = key.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (keyNorm.toLowerCase() === comunaNorm.toLowerCase()) {
        comunaData     = value;
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

    // Obtener datos de estaciones desde API
    const stations = await fetchStationsByIds(stationIds);
    if (stations.length === 0) {
      return { mode: 3, recommendation: null, alternative: null, message: 'No se encontraron estaciones' };
    }

    // Calcular distancias reales por carretera (con fallback a Haversine)
    console.log('[pipeline] 🗺️ Calculando distancias reales por carretera...');

    const stationsWithRealDist = [];
    for (const station of stations) {
      const realDist = await getRealDistance(user_lat, user_lon, station.lat, station.lon);

      let finalDist   = realDist;
      let isEstimated = false;

      if (realDist === null) {
        finalDist   = haversineDistance(user_lat, user_lon, station.lat, station.lon);
        isEstimated = true;
        console.log(`[pipeline] ⚠️ ORS falló para ${station.nombre}, usando línea recta: ${finalDist.toFixed(1)}km`);
      }

      stationsWithRealDist.push({ ...station, _real_distance_km: finalDist, _is_estimated: isEstimated });
      await new Promise(r => setTimeout(r, 200));
    }

    stationsWithRealDist.sort((a, b) => a._real_distance_km - b._real_distance_km);
    console.log(`[pipeline] 📌 ${stationsWithRealDist.length} estaciones (más cercana: ${stationsWithRealDist[0]?._real_distance_km.toFixed(1)}km)`);

    // Preparar estaciones para el motor
    const engineStations = stationsWithRealDist
      .map(s => prepareStation(s, fuel_type, s._real_distance_km))
      .filter(Boolean);

    console.log(`[pipeline] 🔍 Estaciones con ${fuel_type}: ${engineStations.length}`);

    if (engineStations.length === 0) {
      return { mode: 3, recommendation: null, alternative: null, message: `No hay estaciones con ${fuel_type} en ${comunaOriginal}` };
    }

    // Precio de referencia
    const refPrice = calculateReferencePrice(engineStations);
    console.log(`[pipeline] 💹 Precio referencia: $${refPrice}`);

    // Llamar al motor
    const result = engine.decide(
      userProfile,
      engineStations,
      {
        user_lat,
        user_lon,
        reference_price:  refPrice,
        is_urban_peak:    context.is_urban_peak  || false,
        toll_estimate:    context.toll_estimate  || 0,
      }
    );

    // Enriquecer con datos originales (nombre, dirección, precios detalle)
    const enriched = enrichResult(result, stationsWithRealDist, fuel_type);

    const elapsed = Date.now() - startTime;
    console.log(`[pipeline] ✅ Motor respondió mode: ${enriched.mode} (${elapsed}ms)`);
    return enriched;

  } catch (err) {
    console.error('[pipeline] 🔥 Error fatal:', err);
    return { mode: 3, recommendation: null, alternative: null, message: `Error interno: ${err.message}` };
  }
}
function getNearbyStations(comunaData) {
  const mainIds = comunaData.stations?.map(s
module.exports = { runPipeline };
