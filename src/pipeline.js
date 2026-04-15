/**
 * Marcha — Pipeline EFICIENTE v3.0
 * Devuelve datos completos de estaciones (nombre, dirección, precios)
 * CORREGIDO: asegura que solo se usen estaciones con el combustible seleccionado
 */

const engine = require('./engine');
const fs = require('fs');
const path = require('path');

const COMUNA_STATIONS_FILE = path.join(__dirname, '..', 'data', 'comunas-stations.json');
const FETCH_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 5 * 60 * 1000;

const stationsCache = new Map();
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
    
    // Extraer precios (redondeados a entero)
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
    
    // Obtener nombre comercial de la marca
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
// DISTANCIA (Haversine)
// =============================================

function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = deg => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(lat1)) *
            Math.cos(toRad(lat2)) *
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
// PREPARAR ESTACIÓN PARA EL MOTOR (SOLO COMBUSTIBLE SOLICITADO)
// =============================================

function prepareStation(station, fuelType) {
  // Seleccionar el precio correcto según el tipo de combustible
  let price = null;
  let selectedFuel = null;
  
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
  
  // Si la estación NO tiene el combustible solicitado, retornar null
  if (!price || price <= 0) {
    return null;
  }
  
  const ageMinutes = Math.min(Math.round((Date.now() - station.fetched_at) / 60000), 60);
  
  // Log para depuración
  console.log(`[pipeline] 📊 Estación ${station.nombre}: ${selectedFuel} = $${price}`);
  
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
    leaves_main_route: false,
    fuel_type: selectedFuel
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
    
    // Buscar la comuna (normalizando nombres)
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
      console.log(`[pipeline] ⚠️ Comuna "${comuna}" no encontrada en el mapeo`);
      return { mode: 3, recommendation: null, alternative: null, message: `No hay estaciones registradas para ${comuna}` };
    }
    
    const stationIds = comunaData.stations?.map(s => s.id) || [];
    
    if (stationIds.length === 0) {
      return { mode: 3, recommendation: null, alternative: null, message: `No hay estaciones registradas para ${comuna}` };
    }
    
    console.log(`[pipeline] 📍 Comuna: ${comunaOriginal}, IDs: ${stationIds.length} estaciones`);
    
    const stations = await fetchStationsByIds(stationIds);
    
    if (stations.length === 0) {
      return { mode: 3, recommendation: null, alternative: null, message: 'No se encontraron estaciones' };
    }
    
    // Calcular distancia
    const stationsWithDist = stations.map(s => ({
      ...s,
      dist: distanceMeters(user_lat, user_lon, s.lat, s.lon)
    })).sort((a, b) => a.dist - b.dist);
    
    console.log(`[pipeline] 📌 ${stationsWithDist.length} estaciones encontradas`);
    
    // Preparar estaciones para el motor (solo las que tienen el combustible solicitado)
    let engineStations = stationsWithDist
      .map(s => prepareStation(s, fuel_type))
      .filter(Boolean);
    
    console.log(`[pipeline] 🔍 Estaciones con ${fuel_type}: ${engineStations.length}`);
    
    if (engineStations.length === 0) {
      return { mode: 3, recommendation: null, alternative: null, message: `No hay estaciones con ${fuel_type} en ${comuna}. Prueba con otro combustible.` };
    }
    
    // Calcular precio de referencia
    const refPrice = calculateReferencePrice(engineStations);
    console.log(`[pipeline] 💹 Precio referencia para ${fuel_type}: $${refPrice}`);
    
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
    
    // Asegurar que el display_price de la recomendación sea correcto
    if (result.recommendation && result.recommendation.station) {
      const stationData = stationsWithDist.find(s => s.id === result.recommendation.station.id);
      if (stationData) {
        // Obtener el precio correcto del combustible
        let correctPrice = null;
        if (fuel_type === 'diesel') correctPrice = stationData.precios.diesel;
        else if (fuel_type === 'gas93') correctPrice = stationData.precios.gas93;
        else if (fuel_type === 'gas95') correctPrice = stationData.precios.gas95;
        else if (fuel_type === 'gas97') correctPrice = stationData.precios.gas97;
        
        if (correctPrice && correctPrice > 0) {
          result.recommendation.display_price = correctPrice;
          console.log(`[pipeline] 🔧 Corregido display_price: $${correctPrice}`);
        }
        
        result.recommendation.station = {
          ...result.recommendation.station,
          direccion: stationData.direccion,
          comuna: stationData.comuna,
          precios_detalle: stationData.precios_detalle,
          servicios: stationData.servicios,
          metodos_pago: stationData.metodos_pago
        };
      }
    }
    
    // Redondear ahorros
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
